/**
 * A folder's code index (ADR 0090): the definitions and the names used of every source file in it, kept up to date
 * as files change. One per folder, shared by the sessions in it, built in the background in short slices so the
 * process that holds it stays responsive, and brought up to date when it is used: files that changed since are read
 * again, by their size and time, and a file a tool wrote is read again at once.
 *
 * It reads what Glob and Grep would: .gitignore honoured, .git, node_modules, build output and eNCode's worktrees
 * left out, no links followed. Only files in a language it reads are opened, so `.env`, keys and data files never are.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeText } from '../text'
import { toPosix } from '../paths'
import { walk } from '../walk'
import { WORKTREES_DIR } from '../worktree'
import { extract, languageOf } from './extract'
import type { IndexedFile } from './rank'

export interface CodeIndexOptions {
  /** The folder, as a real path. */
  root: string
  caseInsensitive?: boolean
  /** The most files it reads; past that the index says it is partial. */
  maxFiles?: number
  /** Files larger than this are left out: generated or bundled code. */
  maxFileBytes?: number
  /** How old the index may be before a use walks the folder again. */
  staleMs?: number
  now?: () => number
}

interface Entry extends IndexedFile {
  size: number
  mtimeMs: number
}

/** About 9 MB of memory for each thousand files (measured on eNCode's own code). */
const MAX_FILES = 10_000
const MAX_FILE_BYTES = 1_000_000
const STALE_MS = 10_000
/** Work done before the index lets other work in. */
const SLICE_MS = 8
const READ_CONCURRENCY = 8

/** Folders of build output, caches and other people's code, whatever .gitignore says. */
const SKIPPED = ['.git', 'node_modules', 'bower_components', 'vendor', 'target', 'dist', 'build', 'out', 'obj', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.gradle', '.idea', '.vs', 'Pods', 'DerivedData']

/** A file whose lines are this long on average is minified or generated. */
const MINIFIED_LINE = 400

const pause = () => new Promise<void>((resolve) => setImmediate(resolve))

export class CodeIndex {
  readonly root: string
  private readonly entries = new Map<string, Entry>()
  private readonly changedFiles = new Set<string>()
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly staleMs: number
  private readonly now: () => number
  private running: Promise<void> | undefined
  private walkedAt = -Infinity
  private builtOnce = false
  private partial = false
  private version = 0
  private snapshot: { version: number; files: IndexedFile[] } | undefined

  constructor(private readonly options: CodeIndexOptions) {
    this.root = options.root
    this.maxFiles = options.maxFiles ?? MAX_FILES
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
    this.staleMs = options.staleMs ?? STALE_MS
    this.now = options.now ?? Date.now
  }

  /** Whether the walk stopped at the most files it reads. */
  get truncated(): boolean {
    return this.partial
  }

  /** Whether it has been built at least once. */
  get built(): boolean {
    return this.builtOnce
  }

  /** Starts bringing the index up to date, in the background. */
  warm(): void {
    void this.update().catch(() => undefined)
  }

  /** A file changed (a tool wrote it, the editor saved it): it is read again on the next use. */
  changed(file: string): void {
    const relative = this.relative(file)
    if (relative !== undefined) this.changedFiles.add(relative)
  }

  /** Waits at most `ms` for the index to be built; whether it is. */
  async ready(ms: number): Promise<boolean> {
    if (this.builtOnce) return true
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.update().catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
    clearTimeout(timer)
    return this.builtOnce
  }

  /** The files as they are now: brought up to date first when the index is old or a file changed. */
  async files(signal?: AbortSignal): Promise<IndexedFile[]> {
    await this.update(signal)
    return this.current()
  }

  /** The files as last indexed, without waiting. */
  current(): IndexedFile[] {
    if (this.snapshot?.version !== this.version) this.snapshot = { version: this.version, files: [...this.entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) }
    return this.snapshot.files
  }

  /** Brings the index up to date. One update runs at a time; a caller during one waits for it. */
  update(signal?: AbortSignal): Promise<void> {
    if (this.running) return signal ? abortable(this.running, signal) : this.running
    const stale = this.now() - this.walkedAt >= this.staleMs
    if (!stale && !this.changedFiles.size) return Promise.resolve()
    const run = (stale ? this.walkAll() : this.readChanged()).finally(() => {
      this.running = undefined
    })
    this.running = run
    return signal ? abortable(run, signal) : run
  }

  private relative(file: string): string | undefined {
    const relative = toPosix(path.relative(this.root, path.resolve(this.root, file)))
    return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative
  }

  private async walkAll(): Promise<void> {
    const worktrees = path.join(this.root, WORKTREES_DIR)
    const same = this.options.caseInsensitive ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
    const result = await walk({
      dir: this.root,
      caseInsensitive: this.options.caseInsensitive ?? false,
      skipNames: SKIPPED,
      include: (entry) => (entry.isDirectory ? !same(entry.absolute, worktrees) : !entry.isSymlink && languageOf(entry.relative) !== undefined),
      limit: this.maxFiles,
    })
    this.walkedAt = this.now()
    this.partial = result.truncated
    const seen = new Set<string>()
    const files = result.files.filter((entry) => !entry.isDirectory)
    for (const entry of files) seen.add(entry.relative)
    for (const known of [...this.entries.keys()]) {
      if (!seen.has(known)) {
        this.entries.delete(known)
        this.version++
      }
    }
    this.changedFiles.clear()
    await this.readAll(files.map((entry) => entry.relative))
    this.builtOnce = true
  }

  private async readChanged(): Promise<void> {
    const files = [...this.changedFiles]
    this.changedFiles.clear()
    await this.readAll(files, true)
  }

  /** Reads the files whose size or time changed since they were indexed (all of `files` when `force`). */
  private async readAll(files: readonly string[], force = false): Promise<void> {
    let next = 0
    let sliceStart = performance.now()
    const worker = async () => {
      while (next < files.length) {
        const relative = files[next++]
        await this.readOne(relative, force)
        if (performance.now() - sliceStart > SLICE_MS) {
          await pause()
          sliceStart = performance.now()
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker))
  }

  private async readOne(relative: string, force: boolean): Promise<void> {
    const absolute = path.join(this.root, relative)
    const known = this.entries.get(relative)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const link = await fs.lstat(absolute)
      if (!link.isFile() || link.size > this.maxFileBytes) {
        this.forget(relative)
        return
      }
      if (!force && known && known.size === link.size && known.mtimeMs === link.mtimeMs) return
      handle = await fs.open(absolute, 'r')
      const bytes = await handle.readFile()
      const decoded = decodeText(bytes)
      const extracted = decoded && !minified(decoded.text) ? extract(relative, decoded.text) : undefined
      if (!extracted) {
        this.forget(relative)
        return
      }
      this.entries.set(relative, { path: relative, language: extracted.language, definitions: extracted.definitions, names: extracted.names, size: link.size, mtimeMs: link.mtimeMs })
      this.version++
    } catch {
      this.forget(relative)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private forget(relative: string): void {
    if (this.entries.delete(relative)) this.version++
  }
}

function minified(text: string): boolean {
  if (text.length < 20_000) return false
  let lines = 1
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++
  return text.length / lines > MINIFIED_LINE
}

function abortable(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      () => {
        signal.removeEventListener('abort', stop)
        resolve()
      },
      (error) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}
