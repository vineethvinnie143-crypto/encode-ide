/**
 * macOS: Seatbelt through sandbox-exec. Everything is allowed except writing, which is allowed in the policy's
 * folders only; protected paths are denied again after them, and so is renaming away the folders that hold them
 * (the rule is path-based, so a protected path that could be moved aside would not be protected). Unreadable paths
 * are denied for reading, and the network for everything when the policy blocks it. Later rules override earlier ones.
 *
 * Written from the profile language's documentation and not yet run on a Mac: the probe at start-up checks that a
 * write inside is allowed, one outside and one to a protected path are not, and the engine reports itself unavailable
 * otherwise, so a wrong profile costs the sandbox and never blocks the person's commands.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EnginePolicy, EngineProbe, SandboxEngine, SpawnSpec } from './engine'
import { mergeEnv } from './env'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** Temp folders every program on a Mac uses by habit and that are shared anyway. */
const SHARED_TEMP = ['/private/tmp', '/private/var/tmp']
const DEVICES_LITERAL = ['/dev/null', '/dev/zero', '/dev/dtracehelper', '/dev/tty', '/dev/ptmx', '/dev/stdout', '/dev/stderr']
const DEVICES_REGEX = ['^/dev/tty[a-z0-9]*$', '^/dev/ttys[0-9]+$', '^/dev/fd/[0-9]+$', '^/dev/pty[a-z0-9]+$']

function quote(text: string): string {
  if (/[\0\r\n]/.test(text)) throw new Error(`A path with a control character cannot go in a sandbox profile: ${JSON.stringify(text)}`)
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** `subpath` for a folder; `literal` for anything else (a file, a socket), told apart by `isDir`. */
function filter(file: string, isDir: (file: string) => boolean): string {
  return isDir(file) ? `(subpath ${quote(file)})` : `(literal ${quote(file)})`
}

function ancestorsBelow(root: string, file: string): string[] {
  const out: string[] = []
  let dir = path.posix.dirname(file)
  while (dir.length > root.length && dir.startsWith(`${root}/`)) {
    out.push(dir)
    dir = path.posix.dirname(dir)
  }
  return out
}

export function seatbeltProfile(policy: EnginePolicy, isDir: (file: string) => boolean = defaultIsDir): string {
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)']
  const allowed = [...policy.writable.map((folder) => `(subpath ${quote(folder)})`), ...SHARED_TEMP.map((folder) => `(subpath ${quote(folder)})`)]
  allowed.push(...DEVICES_LITERAL.map((device) => `(literal ${quote(device)})`), ...DEVICES_REGEX.map((pattern) => `(regex #${quote(pattern)})`))
  lines.push(`(allow file-write*\n  ${allowed.join('\n  ')})`)
  if (policy.protected.length) {
    lines.push(`(deny file-write*\n  ${policy.protected.map((item) => filter(item, isDir)).join('\n  ')})`)
    // A protected path is only protected where it is: its folders must not be moved aside either.
    const held = new Set<string>()
    for (const item of policy.protected) for (const root of policy.writable) for (const dir of ancestorsBelow(root, item)) held.add(dir)
    if (held.size) lines.push(`(deny file-write-unlink\n  ${[...held].map((dir) => `(literal ${quote(dir)})`).join('\n  ')})`)
  }
  if (policy.unreadable.length) lines.push(`(deny file-read*\n  ${policy.unreadable.map((item) => filter(item, isDir)).join('\n  ')})`)
  if (!policy.network) lines.push('(deny network*)')
  return `${lines.join('\n')}\n`
}

function defaultIsDir(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

export interface MacEngineOptions {
  sandboxExec?: string
}

export function createMacEngine(options: MacEngineOptions = {}): SandboxEngine {
  const exec = options.sandboxExec ?? SANDBOX_EXEC
  return {
    name: 'seatbelt',
    limits: { reads: true, network: true, protectedPaths: 'exact', processes: false },
    async probe(): Promise<EngineProbe> {
      if (!fs.existsSync(exec)) return { ok: false, reason: 'sandbox-exec was not found on this Mac.' }
      const inside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sandbox-probe-')))
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.encode-sandbox-probe-')))
      try {
        fs.mkdirSync(path.join(inside, 'held'))
        const policy: EnginePolicy = { writable: [inside], protected: [path.join(inside, 'held')], unreadable: [], network: true, temp: inside, env: {}, unset: [] }
        const script = [
          `echo ok > ${JSON.stringify(path.join(inside, 'in'))}`,
          `! { echo no > ${JSON.stringify(path.join(outside, 'out'))}; } 2>/dev/null`,
          `! { echo no > ${JSON.stringify(path.join(inside, 'held', 'x'))}; } 2>/dev/null`,
        ].join(' && ')
        const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
          execFile(exec, ['-p', seatbeltProfile(policy), '/bin/sh', '-c', script], { timeout: 15_000, encoding: 'utf8' }, (error, _stdout, stderr) => {
            resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, stderr: String(stderr) })
          })
        })
        if (result.code !== 0) return { ok: false, reason: `Seatbelt failed its test: ${result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.code}`}` }
        if (!fs.existsSync(path.join(inside, 'in'))) return { ok: false, reason: 'Seatbelt started but a command could not write inside the allowed folder.' }
        if (fs.existsSync(path.join(outside, 'out')) || fs.existsSync(path.join(inside, 'held', 'x'))) return { ok: false, reason: 'Seatbelt started but did not stop a write it should have.' }
        return { ok: true }
      } finally {
        fs.rmSync(inside, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
      }
    },
    async prepare(policy) {
      await fs.promises.mkdir(policy.temp, { recursive: true, mode: 0o700 })
    },
    wrap(spec: SpawnSpec, policy: EnginePolicy): SpawnSpec {
      const env = mergeEnv(spec.env, policy.env, policy.unset, 'darwin')
      return { file: exec, args: ['-p', seatbeltProfile(policy), spec.file, ...spec.args], env, cwd: spec.cwd }
    },
  }
}
