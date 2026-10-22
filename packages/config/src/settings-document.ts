import type { TrustFs } from './trust'

/**
 * A settings file as an object to change one key of and write back.
 *
 * A file that cannot be read, is not valid JSON or does not hold an object is never replaced: the person fixes it, or
 * the change is not made. Everything else in the file stays as it was.
 */

export type SettingsDocument = { ok: true; document: Record<string, unknown> } | { ok: false; reason: string }

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `purpose` finishes "fix it before …" in the reason, e.g. "saving a rule". A file that is not there is an empty document. */
export async function readSettingsDocument(fs: TrustFs, file: string, purpose: string): Promise<SettingsDocument> {
  let current: string | null
  try {
    current = await fs.read(file)
  } catch (error) {
    return { ok: false, reason: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (current === null || current.trim() === '') return { ok: true, document: {} }
  let raw: unknown
  try {
    raw = JSON.parse(current.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it before ${purpose} there.` }
  }
  if (!isObject(raw)) return { ok: false, reason: `${file} does not hold a settings object; fix it before ${purpose} there.` }
  return { ok: true, document: raw }
}

/** Writes the document back whole and atomically. Returns the reason it could not be written, or null. */
export async function writeSettingsDocument(fs: TrustFs, file: string, document: Record<string, unknown>): Promise<string | null> {
  try {
    await fs.writeAtomic(file, `${JSON.stringify(document, null, 2)}\n`)
    return null
  } catch (error) {
    return `${file} could not be written: ${error instanceof Error ? error.message : String(error)}`
  }
}
