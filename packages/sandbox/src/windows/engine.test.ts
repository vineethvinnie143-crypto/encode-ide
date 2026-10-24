import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { EnginePolicy } from '../engine'
import { SandboxError } from '../errors'
import type { RunCompiler } from './build'
import { helperJson, runArguments, type Finished, type HelperClient, type LabelOptions, type LabelResult } from './client'
import { createWindowsEngine, tooBroad } from './engine'

const env = {
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}
const home = 'C:\\Users\\u'
const appDir = 'C:\\Users\\u\\AppData\\Local\\Programs\\eNCode'
const sandboxDir = 'C:\\Users\\u\\AppData\\Roaming\\eNCode\\sandbox'

describe('the folders the Windows sandbox will not mark', () => {
  const input = { env, home, keep: [`${sandboxDir}\\helper`, appDir] }

  it('refuses a drive, a share, the home folder and what holds it', () => {
    for (const folder of ['C:\\', 'C:', 'd:\\', '\\\\server\\share']) assert.match(tooBroad(folder, input) ?? '', /drive or share/, folder)
    for (const folder of ['C:\\Users\\u', 'c:\\users\\U\\', 'C:\\Users']) assert.match(tooBroad(folder, input) ?? '', /home folder/, folder)
  })

  it('refuses the folders where programs keep their settings and Windows’ own folders', () => {
    for (const folder of ['C:\\Users\\u\\AppData', 'C:\\Users\\u\\AppData\\Roaming', 'C:\\Users\\u\\AppData\\Local']) assert.match(tooBroad(folder, input) ?? '', /keep their settings/, folder)
    for (const folder of ['C:\\Windows', 'C:\\Windows\\Temp', 'C:\\Program Files\\Tool', 'C:\\Program Files (x86)']) assert.match(tooBroad(folder, input) ?? '', /Windows’ own folders|Windows' own folders/, folder)
  })

  it('refuses a folder that holds the helper or the program itself', () => {
    assert.match(tooBroad(sandboxDir, input) ?? '', /own program/)
    assert.match(tooBroad('C:\\Users\\u\\AppData\\Roaming\\eNCode', input) ?? '', /own program/)
    assert.match(tooBroad('C:\\Users\\u\\AppData\\Local\\Programs', input) ?? '', /own program/)
  })

  it('lets a project, a folder in the documents, and the sandbox’s temp and cache folders be marked', () => {
    for (const folder of ['C:\\work\\p', 'C:\\Users\\u\\Documents\\site', 'C:\\Users\\u\\Documents', `${sandboxDir}\\tmp`, `${sandboxDir}\\cache`, 'D:\\code']) assert.equal(tooBroad(folder, input), undefined, folder)
  })
})

interface Calls {
  label: Array<{ folders: string[]; protect: string[]; options?: LabelOptions }>
  unlabel: Array<{ folders: string[]; protect: string[] }>
  run: string[][]
}

function fakeClient(over: Partial<HelperClient> = {}): HelperClient & { calls: Calls } {
  const calls: Calls = { label: [], unlabel: [], run: [] }
  return {
    calls,
    async probe() {
      return { ok: true, version: '2' }
    },
    async label(_exe, folders, protect, options) {
      calls.label.push({ folders: [...folders], protect: [...protect], ...(options ? { options } : {}) })
      options?.onProgress?.(1234)
      const result: LabelResult = { ok: true, labeled: [...folders], folders: 1, files: 2, linked: 0, redirected: 0, failed: 0, failures: [], ms: 1 }
      return result
    },
    async unlabel(_exe, folders, protect) {
      calls.unlabel.push({ folders: [...folders], protect: [...protect] })
      return { ok: true, ms: 1 }
    },
    async run(_exe, args): Promise<Finished> {
      calls.run.push([...args])
      // As the real helper does: the program writes in the folder it was started in and is refused the one next to it.
      const cwd = args[args.indexOf('--cwd') + 1]
      fs.writeFileSync(path.join(cwd, 'in.txt'), 'ok')
      return { code: 0, stdout: '', stderr: '' }
    },
    ...over,
  }
}

/** A compiler that writes a program where it is told to. */
const compiler =
  (code = 0, stderr = ''): RunCompiler =>
  async (_file, args) => {
    const out = args.find((arg) => arg.startsWith('/out:'))!.slice('/out:'.length)
    if (code === 0) fs.writeFileSync(out, 'MZ')
    return { code, stdout: '', stderr }
  }

const policy = (over: Partial<EnginePolicy> = {}): EnginePolicy => ({
  writable: ['C:\\work\\p', `${sandboxDir}\\tmp`],
  protected: ['C:\\work\\p\\.git\\hooks', 'C:\\work\\p\\.git\\config', 'C:\\work\\p\\.mcp.json', 'C:\\elsewhere\\x'],
  unreadable: [],
  network: true,
  temp: `${sandboxDir}\\tmp`,
  env: { TEMP: `${sandboxDir}\\tmp`, TMP: `${sandboxDir}\\tmp` },
  unset: [],
  ...over,
})

describe('the Windows engine', () => {
  let dir = ''
  let count = 0
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-win-engine-'))
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const make = (client: HelperClient, options: { dir?: string; warn?: (message: string) => void; code?: number; stderr?: string } = {}) =>
    createWindowsEngine({
      dir: options.dir ?? path.join(dir, `s${++count}`),
      build: { csc: 'csc.exe', run: compiler(options.code, options.stderr) },
      client,
      env,
      home,
      appDir,
      ...(options.warn ? { warn: options.warn } : {}),
    })

  it('says what it can and cannot hold', () => {
    const engine = make(fakeClient())
    assert.equal(engine.name, 'integrity-level')
    assert.deepEqual(engine.limits, { reads: false, network: false, protectedPaths: 'best-effort', processes: false })
  })

  it('passes its test when a program writes inside a marked folder and not outside', async () => {
    const client = fakeClient()
    const engine = make(client)
    assert.deepEqual(await engine.probe(), { ok: true })
    assert.equal(client.calls.label.length, 1)
    assert.deepEqual(client.calls.label[0].protect, [])
    const args = client.calls.run[0]
    assert.equal(args[0], 'run')
    assert.ok(args.includes('/d') && args.includes('/c'))
    assert.ok(engine.helperPath()?.endsWith('encode-sandbox.exe'))
  })

  it('fails its test, and says so, when a program writes outside the marked folder', async () => {
    const client = fakeClient({
      async run(_exe, args) {
        const cwd = args[args.indexOf('--cwd') + 1]
        fs.writeFileSync(path.join(cwd, 'in.txt'), 'ok')
        fs.writeFileSync(path.join(cwd, '..', 'out', 'out.txt'), 'no')
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const probe = await make(client).probe()
    assert.equal(probe.ok, false)
    assert.match(probe.reason ?? '', /does not hold/)
  })

  it('fails its test with the helper’s words when no program can be started', async () => {
    const probe = await make(fakeClient({ probe: async () => ({ ok: false, error: 'CreateProcessAsUser failed: Access is denied. (error 5)' }) })).probe()
    assert.deepEqual(probe, { ok: false, reason: 'CreateProcessAsUser failed: Access is denied. (error 5)' })
  })

  it('fails its test with the compiler’s words when the helper cannot be built', async () => {
    const probe = await make(fakeClient(), { code: 1, stderr: 'C:\\x\\src\\Runner.cs(1,1): error CS1002: ; expected' }).probe()
    assert.equal(probe.ok, false)
    assert.match(probe.reason ?? '', /could not be built: .*CS1002/)
  })

  it('marks each folder once, with the protected paths inside it, and remembers what it marked', async () => {
    const client = fakeClient()
    const stateDir = path.join(dir, 'state')
    const engine = make(client, { dir: stateDir })
    const progress: string[] = []
    await engine.prepare(policy(), (message) => progress.push(message))
    assert.equal(client.calls.label.length, 2)
    assert.deepEqual(client.calls.label[0].folders, ['C:\\work\\p'])
    assert.deepEqual(client.calls.label[0].protect, ['C:\\work\\p\\.git\\hooks', 'C:\\work\\p\\.git\\config', 'C:\\work\\p\\.mcp.json'])
    assert.equal(client.calls.label[0].options?.ifMissing, true)
    assert.deepEqual(client.calls.label[1].protect, [])
    assert.ok(progress.includes('Preparing C:\\work\\p for the sandbox'))
    assert.ok(progress.includes('Preparing C:\\work\\p for the sandbox (1,234 items so far)'))

    await engine.prepare(policy())
    assert.equal(client.calls.label.length, 2, 'a folder marked in this run is not asked about again')

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    assert.equal(state.version, 2)
    assert.deepEqual(state.folders['c:\\work\\p'].protect, ['C:\\work\\p\\.git\\hooks', 'C:\\work\\p\\.git\\config', 'C:\\work\\p\\.mcp.json'])
    assert.equal(state.folders['c:\\work\\p'].path, 'C:\\work\\p')

    // Another run asks the helper again, which skips a folder whose mark is complete.
    const again = fakeClient()
    await make(again, { dir: stateDir }).prepare(policy())
    assert.equal(again.calls.label.length, 2)
    assert.equal(again.calls.label[0].options?.ifMissing, true)
  })

  it('refuses a folder that is too broad before it marks anything', async () => {
    const client = fakeClient()
    await assert.rejects(make(client).prepare(policy({ writable: ['C:\\work\\p', 'C:\\Users\\u'] })), (error: unknown) => error instanceof SandboxError && /C:\\Users\\u cannot be prepared/.test(error.message) && /home folder/.test(error.message))
    assert.equal(client.calls.label.length, 0)
  })

  it('says how many items could not be marked', async () => {
    const warnings: string[] = []
    const client = fakeClient({
      async label(_exe, folders) {
        return { ok: true, labeled: [...folders], folders: 1, files: 1, linked: 0, redirected: 0, failed: 3, failures: ['\\\\?\\C:\\work\\p\\locked.db (error 32)'], ms: 1 }
      },
    })
    await make(client, { warn: (message) => warnings.push(message) }).prepare(policy({ writable: ['C:\\work\\p'] }))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^3 items in C:\\work\\p could not be marked for the sandbox \(the first: .*locked\.db \(error 32\)\); commands cannot change them\.$/)
  })

  it('turns a failed walk into a message about the folder', async () => {
    const client = fakeClient({
      async label() {
        throw new SandboxError('failed', 'SetKernelObjectSecurity(\\\\?\\C:\\work\\p) failed: Access is denied. (error 5)')
      },
    })
    await assert.rejects(make(client).prepare(policy()), (error: unknown) => error instanceof SandboxError && /^C:\\work\\p could not be prepared for the sandbox: SetKernelObjectSecurity/.test(error.message))
  })

  it('starts the program through the helper, with the protected paths and the sandbox’s variables', async () => {
    const engine = make(fakeClient())
    await engine.prepare(policy())
    const wrapped = engine.wrap({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoProfile', '-File', 'C:\\t\\1.ps1'], env: { Temp: 'C:\\old', PATH: 'C:\\bin' }, cwd: 'C:\\work\\p' }, policy())
    assert.ok(wrapped.file.endsWith('encode-sandbox.exe'))
    assert.deepEqual(wrapped.args, [
      'run',
      '--cwd',
      'C:\\work\\p',
      '--protect',
      'C:\\work\\p\\.git\\hooks',
      '--protect',
      'C:\\work\\p\\.git\\config',
      '--protect',
      'C:\\work\\p\\.mcp.json',
      '--protect',
      'C:\\elsewhere\\x',
      '--',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '-NoProfile',
      '-File',
      'C:\\t\\1.ps1',
    ])
    assert.equal(wrapped.env.TEMP, `${sandboxDir}\\tmp`)
    assert.equal(wrapped.env.Temp, undefined, 'one variable on Windows, whatever its case')
    assert.equal(wrapped.env.PATH, 'C:\\bin')
    assert.equal(wrapped.cwd, 'C:\\work\\p')
  })

  it('will not start a program before the helper is built', () => {
    assert.throws(() => make(fakeClient()).wrap({ file: 'C:\\x.exe', args: [], env: {}, cwd: 'C:\\work\\p' }, policy()), SandboxError)
  })

  it('says that Git Bash cannot be confined, and PowerShell can', () => {
    const engine = make(fakeClient())
    for (const file of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\SH.EXE']) assert.match(engine.unsupported?.(file) ?? '', /Git Bash cannot run inside the Windows sandbox/)
    for (const file of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe']) assert.equal(engine.unsupported?.(file), undefined)
  })

  it('takes its marks away again, the protected paths included', async () => {
    const client = fakeClient()
    const stateDir = path.join(dir, 'release')
    const engine = make(client, { dir: stateDir })
    await engine.prepare(policy())
    assert.deepEqual(await engine.marked(), ['C:\\work\\p', `${sandboxDir}\\tmp`])
    const released = await engine.release()
    assert.deepEqual(released, ['C:\\work\\p', `${sandboxDir}\\tmp`])
    assert.deepEqual(client.calls.unlabel[0], { folders: ['C:\\work\\p'], protect: ['C:\\work\\p\\.git\\hooks', 'C:\\work\\p\\.git\\config', 'C:\\work\\p\\.mcp.json'] })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).folders, {})
    await engine.prepare(policy())
    assert.equal(client.calls.label.length, 4, 'a folder whose marks were taken away is marked again when it is used')
  })
})

describe('the helper’s answers', () => {
  const node = (script: string) => [process.execPath, ['-e', script]] as const

  it('reads the JSON line and hands progress lines on', async () => {
    const seen: number[] = []
    const [file, args] = node("process.stderr.write('encode-sandbox-progress: 10\\nencode-sandbox-progress: 25\\n'); console.log(JSON.stringify({ ok: true, files: 25 }))")
    const answer = await helperJson<{ ok: boolean; files: number }>(file, args, 20_000, (done) => seen.push(done))
    assert.deepEqual(answer, { ok: true, files: 25 })
    assert.deepEqual(seen, [10, 25])
  })

  it('turns the helper’s failure line into a SandboxError with its words', async () => {
    const [file, args] = node("process.stderr.write('encode-sandbox: Not a folder: C:\\\\x\\n'); process.exit(125)")
    await assert.rejects(helperJson(file, args, 20_000), (error: unknown) => error instanceof SandboxError && error.message === 'Not a folder: C:\\x')
  })

  it('stops a helper that takes too long', async () => {
    const [file, args] = node('setTimeout(() => {}, 60000)')
    await assert.rejects(helperJson(file, args, 300), (error: unknown) => error instanceof SandboxError && /did not finish in 0 seconds|stopped with code null/.test(error.message))
  })

  it('builds the arguments of a run', () => {
    assert.deepEqual(runArguments({}, 'C:\\a.exe', ['x']), ['run', '--', 'C:\\a.exe', 'x'])
    assert.deepEqual(runArguments({ integrity: 'medium', cwd: 'C:\\w', protect: ['C:\\w\\.git\\hooks'] }, 'C:\\a.exe', []), ['run', '--integrity', 'medium', '--cwd', 'C:\\w', '--protect', 'C:\\w\\.git\\hooks', '--', 'C:\\a.exe'])
  })
})
