import path from 'node:path'

/**
 * Path patterns for Read(...) and Edit(...) permission rules, in gitignore
 * syntax: `*` and `?` stay within one folder, `**` spans any number of
 * folders, `[...]` is a character class, and `\` escapes the next character
 * (on Windows `\` separates folders, and `[*]` matches a literal star).
 * A match covers the path and, as gitignore does for folders, everything
 * inside it. Where a pattern is anchored follows Claude Code:
 *
 *   //path   an absolute path: //etc/hosts, or //C:/Users/me on Windows
 *            (without a drive letter, any drive)
 *   ~/path   inside the home directory
 *   /path    inside the workspace root
 *   ./path   inside the workspace root
 *   a/b      with a slash, inside the workspace root
 *   name     without a slash, that name in any folder under the workspace
 *            root (gitignore's rule), or with `anywhere` in any folder at
 *            all, which deny rules use so a copy elsewhere is covered too
 *
 * Matching is on normalized absolute paths (`normalizeForMatch`) and ignores
 * case on Windows, as its filesystem does.
 */

export interface PatternBase {
  /** Absolute workspace root. */
  root: string
  /** Absolute home directory. */
  home: string
  windows: boolean
}

export interface CompiledPattern {
  /** The pattern as written. */
  source: string
  /** Tests a path normalized by `normalizeForMatch`. */
  test(normalized: string): boolean
}

/** A path as patterns see it: forward slashes, single separators, no trailing slash, lower case on Windows. */
export function normalizeForMatch(absolute: string, windows: boolean): string {
  const unc = /^[\\/]{2}[^\\/]/.test(absolute)
  // `.` and `..` are resolved on the text, so /work/src/../../.env cannot be taken for a path inside /work/src.
  let out = path.posix.normalize(absolute.replace(/\\/g, '/').replace(/\/+/g, '/'))
  if (windows) out = out.toLowerCase()
  if (unc) out = `/${out}`
  if (out.length > 1 && out.endsWith('/') && !/^[a-z]:\/$/i.test(out)) out = out.slice(0, -1)
  return out
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** One folder or file name of a glob, as a regex that never crosses a `/`. */
function segmentToRegex(segment: string): string {
  let out = ''
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (char === '\\' && index + 1 < segment.length) {
      out += escapeRegex(segment[++index])
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[' && segment.indexOf(']', index + 2) !== -1) {
      const close = segment.indexOf(']', index + 2)
      let body = segment.slice(index + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      out += `[${negated ? '^/' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`
      index = close
    } else {
      out += escapeRegex(char)
    }
  }
  return out
}

/** A `/`-separated glob as a regex in which every segment starts with `/`. */
function globToRegex(glob: string): string {
  const segments = glob.split('/').filter((segment, index, all) => segment || index === all.length - 1)
  let out = ''
  for (const [index, segment] of segments.entries()) {
    if (segment === '**') out += index === segments.length - 1 ? '(?:/.*)?' : '(?:/[^/]+)*'
    else if (segment) out += `/${segmentToRegex(segment)}`
  }
  return out
}

/**
 * Compiles a rule's path pattern; null for one that cannot be anchored
 * (empty, or another user's home such as `~root/`).
 */
export function compilePattern(pattern: string, base: PatternBase, options: { anywhere?: boolean } = {}): CompiledPattern | null {
  // Backslashes separate folders on Windows, where `[*]` matches a literal star instead.
  let glob = pattern.trim()
  if (base.windows) glob = glob.replace(/\\/g, '/')
  if (!glob || /^~[^/]/.test(glob)) return null
  if (base.windows) glob = glob.toLowerCase()

  let anchor: string
  if (glob.startsWith('//')) {
    const absolute = glob.slice(2).replace(/^\/+/, '')
    const drive = /^([a-z]):(?:\/|$)/i.exec(absolute)
    if (drive) {
      anchor = escapeRegex(`${drive[1]}:`)
      glob = absolute.slice(drive[0].length)
    } else {
      anchor = base.windows ? '[a-z]:' : ''
      glob = absolute
    }
  } else if (glob === '~' || glob.startsWith('~/')) {
    anchor = escapeRegex(normalizeForMatch(base.home, base.windows))
    glob = glob.slice(1)
  } else if (glob.startsWith('/') || glob.startsWith('./')) {
    anchor = escapeRegex(normalizeForMatch(base.root, base.windows))
    glob = glob.replace(/^\.?\/+/, '')
  } else {
    const root = escapeRegex(normalizeForMatch(base.root, base.windows))
    // gitignore: a slash anywhere but the end anchors the pattern; otherwise it floats.
    const floating = !glob.replace(/\/+$/, '').includes('/')
    anchor = !floating ? root : options.anywhere ? '.*' : `${root}(?:/[^/]+)*`
  }
  // A root anchor such as `c:` or `` (POSIX /) needs no trailing slash; the glob's segments bring their own.
  const regex = new RegExp(`^${anchor.replace(/\\\/$/, '')}${globToRegex(glob)}(?:/.*)?$`, base.windows ? 'is' : 's')
  return { source: pattern, test: (normalized) => regex.test(normalized) }
}
