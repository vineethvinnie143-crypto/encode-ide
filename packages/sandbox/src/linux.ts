/**
 * Linux: bubblewrap. The command sees the whole file system read-only, with the policy's writable folders mounted
 * read-write over it, the protected paths read-only again, the unreadable ones replaced by nothing, a private /tmp,
 * its own process and IPC namespaces (so what it started dies with it and it cannot signal anything else), and
 * optionally no network. Mounts are not permissions: a protected path cannot be replaced or removed either.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EnginePolicy, EngineProbe, SandboxEngine, SpawnSpec } from './engine'
import { mergeEnv } from './env'

export interface LinuxEngineOptions {
  /** Full path of bwrap. Default: looked for in PATH and the usual folders. */
  bwrap?: string
  /** What a path is; for tests. */
  stat?(file: string): 'dir' | 'file' | 'other' | undefined
  env?: Record<string, string | undefined>
}

const USUAL = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/run/current-system/sw/bin/bwrap']

export function findBwrap(env: Record<string, string | undefined> = process.env): string | undefined {
  const candidates = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'bwrap')), ...USUAL]
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (path.isAbsolute(candidate)) return candidate
    } catch {
      // next
    }
  }
  return undefined
}

function defaultStat(file: string): 'dir' | 'file' | 'other' | undefined {
  try {
    const stat = fs.statSync(file)
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'
  } catch {
    return undefined
  }
}

/** The bubblewrap arguments for a policy, up to (not including) the program. */
export function bwrapArguments(policy: EnginePolicy, cwd: string, stat: LinuxEngineOptions['stat'] = defaultStat): string[] {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try']
  if (!policy.network) args.push('--unshare-net')
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp')
  // Hidden before the writable folders are mounted: a writable folder that lies inside a hidden one is the person's choice.
  for (const hidden of policy.unreadable) {
    const kind = stat(hidden)
    if (kind === 'dir') args.push('--tmpfs', hidden)
    else if (kind === 'file' || kind === 'other') args.push('--ro-bind', '/dev/null', hidden)
  }
  for (const folder of policy.writable) args.push('--bind-try', folder, folder)
  for (const item of policy.protected) args.push('--ro-bind-try', item, item)
  for (const name of policy.unset) args.push('--unsetenv', name)
  args.push('--chdir', cwd)
  return args
}

function reasonFor(stderr: string): string {
  const text = stderr.trim().split(/\r?\n/).pop() ?? ''
  if (/uid map|Operation not permitted|setting up uid|No permissions to create/i.test(text)) {
    return `bubblewrap cannot create a sandbox here (${text}). The kernel or the distribution restricts unprivileged user namespaces; on Ubuntu 24.04 and later allow it with "sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0", or install an AppArmor profile for bwrap.`
  }
  return `bubblewrap failed its test: ${text || 'no output'}`
}

export function createLinuxEngine(options: LinuxEngineOptions = {}): SandboxEngine {
  const bwrap = options.bwrap ?? findBwrap(options.env)
  return {
    name: 'bubblewrap',
    limits: { reads: true, network: true, protectedPaths: 'exact', processes: true },
    async probe(): Promise<EngineProbe> {
      if (!bwrap) return { ok: false, reason: 'bubblewrap (bwrap) is not installed. Install the "bubblewrap" package to run commands in a sandbox.' }
      const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sandbox-probe-'))
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-sandbox-probe-'))
      try {
        const policy: EnginePolicy = { writable: [inside], protected: [], unreadable: [], network: true, temp: inside, env: {}, unset: [] }
        const script = `echo ok > ${JSON.stringify(path.join(inside, 'in'))} && ! { echo no > ${JSON.stringify(path.join(outside, 'out'))}; } 2>/dev/null`
        const args = [...bwrapArguments(policy, '/', options.stat), '--', '/bin/sh', '-c', script]
        const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
          execFile(bwrap, args, { timeout: 15_000, encoding: 'utf8' }, (error, _stdout, stderr) => {
            resolve({ code: error ? ((error as { code?: unknown }).code as number | null) ?? null : 0, stderr: String(stderr) })
          })
        })
        if (result.code !== 0) return { ok: false, reason: reasonFor(result.stderr) }
        if (!fs.existsSync(path.join(inside, 'in'))) return { ok: false, reason: 'bubblewrap started but a command could not write inside the allowed folder.' }
        if (fs.existsSync(path.join(outside, 'out'))) return { ok: false, reason: 'bubblewrap started but did not stop a write outside the allowed folders.' }
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
      if (!bwrap) throw new Error('bubblewrap is not available')
      const env = mergeEnv(spec.env, policy.env, policy.unset, 'linux')
      return { file: bwrap, args: [...bwrapArguments(policy, spec.cwd, options.stat), '--', spec.file, ...spec.args], env, cwd: spec.cwd }
    },
  }
}
