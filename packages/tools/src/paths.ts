/**
 * Paths as the model writes them, and as the disk resolves them.
 *
 * Tools take absolute paths. A relative path resolves from the workspace
 * root, `~` from the home directory, and on Windows a Git Bash path such as
 * /c/Users/me becomes C:\Users\me, since models read paths back from Bash.
 * Containment is always checked on real paths, so a symlink or junction
 * cannot carry a write out of the workspace.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '@encode/permissions'

export interface PathContext {
  root: string
  home: string
  platform: NodeJS.Platform
}

function api(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The absolute path a tool argument names. */
export function resolveInputPath(input: string, context: PathContext): string {
  const p = api(context.platform)
  let value = input.trim()
  if (context.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(value)
    if (msys) value = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`
  }
  if (value === '~') value = context.home
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = p.join(context.home, value.slice(2))
  return p.resolve(context.root, value)
}

/** The path relative to the root when it is inside, for display; otherwise the absolute path. */
export function displayPath(absolute: string, context: Pick<PathContext, 'root' | 'platform'>): string {
  const p = api(context.platform)
  const relative = p.relative(context.root, absolute)
  if (!relative) return '.'
  if (relative.startsWith('..') || p.isAbsolute(relative)) return absolute
  return relative.split(p.sep).join('/')
}

/**
 * Resolves symlinks, junctions and (on Windows) 8.3 short names on the
 * longest existing prefix of an absolute path, then re-attaches the part that
 * does not exist yet.
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

/** POSIX separators, for matching globs on any platform. */
export function toPosix(relative: string): string {
  return relative.replace(/\\/g, '/')
}
