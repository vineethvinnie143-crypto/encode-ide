import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '@encode/permissions'

/**
 * Resolves symlinks, junctions and (on Windows) 8.3 short names on the longest
 * existing prefix of an absolute path, then re-attaches the part that does
 * not exist yet. Uses the native realpath, so the result is canonical.
 */
export async function realPathOf(absolute: string): Promise<string> {
  const missing: string[] = []
  let probe = absolute
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      return missing.length ? path.join(real, ...missing.reverse()) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(probe)
      if (parent === probe) return absolute
      missing.push(path.basename(probe))
      probe = parent
    }
  }
}

/** True when `absolute`, after resolving links, is `rootReal` or inside it. */
export async function isInsideReal(rootReal: string, absolute: string): Promise<boolean> {
  return isInside(rootReal, await realPathOf(absolute), path)
}
