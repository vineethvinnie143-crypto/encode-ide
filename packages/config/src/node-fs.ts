import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReadText } from './settings'
import type { TrustFs } from './trust'

/** Errors that a file being replaced or scanned at that moment gives a reader (Windows above all), and that pass in a few milliseconds. */
const TRANSIENT_READ_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])
const READ_ATTEMPTS = 3

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
 * Replaces a file in one step: writes a temporary file next to it, then
 * renames it over the old one, so a crash or a second eNCode window never
 * leaves half a file. The file is readable by its owner only.
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

export const nodeTrustFs: TrustFs = { read: readText, writeAtomic }
