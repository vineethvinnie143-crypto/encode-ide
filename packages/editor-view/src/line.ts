import { TOKEN_NAMES, T } from '@encode/editor'
import { rowEnd, rowStart, type LineWrap } from './wrap'

/** The class a token kind is drawn with. */
export const TOKEN_CLASSES: readonly string[] = TOKEN_NAMES.map((name) => `tok-${name}`)

/**
 * A token kind as the view draws it carries more than the kind in its low 8 bits: bits 8 to 10 hold a bracket's colour
 * (1 to 3 by depth, 7 for a closer with no opener), and bit 11 says a server marked the name deprecated.
 */
export const KIND_MASK = 0xff
export const BRACKET_SHIFT = 8
const BRACKET_STRAY = 7
export const DEPRECATED = 1 << 11
/** Bracket colours cycle through this many. */
export const BRACKET_COLORS = 3

const classes = new Map<number, string>()

/** The classes a drawn token kind gets: its kind's, and its bracket colour's. */
export function tokenClass(kind: number): string {
  if (kind <= KIND_MASK) return TOKEN_CLASSES[kind] ?? 'tok-plain'
  let name = classes.get(kind)
  if (name === undefined) {
    const base = TOKEN_CLASSES[kind & KIND_MASK] ?? 'tok-plain'
    const bracket = (kind >> BRACKET_SHIFT) & 7
    name = bracket ? `${base} enc-bracket-${bracket === BRACKET_STRAY ? 'stray' : bracket}` : base
    if (kind & DEPRECATED) name += ' enc-deprecated'
    classes.set(kind, name)
  }
  return name
}

/** A line's tokens with each bracket made a token of its own carrying its colour, from the highlighter's [offset, depth] pairs. */
export function withBrackets(tokens: readonly number[], brackets: readonly number[], length: number): readonly number[] {
  if (!brackets.length) return tokens
  const source = !tokens.length || tokens[0] > 0 ? [0, T.plain, ...tokens] : tokens
  const out: number[] = []
  let next = 0
  for (let index = 0; index < source.length; index += 2) {
    const kind = source[index + 1]
    const end = index + 2 < source.length ? source[index + 2] : length
    let at = source[index]
    while (next < brackets.length && brackets[next] < end) {
      const offset = brackets[next]
      const depth = brackets[next + 1]
      next += 2
      if (offset < at) continue
      if (offset > at) out.push(at, kind)
      const colour = depth < 0 ? BRACKET_STRAY : (depth % BRACKET_COLORS) + 1
      out.push(offset, (kind & KIND_MASK) | (colour << BRACKET_SHIFT))
      at = offset + 1
    }
    if (at < end) out.push(at, kind)
  }
  return out
}

/** A stretch of a line a server named (a type, a parameter): its columns and the kind it is drawn as, flags included. */
export interface SemanticSpan {
  readonly from: number
  readonly to: number
  readonly kind: number
}

/**
 * A line's tokens with the stretches a server named drawn as it says, over the highlighter's own; `spans` are sorted
 * and apart (one that overlaps the one before is cut to start after it).
 */
export function withSemantic(tokens: readonly number[], spans: readonly SemanticSpan[], length: number): readonly number[] {
  if (!spans.length) return tokens
  const source = !tokens.length || tokens[0] > 0 ? [0, T.plain, ...tokens] : tokens
  const out: number[] = []
  const emit = (at: number, kind: number) => {
    const count = out.length
    if (count && out[count - 1] === kind) return
    if (count && out[count - 2] === at) {
      // Nothing was drawn with the kind before: replace it, and join this to the token before it when they match.
      if (count >= 4 && out[count - 3] === kind) out.length = count - 2
      else out[count - 1] = kind
      return
    }
    out.push(at, kind)
  }
  let index = 0
  let pos = 0
  // The highlighter's tokens from `pos` to `end`.
  const syntax = (end: number) => {
    while (pos < end) {
      while (index + 2 < source.length && source[index + 2] <= pos) index += 2
      emit(pos, source[index + 1])
      pos = Math.min(end, index + 2 < source.length ? source[index + 2] : length)
    }
  }
  for (const span of spans) {
    const from = Math.max(span.from, pos)
    const to = Math.min(span.to, length)
    if (to <= from) continue
    syntax(from)
    emit(from, span.kind)
    pos = to
  }
  syntax(length)
  return out
}

/** A hint drawn among a line's text without being part of it: a type a server worked out, a parameter's name. */
export interface InlaySpec {
  /** The column it is drawn before. */
  readonly from: number
  readonly to: number
  readonly label: string
  /** `compose`: what an input method is composing, drawn as text at the caret until it is committed. */
  readonly kind?: 'type' | 'parameter' | 'compose'
  readonly paddingLeft?: boolean
  readonly paddingRight?: boolean
}

/**
 * A hint as drawn: its column, its element, whether the caret at its column is drawn before it (a type's hint), and
 * whether it is a composition (the caret is drawn after it, where the input method types next).
 */
export interface DrawnInlay {
  readonly col: number
  readonly el: HTMLElement
  readonly caretBefore: boolean
  readonly compose?: boolean
}

/**
 * The element of a hint. Its label is drawn from an attribute, not held as text, so the line's text nodes still add
 * up to its text and every offset counts as the document does.
 */
function inlayElement(inlay: InlaySpec): HTMLElement {
  const span = document.createElement('span')
  let name = 'enc-inlay'
  if (inlay.kind) name += ` enc-inlay-${inlay.kind}`
  if (inlay.paddingLeft) name += ' enc-inlay-pl'
  if (inlay.paddingRight) name += ' enc-inlay-pr'
  span.className = name
  span.dataset.label = inlay.label
  span.setAttribute('aria-hidden', 'true')
  return span
}

/** A regular expression character class from inclusive code point pairs, so the source holds no hidden characters. */
function characterClass(...pairs: number[]): string {
  let body = ''
  for (let index = 0; index < pairs.length; index += 2) {
    body += String.fromCodePoint(pairs[index])
    if (pairs[index + 1] !== pairs[index]) body += `-${String.fromCodePoint(pairs[index + 1])}`
  }
  return `[${body}]`
}

/**
 * Characters that make code read differently from how it runs, or that do
 * not show at all: control characters, soft hyphens, line separators, bidi
 * controls, zero-width and filler characters, and the tag block (U+E0000 to
 * U+E007F), which spells out invisible ASCII. They are drawn as visible
 * markers, so neither a "Trojan Source" edit nor text hidden for a model to
 * read can sit in a file unseen. A marker covers one code point, which is two
 * UTF-16 units for the tag block.
 */
const CONTROL_CLASS = characterClass(
  0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x9f, 0xad, 0xad, 0x34f, 0x34f, 0x61c, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e,
  0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0x3164, 0x3164, 0xfeff, 0xfeff, 0xffa0, 0xffa0,
  0xfff9, 0xfffb, 0xe0000, 0xe007f,
)
const CONTROL = new RegExp(CONTROL_CLASS, 'u')
const CONTROL_GLOBAL = new RegExp(CONTROL_CLASS, 'gu')

/**
 * Text whose width the view can compute as columns times the character
 * width: printable ASCII, tabs, and the Latin, Greek and Cyrillic ranges
 * programming fonts cover. Anything else (wide and combining characters,
 * emoji, other scripts) is measured in the DOM.
 */
const SIMPLE = new RegExp(`^(?:[\\t\\x20-\\x7e]|${characterClass(0xa0, 0xac, 0xae, 0x2ff, 0x370, 0x4ff, 0x1e00, 0x1eff)})*$`)

export function isSimpleText(text: string): boolean {
  return SIMPLE.test(text)
}

export function hasControl(text: string): boolean {
  return CONTROL.test(text)
}

/** Right-to-left letters: Hebrew, Arabic, Syriac, Thaana, N'Ko and the other scripts written right to left. */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u

export function hasRtl(text: string): boolean {
  return RTL.test(text)
}

/**
 * The stretches of a line shown in reading order when right-to-left text is: each string and comment (the escapes in a
 * string with it), or in prose every stretch but inline code, that has right-to-left letters in it. Each is shown on
 * its own (isolated), so nothing in it can move the text around it; the code between them stays in stored order.
 * Sorted and apart.
 */
export function isolatesOf(text: string, tokens: readonly number[], prose: boolean): [number, number][] {
  if (!hasRtl(text)) return []
  const out: [number, number][] = []
  const take = (kind: number): boolean => {
    const base = kind & KIND_MASK
    return prose ? base !== T.code : base === T.string || base === T.escape || base === T.comment
  }
  const add = (from: number, to: number) => {
    if (from >= to) return
    const last = out[out.length - 1]
    if (last && last[1] === from) last[1] = to
    else out.push([from, to])
  }
  if (!tokens.length || tokens[0] > 0) {
    if (prose) add(0, tokens.length ? tokens[0] : text.length)
  }
  for (let index = 0; index < tokens.length; index += 2) {
    if (take(tokens[index + 1])) add(tokens[index], index + 2 < tokens.length ? tokens[index + 2] : text.length)
  }
  return out.filter(([from, to]) => RTL.test(text.slice(from, to)))
}

export interface Segment {
  text: string
  kind: number
  /** A character to draw as a marker rather than itself. */
  control: boolean
  /** Offset of the segment in the line. */
  start: number
}

/** The label drawn for a control character: U+200B. */
export function controlLabel(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * Splits `text[from, to)` along the token boundaries, and around control
 * characters, which get a segment of their own.
 */
export function segmentsOf(text: string, tokens: readonly number[], from = 0, to = text.length): Segment[] {
  const out: Segment[] = []
  const push = (start: number, end: number, kind: number) => {
    start = Math.max(start, from)
    end = Math.min(end, to)
    if (start >= end) return
    const piece = text.slice(start, end)
    if (!CONTROL.test(piece)) {
      out.push({ text: piece, kind, control: false, start })
      return
    }
    let last = 0
    for (const match of piece.matchAll(CONTROL_GLOBAL)) {
      if (match.index! > last) out.push({ text: piece.slice(last, match.index), kind, control: false, start: start + last })
      out.push({ text: match[0], kind, control: true, start: start + match.index! })
      last = match.index! + match[0].length
    }
    if (last < piece.length) out.push({ text: piece.slice(last), kind, control: false, start: start + last })
  }
  if (!tokens.length) {
    push(0, text.length, T.plain)
    return out
  }
  // Text before the first token is plain: a tokenizer must not make characters disappear.
  if (tokens[0] > 0) push(0, tokens[0], T.plain)
  for (let index = 0; index < tokens.length; index += 2) {
    const end = index + 2 < tokens.length ? tokens[index + 2] : text.length
    if (end <= from) continue
    if (tokens[index] >= to) break
    push(tokens[index], end, tokens[index + 1])
  }
  return out
}

/**
 * Fills a line element with the text of `text[from, to)`, split into token
 * spans. `lead` goes in front: the spacer that stands in for the part of a
 * long line that is not drawn. `highlights` are ranges (sorted, apart) drawn
 * with the class `enc-zone-mark`, for the words that changed in a review.
 * The spaces and tabs inside `whitespace` (ranges, sorted and apart) are drawn
 * with a mark: a run of spaces as one span of class `enc-ws-space`, a tab as
 * one of `enc-ws-tab`, the text itself unchanged so offsets still count.
 * The text inside `isolates` (from `isolatesOf`) goes in a span of class
 * `enc-bidi` each, shown in reading order; a hint at an isolate's edge stays
 * outside it.
 */
export function fillLine(
  dom: HTMLElement,
  text: string,
  tokens: readonly number[],
  from = 0,
  to = text.length,
  lead?: Node,
  highlights?: readonly (readonly [number, number])[],
  inlays?: readonly InlaySpec[],
  whitespace?: readonly (readonly [number, number])[] | null,
  isolates?: readonly (readonly [number, number])[],
): DrawnInlay[] {
  const nodes: Node[] = lead ? [lead] : []
  // Where each node starts in the line (-1 for the lead), and which are hints, for the isolates.
  const starts: number[] = lead ? [-1] : []
  const hints: boolean[] = lead ? [false] : []
  const push = (node: Node, start: number, hint = false) => {
    nodes.push(node)
    starts.push(start)
    hints.push(hint)
  }
  const drawn: DrawnInlay[] = []
  let nextInlay = 0
  // Pieces are added in order, so the stretch of marked whitespace a position might be in only moves on.
  let stretch = 0
  const markedAt = (pos: number): boolean => {
    while (stretch < whitespace!.length && whitespace![stretch][1] <= pos) stretch++
    return stretch < whitespace!.length && whitespace![stretch][0] <= pos
  }
  // The hints at or before column `col` that are not drawn yet go in now.
  const flush = (col: number) => {
    if (!inlays) return
    while (nextInlay < inlays.length && inlays[nextInlay].from <= col) {
      const inlay = inlays[nextInlay++]
      if (inlay.from < from) continue
      const el = inlayElement(inlay)
      push(el, inlay.from, true)
      const compose = inlay.kind === 'compose'
      drawn.push({ col: inlay.from, el, caretBefore: inlay.kind !== 'parameter' && !compose, compose })
    }
  }
  const addText = (piece: string, start: number, kind: number, marked: boolean) => {
    if (kind === T.plain && !marked) {
      push(document.createTextNode(piece), start)
    } else {
      const span = document.createElement('span')
      const name = tokenClass(kind)
      span.className = marked ? `${name} enc-zone-mark` : name
      span.textContent = piece
      push(span, start)
    }
  }
  const add = (piece: string, start: number, kind: number, control: boolean, marked: boolean) => {
    if (control) {
      const span = document.createElement('span')
      span.className = marked ? 'enc-ctrl enc-zone-mark' : 'enc-ctrl'
      span.dataset.label = controlLabel(piece)
      // Not the character itself: a bidi control in the DOM would still reorder the text after it.
      // One blank per UTF-16 unit it stands for, so offsets keep counting the way the document does.
      span.textContent = ' '.repeat(piece.length)
      push(span, start)
      return
    }
    if (!whitespace?.length || !WHITESPACE.test(piece)) return addText(piece, start, kind, marked)
    let at = 0
    while (at < piece.length) {
      let blank = at
      while (blank < piece.length && !(isBlank(piece.charCodeAt(blank)) && markedAt(start + blank))) blank++
      if (blank > at) addText(piece.slice(at, blank), start + at, kind, marked)
      if (blank >= piece.length) break
      const code = piece.charCodeAt(blank)
      let end = blank + 1
      if (code === 32) while (end < piece.length && piece.charCodeAt(end) === 32 && markedAt(start + end)) end++
      const span = document.createElement('span')
      span.className = `${code === 32 ? 'enc-ws enc-ws-space' : 'enc-ws enc-ws-tab'}${marked ? ' enc-zone-mark' : ''}`
      span.textContent = piece.slice(blank, end)
      push(span, start + blank)
      at = end
    }
  }
  const segments = segmentsOf(text, tokens, from, to)
  for (const segment of inlays?.length ? splitAt(segments, inlays) : segments) {
    flush(segment.start)
    if (!highlights?.length || segment.control) {
      add(segment.text, segment.start, segment.kind, segment.control, !!highlights?.some(([a, b]) => a <= segment.start && segment.start < b))
      continue
    }
    // Cut the segment at the edges of the highlighted ranges.
    const end = segment.start + segment.text.length
    let cursor = segment.start
    for (const [a, b] of highlights) {
      if (b <= cursor || a >= end) continue
      const markFrom = Math.max(a, cursor)
      const markTo = Math.min(b, end)
      if (markFrom > cursor) add(text.slice(cursor, markFrom), cursor, segment.kind, false, false)
      add(text.slice(markFrom, markTo), markFrom, segment.kind, false, true)
      cursor = markTo
    }
    if (cursor < end) add(text.slice(cursor, end), cursor, segment.kind, false, false)
  }
  flush(to)
  dom.replaceChildren(...(isolates?.length ? isolated(nodes, starts, hints, isolates) : nodes))
  return drawn
}

/** The nodes, those of each isolate in a span of its own; a hint at an isolate's edge stays outside. */
function isolated(nodes: readonly Node[], starts: readonly number[], hints: readonly boolean[], isolates: readonly (readonly [number, number])[]): Node[] {
  const out: Node[] = []
  let next = 0
  const inside = (index: number, [from, to]: readonly [number, number]) => (hints[index] ? starts[index] > from && starts[index] < to : starts[index] >= from && starts[index] < to)
  for (let index = 0; index < nodes.length; ) {
    while (next < isolates.length && isolates[next][1] <= starts[index]) next++
    if (starts[index] < 0 || next >= isolates.length || !inside(index, isolates[next])) {
      out.push(nodes[index++])
      continue
    }
    const span = document.createElement('span')
    span.className = 'enc-bidi'
    while (index < nodes.length && starts[index] >= 0 && inside(index, isolates[next])) span.append(nodes[index++])
    out.push(span)
  }
  return out
}

const WHITESPACE = /[ \t]/
const isBlank = (code: number): boolean => code === 32 || code === 9

/**
 * Fills a wrapped line's element with its rows `rowFrom`..`rowTo`, a block each, as `fillLine` fills a line: rows
 * after the first are indented by the line's wrap indent. A hint goes in the row its column starts (at a break, the
 * row after it; at the line's end, the last).
 */
export function fillRows(
  dom: HTMLElement,
  text: string,
  tokens: readonly number[],
  wrap: LineWrap,
  rowFrom: number,
  rowTo: number,
  inlays?: readonly InlaySpec[],
  whitespace?: readonly (readonly [number, number])[] | null,
  isolates?: readonly (readonly [number, number])[],
): DrawnInlay[] {
  const rows: HTMLElement[] = []
  const drawn: DrawnInlay[] = []
  for (let row = rowFrom; row < rowTo; row++) {
    const from = rowStart(wrap, row)
    const to = rowEnd(wrap, row, text.length)
    const el = document.createElement('div')
    el.className = 'enc-row'
    if (row > 0 && wrap.indent) el.style.paddingLeft = `calc(var(--enc-char-w) * ${wrap.indent})`
    const last = row === wrap.breaks.length
    const mine = inlays?.length ? inlays.filter((inlay) => inlay.from >= from && (inlay.from < to || (last && inlay.from === to))) : undefined
    for (const inlay of fillLine(el, text, tokens, from, to, undefined, undefined, mine, whitespace, isolates)) drawn.push(inlay)
    rows.push(el)
  }
  dom.replaceChildren(...rows)
  return drawn
}

/** Segments cut where a hint goes, so that it can go between two of them; a control character's marker is not cut. */
function splitAt(segments: readonly Segment[], inlays: readonly InlaySpec[]): Segment[] {
  const out: Segment[] = []
  let next = 0
  for (const segment of segments) {
    const end = segment.start + segment.text.length
    while (next < inlays.length && inlays[next].from <= segment.start) next++
    if (segment.control || next >= inlays.length || inlays[next].from >= end) {
      out.push(segment)
      continue
    }
    let start = segment.start
    for (; next < inlays.length && inlays[next].from < end; next++) {
      const at = inlays[next].from
      if (at <= start) continue
      out.push({ ...segment, text: segment.text.slice(start - segment.start, at - segment.start), start })
      start = at
    }
    out.push({ ...segment, text: segment.text.slice(start - segment.start), start })
  }
  return out
}
