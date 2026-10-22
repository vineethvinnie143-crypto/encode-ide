import fs from 'node:fs/promises'
import path from 'node:path'
import type { DiskProbe } from '@encode/permissions'
import { candidateNames, realPathOf, searchDirectories } from '@encode/tools'

export interface ProbeOptions {
  /** The environment programs are looked up in. Default: this process's. */
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
}

/**
 * The file names a shell may start for `program`. On Windows that is PATHEXT's, and PowerShell also runs `.ps1`
 * scripts found on PATH; a lookup that left them out would miss a script planted where the program should be.
 * Looking for more than the shell in use will start only makes the check stricter.
 */
export function lookupNames(program: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const names = candidateNames(program, env, platform)
  if (platform !== 'win32') return names
  // A name that ends in an extension Windows runs, or in .ps1, is that file; any other gets each extension.
  if (path.win32.extname(program).toLowerCase() === '.ps1') return [program]
  if (names.length === 1 && names[0] === program) return names
  return [...names, `${program}.ps1`]
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * The disk, as the shell policies check it before a command that looks read-only runs unasked: where links
 * lead, which files a program name would start, and whether a path exists (a `.git`, for instance).
 */
export function nodeDiskProbe(rootReal: string, options: ProbeOptions = {}): DiskProbe {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const api = platform === 'win32' ? path.win32 : path.posix
  return {
    rootReal,
    realPath: (absolute) => realPathOf(absolute),
    async locate(program) {
      // A name with a folder in it is that file, wherever the shell was standing.
      if (/[\\/]/.test(program)) return [program]
      const found: string[] = []
      for (const dir of searchDirectories(env, platform)) {
        for (const name of lookupNames(program, env, platform)) {
          const file = api.join(dir, name)
          if (await isFile(file)) found.push(file)
        }
      }
      return found
    },
    async exists(absolute) {
      try {
        await fs.lstat(absolute)
        return true
      } catch {
        return false
      }
    },
  }
}
