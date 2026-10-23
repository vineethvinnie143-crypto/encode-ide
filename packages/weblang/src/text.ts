/**
 * A document as the server keeps it, and the few LSP shapes its services answer with. Positions are LSP's: zero-based
 * lines and UTF-16 columns, which are JavaScript string offsets within a line.
 */

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export const Severity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const

export interface Diagnostic {
  range: Range
  severity: number
  message: string
  source: string
  code?: string
  /** 1: unnecessary, 2: deprecated. */
  tags?: number[]
}

/** LSP's CompletionItemKind, the ones used here. */
export const ItemKind = { Text: 1, Function: 3, Field: 5, Variable: 6, Class: 7, Module: 9, Property: 10, Unit: 11, Value: 12, Enum: 13, Keyword: 14, Snippet: 15, Color: 16, File: 17, Constant: 21, Struct: 22 } as const

export interface CompletionItem {
  label: string
  kind: number
  detail?: string
  documentation?: { kind: 'markdown'; value: string }
  /** The text that replaces `range`; the label when not set. */
  insertText?: string
  /** 2: a snippet with `$1` and `${1:text}`. */
  insertTextFormat?: 1 | 2
  range?: Range
  sortText?: string
  filterText?: string
  tags?: number[]
}

/** LSP's SymbolKind, the ones used here. */
export const SymbolKind = { File: 1, Module: 2, Namespace: 3, Class: 5, Property: 7, Field: 8, Function: 12, Variable: 13, Constant: 14, String: 15, Number: 16, Boolean: 17, Array: 18, Object: 19, Key: 20, Null: 21, Struct: 23, Event: 24 } as const

export interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

export interface FoldingRange {
  startLine: number
  endLine: number
  kind?: 'comment' | 'region' | 'imports'
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface Hover {
  contents: { kind: 'markdown'; value: string }
  range?: Range
}

export interface FormatOptions {
  tabSize: number
  insertSpaces: boolean
}

export class Document {
  private lineStarts: number[] | null = null

  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    private content: string,
  ) {}

  get text(): string {
    return this.content
  }

  private starts(): number[] {
    if (this.lineStarts) return this.lineStarts
    const starts = [0]
    const text = this.content
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 13) {
        if (text.charCodeAt(index + 1) === 10) index++
        starts.push(index + 1)
      } else if (code === 10) {
        starts.push(index + 1)
      }
    }
    this.lineStarts = starts
    return starts
  }

  get lineCount(): number {
    return this.starts().length
  }

  offsetAt(position: Position): number {
    const starts = this.starts()
    if (position.line < 0) return 0
    if (position.line >= starts.length) return this.content.length
    const start = starts[position.line]!
    const next = position.line + 1 < starts.length ? starts[position.line + 1]! : this.content.length
    // A column past the line's end stops before its line break.
    let end = next
    if (end > start && this.content.charCodeAt(end - 1) === 10) end--
    if (end > start && this.content.charCodeAt(end - 1) === 13) end--
    return Math.min(start + Math.max(0, position.character), end)
  }

  positionAt(offset: number): Position {
    const starts = this.starts()
    const clamped = Math.max(0, Math.min(offset, this.content.length))
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle]! <= clamped) low = middle
      else high = middle - 1
    }
    return { line: low, character: clamped - starts[low]! }
  }

  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) }
  }

  /** LSP's changes, in order: a range and its new text, or the whole text. */
  apply(changes: readonly { range?: Range; text: string }[], version: number): void {
    for (const change of changes) {
      if (!change.range) {
        this.content = change.text
      } else {
        const start = this.offsetAt(change.range.start)
        const end = Math.max(start, this.offsetAt(change.range.end))
        this.content = this.content.slice(0, start) + change.text + this.content.slice(end)
      }
      this.lineStarts = null
    }
    this.version = version
  }
}

/** Edit distance with a swap of two neighbours counted once (`dvi` for `div`), cut off at `limit`: for "did you mean". */
export function distance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1)
      current.push(value)
      if (value < best) best = value
    }
    if (best > limit) return limit + 1
    before = previous
    previous = current
  }
  return previous[b.length]!
}

/** The closest of `names` to `name`, when it is close enough to be a slip. */
export function closest(name: string, names: Iterable<string>): string | null {
  const limit = name.length <= 4 ? 1 : 2
  let best: string | null = null
  let bestDistance = limit + 1
  for (const candidate of names) {
    const value = distance(name, candidate, limit)
    if (value < bestDistance) {
      best = candidate
      bestDistance = value
    }
  }
  return best
}

/** Markdown with what a person wrote kept as text: the characters Markdown reads are escaped. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!<>|~]/g, (char) => `\\${char}`)
}
