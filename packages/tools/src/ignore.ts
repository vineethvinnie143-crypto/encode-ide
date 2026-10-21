/**
 * .gitignore rules, so searches skip what the project itself ignores.
 *
 * Supported: comments, blank lines, `!` negation, a trailing `/` for
 * directories only, patterns anchored by a slash, `**`, classes and escapes
 * of a leading `#` or `!`. The last matching rule wins, and rules in a deeper
 * .gitignore are checked after those above it.
 */
import { globToRegExp } from './glob'

interface Rule {
  regex: RegExp
  negated: boolean
  directoryOnly: boolean
}

export interface IgnoreFile {
  /** The directory the file sits in, relative to the walk root ('' for the root). */
  base: string
  rules: Rule[]
}

export function parseIgnoreFile(text: string, base: string, caseInsensitive = false): IgnoreFile {
  const rules: Rule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }
    let directoryOnly = false
    if (line.endsWith('/')) {
      directoryOnly = true
      line = line.slice(0, -1)
    }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    const glob = anchored ? line : `**/${line}`
    rules.push({ regex: globToRegExp(glob, { caseInsensitive }), negated, directoryOnly })
  }
  return { base, rules }
}

/**
 * Whether the rules in `files` (outermost first) ignore `relative`, a path
 * relative to the walk root. Undefined when no rule matches.
 */
export function ignoredBy(files: readonly IgnoreFile[], relative: string, isDirectory: boolean): boolean | undefined {
  let verdict: boolean | undefined
  for (const file of files) {
    let local: string
    if (!file.base) local = relative
    else if (relative.startsWith(`${file.base}/`)) local = relative.slice(file.base.length + 1)
    else continue
    for (const rule of file.rules) {
      if (rule.directoryOnly && !isDirectory) continue
      if (rule.regex.test(local)) verdict = !rule.negated
    }
  }
  return verdict
}
