/**
 * The Windows engine as the shell uses it, on a real Windows (skipped elsewhere): the helper is built, a project is
 * marked, and programs started through `wrap` may change the project but not what is around it, nor git's hooks and
 * configuration and eNCode's settings inside it. What a command started does not outlive it.
 */
import assert from 'node:assert/strict'
import { execFile, type ExecFileOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { EnginePolicy } from '../engine'
import { buildPolicy } from '../policy'
import { defaultIo } from '../sandbox'
import { DEFAULT_SETTINGS } from '../settings'
import { readLabels } from './client'
import { createWindowsEngine, type WindowsEngine } from './engine'

const windows = process.platform === 'win32'

interface Ran {
  code: number | null
  out: string
}

function exec(file: string, args: readonly string[], options: ExecFileOptions = {}, timeoutMs = 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/** A PowerShell string. */
const q = (text: string) => `'${text.replace(/'/g, "''")}'`
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the Windows sandbox, end to end', { skip: !windows }, () => {
  let base = ''
  let project = ''
  let outside = ''
  let engine: WindowsEngine
  let policy: EnginePolicy
  let powershell = ''
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const cmd = path.join(system, 'System32', 'cmd.exe')

  /** Runs a program the way the shell does: rewritten by the engine, in the project. */
  const run = (file: string, args: readonly string[], cwd = project, using = policy) => {
    const spec = engine.wrap({ file, args: [...args], env: { ...(process.env as Record<string, string>) }, cwd }, using)
    return exec(spec.file, spec.args, { cwd: spec.cwd, env: spec.env })
  }
  const ps = (command: string, cwd = project, using = policy) => run(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command], cwd, using)
  const read = (file: string) => fs.readFileSync(file, 'utf8')

  before(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-win-it-')))
    project = path.join(base, 'project')
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'a.txt'), 'a\n')
    assert.equal((await exec('git', ['init', '-q', project])).code, 0)
    fs.mkdirSync(path.join(project, '.encode'))
    fs.writeFileSync(path.join(project, '.encode', 'settings.json'), '{}\n')
    fs.writeFileSync(path.join(project, '.mcp.json'), '{}\n')
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), 'encode-win-it-out-')))
    const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    powershell = fs.existsSync(pwsh) ? pwsh : path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

    const dir = path.join(base, 'sandbox')
    engine = createWindowsEngine({ dir })
    policy = buildPolicy({
      platform: 'win32',
      home: os.homedir(),
      roots: [project],
      settings: { ...DEFAULT_SETTINGS, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
      temp: path.join(dir, 'tmp'),
      cacheRoot: path.join(dir, 'cache'),
      env: process.env,
      io: defaultIo,
    })
    fs.mkdirSync(policy.temp, { recursive: true })
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
    const probe = await engine.probe()
    assert.deepEqual(probe, { ok: true }, probe.reason ?? 'the sandbox failed its test')
    const started = Date.now()
    await engine.prepare(policy)
    console.log(`[sandbox] prepared ${policy.writable.length} folders in ${Date.now() - started}ms`)
  })

  after(async () => {
    if (engine) await engine.release().catch((error: Error) => console.log(`[sandbox] release: ${error.message}`))
    await exec('reg', ['delete', 'HKCU\\Software\\EncodeSandboxIt', '/f'])
    fs.rmSync(path.join(os.homedir(), 'encode-it-copied.txt'), { force: true })
    for (const dir of [base, outside]) if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lets a program change the project: write, delete, make folders, rename', { timeout: 120_000 }, async () => {
    const done = await ps(
      `Set-Content -Path src\\new.txt -Value made -ErrorAction Stop; Remove-Item -Path src\\a.txt -ErrorAction Stop; ` +
        `New-Item -ItemType Directory -Path build -ErrorAction Stop | Out-Null; Set-Content -Path build\\x.txt -Value x -ErrorAction Stop; ` +
        `Rename-Item -Path build -NewName dist -ErrorAction Stop; Write-Output done`,
    )
    assert.equal(done.code, 0, done.out)
    assert.equal(read(path.join(project, 'src', 'new.txt')).trim(), 'made')
    assert.ok(!fs.existsSync(path.join(project, 'src', 'a.txt')))
    assert.ok(fs.existsSync(path.join(project, 'dist', 'x.txt')))
  })

  it('runs the shell’s script from the sandbox’s temp folder, which it can write', { timeout: 120_000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(policy.temp, 'encode-shell-'))
    const script = path.join(scratch, '1.ps1')
    fs.writeFileSync(script, "Set-Content -LiteralPath (Join-Path $PSScriptRoot '1.cwd') -Value (Get-Location).Path\nWrite-Output ('temp=' + $env:TEMP)\n")
    const done = await run(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script])
    assert.equal(done.code, 0, done.out)
    assert.equal(read(path.join(scratch, '1.cwd')).trim().toLowerCase(), project.toLowerCase())
    assert.match(done.out, new RegExp(`temp=${policy.temp.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`, 'i'))
  })

  it('lets node, cmd and git work, and a program started by another', { timeout: 120_000 }, async () => {
    const nested = await run(process.execPath, ['-e', "require('child_process').execFileSync(process.execPath, ['-e', \"require('fs').writeFileSync('nested.txt', 'x')\"]); console.log('nested-ok')"])
    assert.equal(nested.code, 0, nested.out)
    assert.ok(fs.existsSync(path.join(project, 'nested.txt')))
    const viaCmd = await run(cmd, ['/d', '/c', 'echo from-cmd> cmd.txt && echo cmd-ok'])
    assert.equal(viaCmd.code, 0, viaCmd.out)
    assert.ok(fs.existsSync(path.join(project, 'cmd.txt')))
    const git = await ps('git add -A; git -c user.email=a@b.c -c user.name=n commit -qm first; git log --oneline')
    assert.equal(git.code, 0, git.out)
    assert.match(git.out, /first/)
  })

  it('keeps writes, deletes and renames out of everything around the project', { timeout: 120_000 }, async () => {
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n')
    const startup = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    fs.mkdirSync(startup, { recursive: true })
    const attempts = [
      `Set-Content -Path ${q(path.join(outside, 'escaped.txt'))} -Value x`,
      `Remove-Item -Path ${q(path.join(outside, 'keep.txt'))} -Force`,
      `Rename-Item -Path ${q(path.join(outside, 'keep.txt'))} -NewName moved.txt`,
      `Set-Content -Path ${q(path.join(startup, 'encode-it.cmd'))} -Value x`,
      "New-Item -Path 'HKCU:\\Software\\EncodeSandboxIt' -Force | Out-Null",
      `Copy-Item -Path src\\new.txt -Destination ${q(path.join(os.homedir(), 'encode-it-copied.txt'))}`,
    ]
    for (const attempt of attempts) await ps(`${attempt} -ErrorAction SilentlyContinue`)
    assert.ok(!fs.existsSync(path.join(outside, 'escaped.txt')))
    assert.equal(read(path.join(outside, 'keep.txt')), 'keep\n')
    assert.ok(!fs.existsSync(path.join(startup, 'encode-it.cmd')))
    assert.notEqual((await exec('reg', ['query', 'HKCU\\Software\\EncodeSandboxIt'])).code, 0)
    assert.ok(!fs.existsSync(path.join(os.homedir(), 'encode-it-copied.txt')))
  })

  it('keeps git’s hooks and configuration and eNCode’s settings as they are, renames and replacements included', { timeout: 180_000 }, async () => {
    const config = read(path.join(project, '.git', 'config'))
    fs.writeFileSync(path.join(project, 'replacement'), '[core]\n\thooksPath = evil\n')
    const attempts: Array<[string, () => boolean]> = [
      ["Set-Content -Path .git\\hooks\\pre-commit -Value 'exit 0'", () => !fs.existsSync(path.join(project, '.git', 'hooks', 'pre-commit'))],
      ["Add-Content -Path .git\\config -Value '[alias]'", () => read(path.join(project, '.git', 'config')) === config],
      ['git config --local core.hooksPath evil', () => read(path.join(project, '.git', 'config')) === config],
      ['Remove-Item -Path .git\\config -Force', () => fs.existsSync(path.join(project, '.git', 'config'))],
      ['Move-Item -Path replacement -Destination .git\\config -Force', () => read(path.join(project, '.git', 'config')) === config],
      ['Rename-Item -Path .git\\hooks -NewName hooks-moved', () => fs.existsSync(path.join(project, '.git', 'hooks')) && !fs.existsSync(path.join(project, '.git', 'hooks-moved'))],
      ['Remove-Item -Path .git\\hooks -Recurse -Force', () => fs.existsSync(path.join(project, '.git', 'hooks'))],
      ['Rename-Item -Path .git -NewName git-moved', () => fs.existsSync(path.join(project, '.git', 'config')) && !fs.existsSync(path.join(project, 'git-moved'))],
      ["Set-Content -Path .encode\\settings.json -Value '{\"sandbox\":{\"enabled\":false}}'", () => read(path.join(project, '.encode', 'settings.json')) === '{}\n'],
      ['Set-Content -Path .encode\\other.json -Value x', () => !fs.existsSync(path.join(project, '.encode', 'other.json'))],
      ['Rename-Item -Path .encode -NewName encode-moved', () => fs.existsSync(path.join(project, '.encode', 'settings.json')) && !fs.existsSync(path.join(project, 'encode-moved'))],
      ['Set-Content -Path .mcp.json -Value x', () => read(path.join(project, '.mcp.json')) === '{}\n'],
      ['Remove-Item -Path .mcp.json -Force', () => fs.existsSync(path.join(project, '.mcp.json'))],
    ]
    const escaped: string[] = []
    for (const [attempt, held] of attempts) {
      const done = await ps(`${attempt} -ErrorAction SilentlyContinue`)
      if (!held()) escaped.push(`${attempt} (${done.out.replace(/\s+/g, ' ').slice(0, 200)})`)
    }
    assert.deepEqual(escaped, [])
    const labels = await readLabels(engine.helperPath()!, [path.join(project, '.git', 'hooks'), path.join(project, '.git', 'config'), path.join(project, '.git'), project])
    console.log(`[sandbox] labels: ${labels.join(' | ')}`)
    assert.match(labels[0], /;NW;;;ME\)/)
    assert.match(labels[1], /;NW;;;ME\)/)
    assert.match(labels[2], /;NW;;;LW\)/)
  })

  it('protects git’s hooks again when they are made anew', { timeout: 120_000 }, async () => {
    // Made again by the person's own programs, the folder takes the low mark of the folder it is in, as one git makes would.
    const hooks = path.join(project, '.git', 'hooks')
    fs.rmSync(hooks, { recursive: true, force: true })
    fs.mkdirSync(hooks)
    const [made] = await readLabels(engine.helperPath()!, [hooks])
    assert.match(made, /;NW;;;LW\)/, made)
    await ps("Set-Content -Path .git\\hooks\\pre-commit -Value 'exit 0' -ErrorAction SilentlyContinue")
    assert.ok(!fs.existsSync(path.join(hooks, 'pre-commit')))
    const [now] = await readLabels(engine.helperPath()!, [hooks])
    assert.match(now, /;NW;;;ME\)/, now)
  })

  it('does not let a hard link make a file outside writable', { timeout: 120_000 }, async () => {
    const linked = path.join(base, 'linked')
    fs.mkdirSync(linked)
    const target = path.join(outside, 'target.txt')
    fs.writeFileSync(target, 'target\n')
    fs.linkSync(target, path.join(linked, 'link.txt'))
    fs.writeFileSync(path.join(linked, 'own.txt'), 'own\n')
    const using = buildPolicy({ platform: 'win32', home: os.homedir(), roots: [linked], settings: { ...DEFAULT_SETTINGS, caches: false, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] }, temp: policy.temp, env: process.env, io: defaultIo })
    await engine.prepare(using)
    const [label] = await readLabels(engine.helperPath()!, [target])
    assert.doesNotMatch(label, /;;;LW\)/, `the file outside was marked: ${label}`)
    await ps('Add-Content -Path link.txt -Value more -ErrorAction SilentlyContinue; Add-Content -Path own.txt -Value more -ErrorAction Stop', linked, using)
    assert.equal(read(target), 'target\n')
    assert.match(read(path.join(linked, 'own.txt')), /more/)
  })

  it('ends what a command left running when it ends', { timeout: 120_000 }, async () => {
    const pidFile = path.join(project, 'left.pid')
    const leaver = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`
    const done = await run(process.execPath, ['-e', leaver])
    assert.equal(done.code, 0, done.out)
    const pid = Number(read(pidFile))
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250)
    const still = alive(pid)
    if (still) process.kill(pid)
    assert.equal(still, false, 'a program a command left running outlived it')
  })

  it('costs little to start a program through it', { timeout: 120_000 }, async () => {
    const times = async (wrapped: boolean) => {
      const out: number[] = []
      for (let i = 0; i < 5; i++) {
        const began = Date.now()
        const done = wrapped ? await run(cmd, ['/d', '/c', 'exit 0']) : await exec(cmd, ['/d', '/c', 'exit 0'], { cwd: project })
        assert.equal(done.code, 0, done.out)
        out.push(Date.now() - began)
      }
      return out.sort((a, b) => a - b)[2]
    }
    const direct = await times(false)
    const confined = await times(true)
    console.log(`[sandbox] cmd /c exit: direct median ${direct}ms, through the helper median ${confined}ms`)
    assert.ok(confined < direct + 1_500, `starting through the helper took ${confined}ms against ${direct}ms`)
  })

  it('takes its marks away again', { timeout: 120_000 }, async () => {
    const spare = path.join(base, 'spare')
    fs.mkdirSync(spare)
    const using = buildPolicy({ platform: 'win32', home: os.homedir(), roots: [spare], settings: { ...DEFAULT_SETTINGS, caches: false, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] }, temp: policy.temp, env: process.env, io: defaultIo })
    await engine.prepare(using)
    assert.equal((await ps('Set-Content -Path one.txt -Value 1 -ErrorAction Stop', spare, using)).code, 0)
    assert.deepEqual(await engine.release([spare]), [spare])
    const [label] = await readLabels(engine.helperPath()!, [spare])
    assert.doesNotMatch(label, /LW/, label)
    await ps('Set-Content -Path two.txt -Value 2 -ErrorAction SilentlyContinue', spare, { ...using, writable: [] })
    assert.ok(!fs.existsSync(path.join(spare, 'two.txt')))
  })
})
