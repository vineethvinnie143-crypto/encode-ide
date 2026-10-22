import path from 'node:path'
import type { CheckpointFs, DirEntry } from './types'

/**
 * An in-memory disk for tests: files and folders by path (without case on
 * Windows), folder links for realpath, a settable clock for modification
 * times, and a hook to make any operation fail. Only the tests import it.
 */
export interface MemoryFs extends CheckpointFs {
  /** Makes an operation throw: return an error for `(operation, path)`. */
  failWhen: (operation: string, target: string) => Error | undefined
  clock: number
  put(file: string, text: string | Buffer): void
  get(file: string): Buffer | undefined
  text(file: string): string | undefined
  mkdir(dir: string): void
  /** Makes `from` a link to the folder `to`: paths below `from` resolve below `to`. */
  link(from: string, to: string): void
  touch(file: string, mtimeMs: number): void
  /** Every file, as first written. */
  files(): string[]
  dirs(): string[]
}

interface File {
  path: string
  bytes: Buffer
  mtimeMs: number
}

export function memoryFs(options: { windows?: boolean } = {}): MemoryFs {
  const windows = options.windows === true
  const api = windows ? path.win32 : path.posix
  const fold = (target: string) => {
    const normalized = api.normalize(target)
    return windows ? normalized.toLowerCase() : normalized
  }
  const files = new Map<string, File>()
  const folders = new Map<string, string>()
  const links = new Map<string, string>()

  const mkdirs = (dir: string) => {
    for (let current = api.normalize(dir); ; current = api.dirname(current)) {
      folders.set(fold(current), current)
      if (api.dirname(current) === current) return
    }
  }
  const write = (file: string, bytes: Buffer) => {
    mkdirs(api.dirname(file))
    files.set(fold(file), { path: file, bytes: Buffer.from(bytes), mtimeMs: fs.clock })
  }
  const check = (operation: string, target: string) => {
    const error = fs.failWhen(operation, target)
    if (error) throw error
  }
  const childrenOf = (dir: string) => {
    const key = fold(dir)
    const entries: DirEntry[] = []
    for (const file of files.values()) {
      if (fold(api.dirname(file.path)) === key) entries.push({ name: api.basename(file.path), isFile: true, size: file.bytes.length, mtimeMs: file.mtimeMs })
    }
    for (const [folderKey, folder] of folders) {
      if (folderKey !== key && fold(api.dirname(folder)) === key) entries.push({ name: api.basename(folder), isFile: false, size: 0, mtimeMs: fs.clock })
    }
    return entries
  }

  const fs: MemoryFs = {
    failWhen: () => undefined,
    clock: 1_000,

    put: (file, text) => write(file, Buffer.from(text)),
    get: (file) => files.get(fold(file))?.bytes,
    text: (file) => files.get(fold(file))?.bytes.toString('utf8'),
    mkdir: mkdirs,
    link: (from, to) => links.set(fold(from), to),
    touch(file, mtimeMs) {
      const entry = files.get(fold(file))
      if (entry) entry.mtimeMs = mtimeMs
    },
    files: () => [...files.values()].map((file) => file.path),
    dirs: () => [...folders.values()],

    async read(file) {
      check('read', file)
      return files.get(fold(file))?.bytes ?? null
    },
    async writeOnce(file, bytes) {
      check('writeOnce', file)
      if (!files.has(fold(file))) write(file, bytes)
    },
    async overwrite(file, bytes) {
      check('overwrite', file)
      write(file, bytes)
    },
    async remove(file) {
      check('remove', file)
      files.delete(fold(file))
    },
    async removeEmptyDir(dir) {
      check('removeEmptyDir', dir)
      const key = fold(dir)
      if (!folders.has(key) || childrenOf(dir).length) return false
      folders.delete(key)
      return true
    },
    async append(file, text) {
      check('append', file)
      const entry = files.get(fold(file))
      write(file, Buffer.concat([entry?.bytes ?? Buffer.alloc(0), Buffer.from(text)]))
    },
    async list(dir) {
      check('list', dir)
      return childrenOf(dir)
    },
    async exists(target) {
      const key = fold(target)
      return files.has(key) || folders.has(key) || links.has(key)
    },
    async realpath(target) {
      const key = fold(target)
      for (const [from, to] of links) {
        if (key === from) return api.normalize(to)
        if (key.startsWith(from.endsWith(api.sep) ? from : from + api.sep)) return api.join(to, key.slice(from.length))
      }
      return api.normalize(target)
    },
  }
  return fs
}
