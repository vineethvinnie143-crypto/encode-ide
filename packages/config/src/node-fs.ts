import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReadText } from './settings'
import type { TrustFs } from './trust'

/** Errors that a file being replaced or scanned at that moment gives a reader (Windows above all), and that pass in a few milliseconds. */
const TRANSIENT_READ_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])
/** Five reads, 150 ms apart in all: a file deleted while another program holds it stays "delete pending" on Windows until that program lets go. */
const READ_ATTEMPTS = 5

/** Larger than any settings, servers or trust file eNCode writes: what is bigger is not read into memory at all. */
const MAX_READ_BYTES = 4 * 1024 * 1024

/**
 * Reads a file as UTF-8; null when it does not exist. A read that fails the way a file in the middle of being replaced
 * does is tried again. Only a regular file of at most 4 MB is read, opened so that a named pipe cannot block the
 * reader; a file the folder brings (`fromProject`) must not be a link either, since a link in a cloned repository can
 * lead to any file on the disk. Anything else is an error that names the file's problem.
 */
export const readText: ReadText = async (file, options = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readRegular(file, options.fromProject === true)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      if (attempt >= READ_ATTEMPTS || !TRANSIENT_READ_ERRORS.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt))
    }
  }
}

async function readRegular(file: string, refuseLinks: boolean): Promise<string> {
  if (refuseLinks && (await fs.lstat(file)).isSymbolicLink()) throw new Error('it is a link, and eNCode does not follow links in the files a folder brings')
  // O_NONBLOCK keeps a pipe from holding the open; O_NOFOLLOW closes the gap between the check above and the open.
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (refuseLinks ? (constants.O_NOFOLLOW ?? 0) : 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('it is not a regular file')
    if (stat.size > MAX_READ_BYTES) throw new Error(`it is larger than ${MAX_READ_BYTES / 1024 / 1024} MB`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Errors that renaming over a file gives on Windows while another program holds it open for a moment (an
 * antivirus scanning the file just written, the search indexer, a reader in another process): they pass on their own.
 */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** Waits between attempts to rename, about 1.3 s in all: longer than a scan of a small file takes. */
const RENAME_DELAYS_MS = [20, 40, 80, 160, 320, 640]

/** Renames `from` over `to`, again a few times when the target is held open for a moment. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_DELAYS_MS.length || !TRANSIENT_RENAME_ERRORS.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_DELAYS_MS[attempt]))
    }
  }
}

/**
 * Replaces a file in one step: writes a temporary file next to it, then
 * renames it over the old one, so a crash or a second eNCode window never
 * leaves half a file. The file is readable by its owner only.
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await renameOver(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

export const nodeTrustFs: TrustFs = { read: readText, writeAtomic }
