import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Windows sharing violations from scanners and indexers that hold a file open for a moment. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameOver(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !TRANSIENT.has(code) || attempt === RENAME_ATTEMPTS) throw error
      pause(20 * attempt)
    }
  }
}

/**
 * Replaces `file` with `content`, readable and writable only by the current
 * user on POSIX systems (Windows protects the profile folder by its ACL). The
 * content goes to a new sibling first, created exclusively so a stale or
 * planted temp file is never reused, and is flushed before it is renamed over
 * the target, so a crash leaves the old file or the new one, never half of one.
 */
export function writePrivateFile(file: string, content: string): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      fs.writeFileSync(fd, content, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameOver(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Call once at startup, under the single-instance lock. Tightens a file an
 * earlier build wrote with the default mode, and removes temp copies a crash
 * left beside it: an earlier build's `<file>.tmp` can hold keys in plain text.
 */
export function secureExisting(file: string): void {
  const dir = path.dirname(file)
  const base = path.basename(file)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name !== `${base}.tmp` && !(name.startsWith(`.${base}.`) && name.endsWith('.tmp'))) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* a directory by that name is not ours to remove */
    }
  }
  if (process.platform === 'win32') return
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
  } catch {
    /* missing: nothing to tighten */
  }
}
