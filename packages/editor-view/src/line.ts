import { TOKEN_NAMES, T } from '@encode/editor'

/** The class a token kind is drawn with. */
export const TOKEN_CLASSES: readonly string[] = TOKEN_NAMES.map((name) => `tok-${name}`)

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
 * not show at all: control characters, soft hyphens and zero-width, bidi and
 * line-separator characters. They are drawn as visible markers, so a
 * "Trojan Source" edit cannot hide in the editor.
 */
const CONTROL_CLASS = characterClass(
  0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x9f, 0xad, 0xad, 0x61c, 0x61c, 0x180e, 0x180e, 0x200b, 0x200f, 0x2028, 0x2029,
  0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xfeff, 0xfff9, 0xfffb,
)
const CONTROL = new RegExp(CONTROL_CLASS)
const CONTROL_GLOBAL = new RegExp(CONTROL_CLASS, 'g')

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
  return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
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
      last = match.index! + 1
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
 */
export function fillLine(
  dom: HTMLElement,
  text: string,
  tokens: readonly number[],
  from = 0,
  to = text.length,
  lead?: Node,
  highlights?: readonly (readonly [number, number])[],
): void {
  const nodes: Node[] = lead ? [lead] : []
  const add = (piece: string, kind: number, control: boolean, marked: boolean) => {
    if (control) {
      const span = document.createElement('span')
      span.className = marked ? 'enc-ctrl enc-zone-mark' : 'enc-ctrl'
      span.dataset.label = controlLabel(piece)
      // Not the character itself: a bidi control in the DOM would still reorder the text after it.
      span.textContent = ' '
      nodes.push(span)
    } else if (kind === T.plain && !marked) {
      nodes.push(document.createTextNode(piece))
    } else {
      const span = document.createElement('span')
      const name = TOKEN_CLASSES[kind] ?? 'tok-plain'
      span.className = marked ? `${name} enc-zone-mark` : name
      span.textContent = piece
      nodes.push(span)
    }
  }
  for (const segment of segmentsOf(text, tokens, from, to)) {
    if (!highlights?.length || segment.control) {
      add(segment.text, segment.kind, segment.control, !!highlights?.some(([a, b]) => a <= segment.start && segment.start < b))
      continue
    }
    // Cut the segment at the edges of the highlighted ranges.
    const end = segment.start + segment.text.length
    let cursor = segment.start
    for (const [a, b] of highlights) {
      if (b <= cursor || a >= end) continue
      const markFrom = Math.max(a, cursor)
      const markTo = Math.min(b, end)
      if (markFrom > cursor) add(text.slice(cursor, markFrom), segment.kind, false, false)
      add(text.slice(markFrom, markTo), segment.kind, false, true)
      cursor = markTo
    }
    if (cursor < end) add(text.slice(cursor, end), segment.kind, false, false)
  }
  dom.replaceChildren(...nodes)
}
