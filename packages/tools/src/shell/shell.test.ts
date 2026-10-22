import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { gitSafetyProblem } from '@encode/permissions'
import { bashOutputTool, createBashTool, killShellTool } from '../bash'
import { tempWorkspace, testContext, textOf } from '../testing'
import type { ToolContext } from '../types'
import { detectShell } from './detect'
import { agentEnvironment, looksSecret } from './environment'
import { createJobManager } from './jobs'
import { OutputBuffer, createAgentShell, type ManagedShell } from './run'

const program = detectShell()
const shells: ManagedShell[] = []
after(async () => {
  await Promise.all(shells.map((shell) => shell.dispose()))
})

async function shellIn(files: Record<string, string> = {}, options: Partial<Parameters<typeof createAgentShell>[0]> = {}) {
  const root = await tempWorkspace(files)
  const shell = createAgentShell({ root, baseEnv: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OPENAI_API_KEY: 'sk-secret', ...options.baseEnv }, ...options })
  shells.push(shell)
  return { root, shell }
}

const signal = () => new AbortController().signal

describe('agentEnvironment', () => {
  it('drops credentials but keeps agent sockets and what the user keeps', () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'NPM_AUTH', 'STRIPE_KEY', 'azure_client_secret']) {
      assert.equal(looksSecret(name), true, name)
    }
    for (const name of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'GIT_CONFIG_KEY_0', 'KEYBOARD', 'XAUTHORITY', 'TOKENIZERS_PARALLELISM', 'PWD']) {
      assert.equal(looksSecret(name), false, name)
    }
    const { env, removed } = agentEnvironment({ PATH: '/bin', GITHUB_TOKEN: 'x', NPM_TOKEN: 'y', ELECTRON_RUN_AS_NODE: '1' }, { platform: 'linux', keep: ['npm_token'] })
    assert.deepEqual(removed, ['GITHUB_TOKEN'])
    assert.equal(env.NPM_TOKEN, 'y')
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(env.GIT_CONFIG_COUNT, '2')
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.fsmonitor')
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  })

  it('is one the permission rules accept for git, so git is not asked about for that alone', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { env } = agentEnvironment({ PATH: '/bin', Path: 'C:\\Windows' }, { platform })
      assert.equal(gitSafetyProblem(env, platform === 'win32'), null, platform)
    }
    // A setting the user already had stays, after eNCode's own would be undone by it: the rules ask.
    const own = agentEnvironment({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'x' }, { platform: 'linux' }).env
    assert.equal(own.GIT_CONFIG_COUNT, '3')
    assert.notEqual(gitSafetyProblem(own, false), null)
  })
})

describe('OutputBuffer', () => {
  it('keeps the start and the end of long output', () => {
    const buffer = new OutputBuffer(5, 5)
    buffer.push('abcdefgh')
    buffer.push('ijklmnop')
    assert.equal(buffer.length, 16)
    assert.equal(buffer.text(), 'abcde\n\n… [6 characters cut] …\n\nlmnop')
  })
})

describe('the agent shell', { skip: program?.dialect === 'bash' ? false : 'needs bash' }, () => {
  it('runs a command and reports output and exit codes', async () => {
    const { shell } = await shellIn()
    const ok = await shell.run('echo hello; echo oops >&2', { signal: signal() })
    assert.equal(ok.exitCode, 0)
    assert.match(ok.output, /hello/)
    assert.match(ok.output, /oops/)
    const failed = await shell.run('exit 3', { signal: signal() })
    assert.equal(failed.exitCode, 3)
  })

  it('keeps the directory between commands but not variables, and comes back from outside the workspace', async () => {
    const { root, shell } = await shellIn({ 'sub/file.txt': 'x' })
    await shell.run('cd sub && export ENCODE_TEST_VAR=1', { signal: signal() })
    assert.equal(await fs.realpath(shell.state().cwd), path.join(root, 'sub'))
    const listing = await shell.run('ls; echo "var=[$ENCODE_TEST_VAR]"', { signal: signal() })
    assert.match(listing.output, /file\.txt/)
    assert.match(listing.output, /var=\[\]/)
    const outside = await shell.run('cd ../..', { signal: signal() })
    assert.equal(outside.notice, `Shell cwd was reset to ${root}`)
    assert.equal(shell.state().cwd, root)
  })

  it('does not pass credentials to commands', async () => {
    const { shell } = await shellIn()
    const result = await shell.run('echo "key=[$OPENAI_API_KEY]"', { signal: signal() })
    assert.match(result.output, /key=\[\]/)
    assert.deepEqual(shell.removedEnv, ['OPENAI_API_KEY'])
  })

  it('runs quotes, newlines and heredocs exactly as written', async () => {
    const { shell } = await shellIn()
    const command = `printf '%s\\n' "it's" 'a "test"'\ncat <<'EOF'\n$HOME stays literal\nEOF`
    const result = await shell.run(command, { signal: signal() })
    assert.equal(result.output.trim(), `it's\na "test"\n$HOME stays literal`)
  })

  it('stops a command at its timeout, and when aborted', async () => {
    const { shell } = await shellIn()
    const started = Date.now()
    const slow = await shell.run('echo start; sleep 30', { signal: signal(), timeoutMs: 1_000 })
    assert.equal(slow.timedOut, true)
    assert.equal(slow.exitCode, null)
    assert.match(slow.output, /start/)
    assert.ok(Date.now() - started < 10_000)

    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('stop')), 300)
    const aborted = await shell.run('sleep 30', { signal: controller.signal })
    assert.equal(aborted.interrupted, true)
  })

  it('returns when the shell exits, even if a process it started still holds the pipes', async () => {
    const { shell } = await shellIn()
    const started = Date.now()
    const result = await shell.run('sleep 20 & echo started', { signal: signal(), timeoutMs: 8_000 })
    assert.match(result.output, /started/)
    assert.equal(result.timedOut, false)
    assert.ok(Date.now() - started < 5_000)
  })

  it('lets a sandbox rewrite the spawn', async () => {
    const { shell } = await shellIn({}, { wrapSpawn: (spec) => ({ ...spec, env: { ...spec.env, ENCODE_SANDBOXED: 'yes' } }) })
    const result = await shell.run('echo "sandboxed=$ENCODE_SANDBOXED"', { signal: signal() })
    assert.match(result.output, /sandboxed=yes/)
  })

  it('lets a command ask to leave the sandbox, and keeps the scripts of the others where the sandbox can read them', async () => {
    const scratch = await tempWorkspace({})
    const wrapped: string[] = []
    const { shell } = await shellIn(
      {},
      {
        wrapSpawn: (spec) => {
          wrapped.push(spec.args.join(' '))
          return { ...spec, env: { ...spec.env, ENCODE_SANDBOXED: 'yes' } }
        },
        scratchRoot: () => scratch,
        sandbox: () => ({ active: true, allowUnsandboxed: true }),
      },
    )
    assert.deepEqual(shell.state().sandbox, { active: true, allowUnsandboxed: true })
    const inside = await shell.run('echo "sandboxed=$ENCODE_SANDBOXED"; echo "$0" > where.txt; cat where.txt', { signal: signal() })
    assert.match(inside.output, /sandboxed=yes/)
    assert.equal(wrapped.length, 1)
    assert.ok(wrapped[0].replace(/\\/g, '/').includes(scratch.replace(/\\/g, '/')), `the script was not kept under the sandbox's folder: ${wrapped[0]}`)
    const outside = await shell.run('echo "sandboxed=$ENCODE_SANDBOXED"', { signal: signal(), unsandboxed: true })
    assert.match(outside.output, /sandboxed=\s*$/m)
    assert.equal(wrapped.length, 1, 'a command allowed to leave the sandbox is not rewritten')
    assert.ok(!wrapped.join(' ').includes('unsandboxed'))
  })

  it('has no sandbox view when it is given none', async () => {
    const { shell } = await shellIn({}, { scratchRoot: () => undefined })
    assert.equal(shell.state().sandbox, undefined)
    const result = await shell.run('echo ok', { signal: signal() })
    assert.match(result.output, /ok/)
  })

  it('runs background jobs, hands out new output once, and kills them', async () => {
    const { root, shell } = await shellIn()
    const jobs = createJobManager(shell)
    const ctx = testContext(root, { shell, jobs })
    const bash = createBashTool(shell.dialect, process.platform)
    const started = await bash.run({ command: 'echo first; sleep 0.3; echo second; sleep 30', run_in_background: true }, ctx)
    assert.match(textOf(started.content), /bash_1/)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const first = await bashOutputTool.run({ bash_id: 'bash_1' }, ctx)
    assert.match(textOf(first.content), /^Status: running\n\nfirst\nsecond$/)
    const again = await bashOutputTool.run({ bash_id: 'bash_1' }, ctx)
    assert.equal(again.content, 'Status: running\n\n(no new output)')
    const stopped = await killShellTool.run({ shell_id: 'bash_1' }, ctx)
    assert.equal(stopped.ok, true)
    assert.equal(jobs.list()[0].status, 'killed')
    assert.match(textOf((await bashOutputTool.run({ bash_id: 'nope' }, ctx)).content), /no background command nope\. Known ids: bash_1/)
  })

  it('tells the model about the sandbox, offers to leave it only where that is allowed, and says when it may have been what stopped a command', async () => {
    const none = createBashTool('bash', 'linux')
    assert.ok(!none.definition.description.includes('sandbox'))
    assert.equal('unsandboxed' in (none.definition.inputSchema.properties as object), false)

    const confined = createBashTool('bash', 'linux', { escapable: false })
    assert.match(confined.definition.description, /Commands run in a sandbox: they can write only in the workspace and the temp folder/)
    assert.ok(!confined.definition.description.includes('unsandboxed'))
    assert.equal('unsandboxed' in (confined.definition.inputSchema.properties as object), false)

    const bash = createBashTool('bash', 'linux', { escapable: true })
    assert.match(bash.definition.description, /retry it with unsandboxed true; the person is asked first/)
    assert.equal('unsandboxed' in (bash.definition.inputSchema.properties as object), true)

    const root = await tempWorkspace()
    const ran: Array<{ command: string; unsandboxed: boolean }> = []
    const fake = (view: { active: boolean; allowUnsandboxed: boolean } | undefined, output: string, exitCode: number): ToolContext =>
      testContext(root, {
        shell: {
          dialect: 'bash',
          program: '/bin/bash',
          state: () => ({ cwd: root, env: {}, dialect: 'bash', ...(view ? { sandbox: view } : {}) }),
          run: async (command, options) => {
            ran.push({ command, unsandboxed: options.unsandboxed === true })
            return { output, exitCode, timedOut: false, interrupted: false, cwd: root }
          },
        },
      })

    // The access carries the request, so that the approval policy can ask.
    assert.deepEqual(await bash.access({ command: 'git push', unsandboxed: true }, fake({ active: true, allowUnsandboxed: true }, '', 0)), {
      type: 'command',
      command: 'git push',
      cwd: root,
      background: false,
      unsandboxed: true,
    })
    assert.match((await bash.describe({ command: 'git push', unsandboxed: true }, fake(undefined, '', 0))).detail ?? '', /\(outside the sandbox\)/)

    // A failure that reads like a block gets the hint; the same words from a command outside the sandbox, or one that succeeded, do not.
    const blocked = await bash.run({ command: 'touch /etc/x' }, fake({ active: true, allowUnsandboxed: true }, 'touch: cannot touch /etc/x: Read-only file system', 1))
    assert.match(textOf(blocked.content), /This may be the sandbox\. .* unsandboxed true/)
    const plain = await bash.run({ command: 'false' }, fake({ active: true, allowUnsandboxed: true }, 'boom', 1))
    assert.ok(!textOf(plain.content).includes('sandbox'))
    const outside = await bash.run({ command: 'touch /etc/x', unsandboxed: true }, fake({ active: true, allowUnsandboxed: true }, 'touch: Permission denied', 1))
    assert.ok(!textOf(outside.content).includes('This may be the sandbox'))
    assert.deepEqual(ran.at(-1), { command: 'touch /etc/x', unsandboxed: true })
    const noHint = await bash.run({ command: 'touch /etc/x' }, fake({ active: true, allowUnsandboxed: false }, 'touch: Permission denied', 1))
    assert.ok(!textOf(noHint.content).includes('unsandboxed'))

    // A request to leave is refused when the settings say no, and ignored where there is no sandbox to leave.
    const refused = await bash.run({ command: 'git push', unsandboxed: true }, fake({ active: true, allowUnsandboxed: false }, '', 0))
    assert.equal(refused.ok, false)
    assert.match(textOf(refused.content), /do not let commands run outside the sandbox/)
    const before = ran.length
    await bash.run({ command: 'echo hi', unsandboxed: true }, fake({ active: false, allowUnsandboxed: true }, 'hi', 0))
    assert.equal(ran.length, before + 1)
    assert.equal(ran.at(-1)!.unsandboxed, false)
  })

  it('formats results for the model', async () => {
    const { root, shell } = await shellIn()
    const bash = createBashTool(shell.dialect, process.platform)
    const ctx = testContext(root, { shell })
    const failed = await bash.run({ command: 'echo nope; exit 2' }, ctx)
    assert.equal(failed.ok, false)
    assert.equal(failed.content, 'nope\n\nExit code 2')
    const quiet = await bash.run({ command: 'true' }, ctx)
    assert.equal(quiet.content, '(no output)')
    assert.deepEqual(await bash.access({ command: 'ls' }, ctx), { type: 'command', command: 'ls', cwd: root, background: false })
  })
})
