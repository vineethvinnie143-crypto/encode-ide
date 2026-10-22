import { T, TokenBuilder } from '../language'

/**
 * A cursor over one line for hand-written tokenizers. Tokens are marked at
 * their start (`mark`) and run until the next mark; matching uses sticky
 * regular expressions so no substrings are created.
 */
export class Scanner {
  pos = 0
  private readonly builder = new TokenBuilder()
  /** Loop checks left before the scanner decides a tokenizer is stuck. */
  private budget: number

  constructor(readonly text: string) {
    this.budget = text.length * 16 + 256
  }

  /**
   * True at the end of the line. Every tokenizer loop asks this, so it is
   * also where a loop that stopped advancing is caught: a bug in a
   * tokenizer must never freeze the editor.
   */
  get eol(): boolean {
    if (--this.budget < 0) throw new TokenizerStall(this.text, this.pos)
    return this.pos >= this.text.length
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? ''
  }

  startsWith(prefix: string): boolean {
    return this.text.startsWith(prefix, this.pos)
  }

  /** Consumes a match of the sticky `pattern` at the cursor; null when it does not match here. */
  match(pattern: RegExp): string | null {
    pattern.lastIndex = this.pos
    const found = pattern.exec(this.text)
    if (!found || found[0].length === 0) return null
    this.pos += found[0].length
    return found[0]
  }

  /** True when `pattern` matches at the cursor, without consuming it. */
  sees(pattern: RegExp): boolean {
    pattern.lastIndex = this.pos
    return pattern.test(this.text)
  }

  /** Marks a token of `kind` starting at `from`. */
  mark(from: number, kind: number): void {
    this.builder.push(from, kind)
  }

  /** Consumes a match and marks it as `kind`. */
  token(pattern: RegExp, kind: number): boolean {
    const start = this.pos
    if (this.match(pattern) === null) return false
    this.mark(start, kind)
    return true
  }

  /** Consumes `count` characters as `kind`. */
  take(count: number, kind: number): void {
    this.mark(this.pos, kind)
    this.pos = Math.min(this.text.length, this.pos + count)
  }

  /** The rest of the line as `kind`. */
  rest(kind: number): void {
    if (this.eol) return
    this.mark(this.pos, kind)
    this.pos = this.text.length
  }

  /** The text before the cursor is only whitespace. */
  atLineStart(): boolean {
    for (let index = 0; index < this.pos; index++) {
      const char = this.text[index]
      if (char !== ' ' && char !== '\t') return false
    }
    return true
  }

  /** The next character that is not whitespace, from `offset` past the cursor. */
  nextNonSpace(offset = 0): string {
    for (let index = this.pos + offset; index < this.text.length; index++) {
      const char = this.text[index]
      if (char !== ' ' && char !== '\t') return char
    }
    return ''
  }

  tokens(): number[] {
    // A token marked at the very end of the line covers nothing.
    const tokens = this.builder.tokens
    while (tokens.length && this.text.length && tokens[tokens.length - 2] >= this.text.length) tokens.length -= 2
    return tokens
  }
}

/** Thrown when a tokenizer stops making progress on a line. */
export class TokenizerStall extends Error {
  constructor(text: string, pos: number) {
    super(`Tokenizer made no progress at ${pos} in ${JSON.stringify(text.slice(Math.max(0, pos - 20), pos + 20))}`)
  }
}

export const WHITESPACE = /[ \t]+/y
export const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy
export const NUMBER =
  /(?:0[xX][\da-fA-F_]*(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.(?!\.)[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[\p{L}\d_]*/uy
/** A backslash escape in a string. */
export const ESCAPE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[0-7]{1,3}|[^])/y

/**
 * A quoted string with backslash escapes, from the opening quote at the
 * cursor. Returns true when the line ends inside it after a backslash (the
 * string continues on the next line).
 */
export function quoted(scanner: Scanner, quote: string, escapes = true): boolean {
  scanner.take(1, T.string)
  return quotedBody(scanner, quote, escapes)
}

/** The rest of a quoted string whose opening quote is already behind the cursor. True when it continues on the next line. */
export function quotedBody(scanner: Scanner, quote: string, escapes = true): boolean {
  const text = scanner.text
  let runStart = -1
  while (!scanner.eol) {
    const char = text[scanner.pos]
    if (char === quote) {
      if (runStart < 0) scanner.mark(scanner.pos, T.string)
      scanner.pos++
      return false
    }
    if (escapes && char === '\\') {
      if (scanner.pos === text.length - 1) {
        scanner.mark(scanner.pos, T.string)
        scanner.pos++
        return true
      }
      scanner.token(ESCAPE, T.escape)
      runStart = -1
      continue
    }
    if (runStart < 0) {
      runStart = scanner.pos
      scanner.mark(runStart, T.string)
    }
    scanner.pos++
  }
  return false
}

/** Parses a comma-separated context stack from a state string. */
export function stackOf(state: string): string[] {
  return state ? state.split(',') : []
}

export function words(list: string): ReadonlySet<string> {
  return new Set(list.split(/\s+/).filter(Boolean))
}
