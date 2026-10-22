/**
 * Not a test of behaviour but a measurement: which sets of restricting SIDs let the programs an agent runs work
 * (Git Bash, PowerShell, node, cmd) while keeping writes inside the folders that were granted. It runs only on
 * Windows with ENCODE_SANDBOX_EXPLORE=1 (the sandbox workflow sets it) and prints a table. Its answers decided
 * the SIDs in driver.ts; it stays so that a Windows update that changes them is seen.
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
}

const VARIANTS: Variant[] = [
  { name: 'S', extra: [] },
  { name: 'S+E', extra: ['everyone'] },
  { name: 'S+E+U', extra: ['everyone', 'users'] },
  { name: 'S+E+U+R', extra: ['everyone', 'users', 'restricted'] },
  { name: 'S+E+L', extra: ['everyone', 'logon'] },
  { name: 'S+E+U+R+L', extra: ['everyone', 'users', 'restricted', 'logon'] },
  { name: 'S+E detached', extra: ['everyone'], console: 'detached' },
  { name: 'S+E nolua', extra: ['everyone'], lua: false },
]

interface Context {
  root: string
  temp: string
  outside: Record<string, string>
  bash?: string
  powershell: string
  cmd: string
  node: string
  victim: number
  port: number
}

interface Probe {
  name: string
  expect: 'allow' | 'deny'
  program: (ctx: Context) => string | undefined
  args: (ctx: Context) => string[]
  /** For allow: the effect must be there. For deny: it must not be. */
  effect?: (ctx: Context) => boolean
  /** Probes after the first of a kind are skipped when the first failed. */
  basic?: boolean
}

const win = (file: string) => file.replace(/\//g, '\\')
const posix = (file: string) => file.replace(/\\/g, '/')

const PROBES: Probe[] = [
  { name: 'bash echo', expect: 'allow', basic: true, program: (c) => c.bash, args: () => ['-c', 'echo hello-from-bash'] },
  { name: 'bash > /dev/null', expect: 'allow', program: (c) => c.bash, args: () => ['-c', 'echo x > /dev/null; echo after-null'] },
  { name: 'bash pipe', expect: 'allow', program: (c) => c.bash, args: () => ['-c', 'echo abc | tr a-z A-Z | cat'] },
  { name: 'bash background + wait', expect: 'allow', program: (c) => c.bash, args: () => ['-c', 'sleep 1 & wait; echo waited'] },
  { name: 'bash write new in root', expect: 'allow', program: (c) => c.bash, args: (c) => ['-c', `echo data > '${posix(c.root)}/new.txt'`], effect: (c) => fs.existsSync(path.join(c.root, 'new.txt')) },
  {
    name: 'bash append existing in root',
    expect: 'allow',
    program: (c) => c.bash,
    args: (c) => ['-c', `echo more >> '${posix(c.root)}/sub/deep/existing.txt'`],
    effect: (c) => fs.readFileSync(path.join(c.root, 'sub', 'deep', 'existing.txt'), 'utf8').includes('more'),
  },
  { name: 'bash delete in root', expect: 'allow', program: (c) => c.bash, args: (c) => ['-c', `rm '${posix(c.root)}/to-delete.txt'`], effect: (c) => !fs.existsSync(path.join(c.root, 'to-delete.txt')) },
  { name: 'bash mkdir + rename in root', expect: 'allow', program: (c) => c.bash, args: (c) => ['-c', `mkdir '${posix(c.root)}/d1' && echo z > '${posix(c.root)}/d1/f' && mv '${posix(c.root)}/d1' '${posix(c.root)}/d2'`], effect: (c) => fs.existsSync(path.join(c.root, 'd2', 'f')) },
  { name: 'bash mktemp (TEMP granted)', expect: 'allow', program: (c) => c.bash, args: () => ['-c', 'f=$(mktemp) && echo ok > "$f" && cat "$f"'] },
  {
    name: 'git init, add, commit in root',
    expect: 'allow',
    program: (c) => c.bash,
    args: (c) => ['-c', `cd '${posix(c.root)}' && git init -q . && git add new.txt && git -c user.email=a@b.c -c user.name=n commit -qm one && git log --oneline | wc -l`],
    effect: (c) => fs.existsSync(path.join(c.root, '.git', 'HEAD')),
  },
  { name: 'bash write .git/hooks (protected)', expect: 'deny', program: (c) => c.bash, args: (c) => ['-c', `echo x > '${posix(c.root)}/.git/hooks/pre-commit'`], effect: (c) => fs.existsSync(path.join(c.root, '.git', 'hooks', 'pre-commit')) },
  { name: 'bash write .git/config (protected)', expect: 'deny', program: (c) => c.bash, args: (c) => ['-c', `echo '[alias]' >> '${posix(c.root)}/.git/config'`], effect: (c) => fs.readFileSync(path.join(c.root, '.git', 'config'), 'utf8').includes('[alias]') },
  ...['temp', 'profile', 'public', 'cdrive'].map(
    (where): Probe => ({
      name: `bash write outside (${where})`,
      expect: 'deny',
      program: (c) => c.bash,
      args: (c) => ['-c', `echo x > '${posix(c.outside[where])}/escaped.txt'`],
      effect: (c) => fs.existsSync(path.join(c.outside[where], 'escaped.txt')),
    }),
  ),
  { name: 'ps echo', expect: 'allow', basic: true, program: (c) => c.powershell, args: () => ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', 'Write-Output hello-from-ps'] },
  {
    name: 'ps write in root',
    expect: 'allow',
    program: (c) => c.powershell,
    args: (c) => ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', `Set-Content -Path '${win(c.root)}\\ps.txt' -Value hi`],
    effect: (c) => fs.existsSync(path.join(c.root, 'ps.txt')),
  },
  {
    name: 'ps write outside (profile)',
    expect: 'deny',
    program: (c) => c.powershell,
    args: (c) => ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', `Set-Content -Path '${win(c.outside.profile)}\\ps-escaped.txt' -Value hi`],
    effect: (c) => fs.existsSync(path.join(c.outside.profile, 'ps-escaped.txt')),
  },
  { name: 'cmd > NUL', expect: 'allow', basic: true, program: (c) => c.cmd, args: () => ['/d', '/c', 'echo hi > NUL && echo after-nul'] },
  { name: 'cmd registry write HKCU', expect: 'deny', program: (c) => c.cmd, args: () => ['/d', '/c', 'reg add HKCU\\Software\\EncodeSandboxProbe /v x /d 1 /f'] },
  { name: 'node write in root', expect: 'allow', basic: true, program: (c) => c.node, args: (c) => ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(c.root, 'n.txt'))}, 'x')`], effect: (c) => fs.existsSync(path.join(c.root, 'n.txt')) },
  {
    name: 'node write outside (profile)',
    expect: 'deny',
    program: (c) => c.node,
    args: (c) => ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(c.outside.profile, 'n-escaped.txt'))}, 'x')`],
    effect: (c) => fs.existsSync(path.join(c.outside.profile, 'n-escaped.txt')),
  },
  {
    name: 'node child_process + loopback socket',
    expect: 'allow',
    program: (c) => c.node,
    args: (c) => [
      '-e',
      `const n=require('net');const s=n.connect(${c.port},'127.0.0.1',()=>{s.end();console.log(require('child_process').execSync('echo child-ok').toString().trim())});s.on('error',(e)=>{console.log('socket '+e.message);process.exit(3)})`,
    ],
  },
  { name: 'kill a program outside', expect: 'deny', program: (c) => c.cmd, args: (c) => ['/d', '/c', `taskkill /F /PID ${c.victim}`], effect: (c) => !alive(c.victim) },
  { name: 'cmd npm --version', expect: 'allow', program: (c) => c.cmd, args: () => ['/d', '/c', 'npm --version'] },
]

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findBash(): string | undefined {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[]
  for (const dir of dirs) {
    const candidate = path.join(dir, 'Git', 'bin', 'bash.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
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

function exec(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: unknown }).code as number | null) ?? null : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

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
    const outside: Record<string, string> = {
      temp: fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sbx-out-')),
      profile: fs.mkdtempSync(path.join(os.homedir(), 'encode-sbx-out-')),
      public: fs.mkdtempSync(path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'encode-sbx-out-')),
      cdrive: path.join(process.env.SystemDrive ?? 'C:', `\\encode-sbx-out-${randomInt(1e6)}`),
    }
    try {
      fs.mkdirSync(outside.cdrive)
    } catch (error) {
      say(`could not make a folder in the drive root (${(error as Error).message}); that probe is moot`)
      outside.cdrive = outside.temp
    }
    for (const dir of Object.values(outside)) cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    const server = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    cleanup.push(() => server.close())
    const victim: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
    cleanup.push(() => victim.kill())

    const whoami = await exec('whoami', ['/groups', '/fo', 'csv', '/nh'], 20_000)
    say(`token groups (whoami): ${whoami.out.split(/\r?\n/).map((line) => line.split(',')[0]).join(' | ').slice(0, 600)}`)
    const elevated = await exec('whoami', ['/priv', '/fo', 'csv', '/nh'], 20_000)
    say(`privileges: ${elevated.out.split(/\r?\n/).length} listed`)

    const probe = await probeHelper(build.exe, { restrict: [sid, 'everyone'] })
    say(`probe: ${JSON.stringify(probe)}`)

    // Grant, with timing; and a big tree for the cost of propagation.
    const git = await exec('git', ['init', '-q', root], 30_000)
    say(`git init for the fixture: ${git.code}`)
    const protect = [path.join(root, '.git', 'hooks'), path.join(root, '.git', 'config')]
    const started = Date.now()
    const granted = await grantFolder(build.exe, sid, root, protect)
    say(`grant on a small tree: ${JSON.stringify(granted)} wall=${Date.now() - started}ms`)
    const icacls = await exec('icacls', [path.join(root, 'sub', 'deep', 'existing.txt')], 20_000)
    say(`icacls of a pre-existing nested file: ${icacls.out.replace(/\r?\n/g, ' ; ').slice(0, 500)}`)
    const hooks = await exec('icacls', [path.join(root, '.git', 'hooks')], 20_000)
    say(`icacls of .git/hooks: ${hooks.out.replace(/\r?\n/g, ' ; ').slice(0, 600)}`)

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
      powershell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      cmd: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      node: process.execPath,
      victim: victim.pid!,
      port: (server.address() as net.AddressInfo).port,
    }
    say(`bash=${ctx.bash ?? 'none'}`)

    const table: string[][] = [['probe', ...VARIANTS.map((variant) => variant.name)]]
    const detail: string[] = []
    const dead = new Set<string>()
    for (const probeDef of PROBES) {
      const row = [`${probeDef.name} [${probeDef.expect}]`]
      for (const variant of VARIANTS) {
        const program = probeDef.program(ctx)
        if (!program) {
          row.push('n/a')
          continue
        }
        const key = `${variant.name}|${probeDef.name.split(' ')[0]}`
        if (dead.has(key) && !probeDef.basic) {
          row.push('skip')
          continue
        }
        if (probeDef.name === 'kill a program outside' && !alive(ctx.victim)) {
          const again = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
          cleanup.push(() => again.kill())
          ctx.victim = again.pid!
        }
        const flags: RunFlags = { restrict: [sid, ...variant.extra], ...(variant.console ? { console: variant.console } : {}), ...(variant.lua === false ? { lua: false } : {}) }
        const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
        const began = Date.now()
        const done = await new Promise<{ code: number | null; out: string }>((resolve) =>
          execFile(build.exe, runArguments(flags, program, probeDef.args(ctx)), { windowsHide: true, timeout: 20_000, encoding: 'utf8', env, cwd: root }, (error, stdout, stderr) => {
            resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, out: `${stdout}${stderr}`.trim() })
          }),
        )
        const took = Date.now() - began
        const effect = probeDef.effect ? probeDef.effect(ctx) : undefined
        let cell: string
        if (probeDef.expect === 'allow') {
          const good = done.code === 0 && effect !== false
          cell = good ? 'ok' : done.code === null ? 'TIMEOUT' : `FAIL(${done.code}${effect === false ? ',no effect' : ''})`
          if (!good && probeDef.basic) dead.add(key)
        } else {
          // A denied action: it must not have taken effect. (No `effect` for a command like reg add: use the exit code.)
          const escaped = effect === undefined ? done.code === 0 : effect
          cell = escaped ? 'ESCAPED' : 'denied'
        }
        row.push(cell)
        if (cell !== 'ok' && cell !== 'denied') detail.push(`${variant.name} / ${probeDef.name}: code=${done.code} ${took}ms :: ${done.out.replace(/\s+/g, ' ').slice(0, 220)}`)
        if (probeDef.expect === 'deny' && effect) {
          for (const dir of Object.values(outside)) for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true, recursive: true })
          fs.rmSync(path.join(root, '.git', 'hooks', 'pre-commit'), { force: true })
        }
        if (probeDef.expect === 'allow' && probeDef.name === 'bash delete in root') fs.writeFileSync(path.join(root, 'to-delete.txt'), 'bye')
        if (probeDef.name === 'bash mkdir + rename in root') fs.rmSync(path.join(root, 'd2'), { recursive: true, force: true })
      }
      table.push(row)
    }
    const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)))
    for (const row of table) say(row.map((cell, column) => cell.padEnd(widths[column])).join(' | '))
    for (const line of detail) say(`detail: ${line}`)

    // The cost of starting a program through the helper.
    const times: number[] = []
    for (let i = 0; i < 8; i++) {
      const began = Date.now()
      await runHelper(build.exe, runArguments({ restrict: [sid, 'everyone'] }, ctx.cmd, ['/d', '/c', 'exit 0']), 20_000)
      times.push(Date.now() - began)
    }
    say(`start-up through the helper (cmd /c exit): ${times.join(', ')} ms`)

    const out = process.env.ENCODE_SANDBOX_EXPLORE_OUT
    if (out) fs.writeFileSync(out, lines.join('\n'))
    assert.ok(table.length > 1)
  })
})
