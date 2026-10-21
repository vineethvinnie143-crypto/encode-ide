/**
 * Glob patterns, compiled to regular expressions over POSIX-style relative
 * paths: `*` and `?` within a segment, `**` across segments, character
 * classes (`[a-z]`, `[!.]`) and alternatives (`{ts,tsx}`, nestable).
 * Backslashes count as separators, since Windows paths reach here too.
 */

export interface GlobOptions {
  /** Default false. Windows and macOS file systems usually want true. */
  caseInsensitive?: boolean
  /** A pattern without a slash matches the last segment at any depth, like .gitignore and ripgrep's --glob. */
  matchBase?: boolean
}

const MAGIC = /[*?[{]/
const REGEX_SPECIAL = /[\\^$.|+()[\]{}*?/]/g

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&')
}

/** The index of the brace that closes the one at `open`, or -1. */
function closingBrace(glob: string, open: number): number {
  let depth = 0
  for (let index = open; index < glob.length; index++) {
    const char = glob[index]
    if (char === '[') {
      const end = glob.indexOf(']', index + 2)
      if (end !== -1) index = end
    } else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index
  }
  return -1
}

/** Top-level comma-separated parts of a brace body. */
function alternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '{') depth++
    else if (char === '}') depth--
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

function compile(glob: string): string {
  let out = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    const atSegmentStart = index === 0 || glob[index - 1] === '/'
    if (char === '*') {
      if (glob[index + 1] === '*' && atSegmentStart && (index + 2 === glob.length || glob[index + 2] === '/')) {
        if (index + 2 === glob.length) {
          out += '.*'
          index += 1
        } else {
          out += '(?:.*/)?'
          index += 2
        }
        continue
      }
      while (glob[index + 1] === '*') index++
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[') {
      const end = glob.indexOf(']', index + 2)
      if (end === -1) {
        out += '\\['
        continue
      }
      let body = glob.slice(index + 1, end)
      const negated = body[0] === '!' || body[0] === '^'
      if (negated) body = body.slice(1)
      out += `(?!/)[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      index = end
    } else if (char === '{') {
      const end = closingBrace(glob, index)
      const parts = end === -1 ? [] : alternatives(glob.slice(index + 1, end))
      if (parts.length < 2) {
        out += '\\{'
        continue
      }
      out += `(?:${parts.map(compile).join('|')})`
      index = end
    } else {
      out += escapeRegex(char)
    }
  }
  return out
}

/** Normalizes a pattern: forward slashes, no leading ./, no doubled slashes. */
export function normalizeGlob(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(?:\.\/)+/, '')
}

export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const glob = normalizeGlob(pattern)
  const body = compile(glob)
  const source = options.matchBase && !glob.includes('/') ? `^(?:.*/)?${body}$` : `^${body}$`
  return new RegExp(source, options.caseInsensitive ? 'i' : '')
}

export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern)
}

/**
 * Splits a pattern into the directory it can start walking from and the
 * rest: `src/app/**\/*.ts` → `src/app` and `**\/*.ts`.
 */
export function globBase(pattern: string): { base: string; rest: string } {
  const segments = normalizeGlob(pattern).split('/')
  const fixed: string[] = []
  while (segments.length > 1 && !hasMagic(segments[0])) fixed.push(segments.shift()!)
  return { base: fixed.join('/'), rest: segments.join('/') }
}

/** A matcher for several comma- or space-free patterns at once. */
export function globMatcher(patterns: readonly string[], options: GlobOptions = {}): (relative: string) => boolean {
  const compiled = patterns.filter((pattern) => pattern.trim()).map((pattern) => globToRegExp(pattern, options))
  return (relative) => compiled.some((regex) => regex.test(relative))
}
