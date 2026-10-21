/**
 * Minimal glob matcher used by the search panel and the agent's search tool.
 * Supports `*`, `**`, `?` and character classes are intentionally omitted.
 * A pattern without a slash matches against the basename at any depth,
 * mirroring VS Code's include/exclude semantics.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/')
  let body = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          body += '(?:.*/)?'
        } else {
          body += '.*'
        }
      } else {
        body += '[^/]*'
      }
    } else if (c === '?') {
      body += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      body += '\\' + c
    } else {
      body += c
    }
  }
  const anchored = g.includes('/') ? '^' + body + '$' : '^(?:.*/)?' + body + '$'
  return new RegExp(anchored, 'i')
}

export function parseGlobList(input: string | undefined): RegExp[] {
  if (!input) return []
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => globToRegExp(part))
}

export function matchesAny(path: string, patterns: RegExp[]): boolean {
  if (!patterns.length) return true
  return patterns.some((re) => re.test(path))
}
