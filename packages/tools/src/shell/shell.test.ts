import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { gitSafetyProblem } from '@encode/permissions'
import { bashOutputTool, createBashTool, killShellTool } from '../bash'
import { tempWorkspace, testContext, textOf } from '../testing'
import type { JobInfo, ToolContext } from '../types'
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

  it('comes back to the worktree it was put in, not to the root, until another base is set', async () => {
    const { root, shell } = await shellIn({ '.encode-worktrees/fix/file.txt': 'x', 'sub/file.txt': 'y' })
    const worktree = path.join(root, '.encode-worktrees', 'fix')
    assert.equal(await shell.setCwd(worktree, { base: true }), true)
    await shell.run('cd ../../sub', { signal: signal() })
    assert.equal(await fs.realpath(shell.state().cwd), path.join(root, 'sub'), 'the rest of the project is still inside the workspace')
    const outside = await shell.run('cd /', { signal: signal() })
    assert.equal(outside.notice, `Shell cwd was reset to ${worktree}`)
    assert.equal(shell.state().cwd, worktree)
    // A plain move changes the directory, not where a command is put back.
    await shell.setCwd(path.join(root, 'sub'))
    assert.equal((await shell.run('cd /', { signal: signal() })).notice, `Shell cwd was reset to ${worktree}`)
    await fs.rm(worktree, { recursive: true, force: true })
    assert.equal((await shell.run('true', { signal: signal() })).notice, `Shell cwd was reset to ${root}`, 'a base that is gone gives way to the root')
    await shell.setCwd(root, { base: true })
    assert.equal(await shell.setCwd(path.dirname(root)), false)
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

  it('hands a long test run on whole, with a digest of its failures and totals for the model (ADR 0133)', async () => {
    const script = [
      "console.log('TAP version 13')",
      "for (let n = 1; n <= 400; n++) console.log(`# Subtest: case ${n}\\nok ${n} - case ${n}\\n  ---\\n  duration_ms: 0.1\\n  ...`)",
      "console.log('# Subtest: broken\\nnot ok 401 - broken\\n  ---\\n  error: \\'4 !== 5\\'\\n  ...\\n1..401\\n# tests 401\\n# pass 400\\n# fail 1')",
      'process.exitCode = 1',
    ].join('\n')
    const { root, shell } = await shellIn({ 'run.mjs': script })
    const ctx = testContext(root, { shell, jobs: createJobManager(shell) })
    const bash = createBashTool(shell.dialect, process.platform)
    const outcome = await bash.run({ command: 'node run.mjs' }, ctx)
    assert.equal(outcome.ok, false)
    const whole = textOf(outcome.content)
    assert.ok(whole.includes('ok 200 - case 200') && whole.endsWith('Exit code 1'), whole.slice(-200))
    assert.equal(outcome.display?.output, whole)
    const digest = outcome.digest!
    assert.ok(digest.content.length < whole.length / 10, `${digest.content.length} of ${whole.length}`)
    assert.ok(!digest.content.includes('ok 200 - case 200'))
    assert.ok(digest.content.includes("not ok 401 - broken") && digest.content.includes("error: '4 !== 5'") && digest.content.includes('# fail 1'))
    assert.ok(digest.content.endsWith('Exit code 1'), 'what the tool adds stays')
    assert.match(digest.note, /400 passing tests/)
    const listed = await bash.run({ command: shell.dialect === 'pwsh' ? 'Get-Content run.mjs' : 'cat run.mjs' }, ctx)
    assert.equal(listed.digest, undefined)
  })

  it('refuses a long wait on its own, and runs a short one or one in the background', async () => {
    const { root, shell } = await shellIn()
    const jobs = createJobManager(shell)
    const ctx = testContext(root, { shell, jobs })
    const bash = createBashTool(shell.dialect, process.platform)
    const long = shell.dialect === 'pwsh' ? 'Start-Sleep -Seconds 110; "waited"' : 'sleep 110; echo waited'
    const started = Date.now()
    const refused = await bash.run({ command: long }, ctx)
    assert.equal(refused.ok, false)
    assert.match(textOf(refused.content), /^Not run: this command waits 110 s doing nothing/)
    assert.ok(Date.now() - started < 5_000, 'nothing waited')
    const short = await bash.run({ command: shell.dialect === 'pwsh' ? 'Start-Sleep -Milliseconds 100; Write-Output ok' : 'sleep 0.1; echo ok' }, ctx)
    assert.equal(short.ok, true)
    const behind = await bash.run({ command: long, run_in_background: true }, ctx)
    assert.equal(behind.ok, true)
    await killShellTool.run({ shell_id: 'bash_1' }, ctx)
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
    // A read with nothing new waits for the command (below); a call that is stopped does not.
    const stoppedCall = new AbortController()
    stoppedCall.abort()
    const again = await bashOutputTool.run({ bash_id: 'bash_1' }, { ...ctx, signal: stoppedCall.signal })
    assert.equal(again.content, 'Status: running\n\n(no new output)')
    const stopped = await killShellTool.run({ shell_id: 'bash_1' }, ctx)
    assert.equal(stopped.ok, true)
    assert.equal(jobs.list()[0].status, 'killed')
    assert.match(textOf((await bashOutputTool.run({ bash_id: 'nope' }, ctx)).content), /no background command nope\. Known ids: bash_1/)
  })

  it('waits in BashOutput for the next lines of a command that runs, instead of returning nothing (ADR 0153)', async () => {
    const { root, shell } = await shellIn()
    const jobs = createJobManager(shell)
    const ctx = testContext(root, { shell, jobs })
    const bash = createBashTool(shell.dialect, process.platform)
    await bash.run({ command: 'echo first; sleep 1.5; echo second; sleep 60', run_in_background: true }, ctx)
    const first = textOf((await bashOutputTool.run({ bash_id: 'bash_1' }, ctx)).content)
    assert.match(first, /^Status: running\n\nfirst(\r?\nsecond)?$/)
    if (!first.includes('second')) {
      const started = Date.now()
      const next = await bashOutputTool.run({ bash_id: 'bash_1' }, ctx)
      assert.match(textOf(next.content), /^Status: running\n\nsecond$/)
      assert.ok(Date.now() - started < 20_000, 'it came back with the line, not after the whole wait')
    }
    await killShellTool.run({ shell_id: 'bash_1' }, ctx)
  })

  it('names who started a job and what it is for, passes its output on as it comes, and says when it ends', async () => {
    const { shell } = await shellIn()
    const ended: JobInfo[] = []
    const seen: string[] = []
    const jobs = createJobManager(shell, { onEnd: (job) => ended.push(job) })
    const job = await jobs.start('echo one; echo two; exit 3', { kind: 'monitor', description: '  Watch it  ', agentId: 'main', onOutput: (text) => seen.push(text) })
    assert.deepEqual([job.kind, job.description, job.agentId], ['monitor', 'Watch it', 'main'])
    for (let waited = 0; !ended.length && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(ended.length, 1)
    assert.deepEqual([ended[0].id, ended[0].status, ended[0].exitCode, ended[0].kind], [job.id, 'error', 3, 'monitor'])
    assert.match(seen.join(''), /one\r?\ntwo/)
    const plain = await jobs.start('echo plain', {})
    assert.equal(plain.kind, undefined)
    assert.equal(plain.agentId, undefined)
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
    // Windows: a program of the Git runtime started from PowerShell cannot start in the sandbox, and says so in its own words.
    const msys = await bash.run({ command: 'ssh host' }, fake({ active: true, allowUnsandboxed: true }, '0 [main] ssh (4) C:\\Git\\usr\\bin\\ssh.exe: *** fatal error - couldn\'t create signal pipe, Win32 error 5', 1))
    assert.match(textOf(msys.content), /This may be the sandbox\./)
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
