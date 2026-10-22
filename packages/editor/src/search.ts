import type { Text } from '@encode/text'
import { EditorSelection, SelectionRange } from './selection'
import type { EditorState, TransactionSpec } from './state'
import { CharClass, charClass } from './text-utils'

export interface SearchQuery {
  search: string
  caseSensitive?: boolean
  regexp?: boolean
  wholeWord?: boolean
}

export interface SearchMatch {
  from: number
  to: number
  /** The regular expression match, for `$1`-style replacements. */
  groups?: RegExpExecArray
}

/** A query ready to run, or the reason it cannot (a bad regular expression). */
export interface CompiledSearch {
  readonly query: SearchQuery
  readonly regex: RegExp | null
  /** True when matches can span lines; such a query searches the whole text at once. */
  readonly multiline: boolean
  readonly error?: string
  /** Extra word characters of the language, for whole-word matching. */
  readonly wordChars: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

export function compileSearch(query: SearchQuery, wordChars = ''): CompiledSearch {
  const base = { query, wordChars }
  if (!query.search) return { ...base, regex: null, multiline: false }
  const flags = `g${query.caseSensitive ? '' : 'i'}`
  if (!query.regexp) {
    return {
      ...base,
      regex: new RegExp(escapeRegExp(query.search), `${flags}mu`),
      multiline: query.search.includes('\n'),
    }
  }
  const multiline = /\\n|\\r|\n/.test(query.search)
  try {
    return { ...base, regex: new RegExp(query.search, `${flags}mu`), multiline }
  } catch {
    // Not valid with the u flag (e.g. "\-"): fall back to the legacy syntax.
  }
  try {
    return { ...base, regex: new RegExp(query.search, `${flags}m`), multiline }
  } catch (error) {
    return { ...base, regex: null, multiline: false, error: (error as Error).message }
  }
}

function isWholeWord(text: string, from: number, to: number, wordChars: string): boolean {
  const before = from > 0 ? charClass(text[from - 1], wordChars) : CharClass.Space
  const after = to < text.length ? charClass(text[to], wordChars) : CharClass.Space
  const first = charClass(text[from] ?? ' ', wordChars)
  const last = charClass(text[to - 1] ?? ' ', wordChars)
  return !(first === CharClass.Word && before === CharClass.Word) && !(last === CharClass.Word && after === CharClass.Word)
}

/** Steps past an empty match so the next search makes progress (and keeps surrogate pairs whole). */
function advance(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1
}

/** Matches in `from`–`to`, in document order. Empty matches only come from regular expressions. */
export function* searchMatches(doc: Text, search: CompiledSearch, from = 0, to = doc.length): Generator<SearchMatch> {
  const regex = search.regex
  if (!regex || from > to) return
  const whole = search.query.wholeWord
  if (search.multiline) {
    const text = doc.sliceString(from, to)
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
      const start = match.index
      const end = start + match[0].length
      if (start === end) regex.lastIndex = advance(text, start)
      if (whole && !isWholeWord(text, start, end, search.wordChars)) continue
      yield { from: from + start, to: from + end, groups: match }
    }
    return
  }
  const first = doc.lineAt(from)
  const last = doc.lineAt(to)
  for (let number = first.number; number <= last.number; number++) {
    const line = number === first.number ? first : doc.line(number)
    regex.lastIndex = number === first.number ? from - line.from : 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line.text))) {
      const start = match.index
      const end = start + match[0].length
      if (line.from + end > to) break
      if (start === end) regex.lastIndex = advance(line.text, start)
      if (whole && !isWholeWord(line.text, start, end, search.wordChars)) continue
      yield { from: line.from + start, to: line.from + end, groups: match }
      if (regex.lastIndex > line.text.length) break
    }
  }
}

/** The first match at or after `pos`, wrapping around to the start when `wrap`. */
export function findNext(doc: Text, search: CompiledSearch, pos: number, wrap = true): SearchMatch | null {
  for (const match of searchMatches(doc, search, pos)) if (match.to > match.from || search.query.regexp) return match
  if (!wrap) return null
  for (const match of searchMatches(doc, search, 0, pos)) if (match.to > match.from || search.query.regexp) return match
  return null
}

/** The last match ending at or before `pos`, wrapping around to the end when `wrap`. */
export function findPrevious(doc: Text, search: CompiledSearch, pos: number, wrap = true): SearchMatch | null {
  const lastIn = (from: number, to: number): SearchMatch | null => {
    if (search.multiline) {
      let found: SearchMatch | null = null
      for (const match of searchMatches(doc, search, from, to)) found = match
      return found
    }
    // Line by line from the end, so a find near the cursor stays cheap in a big file.
    const first = doc.lineAt(from).number
    for (let number = doc.lineAt(to).number; number >= first; number--) {
      const line = doc.line(number)
      let found: SearchMatch | null = null
      for (const match of searchMatches(doc, search, Math.max(from, line.from), Math.min(to, line.to))) found = match
      if (found) return found
    }
    return null
  }
  return lastIn(0, pos) ?? (wrap ? lastIn(pos, doc.length) : null)
}

/** The text a match is replaced with: literal, or with `$1`, `$<name>`, `$&`, `$$`, `\n` and `\t` expanded for regular expressions. */
export function replacementFor(search: CompiledSearch, match: SearchMatch, replace: string): string {
  if (!search.query.regexp || !match.groups) return replace
  const groups = match.groups
  return replace.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)|\\([nt\\])/g, (all, token: string, name: string, escaped: string) => {
    if (escaped) return escaped === 'n' ? '\n' : escaped === 't' ? '\t' : '\\'
    if (token === '$') return '$'
    if (token === '&') return groups[0]
    if (name !== undefined) return groups.groups?.[name] ?? ''
    const two = Number(token)
    if (token.length === 2 && two < groups.length) return groups[two] ?? ''
    const one = Number(token[0])
    if (one > 0 && one < groups.length) return (groups[one] ?? '') + token.slice(1)
    return all
  })
}

/** Replaces every match; null when there is none. */
export function replaceAll(state: EditorState, search: CompiledSearch, replace: string): TransactionSpec | null {
  const changes: { from: number; to: number; insert: string }[] = []
  for (const match of searchMatches(state.doc, search)) {
    changes.push({ from: match.from, to: match.to, insert: replacementFor(search, match, replace) })
  }
  if (!changes.length) return null
  return { changes, origin: 'replace', scrollIntoView: false }
}

/** Replaces the match the main selection covers and selects the next one. */
export function replaceNext(state: EditorState, search: CompiledSearch, replace: string): TransactionSpec | null {
  const main = state.selection.main
  const current = findNext(state.doc, search, main.from, false)
  if (!current || current.from !== main.from || current.to !== main.to) {
    const next = findNext(state.doc, search, main.to)
    return next ? { selection: EditorSelection.single(next.from, next.to), scrollIntoView: true } : null
  }
  const insert = replacementFor(search, current, replace)
  const after = current.from + insert.length
  const doc = state.doc.replace(current.from, current.to, insert)
  const next = findNext(doc, search, after)
  const selection = next ? new SelectionRange(next.from, next.to) : SelectionRange.cursor(after)
  return { changes: { from: current.from, to: current.to, insert }, selection, origin: 'replace', scrollIntoView: true }
}
