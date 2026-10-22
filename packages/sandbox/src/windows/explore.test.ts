/**
 * Not a test of behaviour but a measurement: how well the low integrity level keeps writes, deletes and the ending
 * of other programs inside the folders that were labeled low, while the programs an agent runs still work
 * (PowerShell, node, cmd, git, and Git Bash). It runs only on Windows with ENCODE_SANDBOX_EXPLORE=1 (the sandbox
 * workflow sets it) and prints a table. Its answers decided the engine in engine.ts; it stays so that a Windows
 * update that changes them is seen.
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
import { desktopInfo, labelFolder, probeHelper, processSecurity, readLabels, runArguments, unlabelFolder, type RunFlags } from './client'

const explore = process.platform === 'win32' && process.env.ENCODE_SANDBOX_EXPLORE === '1'

type Program = 'ps' | 'ps5' | 'cmd' | 'node' | 'bash'

interface Variant {
  name: string
  /** direct: the program as it is (shows that the probes work and what a program can do unconfined); low: the low integrity level. */
  mode: 'direct' | 'low'
  flags?: Omit<RunFlags, 'restrict' | 'integrity'>
  /** Only the probes of these programs. */
  programs?: Program[]
  /** Git Bash is started through a junction to its folder, which gives the MSYS runtime another installation key. */
  junction?: boolean
  /** A Git Bash of the person's own (not sandboxed) is open while the probes run, as a terminal they have open would be. */
  withBash?: boolean
}

const VARIANTS: Variant[] = [
  { name: 'none', mode: 'direct' },
  { name: 'Low (no bash open)', mode: 'low', programs: ['bash'] },
  { name: 'Low', mode: 'low', withBash: true },
  { name: 'Low junction', mode: 'low', junction: true, withBash: true, programs: ['bash'] },
]

const WHERE = ['temp', 'profile', 'public', 'cdrive', 'wintemp', 'programdata'] as const

interface Context {
  root: string
  temp: string
  outside: Record<string, string>
  junction: string
  bash?: string
  ps5: string
  ps7?: string
  cmd: string
  node: string
  /** A program of the test's own (the elevated runner's level). */
  victim: number
  /** A program at the medium level, as a person's own programs run. */
  victimMedium: number
  port: number
  startup: string
  localLow: string
  /** Puts git's hooks and configuration back as they were, with their labels. */
  restoreProtected: () => Promise<void>
}

interface Probe {
  name: string
  expect: 'allow' | 'deny' | 'info'
  program: Program
  args: (ctx: Context) => string[]
  /** For allow: the effect must be there. For deny: it must not be. */
  effect?: (ctx: Context) => boolean | Promise<boolean>
  /** The output must match (allow). */
  contains?: RegExp
  /** Run for every variant that runs the program. When a probe of a program that is marked basic fails, the other probes of that program are skipped in that variant. */
  basic?: boolean
  /** Put the world in the state the probe needs, before it runs. */
  before?: (ctx: Context) => void | Promise<void>
  /** Take away what the probe left, after it ran. */
  after?: (ctx: Context) => void | Promise<void>
  /** Always print what the program said. */
  show?: boolean
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
  let gitConfig = ''
  let bashCommits = 0
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
      name: 'ps who am i',
      expect: 'info',
      show: true,
      program: 'ps',
      args: () => ps('(whoami /groups | Select-String -Pattern "Mandatory Label|Administrators" | ForEach-Object { $_.Line.Trim() -replace "\\s+", " " }) -join " ; "'),
      contains: /./,
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
      name: 'ps append to a file made after prepare',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Add-Content -Path ${q(path.join(c.root, 'late.txt'))} -Value more -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.root, 'late.txt'), 'late\n'),
      effect: (c) => fs.readFileSync(path.join(c.root, 'late.txt'), 'utf8').includes('more'),
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
      name: 'ps git commit runs a pre-commit hook',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Set-Location ${q(c.root)}; git -c user.email=a@b.c -c user.name=n commit --allow-empty -qm two; Write-Output ('exit=' + $LASTEXITCODE)`),
      before: (c) => {
        rm(path.join(c.root, 'hook-ran.txt'))
        fs.writeFileSync(path.join(c.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook > hook-ran.txt\n')
      },
      effect: (c) => exists(path.join(c.root, 'hook-ran.txt')),
      contains: /exit=0/,
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
      before: (c) => {
        gitConfig ||= fs.readFileSync(path.join(c.root, '.git', 'config'), 'utf8')
        fs.writeFileSync(path.join(c.root, '.git', 'config'), gitConfig)
      },
      effect: (c) => fs.readFileSync(path.join(c.root, '.git', 'config'), 'utf8').includes('[alias]'),
      after: (c) => fs.writeFileSync(path.join(c.root, '.git', 'config'), gitConfig),
    },
    {
      name: 'ps delete .git/config (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Remove-Item -Path ${q(path.join(c.root, '.git', 'config'))} -Force -ErrorAction Stop`),
      effect: (c) => !exists(path.join(c.root, '.git', 'config')),
      after: async (c) => {
        if (!exists(path.join(c.root, '.git', 'config'))) fs.writeFileSync(path.join(c.root, '.git', 'config'), gitConfig)
        await c.restoreProtected()
      },
    },
    {
      name: 'ps replace .git/config by a move (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Move-Item -Path ${q(path.join(c.root, 'cfg-new.txt'))} -Destination ${q(path.join(c.root, '.git', 'config'))} -Force -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.root, 'cfg-new.txt'), '[core]\n\tfoo = bar\n'),
      effect: (c) => !exists(path.join(c.root, '.git', 'config')) || fs.readFileSync(path.join(c.root, '.git', 'config'), 'utf8').includes('foo = bar'),
      after: async (c) => {
        rm(path.join(c.root, 'cfg-new.txt'))
        fs.writeFileSync(path.join(c.root, '.git', 'config'), gitConfig)
        await c.restoreProtected()
      },
    },
    {
      name: 'ps delete a hook (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Remove-Item -Path ${q(path.join(c.root, '.git', 'hooks', 'pre-commit'))} -Force -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n'),
      effect: (c) => !exists(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      after: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit')),
    },
    {
      name: 'ps rename .git/hooks (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Rename-Item -Path ${q(path.join(c.root, '.git', 'hooks'))} -NewName hooks-moved -ErrorAction Stop`),
      effect: (c) => exists(path.join(c.root, '.git', 'hooks-moved')),
      after: async (c) => {
        if (exists(path.join(c.root, '.git', 'hooks-moved'))) {
          rm(path.join(c.root, '.git', 'hooks'))
          fs.renameSync(path.join(c.root, '.git', 'hooks-moved'), path.join(c.root, '.git', 'hooks'))
        }
        await c.restoreProtected()
      },
    },
    {
      name: 'ps delete and recreate .git/hooks (protected)',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`$h = ${q(path.join(c.root, '.git', 'hooks'))}; Remove-Item -Path $h -Recurse -Force -ErrorAction Stop; New-Item -ItemType Directory -Path $h | Out-Null; Set-Content -Path (Join-Path $h 'pre-commit') -Value x -ErrorAction Stop`),
      effect: (c) => exists(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      after: async (c) => {
        // What a command that got this far left behind is taken away, and the samples are made again.
        rm(path.join(c.root, '.git', 'hooks'))
        fs.mkdirSync(path.join(c.root, '.git', 'hooks'), { recursive: true })
        fs.writeFileSync(path.join(c.root, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n')
        await c.restoreProtected()
      },
    },
    {
      name: 'ps append to a file moved in from outside',
      expect: 'info',
      program: 'ps',
      args: (c) => ps(`Add-Content -Path ${q(path.join(c.root, 'moved-in.txt'))} -Value more -ErrorAction Stop`),
      before: (c) => {
        fs.writeFileSync(path.join(c.outside.profile, 'moved-in.txt'), 'moved\n')
        rm(path.join(c.root, 'moved-in.txt'))
        fs.renameSync(path.join(c.outside.profile, 'moved-in.txt'), path.join(c.root, 'moved-in.txt'))
      },
      after: (c) => rm(path.join(c.root, 'moved-in.txt')),
    },
    {
      name: 'ps append through a hard link to a file outside',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Add-Content -Path ${q(path.join(c.root, 'hl.txt'))} -Value more -ErrorAction Stop`),
      before: (c) => {
        rm(path.join(c.outside.profile, 'hl-target.txt'), path.join(c.root, 'hl.txt'))
        fs.writeFileSync(path.join(c.outside.profile, 'hl-target.txt'), 'target\n')
        fs.linkSync(path.join(c.outside.profile, 'hl-target.txt'), path.join(c.root, 'hl.txt'))
      },
      effect: (c) => fs.readFileSync(path.join(c.outside.profile, 'hl-target.txt'), 'utf8').includes('more'),
      after: (c) => rm(path.join(c.outside.profile, 'hl-target.txt'), path.join(c.root, 'hl.txt')),
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
      name: 'ps write through a junction in root',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Set-Content -Path ${q(path.join(c.root, 'jx', 'escaped.txt'))} -Value x -ErrorAction Stop`),
      before: (c) => rm(path.join(c.junction, 'escaped.txt')),
      effect: (c) => exists(path.join(c.junction, 'escaped.txt')),
      after: (c) => rm(path.join(c.junction, 'escaped.txt')),
    },
    {
      name: 'ps write in LocalLow',
      expect: 'info',
      program: 'ps',
      args: (c) => ps(`Set-Content -Path ${q(path.join(c.localLow, 'encode-probe.txt'))} -Value x -ErrorAction Stop`),
      before: (c) => rm(path.join(c.localLow, 'encode-probe.txt')),
      after: (c) => rm(path.join(c.localLow, 'encode-probe.txt')),
    },
    {
      name: 'ps delete a file outside',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Remove-Item -Path ${q(path.join(c.outside.profile, 'keep.txt'))} -ErrorAction Stop`),
      before: (c) => fs.writeFileSync(path.join(c.outside.profile, 'keep.txt'), 'keep'),
      effect: (c) => !exists(path.join(c.outside.profile, 'keep.txt')),
      after: (c) => rm(path.join(c.outside.profile, 'keep.txt')),
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
      name: 'ps dns lookup',
      expect: 'allow',
      program: 'ps',
      args: () => ps("Write-Output ('addresses=' + [System.Net.Dns]::GetHostAddresses('registry.npmjs.org').Count)"),
      contains: /addresses=[1-9]/,
    },
    { name: 'npm view (network, cache redirected)', expect: 'allow', program: 'ps', args: () => ps('npm view left-pad@1.3.0 version'), contains: /1\.3\.0/ },
    {
      name: 'npm install in root',
      expect: 'allow',
      program: 'ps',
      args: (c) => ps(`Set-Location ${q(c.root)}; npm install --no-audit --no-fund --ignore-scripts left-pad@1.3.0 2>&1 | Select-Object -Last 3`),
      before: (c) => {
        fs.writeFileSync(path.join(c.root, 'package.json'), '{"name":"probe","version":"1.0.0"}')
        rm(path.join(c.root, 'node_modules'), path.join(c.root, 'package-lock.json'))
      },
      effect: (c) => exists(path.join(c.root, 'node_modules', 'left-pad', 'package.json')),
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
      name: 'ps stop a medium program',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`Stop-Process -Id ${c.victimMedium} -Force -ErrorAction Stop`),
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'ps5 stop a medium program',
      expect: 'deny',
      program: 'ps5',
      args: (c) => ps(`Stop-Process -Id ${c.victimMedium} -Force -ErrorAction Stop`),
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'ps taskkill a medium program',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`taskkill /F /PID ${c.victimMedium}`),
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'ps .NET Kill() of a medium program',
      expect: 'deny',
      program: 'ps',
      args: (c) => ps(`[System.Diagnostics.Process]::GetProcessById(${c.victimMedium}).Kill()`),
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'ps open a medium program to end it',
      expect: 'info',
      show: true,
      program: 'ps',
      args: (c) =>
        ps(
          `Add-Type -Namespace P -Name N -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr OpenProcess(uint a, bool b, uint c);'; ` +
            `$h = [P.N]::OpenProcess(1, $false, ${c.victimMedium}); Write-Output ('terminate handle=' + $h + ' error=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); ` +
            `$h = [P.N]::OpenProcess(0x1000, $false, ${c.victimMedium}); Write-Output ('query handle=' + $h)`,
        ),
      contains: /terminate handle/,
    },
    {
      name: 'cmd taskkill a medium program',
      expect: 'deny',
      program: 'cmd',
      args: (c) => ['/d', '/c', `taskkill /F /PID ${c.victimMedium}`],
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'node kill a medium program',
      expect: 'deny',
      program: 'node',
      args: (c) => ['-e', `try { process.kill(${c.victimMedium}, 'SIGKILL'); console.log('killed') } catch (e) { console.log('kill ' + e.code) }`],
      effect: (c) => !alive(c.victimMedium),
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
      name: 'node starts node only',
      expect: 'allow',
      program: 'node',
      args: () => ['-e', "const cp=require('child_process');console.log(cp.execFileSync(process.execPath,['-e','console.log(\"grandchild-ok\")']).toString().trim())"],
      contains: /grandchild-ok/,
    },
    {
      name: 'ps named pipe server',
      expect: 'info',
      show: true,
      program: 'ps',
      args: () => ps("$p = New-Object System.IO.Pipes.NamedPipeServerStream('encode-probe-' + $PID); $p.Dispose(); Write-Output 'pipe-ok'"),
      contains: /pipe-ok/,
    },
    {
      name: 'node named pipe server',
      expect: 'info',
      show: true,
      program: 'node',
      args: () => ['-e', `const s=require('net').createServer();s.on('error',(e)=>{console.log('pipe '+e.code);process.exit(2)});s.listen(${JSON.stringify('\\\\.\\pipe\\encode-probe-')}+process.pid,()=>{console.log('pipe-ok');process.exit(0)})`],
      contains: /pipe-ok/,
    },
    {
      name: 'node spawnSync with stdio ignore',
      expect: 'info',
      show: true,
      program: 'node',
      args: () => ['-e', "const r=require('child_process').spawnSync(process.execPath,['-e','0'],{stdio:'ignore'});console.log(r.error?'spawn '+r.error.code:'spawn-ok status='+r.status)"],
      contains: /spawn-ok/,
    },
    {
      name: 'node spawnSync with stdio inherit',
      expect: 'info',
      show: true,
      program: 'node',
      args: () => ['-e', "const r=require('child_process').spawnSync(process.execPath,['-e','0'],{stdio:'inherit'});console.log(r.error?'spawn '+r.error.code:'spawn-ok status='+r.status)"],
      contains: /spawn-ok/,
    },
    {
      name: 'node spawn with pipes',
      expect: 'info',
      show: true,
      program: 'node',
      args: () => ['-e', "const c=require('child_process').spawn(process.execPath,['-e','console.log(1)']);c.on('error',(e)=>console.log('spawn '+e.code));c.stdout.on('data',(d)=>console.log('spawn-ok '+String(d).trim()))"],
      contains: /spawn-ok/,
    },
    {
      name: 'node loopback socket',
      expect: 'allow',
      program: 'node',
      args: (c) => ['-e', `const n=require('net');const s=n.connect(${c.port},'127.0.0.1',()=>{s.end();console.log('loopback-ok')});s.on('error',(e)=>{console.log('socket '+e.message);process.exit(3)})`],
      contains: /loopback-ok/,
    },
    { name: 'cmd registry write HKCU', expect: 'deny', program: 'cmd', args: () => ['/d', '/c', 'reg add HKCU\\Software\\EncodeSandboxProbe /v x /d 1 /f'], effect: () => registryKeyExists(), after: async () => void (await exec('reg', ['delete', 'HKCU\\Software\\EncodeSandboxProbe', '/f'], 20_000)) },

    // Git Bash: what the agent writes by default.
    {
      name: 'bash write in root',
      expect: 'allow',
      program: 'bash',
      args: (c) => ['-c', `echo x > '${posix(path.join(c.root, 'b.txt'))}'`],
      before: (c) => rm(path.join(c.root, 'b.txt')),
      effect: (c) => exists(path.join(c.root, 'b.txt')),
    },
    {
      name: 'bash git add + commit in root',
      expect: 'allow',
      program: 'bash',
      args: (c) => ['-c', `cd '${posix(c.root)}' && echo y${bashCommits} > b2-${bashCommits}.txt && git add b2-${bashCommits}.txt && git -c user.email=a@b.c -c user.name=n commit -qm three-${bashCommits} && git log --oneline | head -1`],
      before: () => void bashCommits++,
      contains: /three-\d+/,
    },
    {
      name: 'bash git commit runs a pre-commit hook',
      expect: 'allow',
      program: 'bash',
      args: (c) => ['-c', `cd '${posix(c.root)}' && git -c user.email=a@b.c -c user.name=n commit --allow-empty -qm four; echo exit=$?`],
      before: (c) => {
        rm(path.join(c.root, 'hook-ran.txt'))
        fs.writeFileSync(path.join(c.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook > hook-ran.txt\n')
      },
      effect: (c) => exists(path.join(c.root, 'hook-ran.txt')),
      contains: /exit=0/,
      after: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit'), path.join(c.root, 'hook-ran.txt')),
    },
    {
      name: 'bash runs node and cmd',
      expect: 'allow',
      program: 'bash',
      args: () => ['-c', 'node -e "console.log(\'nested-node-ok\')" && cmd //c echo nested-cmd-ok'],
      contains: /nested-node-ok[\s\S]*nested-cmd-ok/,
    },
    {
      name: 'bash write outside (profile)',
      expect: 'deny',
      program: 'bash',
      args: (c) => ['-c', `echo x > '${posix(path.join(c.outside.profile, 'b-escaped.txt'))}'`],
      before: (c) => rm(path.join(c.outside.profile, 'b-escaped.txt')),
      effect: (c) => exists(path.join(c.outside.profile, 'b-escaped.txt')),
      after: (c) => rm(path.join(c.outside.profile, 'b-escaped.txt')),
    },
    {
      name: 'bash delete a file outside',
      expect: 'deny',
      program: 'bash',
      args: (c) => ['-c', `rm -f '${posix(path.join(c.outside.profile, 'keep-b.txt'))}'`],
      before: (c) => fs.writeFileSync(path.join(c.outside.profile, 'keep-b.txt'), 'keep'),
      effect: (c) => !exists(path.join(c.outside.profile, 'keep-b.txt')),
      after: (c) => rm(path.join(c.outside.profile, 'keep-b.txt')),
    },
    {
      name: 'bash stop a program outside',
      expect: 'deny',
      program: 'bash',
      args: (c) => ['-c', `taskkill //F //PID ${c.victim}`],
      effect: (c) => !alive(c.victim),
    },
    {
      name: 'bash stop a medium program',
      expect: 'deny',
      program: 'bash',
      args: (c) => ['-c', `taskkill //F //PID ${c.victimMedium}`],
      effect: (c) => !alive(c.victimMedium),
    },
    {
      name: 'bash write .git/hooks (protected)',
      expect: 'deny',
      program: 'bash',
      args: (c) => ['-c', `echo x > '${posix(path.join(c.root, '.git', 'hooks', 'pre-commit'))}'`],
      before: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      effect: (c) => exists(path.join(c.root, '.git', 'hooks', 'pre-commit')),
      after: (c) => rm(path.join(c.root, '.git', 'hooks', 'pre-commit')),
    },
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
const flat = (text: string, max = 700) => text.replace(/\s*\r?\n\s*/g, ' ; ').replace(/\s+/g, ' ').slice(0, max)

describe('what keeps the programs of an agent working and its writes inside the labeled folders (Windows, explore)', { skip: !explore }, () => {
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
    const failure = (error: Error) => ({ error: error.message })

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sbx-'))
    cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }))
    const build: HelperBuild = await ensureHelper({ cacheDir: path.join(base, 'helper') })
    say(`helper built=${build.built} at ${build.exe}`)

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

    // A junction inside the folder that leads out of it, made before the folder is prepared.
    const junction = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sbx-jx-'))
    cleanup.push(() => fs.rmSync(junction, { recursive: true, force: true }))
    fs.symlinkSync(junction, path.join(root, 'jx'), 'junction')
    const localLow = path.join(os.homedir(), 'AppData', 'LocalLow')
    fs.mkdirSync(localLow, { recursive: true })

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
    // A program at the medium level, as a person's own programs run, started through the helper.
    const mediumPidFile = path.join(base, 'medium-victim.pid')
    const newMediumVictim = async (): Promise<number> => {
      rm(mediumPidFile)
      const script = `require('fs').writeFileSync(${JSON.stringify(mediumPidFile)}, String(process.pid)); setTimeout(() => {}, 600000)`
      const holder = spawn(build.exe, runArguments({ restrict: [], integrity: 'medium' }, process.execPath, ['-e', script]), { stdio: 'ignore', windowsHide: true })
      holder.unref()
      cleanup.push(() => holder.kill())
      for (let i = 0; i < 50 && !fs.existsSync(mediumPidFile); i++) await new Promise((resolve) => setTimeout(resolve, 200))
      const pid = Number(fs.existsSync(mediumPidFile) ? fs.readFileSync(mediumPidFile, 'utf8') : 0)
      assert.ok(pid > 0, 'the program at the medium level did not start')
      return pid
    }
    let victimMedium = await newMediumVictim()

    const whoami = await exec('whoami', ['/groups', '/fo', 'csv', '/nh'], 20_000)
    say(`token groups (whoami): ${whoami.out.split(/\r?\n/).map((line) => line.split(',')[0]).join(' | ').slice(0, 600)}`)
    const startup = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    fs.mkdirSync(startup, { recursive: true })

    for (const flags of [{ restrict: [], integrity: 'low' as const }, { restrict: [], integrity: 'medium' as const }]) {
      say(`probe ${JSON.stringify(flags)}: ${JSON.stringify(await probeHelper(build.exe, flags).catch(failure))}`)
    }
    for (const line of await processSecurity(build.exe, [victim.pid!, victimMedium]).catch((error: Error) => [`could not read the security of the programs: ${error.message}`])) say(`process ${line}`)

    // Label the folders, with timing; and a big tree for the cost of propagation.
    const git = await exec('git', ['init', '-q', root], 30_000)
    say(`git init for the fixture: ${git.code}`)
    const protect = [path.join(root, '.git', 'hooks'), path.join(root, '.git', 'config')]
    const labelStarted = Date.now()
    say(`label on a small tree: ${JSON.stringify(await labelFolder(build.exe, root, protect).catch(failure))} wall=${Date.now() - labelStarted}ms`)
    say(`label on the temp folder: ${JSON.stringify(await labelFolder(build.exe, temp, []).catch(failure))}`)
    const sample = [root, path.join(root, 'sub'), path.join(root, 'sub', 'deep', 'existing.txt'), path.join(root, '.git'), path.join(root, '.git', 'hooks'), path.join(root, '.git', 'hooks', 'pre-commit.sample'), path.join(root, '.git', 'config'), path.join(root, '.git', 'HEAD'), path.join(root, 'jx'), junction, temp, outside.profile]
    for (const line of await readLabels(build.exe, sample).catch((error: Error) => [`could not read the labels: ${error.message}`])) say(`label of ${line}`)

    // A hard link from the folder to a file outside it: labeling the folder labels the file wherever it is linked.
    const hardTarget = path.join(outside.profile, 'hl-label-target.txt')
    fs.writeFileSync(hardTarget, 'target\n')
    fs.linkSync(hardTarget, path.join(root, 'hl-label.txt'))
    say(`label of the target of a hard link before the folder is labeled again: ${(await readLabels(build.exe, [hardTarget]).catch((error: Error) => [error.message])).join(' ')}`)
    await labelFolder(build.exe, root, protect).catch(failure)
    say(`label of the target of a hard link after: ${(await readLabels(build.exe, [hardTarget]).catch((error: Error) => [error.message])).join(' ')}`)
    rm(hardTarget, path.join(root, 'hl-label.txt'))

    const big = path.join(base, 'big')
    fs.mkdirSync(big)
    const t0 = Date.now()
    const files = tree(big, 400, 50)
    say(`made a tree of ${files} files in ${Date.now() - t0}ms`)
    const deep = path.join(big, 'd7', 'e47', 'f9.txt')
    const t2 = Date.now()
    say(`label on ${files} files: ${JSON.stringify(await labelFolder(build.exe, big, []).catch(failure))}, wall ${Date.now() - t2}ms`)
    say(`label of a file deep in the big tree: ${(await readLabels(build.exe, [deep]).catch((error: Error) => [error.message])).join(' ')}`)
    const t3 = Date.now()
    say(`unlabel on ${files} files: ${JSON.stringify(await unlabelFolder(build.exe, big, []).catch(failure))}, wall ${Date.now() - t3}ms`)

    const restoreProtected = async () => {
      // A command that got past the labels may have changed what is protected; the test puts it back, labels included.
      await labelFolder(build.exe, root, protect)
    }
    const ctx: Context = {
      root,
      temp,
      outside,
      junction,
      bash: findBash(),
      ps5: path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ps7: findPwsh(),
      cmd: path.join(system, 'System32', 'cmd.exe'),
      node: process.execPath,
      victim: victim.pid!,
      victimMedium,
      port: (server.address() as net.AddressInfo).port,
      startup,
      localLow,
      restoreProtected,
    }
    say(`bash=${ctx.bash ?? 'none'} pwsh7=${ctx.ps7 ?? 'none'}`)
    // Git Bash through a junction to the folder it is installed in: the MSYS runtime derives the name of the objects
    // it shares from the path of its own library, so another path is another installation.
    const gitJunction = path.join(base, 'git-junction')
    let bashJunction: string | undefined
    if (ctx.bash) {
      const gitRoot = path.dirname(path.dirname(ctx.bash))
      try {
        fs.symlinkSync(gitRoot, gitJunction, 'junction')
        bashJunction = path.join(gitJunction, 'usr', 'bin', 'bash.exe')
      } catch (error) {
        say(`could not make a junction to ${gitRoot}: ${(error as Error).message}`)
      }
    }
    const programOf = (program: Program, variant: Variant): string | undefined =>
      program === 'ps' ? (ctx.ps7 ?? ctx.ps5) : program === 'ps5' ? ctx.ps5 : program === 'cmd' ? ctx.cmd : program === 'node' ? ctx.node : variant.junction ? bashJunction : ctx.bash

    // A Git Bash the person has open, not sandboxed.
    let openBash: ChildProcess | undefined
    const openGitBash = () => {
      if (openBash || !ctx.bash) return
      openBash = spawn(ctx.bash, ['-c', 'sleep 900'], { stdio: 'ignore', windowsHide: true })
      openBash.unref()
      cleanup.push(() => openBash?.kill())
    }

    const probes = buildProbes()
    const columns: string[][] = []
    const detail: string[] = []
    const startupTimes: Record<string, number> = {}
    for (const variant of VARIANTS) {
      const column: string[] = []
      columns.push(column)
      if (variant.withBash) {
        openGitBash()
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      const dead = new Set<string>()
      for (const probe of probes) {
        const file = programOf(probe.program, variant)
        if (!file) {
          column.push('n/a')
          continue
        }
        if (variant.programs && !variant.programs.includes(probe.program)) {
          column.push('-')
          continue
        }
        if (dead.has(probe.program) && !probe.basic) {
          column.push('skip')
          continue
        }
        if (!alive(ctx.victim)) {
          victim = newVictim()
          ctx.victim = victim.pid!
        }
        if (!alive(ctx.victimMedium)) {
          victimMedium = await newMediumVictim()
          ctx.victimMedium = victimMedium
        }
        await probe.before?.(ctx)
        // As the sandbox sets them: the temp folder and the package caches are inside what the program may write.
        const env: NodeJS.ProcessEnv = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false' }
        if (variant.junction) {
          const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
          env[key] = [path.join(gitJunction, 'mingw64', 'bin'), path.join(gitJunction, 'usr', 'bin'), env[key] ?? ''].join(path.delimiter)
        }
        const began = Date.now()
        const flags: RunFlags = { restrict: [], integrity: 'low', ...variant.flags }
        const done = variant.mode === 'direct' ? await exec(file, probe.args(ctx), 40_000, { cwd: root, env }) : await exec(build.exe, runArguments(flags, file, probe.args(ctx)), 40_000, { cwd: root, env })
        const took = Date.now() - began
        if (probe.name === 'ps echo' || probe.name === 'ps5 echo') startupTimes[`${probe.name} / ${variant.name}`] = took
        const effect = probe.effect ? await probe.effect(ctx) : undefined
        const matched = probe.contains ? probe.contains.test(done.out) : true
        let cell: string
        if (probe.expect === 'allow') {
          const good = done.code === 0 && effect !== false && matched
          cell = good ? 'ok' : done.code === null ? 'TIMEOUT' : `FAIL(${done.code}${effect === false ? ',no effect' : ''}${matched ? '' : ',output'})`
          if (!good && probe.basic) dead.add(probe.program)
        } else if (probe.expect === 'deny') {
          // A denied action must not have taken effect. Without an `effect` the exit code decides.
          const escaped = effect === undefined ? done.code === 0 : effect
          cell = escaped ? 'ESCAPED' : 'denied'
        } else {
          cell = done.code === 0 && matched ? 'ok' : done.code === null ? 'TIMEOUT' : `FAIL(${done.code})`
          if (cell !== 'ok' && probe.basic) dead.add(probe.program)
        }
        column.push(cell)
        if ((cell !== 'ok' && cell !== 'denied') || probe.show) detail.push(`${variant.name} / ${probe.name}: ${cell} code=${done.code} ${took}ms :: ${done.out.replace(/\s+/g, ' ').slice(0, 300)}`)
        await probe.after?.(ctx)
      }
    }
    const table: string[][] = [['probe', ...VARIANTS.map((variant) => variant.name)], ...probes.map((probe, row) => [`${probe.name} [${probe.expect}]`, ...columns.map((column) => column[row])])]
    const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)))
    for (const row of table) say(row.map((cell, column) => cell.padEnd(widths[column])).join(' | '))
    for (const line of detail) say(`detail: ${line}`)
    say(`start-up of PowerShell through the helper, one run each: ${JSON.stringify(startupTimes)}`)

    // The cost of starting a program through the helper, against starting it directly.
    const cost = async (label: string, file: string, args: string[], flags: RunFlags) => {
      const direct: number[] = []
      const wrapped: number[] = []
      for (let i = 0; i < 5; i++) {
        let began = Date.now()
        await exec(file, args, 40_000, { cwd: root })
        direct.push(Date.now() - began)
        began = Date.now()
        await exec(build.exe, runArguments(flags, file, args), 40_000, { cwd: root })
        wrapped.push(Date.now() - began)
      }
      say(`start-up ${label}: direct median ${median(direct)}ms (${direct.join(',')}), through the helper median ${median(wrapped)}ms (${wrapped.join(',')})`)
    }
    const low: RunFlags = { restrict: [], integrity: 'low' }
    await cost('cmd /c exit (Low)', ctx.cmd, ['/d', '/c', 'exit 0'], low)
    await cost('node -e 0 (Low)', ctx.node, ['-e', '0'], low)
    await cost('powershell 5.1 -Command exit (Low)', ctx.ps5, ps('exit 0'), low)
    if (ctx.ps7) await cost('pwsh 7 -Command exit (Low)', ctx.ps7, ps('exit 0'), low)
    if (bashJunction) await cost('bash -c true (Low, through the junction)', bashJunction, ['-c', 'true'], low)

    // What the job object does: nothing a command left running outlives it.
    const spawnedPid = path.join(root, 'grandchild.pid')
    rm(spawnedPid)
    const leaver = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(${JSON.stringify(spawnedPid)},String(c.pid));c.unref()`
    await exec(build.exe, runArguments(low, ctx.node, ['-e', leaver]), 40_000, { cwd: root })
    const grandchild = Number(fs.existsSync(spawnedPid) ? fs.readFileSync(spawnedPid, 'utf8') : 0)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    say(`(Low) a program left running by a command that ended: pid ${grandchild || 'unknown'} ${grandchild ? (alive(grandchild) ? 'STILL RUNNING' : 'was ended with the command') : ''}`)
    if (grandchild && alive(grandchild)) process.kill(grandchild)

    rm(spawnedPid)
    const longRunner = `require('fs').writeFileSync(${JSON.stringify(spawnedPid)},String(process.pid));setInterval(()=>{},1000)`
    const helperProcess = spawn(build.exe, runArguments(low, ctx.node, ['-e', longRunner]), { cwd: root, stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 50 && !fs.existsSync(spawnedPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    const running = Number(fs.existsSync(spawnedPid) ? fs.readFileSync(spawnedPid, 'utf8') : 0)
    helperProcess.kill()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    say(`(Low) a command whose helper was killed: pid ${running || 'unknown'} ${running ? (alive(running) ? 'STILL RUNNING' : 'ended with the helper') : ''}`)
    if (running && alive(running)) process.kill(running)

    // Taking the labels away leaves the folder as it was.
    say(`unlabel: ${JSON.stringify(await unlabelFolder(build.exe, root, protect).catch(failure))}`)
    for (const line of await readLabels(build.exe, [root, path.join(root, 'sub', 'deep', 'existing.txt'), path.join(root, '.git', 'hooks'), path.join(root, '.git', 'config')]).catch((error: Error) => [`could not read the labels: ${error.message}`])) say(`label after unlabel of ${line}`)

    const out = process.env.ENCODE_SANDBOX_EXPLORE_OUT
    if (out) fs.writeFileSync(out, lines.join('\n'))
    assert.ok(table.length > 1)
  })
})
