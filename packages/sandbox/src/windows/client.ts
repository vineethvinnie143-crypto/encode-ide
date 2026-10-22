/**
 * Talks to the built helper (encode-sandbox.exe): its answers are one line of JSON, its failures a line on standard
 * error that starts with "encode-sandbox:" and exit code 125. Starting a sandboxed program is not done here but by
 * the shell itself, with the arguments `runArguments` makes (the helper's standard handles are the program's).
 */
import { execFile } from 'node:child_process'
import { SandboxError } from '../errors'

export const HELPER_FAILED = 125

export interface RunFlags {
  /** SIDs or names (everyone, users, restricted, logon, authenticated, interactive) the token is restricted to. */
  restrict: readonly string[]
  /** hidden: a console nobody sees (default); detached: none; inherit: the helper's own. */
  console?: 'hidden' | 'detached' | 'inherit'
  /** Turn administrator groups into deny-only (default true). */
  lua?: boolean
  /** Put the program in a job that kills what it left behind (default true). */
  job?: boolean
  /** Restrict reads as well as writes (an experiment; default false). */
  fullRestriction?: boolean
  cwd?: string
}

/** The helper's arguments to start `file args...` under the restricted token. */
export function runArguments(flags: RunFlags, file: string, args: readonly string[]): string[] {
  const out = ['run']
  for (const sid of flags.restrict) out.push('--restrict', sid)
  if (flags.console && flags.console !== 'hidden') out.push('--console', flags.console)
  if (flags.lua === false) out.push('--no-lua')
  if (flags.job === false) out.push('--no-job')
  if (flags.fullRestriction) out.push('--full-restriction')
  if (flags.cwd) out.push('--cwd', flags.cwd)
  out.push('--', file, ...args)
  return out
}

export interface HelperProbe {
  ok: boolean
  error?: string
  tokenError?: string
  code?: number
  user?: string
  elevated?: boolean
  integrity?: number
  logon?: string
  inJob?: boolean
  version?: string
}

interface Finished {
  code: number | null
  stdout: string
  stderr: string
}

export function runHelper(exe: string, args: readonly string[], timeoutMs: number): Promise<Finished> {
  return new Promise((resolve) => {
    execFile(exe, [...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      const why = error && code === null ? `\n${error.message}` : ''
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + why })
    })
  })
}

/** Runs a helper command whose answer is JSON; a failure is a SandboxError with the helper's own words. */
export async function helperJson<T>(exe: string, args: readonly string[], timeoutMs: number): Promise<T> {
  const done = await runHelper(exe, args, timeoutMs)
  if (done.code !== 0) {
    const line = done.stderr.split(/\r?\n/).find((text) => text.startsWith('encode-sandbox:'))
    throw new SandboxError('failed', line ? line.slice('encode-sandbox:'.length).trim() : `The sandbox helper stopped with code ${done.code}. ${done.stderr.trim().split(/\r?\n/)[0] ?? ''}`.trim())
  }
  try {
    return JSON.parse(done.stdout.trim().split(/\r?\n/).pop() ?? '') as T
  } catch {
    throw new SandboxError('failed', `The sandbox helper answered something unexpected: ${done.stdout.slice(0, 200)}`)
  }
}

export function probeHelper(exe: string, flags: RunFlags, timeoutMs = 20_000): Promise<HelperProbe> {
  const args = ['probe']
  for (const sid of flags.restrict) args.push('--restrict', sid)
  if (flags.console && flags.console !== 'hidden') args.push('--console', flags.console)
  if (flags.lua === false) args.push('--no-lua')
  if (flags.job === false) args.push('--no-job')
  if (flags.fullRestriction) args.push('--full-restriction')
  return helperJson<HelperProbe>(exe, args, timeoutMs)
}

export function grantFolder(exe: string, sid: string, folder: string, protect: readonly string[], timeoutMs = 15 * 60_000): Promise<{ ok: boolean; granted: string[]; ms: number }> {
  const args = ['grant', '--sid', sid, '--path', folder]
  for (const item of protect) args.push('--protect', item)
  return helperJson(exe, args, timeoutMs)
}

export function revokeFolder(exe: string, sid: string, folder: string, protect: readonly string[], timeoutMs = 15 * 60_000): Promise<{ ok: boolean; ms: number }> {
  const args = ['revoke', '--sid', sid, '--path', folder]
  for (const item of protect) args.push('--protect', item)
  return helperJson(exe, args, timeoutMs)
}

export async function foldersWithGrant(exe: string, sid: string, folders: readonly string[], timeoutMs = 60_000): Promise<string[]> {
  if (!folders.length) return []
  const args = ['check', '--sid', sid]
  for (const folder of folders) args.push('--path', folder)
  return (await helperJson<{ present: string[] }>(exe, args, timeoutMs)).present
}
