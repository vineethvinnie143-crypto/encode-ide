/**
 * A scratch folder for each session (ADR 0141): where the agent puts probes, throwaway scripts and scratch tests, outside
 * the project. The agent's file tools read and write in it without asking, and nothing written there counts as a change
 * to the project: no checks run for it, no language server reads it, it is not kept to be put back. Its commands may
 * use it in the sandbox too, when the folder lies in the sandbox's own.
 *
 * A folder only its owner may open, made when the session opens, and removed with the session or once nothing in it
 * changed for a week.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '@encode/permissions'

const DAY = 24 * 60 * 60 * 1000
/** Session ids are the store's own; anything else, `.` and `..` among them, is never made into a folder. */
const SESSION_ID = /^(?!\.+$)[\w.-]{1,200}$/

export interface ScratchStore {
  /** Makes the session's folder when it is not there: its real path, or undefined when it cannot be made. */
  make(sessionId: string): Promise<string | undefined>
  /** The session was deleted: its folder goes with it. */
  remove(sessionId: string): Promise<void>
  /** Removes the folders nothing changed in for a week, but those `open` says are in use. */
  tidy(open: (sessionId: string) => boolean): Promise<void>
}

export interface ScratchStoreOptions {
  dir: string
  /** A folder nothing changed in for this long is removed. Default a week. */
  keepMs?: number
  now?: () => number
}

/** When something in the folder last changed: the folder itself and what is in it, two levels down. */
async function newest(folder: string, depth = 2): Promise<number> {
  const stats = await fs.lstat(folder).catch(() => undefined)
  if (!stats) return 0
  let latest = stats.mtimeMs
  if (!stats.isDirectory() || depth === 0) return latest
  for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) latest = Math.max(latest, await newest(path.join(folder, entry.name), depth - 1))
  return latest
}

export function createScratchStore(options: ScratchStoreOptions): ScratchStore {
  const keepMs = options.keepMs ?? 7 * DAY
  const now = options.now ?? Date.now
  let base: Promise<string> | undefined
  /** The real path of the folder the sessions' folders are in, made once. */
  const real = (): Promise<string> => {
    base ??= fs
      .mkdir(options.dir, { recursive: true, mode: 0o700 })
      .then(() => fs.realpath(options.dir))
      .catch((error: unknown) => {
        base = undefined
        throw error
      })
    return base
  }

  return {
    async make(sessionId) {
      if (!SESSION_ID.test(sessionId)) return undefined
      try {
        // The path is the store's, not what a link in its place leads to: a folder the agent swapped for a link leads
        // outside it, and what is there is judged as anything outside is.
        const folder = path.join(await real(), sessionId)
        await fs.mkdir(folder, { recursive: true, mode: 0o700 })
        return folder
      } catch {
        return undefined
      }
    },
    async remove(sessionId) {
      if (!SESSION_ID.test(sessionId)) return
      // A link left in the folder's place goes, not what it leads to.
      await fs.rm(path.join(options.dir, sessionId), { recursive: true, force: true }).catch(() => undefined)
    },
    async tidy(open) {
      for (const entry of await fs.readdir(options.dir, { withFileTypes: true }).catch(() => [])) {
        if (!SESSION_ID.test(entry.name) || open(entry.name)) continue
        const folder = path.join(options.dir, entry.name)
        if (entry.isDirectory() && now() - (await newest(folder)) <= keepMs) continue
        if (!open(entry.name)) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

/** Whether `file`, a real path, lies in the scratch folder, itself a real path. */
export function inScratch(scratch: string | undefined, file: string, platform: NodeJS.Platform): boolean {
  return scratch !== undefined && isInside(scratch, file, platform === 'win32' ? path.win32 : path.posix)
}
