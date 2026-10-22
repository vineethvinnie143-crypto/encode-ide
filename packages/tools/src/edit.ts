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

/** The 1-based lines where `search` starts, the first few. */
function startLines(text: string, search: string, limit = 5): number[] {
  const found: number[] = []
  let line = 1
  let from = 0
  for (let index = text.indexOf(search); index !== -1 && found.length < limit; index = text.indexOf(search, index + search.length)) {
    for (let newline = text.indexOf('\n', from); newline !== -1 && newline < index; newline = text.indexOf('\n', from)) {
      line++
      from = newline + 1
    }
    found.push(line)
  }
  return found
}

const HINT_LINES = 12

/**
 * Where the file has the text the model meant: the same lines with other spacing, or at least the
 * same first line. A model that is told where to look copies the real text instead of guessing again.
 */
function notFoundHint(text: string, oldString: string): string {
  const wanted = oldString.split(/\r?\n/)
  while (wanted.length > 1 && !wanted[wanted.length - 1].trim()) wanted.pop()
  const squeeze = (line: string) => line.trim().replace(/\s+/g, ' ')
  const keys = wanted.map(squeeze)
  if (!keys.some(Boolean)) return ''
  const lines = text.split(/\r?\n/)

  const starts: number[] = []
  for (let start = 0; start + keys.length <= lines.length && starts.length < 4; start++) {
    if (squeeze(lines[start]) === keys[0] && keys.every((key, offset) => squeeze(lines[start + offset]) === key)) starts.push(start)
  }
  if (starts.length === 1) {
    const [start] = starts
    const shown = lines.slice(start, start + Math.min(keys.length, HINT_LINES))
    const range = keys.length > 1 ? `lines ${start + 1}-${start + keys.length}` : `line ${start + 1}`
    return ` The same text is at ${range} with different spacing (indentation, tabs or trailing spaces). It reads:\n${shown.join('\n')}${keys.length > HINT_LINES ? '\n…' : ''}\nCopy it from here, spacing included.`
  }
  if (starts.length > 1) return ` The same text with different spacing is at lines ${starts.map((start) => start + 1).join(', ')}; copy the one you mean from Read, spacing included.`

  const lead = keys.findIndex((key) => key.length >= 6)
  if (lead === -1) return ''
  const hits = lines.flatMap((line, index) => (squeeze(line) === keys[lead] ? [index + 1] : [])).slice(0, 3)
  if (!hits.length) return ''
  return ` Line ${hits.join(', ')} of the file has the same text as line ${lead + 1} of old_string, but the lines around it differ. Read that part again and copy it exactly.`
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
      const where = startLines(finder, candidate.search)
      return {
        ok: false,
        error: `old_string occurs ${count} times (lines ${where.join(', ')}${count > where.length ? ', …' : ''}). Add surrounding lines so it matches exactly one place, or set replace_all to true to change every occurrence.`,
      }
    }
    const result = replaceAt(text, candidate.search, candidate.replacement, Boolean(edit.replace_all), finder)
    return { ok: true, text: result.text, replacements: result.count }
  }
  return {
    ok: false,
    error: `old_string was not found in the file. Read the file again and copy the text exactly, including indentation, without the line-number prefix.${notFoundHint(text, edit.old_string)}`,
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
