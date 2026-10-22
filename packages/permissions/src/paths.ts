import type { PathApi } from './shell-grammar'

/**
 * True when `target` is `root` itself or lies inside it, judged on the path
 * text alone. Callers that need to see through symlinks resolve both sides
 * with realpath first.
 */
export function isInside(root: string, target: string, api: PathApi): boolean {
  if (api === api.win32 && !hasWindowsRoot(target)) return false
  const relative = api.relative(api.resolve(root), api.resolve(target))
  if (relative === '') return true
  if (api.isAbsolute(relative)) return false
  const first = relative.split(api.sep, 1)[0]
  return first !== '..'
}

/** A drive (`C:\`) or UNC (`\\server\share`) root; `\x` and `C:x` depend on hidden per-drive state. */
function hasWindowsRoot(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target) || /^[\\/]{2}[^\\/]/.test(target)
}

/**
 * Directories whose contents can make tools run code or steer later agent
 * turns: git's config and hooks, and eNCode's own workspace settings and
 * skills. Writes there need approval under every policy but Full access.
 */
const PROTECTED_SEGMENTS = new Set(['.git', '.encode'])

/** Files at the top of a workspace that name programs eNCode starts. */
const GUARDED_ROOT_FILES = new Set(['.mcp.json'])

/** A path segment as Windows reads it: without the trailing dots, spaces and `:stream` suffix it strips, and without case. */
function plainName(segment: string): string {
  return segment.split(':', 1)[0].replace(/[. ]+$/, '').toLowerCase()
}

/**
 * True when a workspace-relative path touches a protected directory. Matching
 * ignores case and the trailing dots, spaces and `:stream` suffixes Windows
 * strips, so `.GIT`, `.git.` and `.git::$INDEX_ALLOCATION` all count.
 */
export function isProtectedPath(relative: string): boolean {
  return relative.split(/[\\/]+/).some((segment) => PROTECTED_SEGMENTS.has(plainName(segment)))
}

/**
 * True for a protected path and for the files at the top of the workspace that
 * name programs to start (`.mcp.json`). A write there asks whatever a rule says,
 * since what it holds could run code later; unlike the folders above, a rewind
 * may put such a file back, because the person asks for that themselves.
 */
export function isGuardedPath(relative: string): boolean {
  if (isProtectedPath(relative)) return true
  const segments = relative.split(/[\\/]+/).filter((segment) => segment && segment !== '.')
  return segments.length === 1 && GUARDED_ROOT_FILES.has(plainName(segments[0]))
}
