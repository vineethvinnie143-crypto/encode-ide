/**
 * String replacement for Edit and MultiEdit.
 *
 * The match is exact first. When that fails, three forgiving passes run, and
 * each must still find exactly the text it is looking for:
 *   - line endings: the model sent \n, the file uses \r\n;
 *   - quotes: the model sent curly quotes, the file has straight ones (or the
 *     reverse); the replacement keeps the file's style;
 *   - line numbers: the model copied Read's `cat -n` prefixes along.
 */

export interface EditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export type EditOutcome = { ok: true; text: string; replacements: number } | { ok: false; error: string }

const CURLY = /[\u2018\u2019\u201c\u201d]/g
const HAS_CURLY = /[\u2018\u2019\u201c\u201d]/
const STRAIGHTEN: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"' }
const LINE_NUMBER_PREFIX = /^ *\d+\t/

function straighten(text: string): string {
  return text.replace(CURLY, (char) => STRAIGHTEN[char])
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0
  let count = 0
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count++
  return count
}

function replaceAt(text: string, search: string, replacement: string, all: boolean, finder = text): { text: string; count: number } {
  let out = ''
  let cursor = 0
  let count = 0
  for (let index = finder.indexOf(search); index !== -1; index = finder.indexOf(search, index + search.length)) {
    out += text.slice(cursor, index) + replacement
    cursor = index + search.length
    count++
    if (!all) break
  }
  return { text: out + text.slice(cursor), count }
}

/** The quotes `replacement` should use where the file uses straight quotes: straight. */
function matchQuoteStyle(replacement: string): string {
  return straighten(replacement)
}

interface Candidate {
  /** What to look for in `finder`. */
  search: string
  replacement: string
  /** The text to search, when it differs from the file (same length, position for position). */
  finder?: string
}

function candidates(text: string, edit: EditSpec): Candidate[] {
  const list: Candidate[] = [{ search: edit.old_string, replacement: edit.new_string }]
  if (edit.old_string.includes('\n') && !edit.old_string.includes('\r\n') && text.includes('\r\n')) {
    list.push({ search: edit.old_string.replace(/\n/g, '\r\n'), replacement: edit.new_string.replace(/\r?\n/g, '\r\n') })
  }
  if (HAS_CURLY.test(edit.old_string) || HAS_CURLY.test(text)) {
    const finder = straighten(text)
    const search = straighten(edit.old_string)
    const replacement = HAS_CURLY.test(text) ? edit.new_string : matchQuoteStyle(edit.new_string)
    list.push({ search, replacement, finder })
    if (search.includes('\n') && text.includes('\r\n') && !search.includes('\r\n')) {
      list.push({ search: search.replace(/\n/g, '\r\n'), replacement: replacement.replace(/\r?\n/g, '\r\n'), finder })
    }
  }
  const oldLines = edit.old_string.split('\n')
  if (oldLines.every((line) => LINE_NUMBER_PREFIX.test(line))) {
    const strip = (value: string) =>
      value
        .split('\n')
        .map((line) => line.replace(LINE_NUMBER_PREFIX, ''))
        .join('\n')
    const newLines = edit.new_string.split('\n')
    const replacement = newLines.every((line) => LINE_NUMBER_PREFIX.test(line) || !line) ? strip(edit.new_string) : edit.new_string
    list.push({ search: strip(edit.old_string), replacement })
    if (text.includes('\r\n')) list.push({ search: strip(edit.old_string).replace(/\n/g, '\r\n'), replacement: replacement.replace(/\r?\n/g, '\r\n') })
  }
  return list
}

/** Applies one replacement. Errors are written for the model, and name what to do next. */
export function applyEdit(text: string, edit: EditSpec): EditOutcome {
  if (edit.old_string === edit.new_string) {
    return { ok: false, error: 'old_string and new_string are identical, so there is nothing to change.' }
  }
  if (!edit.old_string) {
    return { ok: false, error: 'old_string is empty. Give the exact text to replace; an empty old_string only creates a new file.' }
  }
  for (const candidate of candidates(text, edit)) {
    const finder = candidate.finder ?? text
    const count = countOccurrences(finder, candidate.search)
    if (!count) continue
    if (count > 1 && !edit.replace_all) {
      return {
        ok: false,
        error: `old_string occurs ${count} times. Add surrounding lines so it matches exactly one place, or set replace_all to true to change every occurrence.`,
      }
    }
    const result = replaceAt(text, candidate.search, candidate.replacement, Boolean(edit.replace_all), finder)
    return { ok: true, text: result.text, replacements: result.count }
  }
  return {
    ok: false,
    error: 'old_string was not found in the file. Read the file again and copy the text exactly, including indentation, without the line-number prefix.',
  }
}

/** Applies edits in order, each to the result of the one before. All or nothing. */
export function applyEdits(text: string, edits: readonly EditSpec[]): EditOutcome {
  let current = text
  let replacements = 0
  for (const [index, edit] of edits.entries()) {
    const outcome = applyEdit(current, edit)
    if (!outcome.ok) return { ok: false, error: edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ${outcome.error} No edit was applied.` : outcome.error }
    current = outcome.text
    replacements += outcome.replacements
  }
  return { ok: true, text: current, replacements }
}

/** The 1-based lines of `after` around its first difference from `before`, for showing the model what changed. */
export function changedRegion(before: string, after: string, context = 4): { start: number; end: number } | undefined {
  if (before === after) return undefined
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const start = Math.max(1, prefix + 1 - context)
  const end = Math.min(b.length, b.length - suffix + context)
  return { start, end: Math.max(start, end) }
}
