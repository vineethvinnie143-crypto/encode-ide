/**
 * Talks to the built helper (encode-sandbox.exe): its answers are one line of JSON, its failures a line on standard
 * error that starts with "encode-sandbox:" and exit code 125. Starting a sandboxed program is not done here but by
 * the shell itself, with the arguments `runArguments` makes (the helper's standard handles are the program's).
 */
import { spawn } from 'node:child_process'
import { SandboxError } from '../errors'

export const HELPER_FAILED = 125

const PROGRESS_PREFIX = 'encode-sandbox-progress:'

export interface RunFlags {
  /** `low` (default): the program cannot write, delete or rename what is labeled higher. `medium`: it runs as an ordinary program of the person does (for the measurement). */
  integrity?: 'low' | 'medium'
  cwd?: string
  /** Paths the program may not change: labeled medium, and kept from being renamed or deleted while it runs. Ones that do not exist are skipped. */
  protect?: readonly string[]
}

/** The helper's arguments to start `file args...` at the low integrity level. */
export function runArguments(flags: RunFlags, file: string, args: readonly string[]): string[] {
  const out = ['run']
  if (flags.integrity) out.push('--integrity', flags.integrity)
  if (flags.cwd) out.push('--cwd', flags.cwd)
  for (const item of flags.protect ?? []) out.push('--protect', item)
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

export interface LabelResult {
  ok: boolean
  /** The folders that were marked now (with `ifMissing`, not the ones that already were). */
  labeled: string[]
  folders: number
  files: number
  /** Files with more than one link, left as they are: a hard link is how a package manager shares a file with the outside. */
  linked: number
  /** Junctions and symbolic links, not followed. */
  redirected: number
  /** Items that could not be marked (in use, or owned by another account). */
  failed: number
  failures: string[]
  ms: number
}

export interface LabelOptions {
  /** Skip a folder that was marked completely before. */
  ifMissing?: boolean
  /** Items marked so far, about once a second. */
  onProgress?(done: number): void
  timeoutMs?: number
}

export interface Finished {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs the helper to the end. Lines of progress on standard error go to `onProgress` and are not part of `stderr`. */
export function runHelper(exe: string, args: readonly string[], timeoutMs: number, onProgress?: (done: number) => void): Promise<Finished> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let pending = ''
    let settled = false
    let child: ReturnType<typeof spawn>
    const finish = (value: Finished) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish({ code: null, stdout, stderr: `${stderr}\nThe sandbox helper did not finish in ${Math.round(timeoutMs / 1000)} seconds.` })
    }, timeoutMs)
    timer.unref()
    try {
      child = spawn(exe, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ code: null, stdout, stderr: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      stdout += text
      if (stdout.length > 8 * 1024 * 1024) child.kill()
    })
    const line = (text: string) => {
      if (text.startsWith(PROGRESS_PREFIX)) {
        const done = Number(text.slice(PROGRESS_PREFIX.length).trim())
        if (Number.isFinite(done)) onProgress?.(done)
      } else if (text) {
        stderr += `${text}\n`
      }
    }
    child.stderr?.on('data', (text: string) => {
      pending += text
      let at = pending.indexOf('\n')
      while (at >= 0) {
        line(pending.slice(0, at).replace(/\r$/, ''))
        pending = pending.slice(at + 1)
        at = pending.indexOf('\n')
      }
    })
    child.once('error', (error) => finish({ code: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once('close', (code) => {
      line(pending.replace(/\r$/, ''))
      finish({ code, stdout, stderr })
    })
  })
}

/** Runs a helper command whose answer is JSON; a failure is a SandboxError with the helper's own words. */
export async function helperJson<T>(exe: string, args: readonly string[], timeoutMs: number, onProgress?: (done: number) => void): Promise<T> {
  const done = await runHelper(exe, args, timeoutMs, onProgress)
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

export function probeHelper(exe: string, timeoutMs = 20_000): Promise<HelperProbe> {
  return helperJson<HelperProbe>(exe, ['probe'], timeoutMs)
}

/** What the engine asks of the helper; tests give it another. */
export interface HelperClient {
  probe(exe: string): Promise<HelperProbe>
  label(exe: string, folders: readonly string[], protect: readonly string[], options?: LabelOptions): Promise<LabelResult>
  unlabel(exe: string, folders: readonly string[], protect: readonly string[]): Promise<{ ok: boolean; ms: number }>
  /** Runs the helper (`run ...` starts a program in the sandbox) and waits for it. */
  run(exe: string, args: readonly string[], timeoutMs: number): Promise<Finished>
}

/** Marks the folders (everything in them, now and later) so that low-integrity programs may write them; the protected paths inside stay medium. */
export function labelFolders(exe: string, folders: readonly string[], protect: readonly string[], options: LabelOptions = {}): Promise<LabelResult> {
  const args = ['label']
  for (const folder of folders) args.push('--path', folder)
  for (const item of protect) args.push('--protect', item)
  if (options.ifMissing) args.push('--if-missing')
  return helperJson<LabelResult>(exe, args, options.timeoutMs ?? 30 * 60_000, options.onProgress)
}

/** Takes the marks away again. */
export function unlabelFolders(exe: string, folders: readonly string[], protect: readonly string[], timeoutMs = 30 * 60_000): Promise<{ ok: boolean; ms: number }> {
  const args = ['unlabel']
  for (const folder of folders) args.push('--path', folder)
  for (const item of protect) args.push('--protect', item)
  return helperJson(exe, args, timeoutMs)
}

/** The labels the paths carry, as "path => S:(ML;...)" lines. */
export async function readLabels(exe: string, paths: readonly string[], timeoutMs = 60_000): Promise<string[]> {
  const args = ['labels']
  for (const item of paths) args.push('--path', item)
  return (await helperJson<{ labels: string[] }>(exe, args, timeoutMs)).labels
}

/** Who may open the running programs and the label they carry, as "pid => O:...D:...S:(ML;...)" lines. */
export async function processSecurity(exe: string, pids: readonly number[], timeoutMs = 20_000): Promise<string[]> {
  const args = ['process-security']
  for (const pid of pids) args.push('--pid', String(pid))
  return (await helperJson<{ processes: string[] }>(exe, args, timeoutMs)).processes
}

export const defaultClient: HelperClient = {
  probe: (exe) => probeHelper(exe),
  label: labelFolders,
  unlabel: (exe, folders, protect) => unlabelFolders(exe, folders, protect),
  run: (exe, args, timeoutMs) => runHelper(exe, args, timeoutMs),
}
