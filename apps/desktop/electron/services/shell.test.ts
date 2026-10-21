import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { agentEnvironment, ShellService } from './shell'

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

let base = ''
let marker = ''
/** Keeps the machine's own git config out of the result. */
let isolation: Record<string, string> = {}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync('git', args, { cwd, env: { ...env, ...isolation }, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** A shell snippet git runs for a config-driven program; it leaves the marker file behind. */
function leaveMarker(): string {
  return `echo ran > '${marker.replace(/\\/g, '/')}'`
}

async function markerExists(): Promise<boolean> {
  return fs.access(marker).then(
    () => true,
    () => false,
  )
}

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-shell-')))
  marker = path.join(base, 'program-ran')
  const globalConfig = path.join(base, 'empty-gitconfig')
  await fs.writeFile(globalConfig, '')
  isolation = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'eNCode test',
    GIT_AUTHOR_EMAIL: 'test@encode.invalid',
    GIT_COMMITTER_NAME: 'eNCode test',
    GIT_COMMITTER_EMAIL: 'test@encode.invalid',
  }
})

after(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('ShellService.capture', () => {
  const node = `"${process.execPath.replace(/\\/g, '/')}"`
  const run = (command: string) => new ShellService().capture(command, base, 20_000, new AbortController().signal)

  it('reports the exit status of the command line', async () => {
    assert.equal((await run(`${node} -e "process.exit(3)"`)).code, 3)
    assert.equal((await run(`${node} -e "process.exit(0)"`)).code, 0)
    assert.equal((await run(`${node} -e "process.exit(0)" && ${node} -e "process.exit(5)"`)).code, 5)
    assert.equal((await run(`${node} -e "process.exit(2)" || ${node} -e "process.exit(0)"`)).code, 0)
  })

  it('reports a command that cannot be found as a failure', async () => {
    const result = await run('encode-no-such-program --version')
    assert.notEqual(result.code, 0)
  })
})

describe('agentEnvironment', () => {
  it('adds its git config after config the user already passes through the environment', () => {
    const saved = { ...process.env }
    try {
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'user.name'
      process.env.GIT_CONFIG_VALUE_0 = 'Someone'
      const env = agentEnvironment()
      assert.equal(env.GIT_CONFIG_KEY_0, 'user.name')
      assert.equal(env.GIT_CONFIG_VALUE_0, 'Someone')
      assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor')
      assert.equal(env.GIT_CONFIG_VALUE_1, 'false')
      assert.equal(env.GIT_CONFIG_KEY_2, 'safe.bareRepository')
      assert.equal(env.GIT_CONFIG_VALUE_2, 'explicit')
      assert.equal(env.GIT_CONFIG_COUNT, '3')
      assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  it('stops a repository fsmonitor hook from running on git status', { skip: !hasGit && 'git is not installed' }, async () => {
    const repo = path.join(base, 'fsmonitor-repo')
    assert.equal(git(base, ['init', '-q', repo], process.env).status, 0)
    await fs.writeFile(path.join(repo, 'a.txt'), 'alpha\n')
    assert.equal(git(repo, ['add', 'a.txt'], process.env).status, 0)
    assert.equal(git(repo, ['commit', '-q', '-m', 'init'], process.env).status, 0)
    assert.equal(git(repo, ['config', 'core.fsmonitor', leaveMarker()], process.env).status, 0)

    // Control: with plain git the hook runs once the index carries fsmonitor data.
    for (let run = 0; run < 3 && !(await markerExists()); run++) git(repo, ['status', '--porcelain'], process.env)
    assert.ok(await markerExists(), 'the fsmonitor hook should run under a plain environment')
    await fs.rm(marker)

    for (let run = 0; run < 3; run++) {
      assert.equal(git(repo, ['status', '--porcelain'], agentEnvironment()).status, 0)
    }
    assert.equal(await markerExists(), false, 'the fsmonitor hook ran under the agent environment')
  })

  it('does not discover a bare repository planted in the workspace', { skip: !hasGit && 'git is not installed' }, async () => {
    const source = path.join(base, 'source-repo')
    assert.equal(git(base, ['init', '-q', source], process.env).status, 0)
    for (const version of ['one\n', 'two\n']) {
      await fs.writeFile(path.join(source, 'data.txt'), version)
      assert.equal(git(source, ['add', 'data.txt'], process.env).status, 0)
      assert.equal(git(source, ['commit', '-q', '-m', version.trim()], process.env).status, 0)
    }
    const planted = path.join(base, 'workspace', 'planted')
    await fs.mkdir(path.dirname(planted), { recursive: true })
    assert.equal(git(base, ['clone', '-q', '--bare', source, planted], process.env).status, 0)
    assert.equal(git(planted, ['config', 'diff.planted.textconv', `${leaveMarker()}; cat`], process.env).status, 0)
    await fs.mkdir(path.join(planted, 'info'), { recursive: true })
    await fs.writeFile(path.join(planted, 'info', 'attributes'), '* diff=planted\n')

    // Control: plain git discovers the bare repository and runs its textconv program.
    const plain = git(planted, ['log', '-p', '-1'], process.env)
    assert.equal(plain.status, 0, plain.output)
    assert.ok(await markerExists(), 'the textconv program should run under a plain environment')
    await fs.rm(marker)

    const agent = git(planted, ['log', '-p', '-1'], agentEnvironment())
    assert.notEqual(agent.status, 0)
    assert.match(agent.output, /bare repository/)
    assert.equal(await markerExists(), false, 'the textconv program ran under the agent environment')
  })
})
