import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Peer } from '@encode/protocol'
import { connect, installNode, sshFailure, type Connection } from './connection'
import type { FolderMainApi, FolderServerApi } from './protocol'
import { KeyTokens, serveTunnel, type NetHostApi, type NetMainApi } from './tunnel'

/** The repository, found from the working folder: the test runs from a bundle elsewhere. */
function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'apps', 'desktop', 'electron', 'remote', 'server.ts'))) return dir
    if (path.dirname(dir) === dir) throw new Error('Run the tests from inside the repository.')
  }
}

const posix = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0

/** `ssh` played by this machine: the command goes to a login shell, with a home of the test's own. */
function fakeSsh(home: string) {
  return (_program: string, args: string[]) => {
    const command = args.at(-1)!
    assert.equal(args.at(-3), '--')
    return spawn('sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', HOME: home }, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  }
}

describe('a folder on another machine', { skip: !posix && 'needs a POSIX shell' }, () => {
  let dir = ''
  let server: { bytes: Buffer; sha256: string }
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'encode-remote-it-'))
    const out = path.join(dir, 'encode-server.cjs')
    const script = `import('./apps/desktop/scripts/main-build.mjs').then(async ({ mainBuildOptions }) => {
      const { build } = await import('esbuild')
      const options = mainBuildOptions({ production: true })
      await build({ ...options, entryPoints: { 'encode-server': 'electron/remote/server.ts' }, outdir: ${JSON.stringify(dir)}, logLevel: 'silent' })
    }).catch((error) => { console.error(error); process.exit(1) })`
    const built = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repoRoot(), encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    const bytes = readFileSync(out)
    server = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('starts eNCode there, sends it first, and serves the folder and the agent over one connection', { timeout: 60_000 }, async () => {
    const home = path.join(dir, 'home')
    const project = path.join(home, 'project')
    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'main.ts'), 'export const answer = 42\n')
    const steps: string[] = []
    const logs: string[] = []
    const result = await connect({ target: { host: 'vm' }, ssh: 'ssh', server, spawn: fakeSsh(home), progress: (step) => steps.push(step), log: (line) => logs.push(line) })
    assert.ok(result.ok, JSON.stringify(result))
    const connection = result as Connection
    try {
      assert.deepEqual(steps, ['connecting', 'uploading', 'starting'])
      const folder = new Peer<FolderMainApi, FolderServerApi>(connection.channels.port('folder'))
      const hello = await folder.request('hello', undefined, { timeoutMs: 10_000 })
      assert.equal(hello.home, home)
      const info = await folder.request('resolveFolder', { path: '~/project' })
      assert.deepEqual(info, { root: project, name: 'project' })
      await assert.rejects(folder.request('resolveFolder', { path: '~/missing' }), /does not exist/)

      await folder.request('call', { service: 'workspace', method: 'open', args: [project] })
      const entries = (await folder.request('call', { service: 'workspace', method: 'list', args: [''] })) as Array<{ name: string }>
      assert.deepEqual(entries.map((entry) => entry.name), ['src'])
      const read = (await folder.request('call', { service: 'workspace', method: 'read', args: ['src/main.ts'] })) as { content: string }
      assert.equal(read.content, 'export const answer = 42\n')
      await folder.request('call', { service: 'workspace', method: 'write', args: ['src/main.ts', 'export const answer = 43\n'] })
      assert.equal(readFileSync(path.join(project, 'src', 'main.ts'), 'utf8'), 'export const answer = 43\n')
      await assert.rejects(folder.request('call', { service: 'workspace', method: 'read', args: ['../../etc/passwd'] }), /outside the workspace/)
      await assert.rejects(folder.request('call', { service: 'workspace', method: 'resolve', args: [''] }), /No method workspace.resolve/)
      await assert.rejects(folder.request('call', { service: 'shell' as never, method: 'constructor', args: [] }), /No method/)

      // The agent host answers on its own channel, as the utility process does on the PC.
      const net = new Peer<NetMainApi, NetHostApi>(connection.channels.port('net'))
      serveTunnel(net, new KeyTokens(), { allowed: () => false, keyFor: () => '' })
      const host = new Peer<{ requests: { key: { params: unknown; result: string } }; events: {} }, { requests: { init: { params: unknown; result: void }; sessions: { params: undefined; result: unknown[] } }; events: {} }>(connection.channels.port('host'))
      host.handle('key', () => '')
      const data = path.join(home, '.encode-server', 'data')
      await host.request('init', { dir: path.join(data, 'sessions'), home, workspace: project, config: { policy: 'workspace-write', maxSteps: 200, maxGoalRounds: 8, contextCap: 200_000, computer: false, languageServers: false, errorGate: 'auto', guide: 'auto', checkGate: 'auto', reviewWork: 'auto', askAgain: 'on', learnConventions: 'on', helpSmaller: 'auto', offerStronger: 'ask', model: 'demo', router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } }, providers: {}, searchProvider: 'duckduckgo' } }, { timeoutMs: 20_000 })
      const sessions = (await host.request('sessions', undefined, { timeoutMs: 10_000 })) as Array<{ projectRoot: string }>
      assert.deepEqual(sessions.map((session) => session.projectRoot), [project])

      // Nothing but messages came on standard output: the program's own lines went to standard error.
      assert.ok(logs.some((line) => line.includes("eNCode's program runs as pid")), logs.join('\n'))
    } finally {
      connection.close()
    }
    await new Promise<void>((resolve) => connection.onClose(() => resolve()))

    // The next connection finds the program there and does not send it again.
    const again = await connect({ target: { host: 'vm' }, ssh: 'ssh', server, spawn: fakeSsh(home), progress: (step) => steps.push(step) })
    assert.ok(again.ok)
    assert.deepEqual(steps.slice(3), ['connecting', 'starting'])
    ;(again as Connection).close()
  })

  it('says why, in words, when SSH could not connect', () => {
    assert.equal(sshFailure('user@vm: Permission denied (publickey,password).', { host: 'vm', user: 'user' }).kind, 'auth')
    assert.equal(sshFailure('Host key verification failed.', { host: 'vm' }).kind, 'host-key')
    assert.equal(sshFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', { host: 'vm' }).kind, 'host-key-changed')
    assert.equal(sshFailure('ssh: Could not resolve hostname nope: Name or service not known', { host: 'nope' }).kind, 'unreachable')
    assert.match(sshFailure('ssh: connect to host vm port 22: Connection refused', { host: 'vm' }).message, /refused the connection/)
  })

  it('reports a machine without Node.js, with what it is, and passes over what a login script prints', { timeout: 30_000 }, async () => {
    const result = await connect({
      target: { host: 'vm' },
      ssh: 'ssh',
      server,
      spawn: (_program, args) => {
        const nonce = args.at(-1)!.match(/ENCODE-NODE-MISSING (\w+)/)![1]
        const fake = `printf "Welcome to the VM\\nENCODE-NODE-MISSING not-this-one Darwin-arm64\\n\\nENCODE-NODE-MISSING ${nonce} Linux-x86_64\\n"`
        return spawn('sh', ['-c', fake], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams
      },
    })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.kind, 'node-missing')
    assert.equal(!result.ok && result.machine, 'Linux-x86_64')
  })
})

describe('putting Node.js on a machine that has none', () => {
  /** `ssh` played by a program that prints what the install script would, for the nonce in the command it was given. */
  const printing = (lines: (nonce: string) => string) => (_program: string, args: string[]) => {
    const nonce = args.at(-1)!.match(/ENCODE-INSTALLED (\w+)/)![1]!
    return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(lines(nonce))})`], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  }

  it('says it worked when the script says so, for this install only', async () => {
    const result = await installNode({ target: { host: 'vm' }, ssh: 'ssh', platform: 'linux-x64', spawn: printing((nonce) => `ENCODE-INSTALLED someone-else\nunpacking\nENCODE-INSTALLED ${nonce}\n`) })
    assert.deepEqual(result, { ok: true })
  })

  it('says in words what went wrong', async () => {
    const result = await installNode({ target: { host: 'vm' }, ssh: 'ssh', platform: 'linux-x64', spawn: printing((nonce) => `\nENCODE-FAILED ${nonce} checksum\n`) })
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.message : '', /checksum is not the one eNCode expects/)
  })

  it('installs only a build it has a checksum for', async () => {
    const result = await installNode({ target: { host: 'vm' }, ssh: 'ssh', platform: 'windows-x64', spawn: () => assert.fail('nothing should run') })
    assert.equal(result.ok, false)
  })
})
