/**
 * Tool results too long to send to the model whole (ADR 0093). The model reads their start and end and the path of a
 * file that keeps all of it, which it reads by range or searches like any file: a long build log no longer fills the
 * conversation, and nothing of it is lost.
 *
 * A folder for each session, which that session's agent reads without asking (its read roots) and no other session's
 * does. Files only their owner may open, a ceiling for each session and one for all of them, and a session's folder
 * removed with the session, or once nothing was kept in it for two weeks.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export interface OutputStore {
  /** Where a session's outputs are kept. */
  folder(sessionId: string): string
  /** Keeps a result whole: the file's path, or undefined when it could not be kept (no room left, a disk error). */
  keep(sessionId: string, name: string, text: string): Promise<string | undefined>
  /** The session was deleted: its outputs go with it. */
  remove(sessionId: string): Promise<void>
}

export interface OutputStoreOptions {
  dir: string
  /** What one session may keep. Default 64 MB. */
  maxSessionBytes?: number
  /** What all sessions together may keep; the oldest folders go first to make room. Default 512 MB. */
  maxTotalBytes?: number
  /** A folder nothing was kept in for this long is removed. Default two weeks. */
  keepMs?: number
  now?: () => number
}

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
/** Session ids are the store's own; anything else is never made into a folder. */
const SESSION_ID = /^[\w.-]{1,200}$/
/** How often a long-running app looks for folders to remove, besides when there is no room. */
const TIDY_EVERY_MS = DAY

/** A file name from a tool's name and a call's id, which the model chose: nothing in it can leave the folder. */
function fileBase(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^[.-]+/, '').slice(0, 100) || 'output'
}

export function createOutputStore(options: OutputStoreOptions): OutputStore {
  const maxSession = options.maxSessionBytes ?? 64 * MB
  const maxTotal = options.maxTotalBytes ?? 512 * MB
  const keepMs = options.keepMs ?? 14 * DAY
  const now = options.now ?? Date.now
  const folder = (sessionId: string) => path.join(options.dir, sessionId)

  /** Bytes kept, by session and in all, as counted at the last tidy and added to since. */
  const sizes = new Map<string, number>()
  let total: number | undefined
  let tidiedAt = 0

  // One at a time: a long result is rare, and counting the room left is simpler for it.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  /** Removes the folders that are old, then the oldest others until `bytes` more fit; counts what is left. */
  async function tidy(current: string, bytes: number): Promise<number> {
    const folders: { id: string; size: number; newest: number }[] = []
    for (const entry of await fs.readdir(options.dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
      let size = 0
      let newest = 0
      for (const file of await fs.readdir(folder(entry.name), { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile()) continue
        const stats = await fs.stat(path.join(folder(entry.name), file.name)).catch(() => undefined)
        if (!stats) continue
        size += stats.size
        newest = Math.max(newest, stats.mtimeMs)
      }
      folders.push({ id: entry.name, size, newest })
    }
    folders.sort((a, b) => a.newest - b.newest)
    let sum = folders.reduce((all, one) => all + one.size, 0)
    sizes.clear()
    for (const one of folders) {
      const old = now() - one.newest > keepMs
      if (one.id !== current && (old || sum + bytes > maxTotal)) {
        await fs.rm(folder(one.id), { recursive: true, force: true }).catch(() => undefined)
        sum -= one.size
      } else sizes.set(one.id, one.size)
    }
    tidiedAt = now()
    return sum
  }

  async function writeNew(dir: string, base: string, text: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const file = path.join(dir, `${attempt === 1 ? base : `${base}-${attempt}`}.txt`)
      try {
        await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 })
        return file
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 20) throw error
      }
    }
  }

  return {
    folder,
    keep: (sessionId, name, text) =>
      serial(async () => {
        if (!SESSION_ID.test(sessionId)) return undefined
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > maxSession) return undefined
        try {
          if (total === undefined || total + bytes > maxTotal || now() - tidiedAt > TIDY_EVERY_MS) total = await tidy(sessionId, bytes)
          const mine = sizes.get(sessionId) ?? 0
          if (mine + bytes > maxSession || total + bytes > maxTotal) return undefined
          const dir = folder(sessionId)
          await fs.mkdir(dir, { recursive: true, mode: 0o700 })
          const file = await writeNew(dir, fileBase(name), text)
          sizes.set(sessionId, mine + bytes)
          total += bytes
          return file
        } catch {
          return undefined
        }
      }),
    remove: (sessionId) =>
      serial(async () => {
        if (!SESSION_ID.test(sessionId)) return
        await fs.rm(folder(sessionId), { recursive: true, force: true }).catch(() => undefined)
        if (total !== undefined) total -= sizes.get(sessionId) ?? 0
        sizes.delete(sessionId)
      }),
  }
}
