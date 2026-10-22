import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReadText } from './settings'
import type { TrustFs } from './trust'

/** Reads a file as UTF-8; null when it does not exist. */
export const readText: ReadText = async (file) => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw error
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
