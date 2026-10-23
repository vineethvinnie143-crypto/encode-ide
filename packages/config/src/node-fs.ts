import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReadText } from './settings'
import type { TrustFs } from './trust'

/** Errors that a file being replaced or scanned at that moment gives a reader (Windows above all), and that pass in a few milliseconds. */
const TRANSIENT_READ_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])
/** Five reads, 150 ms apart in all: a file deleted while another program holds it stays "delete pending" on Windows until that program lets go. */
const READ_ATTEMPTS = 5

/** Reads a file as UTF-8; null when it does not exist. A read that fails the way a file in the middle of being replaced does is tried again. */
export const readText: ReadText = async (file) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      if (attempt >= READ_ATTEMPTS || !TRANSIENT_READ_ERRORS.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt))
    }
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
