import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { EnginePolicy, EngineProbe, SandboxEngine, SpawnSpec } from './engine'
import { SandboxError } from './errors'
import { Sandbox } from './sandbox'
import { DEFAULT_SETTINGS, type SandboxSettings } from './settings'

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...DEFAULT_SETTINGS, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [], caches: false, ...over })

interface Fake extends SandboxEngine {
  probes: number
  prepared: EnginePolicy[]
  wrapped: EnginePolicy[]
}

function fakeEngine(probe: EngineProbe = { ok: true }): Fake {
  const engine: Fake = {
    name: 'bubblewrap',
    limits: { reads: true, network: true, protectedPaths: 'exact', processes: true },
    probes: 0,
    prepared: [],
    wrapped: [],
    async probe() {
      engine.probes++
      return probe
    },
    async prepare(policy) {
      engine.prepared.push(policy)
    },
    wrap(spec: SpawnSpec, policy: EnginePolicy) {
      engine.wrapped.push(policy)
      return { ...spec, file: '/usr/bin/fake-sandbox', args: ['--', spec.file, ...spec.args] }
    },
  }
  return engine
}

describe('the sandbox', () => {
  let dir = ''
  let project = ''
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'work-')))
    project = path.join(dir, 'project')
    fs.mkdirSync(project)
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const make = (engine: SandboxEngine | undefined, over: Partial<ConstructorParameters<typeof Sandbox>[0]> = {}) =>
    new Sandbox({ platform: 'linux', home: path.join(dir, 'home'), dir: path.join(dir, 'sandbox'), ...(engine ? { engine } : {}), env: {}, ...over })
  const spec = (): SpawnSpec => ({ file: '/bin/bash', args: ['x.sh'], env: { PATH: '/usr/bin' }, cwd: project })

  it('checks the machine once and says what it found', async () => {
    const engine = fakeEngine()
    const sandbox = make(engine)
    assert.equal(sandbox.status().state, 'unavailable')
    const [one, two] = await Promise.all([sandbox.start(), sandbox.start()])
    assert.equal(engine.probes, 1)
    assert.equal(one.state, 'active')
    assert.equal(two.engine, 'bubblewrap')
    assert.equal(sandbox.status().state, 'active')
    await sandbox.refresh()
    assert.equal(engine.probes, 2)
  })

  it('says why when the engine fails its test', async () => {
    const sandbox = make(fakeEngine({ ok: false, reason: 'bubblewrap is not installed.' }))
    const status = await sandbox.start()
    assert.equal(status.state, 'unavailable')
    assert.equal(status.reason, 'bubblewrap is not installed.')
  })

  it('tells listeners when the answer changes', async () => {
    const sandbox = make(fakeEngine())
    let calls = 0
    const stop = sandbox.onChange(() => calls++)
    await sandbox.start()
    assert.ok(calls >= 1)
    stop()
    const before = calls
    await sandbox.refresh()
    assert.equal(calls, before)
  })

  it('wraps a session’s spawn in the engine with a policy for its folders', async () => {
    const engine = fakeEngine()
    const sandbox = make(engine)
    const session = sandbox.session({ roots: () => [project], settings: () => settings() })
    const wrapped = await session.wrapSpawn(spec())
    assert.equal(wrapped.file, '/usr/bin/fake-sandbox')
    assert.deepEqual(wrapped.args, ['--', '/bin/bash', 'x.sh'])
    const policy = engine.wrapped[0]
    assert.ok(policy.writable.includes(project))
    assert.ok(policy.writable.includes(path.join(dir, 'sandbox', 'tmp')))
    // The sandbox here is a Linux one, whatever runs the test, so its paths are joined the way a Linux policy joins them.
    assert.ok(policy.protected.includes(path.posix.join(project, '.git', 'hooks')))
    assert.deepEqual(session.state(), { active: true, required: false, allowUnsandboxed: true, limits: engine.limits })
  })

  it('gives a repository without a hooks folder an empty one before a command runs, and leaves other folders alone', async () => {
    const repo = path.join(dir, 'no-hooks')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const session = make(fakeEngine()).session({ roots: () => [repo, project], settings: () => settings() })
    await session.wrapSpawn({ ...spec(), cwd: repo })
    assert.ok(fs.statSync(path.join(repo, '.git', 'hooks')).isDirectory())
    assert.equal(fs.existsSync(path.join(project, '.git')), false)
  })

  it('prepares a set of folders once', async () => {
    const engine = fakeEngine()
    const sandbox = make(engine)
    const session = sandbox.session({ roots: () => [project], settings: () => settings() })
    await session.wrapSpawn(spec())
    await session.wrapSpawn(spec())
    assert.equal(engine.prepared.length, 1)
    const other = sandbox.session({ roots: () => [project, dir], settings: () => settings() })
    await other.wrapSpawn(spec())
    assert.equal(engine.prepared.length, 2)
  })

  it('picks up an extra folder the person allows later', async () => {
    const engine = fakeEngine()
    const extra: string[] = []
    const session = make(engine).session({ roots: () => [project, ...extra], settings: () => settings() })
    await session.wrapSpawn(spec())
    extra.push(dir)
    await session.wrapSpawn(spec())
    assert.ok(engine.wrapped[1].writable.includes(dir))
    assert.ok(!engine.wrapped[0].writable.includes(dir))
  })

  it('leaves the spawn alone when the settings turn it off', async () => {
    const engine = fakeEngine()
    const session = make(engine).session({ roots: () => [project], settings: () => settings({ enabled: false }) })
    assert.deepEqual(await session.wrapSpawn(spec()), spec())
    assert.equal(engine.probes, 0)
    assert.equal(session.state().active, false)
    assert.match(session.state().reason ?? '', /turned off/)
    assert.equal(await session.scratchRoot(), undefined)
  })

  it('leaves the spawn alone where there is no sandbox, and says so, unless the settings require one', async () => {
    const engine = fakeEngine({ ok: false, reason: 'no namespaces' })
    const optional = make(engine).session({ roots: () => [project], settings: () => settings() })
    assert.deepEqual(await optional.wrapSpawn(spec()), spec())
    assert.equal(optional.state().active, false)
    assert.equal(optional.state().reason, 'no namespaces')
    assert.equal(await optional.scratchRoot(), undefined)

    const required = make(engine).session({ roots: () => [project], settings: () => settings({ required: true }) })
    await assert.rejects(required.wrapSpawn(spec()), (error: unknown) => error instanceof SandboxError && error.code === 'unavailable' && /require the sandbox/.test(error.message) && /no namespaces/.test(error.message))
    assert.equal(required.state().required, true)
  })

  it('runs a program the engine cannot confine as it is, and says why, unless the settings require the sandbox', async () => {
    const engine = fakeEngine()
    engine.unsupported = (file) => (file.endsWith('bash.exe') ? 'Git Bash cannot run in the sandbox.' : undefined)
    const sandbox = make(engine)
    await sandbox.start()
    const optional = sandbox.session({ roots: () => [project], settings: () => settings() })
    const bash = { ...spec(), file: '/git/bin/bash.exe' }
    assert.deepEqual(await optional.wrapSpawn(bash), bash)
    assert.equal(engine.wrapped.length, 0)
    assert.equal((await optional.wrapSpawn({ ...spec(), file: '/pwsh/pwsh.exe' })).file, '/usr/bin/fake-sandbox')
    assert.equal(optional.state('/pwsh/pwsh.exe').active, true)
    assert.equal(optional.state().active, true, 'with no program given nothing is known against it')
    const refused = optional.state('/git/bin/bash.exe')
    assert.equal(refused.active, false)
    assert.equal(refused.reason, 'Git Bash cannot run in the sandbox.')
    assert.equal(sandbox.unsupported('/git/bin/bash.exe'), 'Git Bash cannot run in the sandbox.')

    const required = sandbox.session({ roots: () => [project], settings: () => settings({ required: true }) })
    await assert.rejects(required.wrapSpawn(bash), (error: unknown) => error instanceof SandboxError && /require the sandbox/.test(error.message) && /Git Bash cannot run/.test(error.message))
  })

  it('has no sandbox for a system without an engine', async () => {
    const sandbox = make(undefined, { platform: 'freebsd' as NodeJS.Platform })
    const status = await sandbox.start()
    assert.equal(status.state, 'unavailable')
    assert.match(status.reason ?? '', /no sandbox for freebsd/)
  })

  it('keeps the shell’s scripts in its temp folder while it is active', async () => {
    const sandbox = make(fakeEngine())
    const session = sandbox.session({ roots: () => [project], settings: () => settings() })
    const root = await session.scratchRoot()
    assert.equal(root, path.join(dir, 'sandbox', 'tmp'))
    assert.ok(fs.statSync(root!).isDirectory())
  })

  it('prepares ahead when warmed', async () => {
    const engine = fakeEngine()
    const session = make(engine).session({ roots: () => [project], settings: () => settings() })
    session.warm()
    for (let i = 0; i < 50 && !engine.prepared.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(engine.prepared.length, 1)
  })

  it('removes the scripts of commands that ended long ago and keeps recent ones', async () => {
    const sandboxDir = path.join(dir, 'sweep')
    const old = path.join(sandboxDir, 'tmp', 'encode-shell-old')
    const fresh = path.join(sandboxDir, 'tmp', 'encode-shell-new')
    fs.mkdirSync(old, { recursive: true })
    fs.mkdirSync(fresh, { recursive: true })
    const longAgo = new Date(Date.now() - 3 * 24 * 3_600_000)
    fs.utimesSync(old, longAgo, longAgo)
    await new Sandbox({ platform: 'linux', home: dir, dir: sandboxDir, engine: fakeEngine(), env: {} }).start()
    for (let i = 0; i < 50 && fs.existsSync(old); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(!fs.existsSync(old))
    assert.ok(fs.existsSync(fresh))
  })
})
