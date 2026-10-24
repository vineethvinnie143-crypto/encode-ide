/**
 * String replacement for Edit and MultiEdit.
 *
 * The match is exact first. When that fails, forgiving passes run, and each
 * must still find exactly the text it is looking for:
 *   - line endings: the model sent \n, the file uses \r\n;
 *   - quotes: the model sent curly quotes, the file has straight ones (or the
 *     reverse); the replacement keeps the file's style;
 *   - line numbers: the model copied Read's `cat -n` prefixes along;
 *   - indentation (ADR 0089): whole lines that differ only in their
 *     indentation, by the same amount on every line, or in trailing spaces,
 *     at exactly one place. new_string is indented the same way, and the
 *     result says so.
 * When nothing matches, the error shows the closest lines of the file and
 * how each differs, so the next try copies them.
 */

export interface EditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export type EditOutcome = { ok: true; text: string; replacements: number; notes?: string[] } | { ok: false; error: string }

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

const indentOf = (line: string) => line.slice(0, line.length - line.trimStart().length)

/** How the file's indentation differs from old_string's, the same on every line: a function from one to the other. */
interface Shift {
  apply(indent: string): string | null
  /** In words, for the note: "4 more spaces". */
  words: string
}

function shiftBetween(from: string, to: string): Shift | null {
  if (from === to) return { apply: (indent) => indent, words: 'the same indentation' }
  if (to.endsWith(from)) {
    const extra = to.slice(0, to.length - from.length)
    return { apply: (indent) => extra + indent, words: `${describeIndent(extra)} more` }
  }
  if (from.endsWith(to)) {
    const less = from.slice(0, from.length - to.length)
    return { apply: (indent) => (indent.startsWith(less) ? indent.slice(less.length) : null), words: `${describeIndent(less)} less` }
  }
  // Spaces in old_string where the file has tabs, or the reverse, at a fixed number of spaces per tab.
  if (/^ +$/.test(from) && /^\t+$/.test(to) && from.length % to.length === 0) {
    const width = from.length / to.length
    return { apply: (indent) => (/^ *$/.test(indent) && indent.length % width === 0 ? '\t'.repeat(indent.length / width) : null), words: `tabs for every ${width} spaces` }
  }
  if (/^\t+$/.test(from) && /^ +$/.test(to) && to.length % from.length === 0) {
    const width = to.length / from.length
    return { apply: (indent) => (/^\t*$/.test(indent) ? ' '.repeat(indent.length * width) : null), words: `${width} spaces for every tab` }
  }
  return null
}

function describeIndent(indent: string): string {
  const tabs = indent.split('\t').length - 1
  const spaces = indent.length - tabs
  const parts = [tabs ? `${tabs} ${tabs === 1 ? 'tab' : 'tabs'}` : '', spaces ? `${spaces} ${spaces === 1 ? 'space' : 'spaces'}` : ''].filter(Boolean)
  return parts.join(' and ')
}

/** old_string's lines, without the empty one a closing newline leaves. */
function wantedLines(oldString: string): { lines: string[]; closed: boolean } {
  const lines = oldString.replace(/\r\n/g, '\n').split('\n')
  const closed = lines.length > 1 && lines[lines.length - 1] === ''
  return { lines: closed ? lines.slice(0, -1) : lines, closed }
}

/**
 * The one place whose whole lines are old_string's but for their indentation (shifted alike on every line) or trailing
 * spaces, with new_string indented the same way. Null when there is none, more than one, or new_string cannot be.
 */
function shiftedMatch(text: string, edit: EditSpec): { text: string; note: string } | null {
  const { lines: wanted, closed } = wantedLines(edit.old_string)
  const first = wanted.findIndex((line) => line.trim())
  // Too little text to place by its words alone (a lone brace, `end`).
  if (first < 0 || wanted.reduce((sum, line) => sum + line.trim().length, 0) < 8) return null
  const lines = text.split('\n')
  const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)
  let found: { start: number; shift: Shift } | null = null
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (bare(lines[start + first]).trim() !== wanted[first].trim()) continue
    // The shift is read where the indentation first differs; every other line must agree with it.
    const differs = wanted.findIndex((line, offset) => line.trim() && indentOf(line) !== indentOf(bare(lines[start + offset])))
    const shift = differs < 0 ? shiftBetween('', '') : shiftBetween(indentOf(wanted[differs]), indentOf(bare(lines[start + differs])))
    if (!shift) continue
    const fits = wanted.every((line, offset) => {
      const have = bare(lines[start + offset])
      if (!line.trim()) return !have.trim()
      return have.trim() === line.trim() && shift.apply(indentOf(line)) === indentOf(have)
    })
    if (!fits) continue
    if (found) return null
    found = { start, shift }
  }
  if (!found) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const { lines: replacement, closed: newClosed } = wantedLines(edit.new_string)
  const shifted: string[] = []
  for (const line of edit.new_string ? replacement : []) {
    if (!line.trim()) {
      shifted.push('')
      continue
    }
    const indent = found.shift.apply(indentOf(line))
    if (indent === null) return null
    shifted.push(indent + line.trimStart())
  }
  const startAt = lines.slice(0, found.start).reduce((sum, line) => sum + line.length + 1, 0)
  const last = found.start + wanted.length - 1
  let endAt = startAt + lines.slice(found.start, last).reduce((sum, line) => sum + line.length + 1, 0) + bare(lines[last]).length
  // old_string took its closing newline and new_string gives none back: the line break goes too.
  if (closed && !newClosed && endAt < text.length) endAt += text.startsWith('\r\n', endAt) ? 2 : 1
  const body = shifted.join(eol) + (!closed && newClosed ? eol : '')
  const range = wanted.length > 1 ? `lines ${found.start + 1}-${last + 1}` : `line ${found.start + 1}`
  const how = found.shift.words === 'the same indentation' ? 'once trailing spaces are left aside' : `once indented with ${found.shift.words}`
  return {
    text: text.slice(0, startAt) + body + text.slice(endAt),
    note: `old_string matched ${range} only ${how}, as the file has it; new_string was indented the same way. Copy text from Read exactly, spacing included.`,
  }
}

/** Letter pairs of a line, for how alike two lines are. */
function pairsOf(line: string): Map<string, number> {
  const pairs = new Map<string, number>()
  for (let index = 0; index < line.length - 1; index++) {
    const pair = line.slice(index, index + 2)
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  return pairs
}

/** How alike two lines are, from 0 to 1 (Dice's coefficient of their letter pairs). */
function alike(a: string, b: string, pairs: (line: string) => Map<string, number>): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const left = pairs(a)
  const right = pairs(b)
  let shared = 0
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0)
  return (2 * shared) / (a.length - 1 + b.length - 1)
}

/** The work the closest-lines search may do, in line comparisons. */
const CLOSEST_BUDGET = 400_000
const CLOSEST_SHOWN = 6

/**
 * The lines of the file most like old_string, and each line where they differ, both shown as they are. A model told
 * "line 41 has `price * quantity` where you wrote `price * qty`" copies the real text; told "not found", it guesses.
 */
function closestHint(text: string, oldString: string): string {
  const { lines: wanted } = wantedLines(oldString)
  const keys = wanted.map((line) => line.trim().replace(/\s+/g, ' '))
  const lines = text.split(/\r?\n/)
  if (!keys.some((key) => key.length >= 4) || wanted.length > lines.length || wanted.length * lines.length > CLOSEST_BUDGET) return ''
  const squeezed = lines.map((line) => line.trim().replace(/\s+/g, ' '))
  const cache = new Map<string, Map<string, number>>()
  const pairs = (line: string) => {
    let found = cache.get(line)
    if (!found) cache.set(line, (found = pairsOf(line)))
    return found
  }
  let best = { start: -1, score: 0 }
  const enough = 0.75 * wanted.length
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    let score = 0
    for (let offset = 0; offset < wanted.length; offset++) {
      score += keys[offset] || squeezed[start + offset] ? alike(keys[offset], squeezed[start + offset], pairs) : 1
      // Even if every line left were the same, this place could not beat the best one, or be close enough.
      if (score + wanted.length - offset - 1 < Math.max(enough, best.score * wanted.length)) break
    }
    if (score / wanted.length > best.score) best = { start, score: score / wanted.length }
  }
  if (best.start < 0 || best.score < 0.75) return ''
  const differ: string[] = []
  for (let offset = 0; offset < wanted.length && differ.length < CLOSEST_SHOWN * 2; offset++) {
    const have = lines[best.start + offset]
    if (have === wanted[offset].replace(/\r$/, '')) continue
    const show = (line: string) => JSON.stringify(line.length > 160 ? `${line.slice(0, 160)}…` : line)
    differ.push(`  old_string line ${offset + 1}: ${show(wanted[offset])}`, `  file line ${best.start + offset + 1}: ${show(have)}`)
  }
  if (!differ.length) return ''
  const range = wanted.length > 1 ? `lines ${best.start + 1}-${best.start + wanted.length}` : `line ${best.start + 1}`
  return ` The closest text is at ${range}. Where it differs:\n${differ.join('\n')}\nCopy those lines from the file as they are.`
}

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

  const closest = closestHint(text, oldString)
  if (closest) return closest

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
  const shifted = shiftedMatch(text, edit)
  if (shifted) return { ok: true, text: shifted.text, replacements: 1, notes: [shifted.note] }
  return {
    ok: false,
    error: `old_string was not found in the file. Read the file again and copy the text exactly, including indentation, without the line-number prefix.${notFoundHint(text, edit.old_string)}`,
  }
}

/** Applies edits in order, each to the result of the one before. All or nothing. */
export function applyEdits(text: string, edits: readonly EditSpec[]): EditOutcome {
  let current = text
  let replacements = 0
  const notes: string[] = []
  for (const [index, edit] of edits.entries()) {
    const outcome = applyEdit(current, edit)
    if (!outcome.ok) return { ok: false, error: edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ${outcome.error} No edit was applied.` : outcome.error }
    current = outcome.text
    replacements += outcome.replacements
    for (const note of outcome.notes ?? []) notes.push(edits.length > 1 ? `Edit ${index + 1}: ${note}` : note)
  }
  return { ok: true, text: current, replacements, ...(notes.length ? { notes } : {}) }
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
