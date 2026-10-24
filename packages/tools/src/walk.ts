/**
 * Walks a directory tree for Glob and Grep: honours .gitignore files from the
 * workspace root down, never enters .git, does not follow directory links
 * (so a link cannot loop or lead out of the tree), leaves out folders that are
 * off limits and links into them, reads several directories at once, and
 * stops when aborted or when it has found enough.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ignoredBy, parseIgnoreFile, type IgnoreFile } from './ignore'
import { offLimitsFolder, realPathOf, toPosix, type OffLimits } from './paths'

export interface WalkEntry {
  absolute: string
  /** Relative to the walked directory, with forward slashes. */
  relative: string
  isDirectory: boolean
  isSymlink: boolean
}

export interface WalkOptions {
  /** The absolute directory to walk. */
  dir: string
  /** The directory whose .gitignore files apply first (the workspace root). Default: `dir`. */
  ignoreRoot?: string
  /** Honour .gitignore files. Default true. */
  gitignore?: boolean
  caseInsensitive?: boolean
  /** Directory names never entered. Default: .git and node_modules. */
  skipNames?: readonly string[]
  /** Folders never entered, nor files linked into them (eNCode's profile). */
  offLimits?: OffLimits
  /** Return false to leave out a file, or a directory and everything in it. */
  include?(entry: WalkEntry): boolean
  /** Stop after this many files. */
  limit?: number
  signal?: AbortSignal
}

export interface WalkResult {
  files: WalkEntry[]
  /** True when `limit` stopped the walk. */
  truncated: boolean
}

const CONCURRENCY = 16
const DEFAULT_SKIP = ['.git', 'node_modules']

async function readIgnore(dir: string, base: string, caseInsensitive: boolean): Promise<IgnoreFile | undefined> {
  try {
    const text = await fs.readFile(path.join(dir, '.gitignore'), 'utf8')
    const file = parseIgnoreFile(text, base, caseInsensitive)
    return file.rules.length ? file : undefined
  } catch {
    return undefined
  }
}

export async function walk(options: WalkOptions): Promise<WalkResult> {
  const { dir, signal } = options
  const gitignore = options.gitignore ?? true
  const caseInsensitive = options.caseInsensitive ?? false
  const limit = options.limit ?? Infinity
  const skip = new Set(options.skipNames ?? DEFAULT_SKIP)
  // Where the walk starts, relative to the ignore root; a walk outside the root uses its own files only.
  let ignoreRoot = options.ignoreRoot ?? dir
  let startPrefix = toPosix(path.relative(ignoreRoot, dir))
  if (startPrefix.startsWith('..') || path.isAbsolute(startPrefix)) {
    ignoreRoot = dir
    startPrefix = ''
  }

  // .gitignore files from the ignore root down to the walked directory.
  const inherited: IgnoreFile[] = []
  if (gitignore) {
    const segments = startPrefix ? startPrefix.split('/') : []
    for (let depth = 0; depth <= segments.length; depth++) {
      const base = segments.slice(0, depth).join('/')
      const file = await readIgnore(path.join(ignoreRoot, ...segments.slice(0, depth)), base, caseInsensitive)
      if (file) inherited.push(file)
    }
  }
  const toIgnoreRelative = (relative: string) => (startPrefix ? (relative ? `${startPrefix}/${relative}` : startPrefix) : relative)

  const files: WalkEntry[] = []
  let truncated = false
  // Off-limits folders are matched on real paths: the walk keeps the real path of each folder next to the one it shows.
  const limits = options.offLimits?.folders.length ? options.offLimits : undefined
  type Job = { absolute: string; real: string; relative: string; ignores: IgnoreFile[] }
  const queue: Job[] = [{ absolute: dir, real: limits ? await realPathOf(dir) : dir, relative: '', ignores: inherited }]
  let active = 0

  await new Promise<void>((resolve, reject) => {
    const finishIfIdle = () => {
      if (!active && (!queue.length || truncated)) resolve()
    }
    const pump = () => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      while (active < CONCURRENCY && queue.length && !truncated) {
        const job = queue.shift()!
        active++
        visit(job)
          .then(() => {
            active--
            pump()
            finishIfIdle()
          })
          .catch((error) => {
            truncated = true
            reject(error)
          })
      }
      finishIfIdle()
    }

    const visit = async (job: Job) => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(job.absolute, { withFileTypes: true })
      } catch {
        return
      }
      let ignores = job.ignores
      if (gitignore && job.relative) {
        const own = await readIgnore(job.absolute, toIgnoreRelative(job.relative), caseInsensitive)
        if (own) ignores = [...ignores, own]
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const dirent of entries) {
        if (truncated) return
        const absolute = path.join(job.absolute, dirent.name)
        const relative = job.relative ? `${job.relative}/${dirent.name}` : dirent.name
        let isDirectory = dirent.isDirectory()
        const isSymlink = dirent.isSymbolicLink()
        if (isSymlink) {
          try {
            isDirectory = (await fs.stat(absolute)).isDirectory()
          } catch {
            continue
          }
        } else if (!isDirectory && !dirent.isFile()) {
          continue
        }
        if (isDirectory && skip.has(dirent.name)) continue
        if (gitignore && ignores.length && ignoredBy(ignores, toIgnoreRelative(relative), isDirectory)) continue
        let real = absolute
        if (limits) {
          real = isSymlink ? await realPathOf(absolute).catch(() => absolute) : path.join(job.real, dirent.name)
          if (offLimitsFolder(limits, real)) continue
        }
        const entry: WalkEntry = { absolute, relative, isDirectory, isSymlink }
        if (options.include && !options.include(entry)) continue
        if (isDirectory) {
          if (!isSymlink) queue.push({ absolute, real, relative, ignores })
        } else {
          files.push(entry)
          if (files.length >= limit) {
            truncated = true
            return
          }
        }
      }
    }

    pump()
  })

  return { files, truncated }
}
