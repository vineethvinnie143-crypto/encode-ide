import type { ChangeSet, Text } from '@encode/text'
import { T, type Tokenizer } from './language'

/** Lines longer than this are tokenized up to here; the rest is plain (a minified bundle stays responsive). */
export const MAX_TOKENIZED_LINE = 10_000
/** A visible line this far past the known states is tokenized in one go; further away, its state is guessed. */
const SYNC_LINES = 3_000
/** Lines run from the start state to guess a far line's state. */
const GUESS_LINES = 80
/** Tokenized lines kept for reuse. */
const CACHE_SIZE = 5_000
/** Lines tokenized between deadline checks. */
const BATCH = 256

const NONE = -1

/**
 * Line start states as small integers (each distinct state string gets an
 * id), so an edit that adds or removes lines in a huge file moves a typed
 * array instead of a million strings.
 *
 * An entry is unknown, verified (it follows from the entry before it and
 * the line between them), or a candidate that has to be compared before it
 * counts: the state that followed an edited line before the edit. Candidates
 * are stored as `-id - 2`.
 */
class StateStore {
  private ids = new Int32Array(1024)
  length = 0
  private table: string[] = []
  private lookup = new Map<string, number>()

  /** The entry's state, verified or candidate; null when unknown. */
  get(index: number): string | null {
    const id = this.ids[index]
    if (id === NONE) return null
    return this.table[id >= 0 ? id : -id - 2]
  }

  /** Stores a verified state. */
  set(index: number, state: string): void {
    let id = this.lookup.get(state)
    if (id === undefined) {
      id = this.table.length
      this.table.push(state)
      this.lookup.set(state, id)
    }
    this.reserve(index + 1)
    this.ids[index] = id
    if (index >= this.length) this.length = index + 1
  }

  /** Turns a verified entry into a candidate. */
  unverify(index: number): void {
    const id = this.ids[index]
    if (index < this.length && id >= 0) this.ids[index] = -id - 2
  }

  /** Replaces `remove` entries at `start` with `insert` unknown ones. */
  splice(start: number, remove: number, insert: number): void {
    const tail = this.length - start - remove
    this.reserve(start + insert + Math.max(0, tail))
    if (tail > 0) this.ids.copyWithin(start + insert, start + remove, this.length)
    this.ids.fill(NONE, start, start + insert)
    this.length = start + insert + Math.max(0, tail)
  }

  truncate(length: number): void {
    this.length = Math.min(this.length, length)
  }

  /** The first entry at or after `from` that is unknown or a candidate, or `length`. */
  nextUnverified(from: number): number {
    const ids = this.ids
    for (let index = from; index < this.length; index++) if (ids[index] < 0) return index
    return this.length
  }

  private reserve(size: number): void {
    if (size <= this.ids.length) return
    let capacity = this.ids.length
    while (capacity < size) capacity *= 2
    const ids = new Int32Array(capacity)
    ids.set(this.ids.subarray(0, this.length))
    this.ids = ids
  }
}

/**
 * What one line does to the bracket depth, as two numbers: the lowest the depth goes below where the line started
 * (zero or less) and how far it ends from there. Unknown entries hold UNKNOWN (1, which no low point can be) in `low`.
 */
class SummaryStore {
  private data = new Int32Array(2048)
  length = 0

  /** The entry's low point, or UNKNOWN. */
  low(index: number): number {
    return index < this.length ? this.data[index * 2] : UNKNOWN
  }

  net(index: number): number {
    return this.data[index * 2 + 1]
  }

  set(index: number, low: number, net: number): void {
    this.reserve(index + 1)
    if (index >= this.length) {
      for (let at = this.length; at < index; at++) this.data[at * 2] = UNKNOWN
      this.length = index + 1
    }
    this.data[index * 2] = low
    this.data[index * 2 + 1] = net
  }

  /** Replaces `remove` entries at `start` with `insert` unknown ones. */
  splice(start: number, remove: number, insert: number): void {
    if (start >= this.length) return
    remove = Math.min(remove, this.length - start)
    const tail = this.length - start - remove
    this.reserve(start + insert + tail)
    this.data.copyWithin((start + insert) * 2, (start + remove) * 2, this.length * 2)
    for (let at = start; at < start + insert; at++) this.data[at * 2] = UNKNOWN
    this.length = start + insert + tail
  }

  clear(): void {
    this.length = 0
  }

  private reserve(size: number): void {
    if (size * 2 <= this.data.length) return
    let capacity = this.data.length
    while (capacity < size * 2) capacity *= 2
    const data = new Int32Array(capacity)
    data.set(this.data.subarray(0, this.length * 2))
    this.data = data
  }
}

const UNKNOWN = 1

/** The brackets of a line that bracket colouring paints: offsets with their depth, -1 for a closer with no opener. */
export interface LineBrackets {
  /** Flat [offset, depth, ...]. */
  readonly brackets: readonly number[]
  /** False when the depth the line starts at was not known yet. */
  readonly exact: boolean
}

export interface HighlightedLine {
  /** Flat [start, kind, ...] as a tokenizer produces them. */
  tokens: readonly number[]
  /** False when the line's start state was guessed because the lines above have not been tokenized yet. */
  exact: boolean
}

/**
 * Incremental highlighting. It keeps the tokenizer state at the start of
 * every line it has reached; an edit invalidates states from the edited
 * line on, and re-tokenizing stops as soon as a recomputed state equals the
 * one the line had before the edit, so typing in a large file re-tokenizes a
 * line or two. Far-away lines are highlighted from a guessed state until
 * background work (`work`) catches up.
 */
export class Highlighter {
  private states = new StateStore()
  /** states[0 .. valid) are right for the current document. Entry i is the state at the start of line i + 1. */
  private valid = 1
  private cache = new Map<number, { text: string; state: string; tokens: number[] }>()
  /** Bracket characters by code: 1 opens, -1 closes; null while bracket colouring is off. */
  private bracketChars: Map<number, number> | null = null
  /** summaries entry i: what line i + 1 does to the bracket depth. Kept for lines tokenized from a known state. */
  private summaries = new SummaryStore()
  /** depths[i]: the bracket depth at the start of line i + 1, right for depths[0 .. depthValid). */
  private depths = new Int32Array(1024)
  private depthValid = 1
  private bracketCache = new Map<number, { text: string; tokens: readonly number[]; depth: number; brackets: number[] }>()

  /** Told about tokenizer errors (the line falls back to plain text). */
  onError: ((error: unknown) => void) | null = null

  constructor(
    private tokenizer: Tokenizer,
    private doc: Text,
  ) {
    this.states.set(0, tokenizer.start)
  }

  /** Lines whose start state is known exactly. */
  get frontier(): number {
    return this.valid
  }

  get done(): boolean {
    return this.valid >= this.doc.lineCount
  }

  /** Switches language: everything is tokenized again. */
  setTokenizer(tokenizer: Tokenizer): void {
    this.tokenizer = tokenizer
    this.states = new StateStore()
    this.states.set(0, tokenizer.start)
    this.valid = 1
    this.cache.clear()
    this.resetBrackets()
  }

  /**
   * Turns bracket colouring on with these pairs, or off with null. While it is on, tokenizing a line also notes what
   * it does to the depth, so the depth at any line known exactly costs one sum over the lines above it.
   */
  setBrackets(pairs: readonly (readonly [string, string])[] | null): void {
    if (!pairs?.length) {
      if (!this.bracketChars) return
      this.bracketChars = null
      this.resetBrackets()
      return
    }
    const chars = new Map<number, number>()
    for (const [open, close] of pairs) {
      if (open.length === 1) chars.set(open.charCodeAt(0), 1)
      if (close.length === 1) chars.set(close.charCodeAt(0), -1)
    }
    const same = this.bracketChars && this.bracketChars.size === chars.size && [...chars].every(([code, dir]) => this.bracketChars!.get(code) === dir)
    if (same) return
    this.bracketChars = chars
    this.resetBrackets()
    // The known states hold, but their lines were never read for brackets: tokenize again from the top.
    this.states.truncate(1)
    this.valid = 1
  }

  private resetBrackets(): void {
    this.summaries.clear()
    this.depthValid = 1
    this.depths[0] = 0
    this.bracketCache.clear()
  }

  /** Follows a document change; `doc` is the document after it. */
  update(changes: ChangeSet, doc: Text): void {
    const old = this.doc
    this.doc = doc
    const span = changes.span()
    if (!span) return
    const first = old.lineAt(span.fromA).number
    const lastOld = old.lineAt(span.toA).number
    const lastNew = doc.lineAt(span.toB).number
    const known = this.states.length
    this.valid = Math.min(this.valid, first)
    if (this.bracketChars) {
      // The edited lines are read again; the depth at their first line still follows from the lines above it.
      this.summaries.splice(first - 1, lastOld - first + 1, lastNew - first + 1)
      this.depthValid = Math.min(this.depthValid, first)
    }
    if (known <= first) return
    if (known <= lastOld) {
      this.states.truncate(first)
      return
    }
    // Entries first..lastNew-1 follow edited lines and are unknown; entry lastNew keeps the old state
    // after the edit as a candidate, which re-tokenizing compares against.
    this.states.splice(first, lastOld - first, lastNew - first)
    this.states.unverify(lastNew)
  }

  /** Tokens for line `n` (1-based). */
  line(n: number): HighlightedLine {
    let state: string
    let exact = true
    // Usually a few lines settle on the states from before an edit and the rest hold again.
    if (n - 1 >= this.valid) this.advance(Math.min(n, this.valid + SYNC_LINES), Infinity)
    if (n - 1 < this.valid) state = this.states.get(n - 1)!
    else {
      exact = false
      state = this.tokenizer.start
      const from = Math.max(this.valid, n - GUESS_LINES)
      for (const text of this.doc.lineTexts(from, n - 1)) state = this.tokenize(text, state).state
    }
    const text = this.doc.line(n).text
    const cached = this.cache.get(n)
    if (cached && cached.text === text && cached.state === state) return { tokens: cached.tokens, exact }
    const result = this.tokenize(text, state)
    if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(n, { text, state, tokens: result.tokens })
    return { tokens: result.tokens, exact }
  }

  /**
   * The brackets of line `n` (1-based) outside strings and comments, with the depth each is at: an opener at the depth
   * before it, a closer at the depth it returns to. Empty while bracket colouring is off.
   */
  brackets(n: number): LineBrackets {
    const chars = this.bracketChars
    if (!chars) return { brackets: [], exact: true }
    const { tokens, exact: tokensExact } = this.line(n)
    const known = this.depthAt(n)
    const exact = tokensExact && known !== null
    const depth = known ?? this.guessDepth(n)
    const text = this.doc.line(n).text
    const cached = this.bracketCache.get(n)
    if (cached && cached.text === text && cached.tokens === tokens && cached.depth === depth) return { brackets: cached.brackets, exact }
    const brackets: number[] = []
    let current = depth
    scanBrackets(text, tokens, chars, (offset, dir) => {
      if (dir > 0) brackets.push(offset, current++)
      else if (current === 0) brackets.push(offset, -1)
      else brackets.push(offset, --current)
    })
    if (this.bracketCache.size >= CACHE_SIZE) this.bracketCache.delete(this.bracketCache.keys().next().value!)
    this.bracketCache.set(n, { text, tokens, depth, brackets })
    return { brackets, exact }
  }

  /** The bracket depth at the start of line `n`, or null while a line above it has not been read from a known state. */
  private depthAt(n: number): number | null {
    if (n <= this.depthValid) return this.depths[n - 1]
    if (n > this.valid) return null
    if (this.depths.length < n) {
      let capacity = this.depths.length
      while (capacity < n) capacity *= 2
      const depths = new Int32Array(capacity)
      depths.set(this.depths.subarray(0, this.depthValid))
      this.depths = depths
    }
    for (let line = this.depthValid; line < n; line++) {
      const low = this.summaries.low(line - 1)
      if (low === UNKNOWN) return null
      // A closer with nothing open is painted as stray and leaves the depth at zero.
      this.depths[line] = Math.max(this.depths[line - 1], -low) + this.summaries.net(line - 1)
      this.depthValid = line + 1
    }
    return this.depths[n - 1]
  }

  /** Far below what is known: the depth at the last known line, which the lines in between may not have changed. */
  private guessDepth(n: number): number {
    const known = Math.min(n, this.depthValid)
    return this.depths[known - 1] ?? 0
  }

  /** The token kind at `pos` (for bracket matching, which skips strings and comments). */
  kindAt(pos: number): number {
    const line = this.doc.lineAt(pos)
    const { tokens } = this.line(line.number)
    const offset = pos - line.from
    let kind: number = T.plain
    for (let index = 0; index < tokens.length && tokens[index] <= offset; index += 2) kind = tokens[index + 1]
    return kind
  }

  /** Tokenizes ahead until `deadline` (a performance.now() time); true while lines remain. */
  work(deadline: number): boolean {
    this.advance(this.doc.lineCount, deadline)
    return !this.done
  }

  /** Computes start states up to line `target` (1-based), or until the deadline passes. */
  private advance(target: number, deadline: number): void {
    try {
      this.compute(Math.min(target, this.doc.lineCount), deadline)
    } finally {
      // The entry past the frontier may follow a state that just changed: it has to be checked again.
      this.states.unverify(this.valid)
    }
  }

  private compute(target: number, deadline: number): void {
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()
    while (this.valid < target) {
      const end = Math.min(target, this.valid + BATCH)
      const texts = this.doc.lineTexts(this.valid, end - 1)
      let state = this.states.get(this.valid - 1)!
      let converged = false
      for (let offset = 0; offset < texts.length; offset++) {
        const index = this.valid
        const result = this.tokenize(texts[offset], state)
        state = result.state
        // Line `index` was read from a known state: note what it does to the bracket depth.
        if (this.bracketChars) this.summarize(index, texts[offset], result.tokens)
        if (index < this.states.length && this.states.get(index) === state) {
          // Same state as before the edit, and the lines below are unchanged: the old states hold
          // up to the next entry that still has to be checked.
          this.states.set(index, state)
          this.valid = this.states.nextUnverified(index + 1)
          converged = true
          break
        }
        this.states.set(index, state)
        this.valid = index + 1
      }
      if (!converged && now() > deadline) return
    }
  }

  private summarize(line: number, text: string, tokens: readonly number[]): void {
    let low = 0
    let net = 0
    scanBrackets(text, tokens, this.bracketChars!, (_offset, dir) => {
      net += dir
      if (net < low) low = net
    })
    this.summaries.set(line - 1, low, net)
  }

  private tokenize(text: string, state: string): { tokens: number[]; state: string } {
    try {
      if (text.length <= MAX_TOKENIZED_LINE) return this.tokenizer.line(text, state)
      const head = this.tokenizer.line(text.slice(0, MAX_TOKENIZED_LINE), state)
      return { tokens: [...head.tokens, MAX_TOKENIZED_LINE, T.plain], state: head.state }
    } catch (error) {
      // A tokenizer bug costs this line its colours, never the editor.
      this.onError?.(error)
      return { tokens: text ? [0, T.plain] : [], state }
    }
  }
}

/** Calls `found` for each bracket character of `text` that is not in a string, a comment or a regular expression. */
function scanBrackets(text: string, tokens: readonly number[], chars: ReadonlyMap<number, number>, found: (offset: number, dir: number) => void): void {
  const end = Math.min(text.length, MAX_TOKENIZED_LINE)
  let token = 0
  let kind: number = T.plain
  let next = tokens.length ? tokens[0] : Infinity
  for (let offset = 0; offset < end; offset++) {
    while (offset >= next) {
      kind = tokens[token + 1]
      token += 2
      next = token < tokens.length ? tokens[token] : Infinity
    }
    const dir = chars.get(text.charCodeAt(offset))
    if (dir === undefined || kind === T.string || kind === T.comment || kind === T.regexp) continue
    found(offset, dir)
  }
}

/**
 * Splits a line's tokens at `from`–`to` so a renderer can show part of a
 * line (wrapping, or a long line clipped to the viewport).
 */
export function sliceTokens(tokens: readonly number[], from: number, to: number): number[] {
  const out: number[] = []
  for (let index = 0; index < tokens.length; index += 2) {
    const start = tokens[index]
    const end = index + 2 < tokens.length ? tokens[index + 2] : Infinity
    if (end <= from || start >= to) continue
    out.push(Math.max(start, from) - from, tokens[index + 1])
  }
  return out
}
