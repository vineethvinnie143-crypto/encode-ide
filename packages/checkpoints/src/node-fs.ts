import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CheckpointFs, DirEntry } from './types'

/**
 * The checkpoint disk on Node's fs. Store files are created private to the
 * user (0600 in 0700 folders; Windows keeps the profile's ACLs), since they
 * hold copies of source files that may hold secrets.
 */

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/** The path does not exist, or a part of it is a file. */
function isAbsent(error: unknown): boolean {
  const c = code(error)
  return c === 'ENOENT' || c === 'ENOTDIR'
}

async function realpathOf(target: string): Promise<string> {
  const missing: string[] = []
  let probe = target
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      return missing.length ? path.join(real, ...missing.reverse()) : real
    } catch (error) {
      if (!isAbsent(error)) throw error
      const parent = path.dirname(probe)
      if (parent === probe) return target
      missing.push(path.basename(probe))
      probe = parent
    }
  }
}

export function nodeCheckpointFs(): CheckpointFs {
  return {
    async read(file) {
      try {
        return await fs.readFile(file)
      } catch (error) {
        if (isAbsent(error)) return null
        throw error
      }
    },

    async writeOnce(file, bytes) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        await fs.rename(temp, file)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        // Two windows saving the same bytes at once: on Windows the second rename can be refused. The file is there, and is the same.
        if (await fs.stat(file).then(() => true, () => false)) return
        throw error
      }
    },

    async overwrite(file, bytes) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, bytes)
    },

    async remove(file) {
      try {
        await fs.unlink(file)
      } catch (error) {
        if (!isAbsent(error)) throw error
      }
    },

    async removeEmptyDir(dir) {
      try {
        await fs.rmdir(dir)
        return true
      } catch {
        return false
      }
    },

    async append(file, text) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.appendFile(file, text, { mode: 0o600 })
    },

    async list(dir) {
      let names
      try {
        names = await fs.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isAbsent(error)) return []
        throw error
      }
      const entries: DirEntry[] = []
      for (const entry of names) {
        try {
          const stat = await fs.lstat(path.join(dir, entry.name))
          entries.push({ name: entry.name, isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // Gone since the listing.
        }
      }
      return entries
    },

    async exists(target) {
      try {
        await fs.lstat(target)
        return true
      } catch (error) {
        // A path that cannot be examined is treated as present: callers use this to avoid claiming folders they did not create.
        return !isAbsent(error)
      }
    },

    realpath: realpathOf,
  }
}
