/**
 * Builds the sandbox helper from the C# in this repository, once per version of its source.
 *
 * Same method as the desktop helper (0053): the compiler is the one every Windows 10 and 11 already has (the .NET
 * Framework's csc.exe), nothing is downloaded and no binary is kept in the repository. The result goes to a folder
 * named by the hash of the source; a copy whose hash does not match the one recorded beside it is built again, so a
 * half-written or altered file is never started.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SandboxError } from '../errors'
import { HELPER_FILES, HELPER_MANIFEST, type SourceFile } from './sources'

export const HELPER_EXE = 'encode-sandbox.exe'

/** Changes with the helper's command line, so a helper built for another one is never started. */
export const HELPER_PROTOCOL = 1

export interface CompilerRun {
  code: number | null
  stdout: string
  stderr: string
}

export type RunCompiler = (file: string, args: string[], options: { timeoutMs: number }) => Promise<CompilerRun>

export interface BuildOptions {
  /** Where compiled helpers are kept, one folder per source hash. */
  cacheDir: string
  files?: readonly SourceFile[]
  manifest?: string
  /** Full path of csc.exe. Default: the .NET Framework 4 folder under the Windows folder. */
  csc?: string
  run?: RunCompiler
  /** How long the compiler may take, ms. */
  timeoutMs?: number
}

export interface HelperBuild {
  dir: string
  exe: string
  hash: string
  /** False when a good copy was already there. */
  built: boolean
}

const BUILD_TIMEOUT_MS = 90_000
const KEEP_OLD_MS = 14 * 24 * 3_600_000

export async function findCompiler(windowsDir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'): Promise<string> {
  for (const kind of ['Framework64', 'Framework']) {
    const csc = path.join(windowsDir, 'Microsoft.NET', kind, 'v4.0.30319', 'csc.exe')
    if (await exists(csc)) return csc
  }
  throw new SandboxError(
    'unavailable',
    'The .NET Framework 4 compiler was not found under the Windows folder, so the sandbox helper cannot be built. Windows 10 and 11 include it; repair .NET Framework 4.8 in Windows Features.',
  )
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** The name of a build: everything that goes into the program, so one name is one program. */
export function helperHash(files: readonly SourceFile[], manifest: string): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ protocol: HELPER_PROTOCOL, manifest, files: [...files].sort((a, b) => a.name.localeCompare(b.name)).map((file) => [file.name, file.text]) }))
  return hash.digest('hex').slice(0, 16)
}

async function sha256Of(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/** A copy is good when its bytes are the ones that were written after the compiler succeeded. */
async function verified(exe: string): Promise<boolean> {
  try {
    const recorded = (await fs.readFile(`${exe}.sha256`, 'utf8')).trim()
    return recorded.length === 64 && recorded === (await sha256Of(exe))
  } catch {
    return false
  }
}

const defaultRun: RunCompiler = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const exit = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      // A compiler that did not start, or was stopped for taking too long, has no exit code: say why instead.
      const why = error && exit === null ? `\n${error.message}` : ''
      resolve({ code: exit, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + why })
    })
  })

/** The compiler's complaints about our sources, without the folder they were written to. */
export function compilerErrors(output: string, folder: string): string {
  const lines = output
    .split(/\r?\n/)
    .filter((line) => /: (error|fatal error) /i.test(line) || /^error /i.test(line))
    .map((line) => line.split(folder).join('').replace(/^[\\/]+/, '').trim())
  return lines.slice(0, 6).join('\n')
}

const building = new Map<string, Promise<HelperBuild>>()

/** Makes sure a good helper exists for this source and returns where it is. Concurrent callers share one build. */
export function ensureHelper(options: BuildOptions): Promise<HelperBuild> {
  const files = options.files ?? HELPER_FILES
  const manifest = options.manifest ?? HELPER_MANIFEST
  const hash = helperHash(files, manifest)
  const dir = path.join(options.cacheDir, hash)
  const running = building.get(dir)
  if (running) return running
  const job = build(options, files, manifest, hash, dir).finally(() => building.delete(dir))
  building.set(dir, job)
  return job
}

async function build(options: BuildOptions, files: readonly SourceFile[], manifest: string, hash: string, dir: string): Promise<HelperBuild> {
  const exe = path.join(dir, HELPER_EXE)
  if (await verified(exe)) return { dir, exe, hash, built: false }

  const csc = options.csc ?? (await findCompiler())
  const run = options.run ?? defaultRun
  await fs.mkdir(options.cacheDir, { recursive: true })
  const work = path.join(options.cacheDir, `${hash}.build-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    const source = path.join(work, 'src')
    await fs.mkdir(source, { recursive: true })
    for (const file of files) await fs.writeFile(path.join(source, file.name), file.text, 'utf8')
    const manifestFile = path.join(work, 'helper.manifest')
    await fs.writeFile(manifestFile, manifest, 'utf8')
    const out = path.join(work, HELPER_EXE)
    const args = [
      '/nologo',
      '/noconfig',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      '/debug-',
      '/warn:4',
      `/out:${out}`,
      `/win32manifest:${manifestFile}`,
      '/r:System.dll',
      '/r:System.Core.dll',
      ...files.map((file) => path.join(source, file.name)),
    ]
    const result = await run(csc, args, { timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS })
    if (result.code !== 0 || !(await exists(out))) {
      const why = compilerErrors(`${result.stdout}\n${result.stderr}`, work) || result.stderr.trim().split(/\r?\n/)[0] || `the compiler stopped with code ${result.code}`
      throw new SandboxError('unavailable', `The sandbox helper could not be built: ${why}`)
    }
    await fs.writeFile(`${out}.sha256`, `${await sha256Of(out)}\n`, 'utf8')
    await fs.rm(source, { recursive: true, force: true })
    // A good copy that appeared while the compiler ran is another window's finished build: use it. One that fails its check is replaced.
    if (await verified(exe)) return { dir, exe, hash, built: false }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    try {
      await fs.rename(work, dir)
    } catch (error) {
      // Another window of eNCode finished the same build first: use theirs if it is good.
      if (await verified(exe)) return { dir, exe, hash, built: false }
      throw new SandboxError('unavailable', `The sandbox helper could not be put in place: ${error instanceof Error ? error.message : String(error)}`)
    }
    void prune(options.cacheDir, hash)
    return { dir, exe, hash, built: true }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Old builds are not kept for long, and a build another window is making right now is left alone. */
async function prune(cacheDir: string, keep: string): Promise<void> {
  try {
    for (const entry of await fs.readdir(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keep || entry.name.includes('.build-')) continue
      const full = path.join(cacheDir, entry.name)
      const stat = await fs.stat(full)
      if (Date.now() - stat.mtimeMs > KEEP_OLD_MS) await fs.rm(full, { recursive: true, force: true })
    }
  } catch {
    // Pruning is a courtesy.
  }
}
