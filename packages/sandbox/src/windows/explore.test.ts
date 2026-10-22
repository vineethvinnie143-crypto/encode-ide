/**
 * Not a test of behaviour but a measurement: which sets of restricting SIDs let the programs an agent runs work
 * (PowerShell, node, cmd, git, and Git Bash to show that it cannot) while keeping writes inside the folders that
 * were granted. It runs only on Windows with ENCODE_SANDBOX_EXPLORE=1 (the sandbox workflow sets it) and prints a
 * table. Its answers decided the SIDs in engine.ts and that Git Bash is not run in the sandbox; it stays so that a
 * Windows update that changes them is seen.
 */
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { ensureHelper, type HelperBuild } from './build'
import { grantFolder, probeHelper, runArguments, runHelper, type RunFlags } from './client'

const explore = process.platform === 'win32' && process.env.ENCODE_SANDBOX_EXPLORE === '1'

interface Variant {
  name: string
  extra: string[]
  console?: RunFlags['console']
  lua?: boolean
  /** Run the program as it is, with no helper: shows that the probes themselves work and what a program can do unconfined. */
  direct?: boolean
  /** Only the probes marked `basic`. */
  basicOnly?: boolean
}

const VARIANTS: Variant[] = [
  { name: 'none', extra: [], direct: true },
  { name: 'S+E+U+R', extra: ['everyone', 'users', 'restricted'] },
  { name: 'S+E+L', extra: ['everyone', 'logon'] },
  { name: 'S+L', extra: ['logon'] },
  { name: 'S+E+R+L', extra: ['everyone', 'restricted', 'logon'] },
  { name: 'S+E+L detached', extra: ['everyone', 'logon'], console: 'detached', basicOnly: true },
  { name: 'S+E+L nolua', extra: ['everyone', 'logon'], lua: false, basicOnly: true },
]

const WHERE = ['temp', 'profile', 'public', 'cdrive', 'wintemp', 'programdata'] as const

interface Context {
  root: string
  temp: string
  outside: Record<string, string>
  bash?: string
  ps5: string
  ps7?: string
  cmd: string
  node: string
  victim: number
  port: number
  startup: string
}

type Program = 'ps' | 'ps5' | 'cmd' | 'node' | 'bash'

interface Probe {
  name: string
  expect: 'allow' | 'deny' | 'info'
  program: Program
  args: (ctx: Context) => string[]
  /** For allow: the effect must be there. For deny: it must not be. */
  effect?: (ctx: Context) => boolean | Promise<boolean>
  /** The output must match (allow). */
  contains?: RegExp
  /** Run for every variant, also the ones that only get the basic probes. After the first of a kind that failed, the others of that program are skipped. */
  basic?: boolean
  /** Put the world in the state the probe needs, before it runs. */
  before?: (ctx: Context) => void | Promise<void>
  /** Take away what the probe left, after it ran. */
  after?: (ctx: Context) => void | Promise<void>
}

const win = (file: string) => file.replace(/\//g, '\\')
const posix = (file: string) => file.replace(/\\/g, '/')
/** A PowerShell string. */
const q = (text: string) => `'${text.replace(/'/g, "''")}'`
const PS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command']
const ps = (command: string) => [...PS, command]
const rm = (...files: string[]) => {
  for (const file of files) fs.rmSync(file, { force: true, recursive: true })
}
const exists = (file: string) => fs.existsSync(file)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function registryKeyExists(): Promise<boolean> {
  return (await exec('reg', ['query', 'HKCU\\Software\\EncodeSandboxProbe'], 20_000)).code === 0
}

async function taskExists(): Promise<boolean> {
  return (await exec('schtasks', ['/query', '/tn', 'EncodeSandboxProbe'], 20_000)).code === 0
}

function buildProbes(): Probe[] {
  const probes: Probe[] = [
    { name: 'bash echo', expect: 'info', basic: true, program: 'bash', args: () => ['-c', 'echo hello-from-bash'], contains: /hello-from-bash/ },
    { name: 'ps echo', expect: 'allow', basic: true, program: 'ps', args: () => ps('Write-Output hello-from-ps'), contains: /hello-from-ps/ },
    { name: 'ps5 echo', expect: 'allow', basic: true, program: 'ps5', args: () => ps('Write-Output hello-from-ps5'), contains: /hello-from-ps5/ },
    { name: 'cmd > NUL', expect: 'allow', basic: true, program: 'cmd', args: () => ['/d', '/c', 'echo hi > NUL && echo after-nul'], contains: /after-nul/ },
    {
      name: 'node write in root',
      expect: 'allow',
      basic: true,
      program: 'node',
      args: (c) => ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(c.root, 'n.txt'))}, 'x')`],
      before: (c) => rm(path.join(c.root, 'n.txt')),
      effect: (c) => exists(path.join(c.root, 'n.txt')),
    },
    {
      name: 'ps write in root',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Set-Content -Path ${q(path.join(c.root, 'ps.txt'))} -Value hi -ErrorAction Stop`),
      before: (c) => rm(path.join(c.root, 'ps.txt')),
      effect: (c) => exists(path.join(c.root, 'ps.txt')),
    },
    {
      name: 'ps append to a file that was there',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Add-Content -Path ${q(path.join(c.root, 'sub', 'deep', 'existing.txt'))} -Value more -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.root, 'sub', 'deep', 'existing.txt'), 'before\n'),
      effect: (c) => fs.readFileSync(path.join(c.root, 'sub', 'deep', 'existing.txt'), 'utf8').includes('more'),
    },
    {
      name: 'ps delete in root',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Remove-Item -Path ${q(path.join(c.root, 'to-delete.txt'))} -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.root, 'to-delete.txt'), 'bye'),
      effect: (c) => !exists(path.join(c.root, 'to-delete.txt')),
    },
    {
      name: 'ps mkdir + rename in root',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`$d = ${q(path.join(c.root, 'd1'))}; New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null; Set-Content -Path (Join-Path $d 'f') -Value z -ErrorAction Stop; Rename-Item -Path $d -NewName d2 -ErrorAction Stop`),
      before: (c) => rm(path.join(c.root, 'd1'), path.join(c.root, 'd2')),
      effect: (c) => exists(path.join(c.root, 'd2', 'f')),
      after: (c) => rm(path.join(c.root, 'd1'), path.join(c.root, 'd2')),
    },
    {
      name: 'ps write in TEMP (granted)',
      expect: 'allow',
      program: 'ps',
      args: () => ps(`$f = Join-Path $env:TEMP 'psprobe.txt'; Set-Content -Path $f -Value ok -ErrorAction Stop; Get-Content -Path $f`),
      before: (c) => rm(path.join(c.temp, 'psprobe.txt')),
      effect: (c) => exists(path.join(c.temp, 'psprobe.txt')),
    },
    { name: 'ps runs cmd', expect: 'allow', program: 'ps', args: () => ps('cmd /c echo nested-cmd-ok'), contains: /nested-cmd-ok/ },
    {
      name: 'ps runs node (writes in root)',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Set-Location ${q(c.root)}; node probe-write.js`),
      before: (c) => {
        fs.writeFileSync(path.join(c.root, 'probe-write.js'), "require('fs').writeFileSync('nested.txt', 'x'); console.log('nested-node-ok')")
        rm(path.join(c.root, 'nested.txt'))
      },
      effect: (c) => exists(path.join(c.root, 'nested.txt')),
      contains: /nested-node-ok/,
    },
    { name: 'ps runs npm --version', expect: 'allow', program: 'ps', args: () => ps('npm --version'), contains: /^\d+\.\d+/m },
    { name: 'ps runs git --version', expect: 'allow', program: 'ps', args: () => ps('git --version'), contains: /git version/ },
    {
      name: 'ps git add + commit in root',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Set-Location ${q(c.root)}; git add new-base.txt; git -c user.email=a@b.c -c user.name=n commit -qm one; git log --oneline`),
      effect: (c) => exists(path.join(c.root, '.git', 'HEAD')),
      contains: /\bone\b/,
    },
    {
      name: 'ps git commit with a pre-commit hook',
      expect: 'info',
      program: 'ps',
      args: (c) => ps(`Set-Location ${q(c.root)}; git -c user.email=a@b.c -c user.name=n commit --allow-empty -qm two; Write-Output ('exit=' + $LASTEXITCODE)`),
      before: (c) => fs.writeFileSync(path.join(c.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook > hook-ran.txt\n'),
      after: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit'), path.join(c.root, 'hook-ran.txt')),
    },
    {
      name: 'ps write .git/hooks (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Set-Content -Path ${q(path.join(c.root, '.git', 'hooks', 'pre-commit'))} -Value x -ErrorAction Stop`),
      before: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      effect: (c) => exists(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      after: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit')),
    },
    {
      name: 'ps write .git/config (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Add-Content -Path ${q(path.join(c.root, '.git', 'config'))} -Value '[alias]' -ErrorAction Stop`),
      effect: (c) => fs.readFileSync(path.join(c.root, '.git', 'config'), 'utf8').includes('[alias]'),
    },
    ...WHERE.map(
      (where): Probe => ({
        name: `ps write outside (${where})`,
        expect: 'deny',
        program: 'ps',
        args: (c) => ps(`Set-Content -Path ${q(path.join(c.outside[where], 'escaped.txt'))} -Value x -ErrorAction Stop`),
        before: (c) => rm(path.join(c.outside[where], 'escaped.txt')),
        effect: (c) => exists(path.join(c.outside[where], 'escaped.txt')),
        after: (c) => rm(path.join(c.outside[where], 'escaped.txt')),
      }),
    ),
    {
      name: 'ps delete a file outside',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Remove-Item -Path ${q(path.join(c.outside.profile, 'keep.txt'))} -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.outside.profile, 'keep.txt'), 'keep'),
      effect: (c) => !exists(path.join(c.outside.profile, 'keep.txt')),
    },
    {
      name: 'ps write in the Startup folder',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Set-Content -Path ${q(path.join(c.startup, 'encode-probe.txt'))} -Value x -ErrorAction Stop`),
      before: (c) => rm(path.join(c.startup, 'encode-probe.txt')),
      effect: (c) => exists(path.join(c.startup, 'encode-probe.txt')),
      after: (c) => rm(path.join(c.startup, 'encode-probe.txt')),
    },
    {
      name: 'ps registry write HKCU',
      expect: 'deny',
      program: 'ps',
      args: () => ps("New-Item -Path 'HKCU:\\Software\\EncodeSandboxProbe' -Force -ErrorAction Stop | Out-Null"),
      effect: () => registryKeyExists(),
      after: async () => void (await exec('reg', ['delete', 'HKCU\\Software\\EncodeSandboxProbe', '/f'], 20_000)),
    },
    {
      name: 'ps scheduled task',
      expect: 'deny',
      program: 'ps',
      args: () => ps('schtasks /create /tn EncodeSandboxProbe /tr "cmd /c echo x" /sc once /st 23:59 /f'),
      effect: () => taskExists(),
      after: async () => void (await exec('schtasks', ['/delete', '/tn', 'EncodeSandboxProbe', '/f'], 20_000)),
    },
    {
      name: 'ps stop a program outside',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Stop-Process -Id ${c.victim} -Force -ErrorAction Stop`),
      effect: (c) => !alive(c.victim),
    },
    {
      name: 'ps loopback socket',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`$c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', ${c.port}); $c.Close(); Write-Output loopback-ok`),
      contains: /loopback-ok/,
    },
    {
      name: 'cmd copy outside',
      expect: 'deny',
      program: 'cmd',
      args: (c) => ['/d', '/c', `copy /y "${win(path.join(c.root, 'new-base.txt'))}" "${win(path.join(c.outside.profile, 'cmd-escaped.txt'))}"`],
      before: (c) => rm(path.join(c.outside.profile, 'cmd-escaped.txt')),
      effect: (c) => exists(path.join(c.outside.profile, 'cmd-escaped.txt')),
      after: (c) => rm(path.join(c.outside.profile, 'cmd-escaped.txt')),
    },
    { name: 'cmd npm --version', expect: 'allow', program: 'cmd', args: () => ['/d', '/c', 'npm --version'], contains: /^\d+\.\d+/m },
    {
      name: 'node write outside (profile)',
      expect: 'deny',
      program: 'node',
      args: (c) => ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(c.outside.profile, 'n-escaped.txt'))}, 'x')`],
      before: (c) => rm(path.join(c.outside.profile, 'n-escaped.txt')),
      effect: (c) => exists(path.join(c.outside.profile, 'n-escaped.txt')),
      after: (c) => rm(path.join(c.outside.profile, 'n-escaped.txt')),
    },
    {
      name: 'node starts cmd and node',
      expect: 'allow',
      program: 'node',
      args: () => ['-e', "const cp=require('child_process');console.log(cp.execSync('echo child-ok').toString().trim());console.log(cp.execFileSync(process.execPath,['-e','console.log(\"grandchild-ok\")']).toString().trim())"],
      contains: /child-ok[\s\S]*grandchild-ok/,
    },
    {
      name: 'node loopback socket',
      expect: 'allow',
      program: 'node',
      args: (c) => ['-e', `const n=require('net');const s=n.connect(${c.port},'127.0.0.1',()=>{s.end();console.log('loopback-ok')});s.on('error',(e)=>{console.log('socket '+e.message);process.exit(3)})`],
      contains: /loopback-ok/,
    },
    { name: 'cmd registry write HKCU', expect: 'deny', program: 'cmd', args: () => ['/d', '/c', 'reg add HKCU\\Software\\EncodeSandboxProbe /v x /d 1 /f'], effect: () => registryKeyExists(), after: async () => void (await exec('reg', ['delete', 'HKCU\\Software\\EncodeSandboxProbe', '/f'], 20_000)) },
  ]
  return probes
}

function findBash(): string | undefined {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[]
  for (const dir of dirs) {
    const candidate = path.join(dir, 'Git', 'bin', 'bash.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function findPwsh(): string | undefined {
  const candidate = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  return fs.existsSync(candidate) ? candidate : undefined
}

function randomSid(): string {
  return `S-1-5-21-${[randomInt(1, 2 ** 31 - 1), randomInt(1, 2 ** 31 - 1), randomInt(1, 2 ** 31 - 1)].join('-')}-${randomInt(1000, 9999)}`
}

function tree(root: string, dirs: number, filesPerDir: number): number {
  let count = 0
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `d${d % 40}`, `e${d}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < filesPerDir; f++) {
      fs.writeFileSync(path.join(dir, `f${f}.txt`), 'content')
      count++
    }
  }
  return count
}

function exec(file: string, args: string[], timeoutMs: number, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

describe('which restricting SIDs keep the agent’s programs working (Windows, explore)', { skip: !explore }, () => {
  const cleanup: Array<() => void> = []
  after(() => {
    for (const run of cleanup.reverse()) {
      try {
        run()
      } catch {
        // best effort
      }
    }
  })

  it('measures', { timeout: 25 * 60_000 }, async () => {
    const lines: string[] = []
    const say = (text: string) => {
      lines.push(text)
      console.log(`[explore] ${text}`)
    }

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sbx-'))
    cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }))
    const build: HelperBuild = await ensureHelper({ cacheDir: path.join(base, 'helper') })
    say(`helper built=${build.built} at ${build.exe}`)

    const sid = randomSid()
    const root = path.join(base, 'workspace')
    const temp = path.join(base, 'sandbox-temp')
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true })
    fs.mkdirSync(temp, { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'deep', 'existing.txt'), 'before\n')
    fs.writeFileSync(path.join(root, 'to-delete.txt'), 'bye')
    fs.writeFileSync(path.join(root, 'new-base.txt'), 'base')
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const drive = process.env.SystemDrive ?? 'C:'
    const outside: Record<string, string> = {
      temp: fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sbx-out-')),
      profile: fs.mkdtempSync(path.join(os.homedir(), 'encode-sbx-out-')),
      public: fs.mkdtempSync(path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'encode-sbx-out-')),
      cdrive: path.join(drive, `\\encode-sbx-out-${randomInt(1e6)}`),
      wintemp: path.join(system, 'Temp', `encode-sbx-out-${randomInt(1e6)}`),
      programdata: path.join(process.env.ProgramData ?? 'C:\\ProgramData', `encode-sbx-out-${randomInt(1e6)}`),
    }
    for (const where of ['cdrive', 'wintemp', 'programdata']) {
      try {
        fs.mkdirSync(outside[where])
      } catch (error) {
        say(`could not make a folder for ${where} (${(error as Error).message}); that probe is moot`)
        outside[where] = outside.temp
      }
    }
    for (const dir of new Set(Object.values(outside))) cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    // The server end of a connection that the other end resets is a normal thing here; it must not end the run.
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined)
      socket.end()
    })
    server.on('error', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    cleanup.push(() => server.close())
    const newVictim = (): ChildProcess => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
      child.unref()
      cleanup.push(() => child.kill())
      return child
    }
    let victim = newVictim()

    const whoami = await exec('whoami', ['/groups', '/fo', 'csv', '/nh'], 20_000)
    say(`token groups (whoami): ${whoami.out.split(/\r?\n/).map((line) => line.split(',')[0]).join(' | ').slice(0, 600)}`)
    const startup = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    fs.mkdirSync(startup, { recursive: true })

    for (const flags of [{ restrict: [sid, 'everyone', 'logon'] }, { restrict: [sid, 'logon'], lua: false }]) {
      say(`probe ${JSON.stringify(flags)}: ${JSON.stringify(await probeHelper(build.exe, flags))}`)
    }

    // Grant, with timing; and a big tree for the cost of propagation.
    const git = await exec('git', ['init', '-q', root], 30_000)
    say(`git init for the fixture: ${git.code}`)
    const protect = [path.join(root, '.git', 'hooks'), path.join(root, '.git', 'config')]
    const started = Date.now()
    const granted = await grantFolder(build.exe, sid, root, protect)
    say(`grant on a small tree: ${JSON.stringify(granted)} wall=${Date.now() - started}ms`)
    const granted2 = await grantFolder(build.exe, sid, temp, [])
    say(`grant on the temp folder: ${JSON.stringify(granted2)}`)
    for (const [label, target] of [
      ['a pre-existing nested file', path.join(root, 'sub', 'deep', 'existing.txt')],
      ['.git/hooks', path.join(root, '.git', 'hooks')],
      ['C:\\Users\\Public', process.env.PUBLIC ?? 'C:\\Users\\Public'],
      ['C:\\Windows\\Temp', path.join(system, 'Temp')],
      ['C:\\ProgramData', process.env.ProgramData ?? 'C:\\ProgramData'],
      [`${drive}\\`, `${drive}\\`],
    ]) {
      say(`icacls of ${label}: ${(await exec('icacls', [target], 20_000)).out.replace(/\s*\r?\n\s*/g, ' ; ').replace(/\s+/g, ' ').slice(0, 700)}`)
    }

    const big = path.join(base, 'big')
    fs.mkdirSync(big)
    const t0 = Date.now()
    const files = tree(big, 400, 50)
    say(`made a tree of ${files} files in ${Date.now() - t0}ms`)
    const t1 = Date.now()
    const bigGrant = await grantFolder(build.exe, sid, big, [])
    say(`grant on ${files} files: helper says ${bigGrant.ms}ms, wall ${Date.now() - t1}ms`)

    const ctx: Context = {
      root,
      temp,
      outside,
      bash: findBash(),
      ps5: path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ps7: findPwsh(),
      cmd: path.join(system, 'System32', 'cmd.exe'),
      node: process.execPath,
      victim: victim.pid!,
      port: (server.address() as net.AddressInfo).port,
      startup,
    }
    say(`bash=${ctx.bash ?? 'none'} pwsh7=${ctx.ps7 ?? 'none'}`)
    const programOf = (program: Program): string | undefined =>
      program === 'ps' ? (ctx.ps7 ?? ctx.ps5) : program === 'ps5' ? ctx.ps5 : program === 'cmd' ? ctx.cmd : program === 'node' ? ctx.node : ctx.bash

    const probes = buildProbes()
    const table: string[][] = [['probe', ...VARIANTS.map((variant) => variant.name)]]
    const detail: string[] = []
    const dead = new Set<string>()
    const startupTimes: Record<string, number> = {}
    for (const probe of probes) {
      const row = [`${probe.name} [${probe.expect}]`]
      for (const variant of VARIANTS) {
        const file = programOf(probe.program)
        if (!file) {
          row.push('n/a')
          continue
        }
        if (variant.basicOnly && !probe.basic) {
          row.push('-')
          continue
        }
        const key = `${variant.name}|${probe.program}`
        if (dead.has(key) && !probe.basic) {
          row.push('skip')
          continue
        }
        if (!alive(ctx.victim)) {
          victim = newVictim()
          ctx.victim = victim.pid!
        }
        await probe.before?.(ctx)
        const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
        const began = Date.now()
        const done = variant.direct
          ? await exec(file, probe.args(ctx), 40_000, { cwd: root, env })
          : await exec(
              build.exe,
              runArguments({ restrict: [sid, ...variant.extra], ...(variant.console ? { console: variant.console } : {}), ...(variant.lua === false ? { lua: false } : {}) }, file, probe.args(ctx)),
              40_000,
              { cwd: root, env },
            )
        const took = Date.now() - began
        if (probe.name === 'ps echo' || probe.name === 'ps5 echo') startupTimes[`${probe.name} / ${variant.name}`] = took
        const effect = probe.effect ? await probe.effect(ctx) : undefined
        const matched = probe.contains ? probe.contains.test(done.out) : true
        let cell: string
        if (probe.expect === 'allow') {
          const good = done.code === 0 && effect !== false && matched
          cell = good ? 'ok' : done.code === null ? 'TIMEOUT' : `FAIL(${done.code}${effect === false ? ',no effect' : ''}${matched ? '' : ',output'})`
          if (!good && probe.basic) dead.add(key)
        } else if (probe.expect === 'deny') {
          // A denied action must not have taken effect. Without an `effect` the exit code decides.
          const escaped = effect === undefined ? done.code === 0 : effect
          cell = escaped ? 'ESCAPED' : 'denied'
        } else {
          cell = done.code === 0 && matched ? 'ok' : done.code === null ? 'TIMEOUT' : `FAIL(${done.code})`
          if (cell !== 'ok' && probe.basic) dead.add(key)
        }
        row.push(cell)
        if (cell !== 'ok' && cell !== 'denied') detail.push(`${variant.name} / ${probe.name}: code=${done.code} ${took}ms :: ${done.out.replace(/\s+/g, ' ').slice(0, 260)}`)
        await probe.after?.(ctx)
        if (probe.name === 'ps delete a file outside') rm(path.join(outside.profile, 'keep.txt'))
      }
      table.push(row)
    }
    const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)))
    for (const row of table) say(row.map((cell, column) => cell.padEnd(widths[column])).join(' | '))
    for (const line of detail) say(`detail: ${line}`)
    say(`start-up of PowerShell through the helper, one run each: ${JSON.stringify(startupTimes)}`)

    // The cost of starting a program through the helper, against starting it directly.
    const cost = async (label: string, file: string, args: string[]) => {
      const direct: number[] = []
      const wrapped: number[] = []
      for (let i = 0; i < 5; i++) {
        let began = Date.now()
        await exec(file, args, 40_000, { cwd: root })
        direct.push(Date.now() - began)
        began = Date.now()
        await exec(build.exe, runArguments({ restrict: [sid, 'everyone', 'logon'] }, file, args), 40_000, { cwd: root })
        wrapped.push(Date.now() - began)
      }
      say(`start-up ${label}: direct median ${median(direct)}ms (${direct.join(',')}), through the helper median ${median(wrapped)}ms (${wrapped.join(',')})`)
    }
    await cost('cmd /c exit', ctx.cmd, ['/d', '/c', 'exit 0'])
    await cost('node -e 0', ctx.node, ['-e', '0'])
    await cost('powershell 5.1 -Command exit', ctx.ps5, ps('exit 0'))
    if (ctx.ps7) await cost('pwsh 7 -Command exit', ctx.ps7, ps('exit 0'))

    // What the job object does: nothing a command left running outlives it.
    const flags: RunFlags = { restrict: [sid, 'everyone', 'logon'] }
    const spawnedPid = path.join(root, 'grandchild.pid')
    rm(spawnedPid)
    const leaver = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(${JSON.stringify(spawnedPid)},String(c.pid));c.unref()`
    await exec(build.exe, runArguments(flags, ctx.node, ['-e', leaver]), 40_000, { cwd: root })
    const grandchild = Number(fs.existsSync(spawnedPid) ? fs.readFileSync(spawnedPid, 'utf8') : 0)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    say(`a program left running by a command that ended: pid ${grandchild || 'unknown'} ${grandchild ? (alive(grandchild) ? 'STILL RUNNING' : 'was ended with the command') : ''}`)
    if (grandchild && alive(grandchild)) process.kill(grandchild)

    rm(spawnedPid)
    const longRunner = `require('fs').writeFileSync(${JSON.stringify(spawnedPid)},String(process.pid));setInterval(()=>{},1000)`
    const helperProcess = spawn(build.exe, runArguments(flags, ctx.node, ['-e', longRunner]), { cwd: root, stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 50 && !fs.existsSync(spawnedPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    const running = Number(fs.existsSync(spawnedPid) ? fs.readFileSync(spawnedPid, 'utf8') : 0)
    helperProcess.kill()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    say(`a command whose helper was killed: pid ${running || 'unknown'} ${running ? (alive(running) ? 'STILL RUNNING' : 'ended with the helper') : ''}`)
    if (running && alive(running)) process.kill(running)

    const out = process.env.ENCODE_SANDBOX_EXPLORE_OUT
    if (out) fs.writeFileSync(out, lines.join('\n'))
    assert.ok(table.length > 1)
  })
})
