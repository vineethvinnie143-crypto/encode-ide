import type { DiffHunk } from '@encode/tools'

/**
 * Finds characters in newly written text that make it read differently from what it is: text-direction controls
 * that reorder a line on screen ("Trojan Source", CVE-2021-42574), invisible tag and zero-width characters that
 * carry hidden text, control characters that rewrite a terminal, variation selectors with nothing to vary, and
 * letters from another script that look like Latin ones (a Cyrillic "а" in "admin").
 *
 * Pure and fast: a line of printable ASCII is passed over with one loop. Only the lines a call adds are scanned,
 * so what was already in the file is never blamed on the call. The findings go on the approval card and into the
 * note the model reads after the write. (A command that holds such characters never reaches the Reviewer: the
 * fixed checks in front of it stop the line.)
 *
 * The characters themselves are never shown. A finding names them by code point and shows the surrounding
 * text with each one replaced by a marker, so a card cannot be tricked by what it reports.
 */

export type FindingKind = 'direction' | 'tag' | 'invisible' | 'control' | 'linebreak' | 'variation' | 'lookalike'

export interface Finding {
  kind: FindingKind
  /** The 1-based line of the file (or of the scanned text) the characters are on. */
  line: number
  /** What was found and why it matters, as a clause. Free of hidden characters, so it is safe to show. */
  what: string
}

export interface ScanResult {
  findings: Finding[]
  /** Findings past the cap, which are not listed. */
  omitted: number
}

export interface ScanOptions {
  /** Source, configuration or a script: look-alike letters count even in whole words, and every direction mark does. */
  code: boolean
}

const MAX_FINDINGS = 8
const MAX_DECODED = 60
const MAX_SNIPPET = 72

type Family = 'tag' | 'variation' | 'direction' | 'format' | 'control' | 'linebreak'

const KIND: Record<Family, FindingKind> = {
  tag: 'tag',
  variation: 'variation',
  direction: 'direction',
  format: 'invisible',
  control: 'control',
  linebreak: 'linebreak',
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index)

/** Embeddings, overrides and isolates: they reorder what a line shows, whatever the file is. */
const DIRECTION = new Set([...range(0x202a, 0x202e), ...range(0x2066, 0x2069)])
/** Marks that only nudge direction: ordinary in right-to-left prose, a surprise next to code. */
const MARKS = new Set([0x061c, 0x200e, 0x200f])
/** Characters with no glyph of their own, apart from the direction ones. */
const FORMAT = new Set([
  ...MARKS,
  0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x200b, 0x200c, 0x200d, 0x2800, 0x3164, 0xfeff, 0xffa0, 0x1d159,
  ...range(0x2060, 0x2064),
  ...range(0x206a, 0x206f),
  ...range(0xfff9, 0xfffb),
  ...range(0x1d173, 0x1d17a),
])
/** No legitimate use today, so they count even with nothing ASCII beside them. */
const ALWAYS = new Set([0x3164, 0xffa0, 0x1d159, ...range(0x206a, 0x206f), ...range(0xfff9, 0xfffb), ...range(0x1d173, 0x1d17a)])

const NAMES = new Map<number, string>([
  [0x00ad, 'soft hyphen'],
  [0x034f, 'combining grapheme joiner'],
  [0x061c, 'Arabic letter mark'],
  [0x115f, 'Hangul choseong filler'],
  [0x1160, 'Hangul jungseong filler'],
  [0x17b4, 'Khmer inherent vowel'],
  [0x17b5, 'Khmer inherent vowel'],
  [0x180b, 'Mongolian free variation selector'],
  [0x180c, 'Mongolian free variation selector'],
  [0x180d, 'Mongolian free variation selector'],
  [0x180e, 'Mongolian vowel separator'],
  [0x180f, 'Mongolian free variation selector'],
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x2028, 'line separator'],
  [0x2029, 'paragraph separator'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2060, 'word joiner'],
  [0x2061, 'function application'],
  [0x2062, 'invisible times'],
  [0x2063, 'invisible separator'],
  [0x2064, 'invisible plus'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
  [0x206a, 'inhibit symmetric swapping'],
  [0x206b, 'activate symmetric swapping'],
  [0x206c, 'inhibit Arabic form shaping'],
  [0x206d, 'activate Arabic form shaping'],
  [0x206e, 'national digit shapes'],
  [0x206f, 'nominal digit shapes'],
  [0x2800, 'Braille blank'],
  [0x3164, 'Hangul filler'],
  [0xfeff, 'byte order mark'],
  [0xffa0, 'halfwidth Hangul filler'],
  [0xfff9, 'interlinear annotation anchor'],
  [0xfffa, 'interlinear annotation separator'],
  [0xfffb, 'interlinear annotation terminator'],
  [0x1d159, 'musical null notehead'],
  [0x0000, 'null'],
  [0x0007, 'bell'],
  [0x0008, 'backspace'],
  [0x000b, 'vertical tab'],
  [0x000d, 'carriage return'],
  [0x001b, 'escape'],
  [0x007f, 'delete'],
  [0x0085, 'next line'],
  [0x2215, 'division slash'],
  [0x29f8, 'big solidus'],
  [0xff0f, 'fullwidth solidus'],
  [0x2216, 'set minus'],
  [0x29f5, 'reverse solidus operator'],
  [0xff3c, 'fullwidth reverse solidus'],
  [0xfe68, 'small reverse solidus'],
  [0x037e, 'Greek question mark'],
  [0x2024, 'one dot leader'],
])

/** Cyrillic letters drawn the same as a Latin letter in common fonts, and the letter they pass for. */
const CYRILLIC_LIKE = new Map<number, string>([
  [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'], [0x0455, 's'],
  [0x0456, 'i'], [0x0458, 'j'], [0x04bb, 'h'], [0x04cf, 'l'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'],
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041a, 'K'], [0x041c, 'M'], [0x041d, 'H'], [0x041e, 'O'], [0x0420, 'P'],
  [0x0421, 'C'], [0x0422, 'T'], [0x0423, 'Y'], [0x0425, 'X'], [0x0405, 'S'], [0x0406, 'I'], [0x0408, 'J'], [0x04c0, 'I'],
  [0x051a, 'Q'], [0x051c, 'W'],
])
const GREEK_LIKE = new Map<number, string>([
  [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'], [0x0399, 'I'], [0x039a, 'K'], [0x039c, 'M'],
  [0x039d, 'N'], [0x039f, 'O'], [0x03a1, 'P'], [0x03a4, 'T'], [0x03a5, 'Y'], [0x03a7, 'X'], [0x03bf, 'o'], [0x03bd, 'v'],
])
/** Punctuation that stands in for a path or statement separator. Only counted in code, next to ASCII. */
const PUNCTUATION_LIKE = new Map<number, string>([
  [0x2215, '/'], [0x29f8, '/'], [0xff0f, '/'], [0x2216, '\\'], [0x29f5, '\\'], [0xff3c, '\\'], [0xfe68, '\\'], [0x037e, ';'], [0x2024, '.'],
])

const SCRIPT_LATIN = /^\p{Script=Latin}$/u
const SCRIPT_ARMENIAN = /^\p{Script=Armenian}$/u
const SCRIPT_CHEROKEE = /^\p{Script=Cherokee}$/u
const SCRIPT_COPTIC = /^\p{Script=Coptic}$/u
const SCRIPT_LISU = /^\p{Script=Lisu}$/u
const WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_$]$/u
const LETTER = /^\p{L}$/u
const ASCII_LETTERS = /^[A-Za-z]+$/

const OPEN = String.fromCodePoint(0x2039)
const CLOSE = String.fromCodePoint(0x203a)

const hex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`

function label(c: number): string {
  const name = NAMES.get(c)
  return name ? `${hex(c)} (${name})` : hex(c)
}

function labels(codes: readonly number[]): string {
  const distinct = [...new Set(codes)]
  const shown = distinct.slice(0, 3).map(label).join(', ')
  return distinct.length > 3 ? `${shown} and ${distinct.length - 3} more kinds` : shown
}

const printable = (c: number | undefined): boolean => c !== undefined && c > 0x20 && c < 0x7f
const asciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

function familyOf(c: number, last: boolean): Family | undefined {
  if (c < 0x7f) {
    if (c >= 0x20 || c === 0x09 || c === 0x0c) return undefined
    // A carriage return ending the line is a Windows line ending.
    if (c === 0x0d && last) return undefined
    return 'control'
  }
  if (c < 0xa0) return c === 0x85 ? 'linebreak' : 'control'
  if (c < 0x00ad) return undefined
  if (c === 0x2028 || c === 0x2029) return 'linebreak'
  if (DIRECTION.has(c)) return 'direction'
  if (FORMAT.has(c)) return 'format'
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x180b && c <= 0x180d) || c === 0x180f || (c >= 0xe0100 && c <= 0xe01ef)) return 'variation'
  if (c >= 0xe0000 && c <= 0xe007f) return 'tag'
  return undefined
}

/** True when a code point is drawn as itself, so a finding may quote it. */
function drawn(c: number): boolean {
  if (c < 0x7f) return c >= 0x20
  return c >= 0xa0 && (c < 0xd800 || c > 0xdfff) && familyOf(c, false) === undefined
}

/** Text around a find, with each hidden character replaced by its marker. */
function render(points: Int32Array, from: number, to: number): string {
  let out = ''
  for (let k = from; k < to && out.length < MAX_SNIPPET; k++) {
    const c = points[k]
    if (c === 0x09) out += ' '
    else out += drawn(c) ? String.fromCodePoint(c) : `${OPEN}${hex(c)}${CLOSE}`
  }
  return out.length >= MAX_SNIPPET ? `${out}...` : out
}

function around(points: Int32Array, count: number, i: number, j: number): string {
  const head = render(points, Math.max(0, i - 8), i)
  const body = render(points, i, Math.min(j, i + 6))
  const tail = render(points, j, Math.min(count, j + 8))
  return `${head}${body}${j - i > 6 ? `${OPEN}+${j - i - 6} more${CLOSE}` : ''}${tail}`
}

function emojiBase(c: number | undefined): boolean {
  if (c === undefined) return false
  return (
    c === 0x00a9 || c === 0x00ae || c === 0x203c || c === 0x2049 || c === 0x2122 || c === 0x2139 || c === 0x20e3 || c === 0x24c2 ||
    c === 0x3030 || c === 0x303d || c === 0x3297 || c === 0x3299 ||
    (c >= 0x2194 && c <= 0x21aa) || (c >= 0x231a && c <= 0x23ff) || (c >= 0x25aa && c <= 0x25fe) || (c >= 0x2600 && c <= 0x27bf) ||
    (c >= 0x2934 && c <= 0x2935) || (c >= 0x2b05 && c <= 0x2b55) || (c >= 0x1f000 && c <= 0x1faff)
  )
}

function ideograph(c: number | undefined): boolean {
  if (c === undefined) return false
  return (
    (c >= 0x2e80 && c <= 0x2fdf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x3134f)
  )
}

/** Bases that take one of the older variation selectors (FE00 to FE0D) in the standard's list. */
function variantBase(c: number | undefined): boolean {
  if (c === undefined) return false
  return ideograph(c) || (c >= 0x2200 && c <= 0x22ff) || (c >= 0x2a00 && c <= 0x2aff) || (c >= 0xa840 && c <= 0xa87f) || (c >= 0x1820 && c <= 0x18af)
}

const keycapBase = (c: number | undefined): boolean => c !== undefined && (c === 0x23 || c === 0x2a || (c >= 0x30 && c <= 0x39))

function decodeTags(points: Int32Array, i: number, j: number): string {
  let text = ''
  for (let k = i; k < j; k++) {
    const c = points[k]
    if (c >= 0xe0020 && c <= 0xe007e) text += String.fromCharCode(c - 0xe0000)
  }
  return text.length > MAX_DECODED ? `${text.slice(0, MAX_DECODED)}...` : text
}

function judgeTags(points: Int32Array, count: number, i: number, j: number): string | undefined {
  // The flags of England, Scotland and Wales are a black flag, a short code spelled in tag letters and a cancel tag.
  const payload = j - i - 1
  if (i > 0 && points[i - 1] === 0x1f3f4 && points[j - 1] === 0xe007f && payload >= 2 && payload <= 7) {
    let flag = true
    for (let k = i; k < j - 1; k++) {
      const c = points[k]
      if (!((c >= 0xe0030 && c <= 0xe0039) || (c >= 0xe0061 && c <= 0xe007a))) flag = false
    }
    if (flag) return undefined
  }
  const text = decodeTags(points, i, j)
  const size = j - i
  const noun = size === 1 ? 'an invisible tag character' : `${size} invisible tag characters`
  if (text) return `${noun} that spell "${text}"`
  return `${noun} (${labels(Array.from(points.subarray(i, j)))}) in "${around(points, count, i, j)}"`
}

function judgeVariation(points: Int32Array, count: number, i: number, j: number): string | undefined {
  const size = j - i
  if (size >= 2) return `${size} variation selectors in a row, which can carry hidden data, in "${around(points, count, i, j)}"`
  const c = points[i]
  const before = i > 0 ? points[i - 1] : undefined
  const after = j < count ? points[j] : undefined
  if (c === 0xfe0e || c === 0xfe0f) {
    if (emojiBase(before)) return undefined
    if (c === 0xfe0f && keycapBase(before) && after === 0x20e3) return undefined
  } else if (c >= 0xfe00 && c <= 0xfe0d) {
    if (variantBase(before)) return undefined
  } else if (c >= 0xe0100) {
    if (ideograph(before)) return undefined
  } else if (before !== undefined && before >= 0x1820 && before <= 0x18af) {
    return undefined
  }
  return `variation selector ${label(c)} where it changes nothing, in "${around(points, count, i, j)}"`
}

function judgeFormat(points: Int32Array, count: number, i: number, j: number, first: boolean, code: boolean): string | undefined {
  const run = Array.from(points.subarray(i, j))
  const size = run.length
  // A byte order mark opens a file.
  if (first && i === 0 && size === 1 && run[0] === 0xfeff) return undefined
  const before = i > 0 ? points[i - 1] : undefined
  const after = j < count ? points[j] : undefined
  const near = printable(before) || printable(after)
  let flagged = size >= 2 || near || run.some((c) => ALWAYS.has(c))
  if (!flagged && code && run.every((c) => MARKS.has(c))) flagged = true
  if (flagged && run.every((c) => c === 0x2800)) {
    // Braille pictures use the blank cell as paper.
    for (let k = 0; k < count; k++) if (points[k] > 0x2800 && points[k] <= 0x28ff) return undefined
  }
  if (!flagged) return undefined
  const where = `in "${around(points, count, i, j)}"`
  if (size === 1) return `invisible character ${label(run[0])} ${where}`
  return `${size} invisible characters in a row (${labels(run)}) ${where}`
}

const CONTROL_REASON = new Map<number, string>([
  [0x1b, 'a terminal can use it to rewrite what is shown'],
  [0x0d, 'in the middle of a line it can make a terminal show other text over this line'],
  [0x08, 'it moves a terminal back over text already shown'],
  [0x00, 'some programs stop reading text at it'],
])

function judgeControl(points: Int32Array, count: number, i: number, j: number): string {
  const run = Array.from(points.subarray(i, j))
  const reason = run.map((c) => CONTROL_REASON.get(c)).find((text) => text !== undefined)
  const what = run.length === 1 ? `control character ${label(run[0])}` : `${run.length} control characters (${labels(run)})`
  return `${what}${reason ? `: ${reason}` : ''}, in "${around(points, count, i, j)}"`
}

function judge(family: Family, points: Int32Array, count: number, i: number, j: number, first: boolean, code: boolean): string | undefined {
  switch (family) {
    case 'tag':
      return judgeTags(points, count, i, j)
    case 'variation':
      return judgeVariation(points, count, i, j)
    case 'format':
      return judgeFormat(points, count, i, j, first, code)
    case 'control':
      return judgeControl(points, count, i, j)
    case 'direction': {
      const run = Array.from(points.subarray(i, j))
      const what = run.length === 1 ? `text-direction control ${label(run[0])}` : `${run.length} text-direction controls (${labels(run)})`
      return `${what}, which can make the line read in a different order than it runs, in "${around(points, count, i, j)}"`
    }
    case 'linebreak': {
      const run = Array.from(points.subarray(i, j))
      return `unusual line break ${labels(run)}, which editors and compilers disagree about, in "${around(points, count, i, j)}"`
    }
  }
}

/** Where letters that pass for ASCII ones live: Greek, Cyrillic, Armenian, Cherokee, Coptic, Lisu, ligatures, fullwidth and mathematical forms. */
const maybeLookalike = (c: number): boolean =>
  (c >= 0x0370 && c <= 0x058f) ||
  (c >= 0x13a0 && c <= 0x13ff) ||
  (c >= 0x2c80 && c <= 0x2cff) ||
  (c >= 0xa4d0 && c <= 0xa4ff) ||
  (c >= 0xfb00 && c <= 0xfb06) ||
  (c >= 0xff21 && c <= 0xff5a) ||
  (c >= 0x1d400 && c <= 0x1d7ff)

const wordCharacter = (c: number): boolean => (c < 0x80 ? asciiLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x24 : WORD_CHARACTER.test(String.fromCodePoint(c)))

/** A letter that normalises to plain ASCII letters (fullwidth, mathematical, ligatures): code that is read through NFKC sees them as ASCII. */
function styled(c: number): boolean {
  if (c < 0x80 || c === 0xaa || c === 0xba) return false
  const character = String.fromCodePoint(c)
  return LETTER.test(character) && ASCII_LETTERS.test(character.normalize('NFKC'))
}

function foreignScript(character: string): string | undefined {
  if (SCRIPT_ARMENIAN.test(character)) return 'Armenian'
  if (SCRIPT_CHEROKEE.test(character)) return 'Cherokee'
  if (SCRIPT_COPTIC.test(character)) return 'Coptic'
  if (SCRIPT_LISU.test(character)) return 'Lisu'
  return undefined
}

const SHOWN_WORD = 40

/** A word as a finding quotes it: the letters in question as markers, a long word cut short. */
function shown(word: Int32Array, marks: ReadonlySet<number>): string {
  let out = ''
  for (let k = 0; k < word.length && k < SHOWN_WORD; k++) out += marks.has(word[k]) ? `${OPEN}${hex(word[k])}${CLOSE}` : String.fromCodePoint(word[k])
  return word.length > SHOWN_WORD ? `${out}...` : out
}

function asciiOnly(text: string): string {
  let out = ''
  for (const character of text.slice(0, SHOWN_WORD)) out += character >= '!' && character <= '~' ? character : '?'
  return text.length > SHOWN_WORD ? `${out}...` : out
}

function judgeWord(word: Int32Array, code: boolean): string | undefined {
  let latin = 0
  let others = 0
  const looks: number[] = []
  const scripts = new Set<string>()
  const foreign: number[] = []
  const styledLetters: number[] = []
  for (const c of word) {
    if (c < 0x80) {
      if (asciiLetter(c)) latin++
      continue
    }
    const character = String.fromCodePoint(c)
    const cyrillic = CYRILLIC_LIKE.has(c)
    const other = cyrillic || GREEK_LIKE.has(c) ? undefined : foreignScript(character)
    if (cyrillic || GREEK_LIKE.has(c)) {
      looks.push(c)
      foreign.push(c)
      scripts.add(cyrillic ? 'Cyrillic' : 'Greek')
    } else if (other) {
      foreign.push(c)
      scripts.add(other)
    } else if (styled(c)) {
      styledLetters.push(c)
    } else if (SCRIPT_LATIN.test(character)) {
      latin++
    } else if (LETTER.test(character)) {
      others++
    }
  }
  if (latin > 0 && foreign.length > 0) {
    const letters = foreign.slice(0, 3).map((c) => {
      const like = CYRILLIC_LIKE.get(c) ?? GREEK_LIKE.get(c)
      return like ? `${hex(c)}, which looks like Latin ${like}` : hex(c)
    })
    return `"${shown(word, new Set(foreign))}" mixes Latin letters with ${[...scripts].join(' and ')} ones (${letters.join('; ')})`
  }
  if (styledLetters.length > 0 && (latin > 0 || code)) {
    const plain = asciiOnly(String.fromCodePoint(...word.subarray(0, SHOWN_WORD)).normalize('NFKC'))
    return `"${shown(word, new Set(styledLetters))}" has letters that are read as plain ASCII ("${plain}") although they are drawn differently`
  }
  const cyrillicLooks = looks.filter((c) => CYRILLIC_LIKE.has(c))
  if (code && latin === 0 && others === 0 && styledLetters.length === 0 && cyrillicLooks.length >= 3 && cyrillicLooks.length === looks.length) {
    const as = asciiOnly(looks.map((c) => CYRILLIC_LIKE.get(c)).join(''))
    return `"${shown(word, new Set(looks))}" is written in Cyrillic letters that look like the Latin word "${as}"`
  }
  return undefined
}

function lookalikes(points: Int32Array, count: number, line: number, code: boolean, add: (finding: Finding) => void): void {
  let done = 0
  for (let k = 0; k < count; k++) {
    const c = points[k]
    if (code && PUNCTUATION_LIKE.has(c) && (printable(k > 0 ? points[k - 1] : undefined) || printable(k + 1 < count ? points[k + 1] : undefined))) {
      add({
        kind: 'lookalike',
        line,
        what: `${label(c)} looks like "${PUNCTUATION_LIKE.get(c)}" but is a different character, in "${around(points, count, k, k + 1)}"`,
      })
    }
    if (k < done || !maybeLookalike(c)) continue
    if (!wordCharacter(c)) continue
    let from = k
    while (from > 0 && wordCharacter(points[from - 1])) from--
    let to = k + 1
    while (to < count && wordCharacter(points[to])) to++
    done = to
    const what = judgeWord(points.subarray(from, to), code)
    if (what) add({ kind: 'lookalike', line, what })
  }
}

function plain(text: string): boolean {
  const end = text.endsWith('\r') ? text.length - 1 : text.length
  for (let k = 0; k < end; k++) {
    const c = text.charCodeAt(k)
    if (c > 0x7e || (c < 0x20 && c !== 0x09)) return false
  }
  return true
}

function scanLine(text: string, line: number, code: boolean, add: (finding: Finding) => void): void {
  if (plain(text)) return
  const points = new Int32Array(text.length)
  let count = 0
  for (const character of text) points[count++] = character.codePointAt(0) as number
  const first = line === 1
  let i = 0
  while (i < count) {
    const family = familyOf(points[i], i === count - 1)
    if (!family) {
      i++
      continue
    }
    let j = i + 1
    while (j < count && familyOf(points[j], j === count - 1) === family) j++
    const what = judge(family, points, count, i, j, first, code)
    if (what) add({ kind: KIND[family], line, what })
    i = j
  }
  lookalikes(points, count, line, code, add)
}

function collector(): { add: (finding: Finding) => void; result: () => ScanResult } {
  const findings: Finding[] = []
  let omitted = 0
  return {
    add: (finding) => {
      if (findings.length < MAX_FINDINGS) findings.push(finding)
      else omitted++
    },
    result: () => ({ findings, omitted }),
  }
}

/** Scans text, such as the content of a new file or a shell command. Lines are numbered from 1. */
export function scanText(text: string, options: ScanOptions): ScanResult {
  const sink = collector()
  const lines = text.split('\n')
  for (let k = 0; k < lines.length; k++) scanLine(lines[k], k + 1, options.code, sink.add)
  return sink.result()
}

/** Scans the lines a diff adds. Context and removed lines are left alone, and findings carry the line number in the new file. */
export function scanHunks(hunks: readonly DiffHunk[], path: string): ScanResult {
  const code = isCodePath(path)
  const sink = collector()
  for (const hunk of hunks) {
    let next = hunk.newStart
    for (const entry of hunk.lines) {
      if (entry.type === 'del') continue
      const number = entry.newNo ?? next
      next = number + 1
      if (entry.type === 'add') scanLine(entry.text, number, code, sink.add)
    }
  }
  return sink.result()
}

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb', 'php', 'pl', 'pm', 'lua', 'r', 'sql', 'graphql', 'gql',
  'proto', 'tf', 'hcl', 'gradle', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'sol',
  'dart', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'zig', 'nim', 'vim', 'el', 'lisp', 'mk', 'cmake', 'dockerfile',
])
const CODE_NAMES = new Set([
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile', 'brewfile', 'vagrantfile', 'justfile', '.gitignore',
  '.gitattributes', '.npmrc', '.editorconfig', '.bashrc', '.zshrc', '.profile',
])

/** Source, configuration and scripts, where a hidden character changes what runs. Prose files get the gentler rules. */
export function isCodePath(path: string): boolean {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (CODE_NAMES.has(base) || base.startsWith('.env')) return true
  const dot = base.lastIndexOf('.')
  return dot > 0 && CODE_EXTENSIONS.has(base.slice(dot + 1))
}

/** The findings as lines for an approval card. */
export function formatFindings(result: ScanResult): string[] {
  const lines = result.findings.map((finding) => `Line ${finding.line}: ${finding.what}`)
  if (result.omitted) lines.push(`and ${result.omitted} more`)
  return lines
}

/** Text with every hidden or control character replaced by its marker, for showing something a model or a file chose, such as a path. */
export function visible(text: string): string {
  let out = ''
  for (const character of text) {
    const c = character.codePointAt(0) as number
    out += c === 0x09 ? ' ' : drawn(c) ? character : `${OPEN}${hex(c)}${CLOSE}`
  }
  return out
}

/** What the model reads after a write that holds such characters: where they are, and to remove them unless they are meant. */
export function warningNote(path: string, result: ScanResult): string {
  return `Heads-up: ${visible(path)} now contains characters that are invisible or look like others:\n${formatFindings(result)
    .map((line) => `- ${line}`)
    .join('\n')}\nRewrite those lines without them unless they are meant to be there.`
}
