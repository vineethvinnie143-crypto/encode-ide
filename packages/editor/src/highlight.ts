import type { ChangeSet, Text } from '@encode/text'
import { T, type Tokenizer } from './language'

/** Lines longer than this are tokenized up to here; the rest is plain (a minified bundle stays responsive). */
export const MAX_TOKENIZED_LINE = 10_000
/** A visible line this far past the known states is tokenized in one go; further away, its state is guessed. */
const SYNC_LINES = 3_000
/** Lines run from the start state to guess a far line's state. */
const GUESS_LINES = 80
/** Lines read on from the frontier, once per place it stops, to see whether the states settle on the old ones. */
const SETTLE_LINES = 256
/** Tokenized lines kept for reuse. */
const CACHE_SIZE = 5_000
/** Lines tokenized between deadline checks. */
const BATCH = 256
/** The most lines, and characters, one batch for another thread holds. */
export const MAX_BATCH_LINES = 16_384
export const MAX_BATCH_CHARS = 1_000_000

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

/**
 * Lines for another thread (a worker) to tokenize, so the page's own thread only stores what comes back: the states
 * the lines end in and, with bracket colouring on, what each does to the bracket depth.
 */
export interface HighlightBatch {
  readonly id: number
  /** The language whose tokenizer reads the lines, by id. */
  readonly language: string
  /** The bracket pairs to note, or null while bracket colouring is off. */
  readonly brackets: readonly (readonly [string, string])[] | null
  /** The state the first line starts in. */
  readonly state: string
  /** The lines, each cut where tokenizing stops (MAX_TOKENIZED_LINE). */
  readonly lines: readonly string[]
}

/** What came back for a batch. */
export interface HighlightResult {
  readonly id: number
  /** The distinct states, which `states` points into. */
  readonly table: readonly string[]
  /** For each line, the state it ends in, as an index into `table`. */
  readonly states: Int32Array
  /** For each line, the lowest point and the net change of the bracket depth; null without brackets. */
  readonly summaries: Int32Array | null
}

/** Tokenizes batches somewhere else. Resolves null when it cannot: it does not know the language, or it failed. */
export interface HighlightService {
  run(batch: HighlightBatch): Promise<HighlightResult | null>
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
  private bracketPairs: readonly (readonly [string, string])[] | null = null
  /** The batch another thread is tokenizing; `dirty` is the first line an edit has touched since it was made. */
  private inflight: { id: number; from: number; count: number; dirty: number } | null = null
  private batchId = 0
  /** The frontier where settling on old states was last tried. */
  private settleTried = -1
  /** The last far line drawn from a guess, so the next one down goes on from it instead of guessing again. */
  private lastGuess: { line: number; state: string; valid: number; doc: Text } | null = null

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
    this.inflight = null
    this.lastGuess = null
  }

  /**
   * Turns bracket colouring on with these pairs, or off with null. While it is on, tokenizing a line also notes what
   * it does to the depth, so the depth at any line known exactly costs one sum over the lines above it.
   */
  setBrackets(pairs: readonly (readonly [string, string])[] | null): void {
    if (!pairs?.length) {
      if (!this.bracketChars) return
      this.bracketChars = null
      this.bracketPairs = null
      this.resetBrackets()
      this.inflight = null
      return
    }
    const chars = bracketCharsOf(pairs)
    const same = this.bracketChars && this.bracketChars.size === chars.size && [...chars].every(([code, dir]) => this.bracketChars!.get(code) === dir)
    if (same) return
    this.bracketChars = chars
    this.bracketPairs = pairs
    this.resetBrackets()
    this.inflight = null
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
    // A batch out on another thread still holds for the lines above the edit.
    if (this.inflight) this.inflight.dirty = Math.min(this.inflight.dirty, first)
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
    if (n - 1 >= this.valid) {
      if (n - 1 - this.valid <= SYNC_LINES) this.advance(n, Infinity)
      else if (this.states.length > this.valid && this.settleTried !== this.valid) {
        // After an edit the states usually settle on the old ones within a line or two, and all below holds again.
        // Reading every line up to a far one here would hold up the frame, so it is tried once per place.
        this.advance(this.valid + SETTLE_LINES, Infinity)
        this.settleTried = this.valid
      }
    }
    if (n - 1 < this.valid) state = this.states.get(n - 1)!
    else {
      exact = false
      state = this.guess(n)
    }
    const text = this.doc.line(n).text
    const cached = this.cache.get(n)
    if (cached && cached.text === text && cached.state === state) return { tokens: cached.tokens, exact }
    const result = this.tokenize(text, state)
    if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(n, { text, state, tokens: result.tokens })
    return { tokens: result.tokens, exact }
  }

  /** A start state for line `n`, far past the frontier: from the lines just above it, or on from the line above's. */
  private guess(n: number): string {
    const last = this.lastGuess
    const fresh = last !== null && last.valid === this.valid && last.doc === this.doc
    // A line is read twice in a row for its tokens and its brackets.
    if (fresh && last.line === n) return last.state
    let state: string
    if (fresh && last.line === n - 1) {
      state = this.tokenize(this.doc.line(n - 1).text, last.state).state
    } else {
      state = this.tokenizer.start
      const from = Math.max(this.valid, n - GUESS_LINES)
      for (const text of this.doc.lineTexts(from, n - 1)) state = this.tokenize(text, state).state
    }
    this.lastGuess = { line: n, state, valid: this.valid, doc: this.doc }
    return state
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

  /**
   * The next lines for another thread to tokenize, from the first whose start state is not known yet; null when every
   * state is known or a batch is still out. `language` is the id of the language whose tokenizer this is.
   */
  nextBatch(language: string, maxLines = MAX_BATCH_LINES, maxChars = MAX_BATCH_CHARS): HighlightBatch | null {
    if (this.inflight || this.done) return null
    const from = this.valid
    // The last line's end state starts no line, so it is not asked for (as tokenizing here does not).
    const last = Math.min(this.doc.lineCount - 1, from + Math.max(1, maxLines) - 1)
    const lines: string[] = []
    let chars = 0
    for (const text of this.doc.lineTexts(from, last)) {
      const line = text.length > MAX_TOKENIZED_LINE ? text.slice(0, MAX_TOKENIZED_LINE) : text
      if (lines.length && chars + line.length + 1 > maxChars) break
      lines.push(line)
      chars += line.length + 1
    }
    const id = ++this.batchId
    this.inflight = { id, from, count: lines.length, dirty: Infinity }
    return { id, language, brackets: this.bracketPairs, state: this.states.get(from - 1)!, lines }
  }

  /**
   * Stores what another thread found for the batch out now, for the lines no edit has reached since. Stops where a
   * state equals the one the line had before an edit, as tokenizing here does. True when the known states moved on.
   */
  acceptBatch(result: HighlightResult): boolean {
    const flight = this.inflight
    if (!flight || result.id !== flight.id) return false
    this.inflight = null
    if (!wellFormed(result, flight.count, this.bracketChars !== null)) return false
    const limit = Math.min(flight.from + flight.count, flight.dirty)
    if (this.valid < flight.from || this.valid >= limit) return false
    try {
      for (let index = this.valid; index < limit; index++) {
        const local = index - flight.from
        const state = result.table[result.states[local]]
        if (this.bracketChars) this.summaries.set(index - 1, result.summaries![local * 2], result.summaries![local * 2 + 1])
        if (index < this.states.length && this.states.get(index) === state) {
          this.states.set(index, state)
          this.valid = this.states.nextUnverified(index + 1)
          break
        }
        this.states.set(index, state)
        this.valid = index + 1
      }
    } finally {
      this.states.unverify(this.valid)
    }
    return true
  }

  /** Forgets the batch out now: what comes back for it is ignored, and the next one starts where the states end. */
  dropBatch(): void {
    this.inflight = null
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
    return tokenizeLine(this.tokenizer, text, state, this.onError)
  }
}

/** One line's tokens and end state, as far as tokenizing goes on a long line; a tokenizer that throws leaves it plain. */
function tokenizeLine(tokenizer: Tokenizer, text: string, state: string, onError?: ((error: unknown) => void) | null): { tokens: number[]; state: string } {
  try {
    if (text.length <= MAX_TOKENIZED_LINE) return tokenizer.line(text, state)
    const head = tokenizer.line(text.slice(0, MAX_TOKENIZED_LINE), state)
    return { tokens: [...head.tokens, MAX_TOKENIZED_LINE, T.plain], state: head.state }
  } catch (error) {
    // A tokenizer bug costs this line its colours, never the editor.
    onError?.(error)
    return { tokens: text ? [0, T.plain] : [], state }
  }
}

/** Bracket characters by code: 1 opens, -1 closes. Only single characters count. */
function bracketCharsOf(pairs: readonly (readonly [string, string])[]): Map<number, number> {
  const chars = new Map<number, number>()
  for (const [open, close] of pairs) {
    if (open.length === 1) chars.set(open.charCodeAt(0), 1)
    if (close.length === 1) chars.set(close.charCodeAt(0), -1)
  }
  return chars
}

/** Whether a batch's result has a state for each of its `count` lines, within its table, and summaries when asked. */
function wellFormed(result: HighlightResult, count: number, brackets: boolean): boolean {
  const { table, states, summaries } = result
  if (!Array.isArray(table) || !(states instanceof Int32Array) || states.length !== count) return false
  for (const state of table) if (typeof state !== 'string') return false
  for (let index = 0; index < count; index++) if (states[index] < 0 || states[index] >= table.length) return false
  if (!brackets) return true
  if (!(summaries instanceof Int32Array) || summaries.length !== count * 2) return false
  for (let index = 0; index < count; index++) if (summaries[index * 2] > 0) return false
  return true
}

/**
 * Tokenizes a batch, as another thread does: the state each line ends in and, when the batch names brackets, what
 * each line does to the bracket depth. `onError` hears about a tokenizer that throws (the line counts as plain).
 */
export function tokenizeBatch(tokenizer: Tokenizer, batch: HighlightBatch, onError?: (error: unknown) => void): HighlightResult {
  const count = batch.lines.length
  const states = new Int32Array(count)
  const table: string[] = []
  const ids = new Map<string, number>()
  const chars = batch.brackets?.length ? bracketCharsOf(batch.brackets) : null
  const summaries = chars ? new Int32Array(count * 2) : null
  let state = batch.state
  for (let index = 0; index < count; index++) {
    const text = batch.lines[index]
    const result = tokenizeLine(tokenizer, text, state, onError)
    state = result.state
    let id = ids.get(state)
    if (id === undefined) {
      id = table.length
      table.push(state)
      ids.set(state, id)
    }
    states[index] = id
    if (chars) {
      let low = 0
      let net = 0
      scanBrackets(text, result.tokens, chars, (_offset, dir) => {
        net += dir
        if (net < low) low = net
      })
      summaries![index * 2] = low
      summaries![index * 2 + 1] = net
    }
  }
  return { id: batch.id, table, states, summaries }
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
