/**
 * What the editor knows about a language: comment markers and brackets for
 * the editing commands, and a line tokenizer for highlighting.
 */

/** Token kinds; the view renders kind `name` as the class `tok-<name>`. */
export const TOKEN_NAMES = [
  'plain',
  'comment',
  'string',
  'number',
  'keyword',
  'type',
  'function',
  'punct',
  'operator',
  'tag',
  'attr',
  'value',
  'key',
  'bool',
  'heading',
  'emphasis',
  'strong',
  'variable',
  'link',
  'meta',
  'regexp',
  'escape',
  'property',
  'constant',
  'inserted',
  'deleted',
  'code',
] as const

export type TokenName = (typeof TOKEN_NAMES)[number]

/** Token kind numbers, by name. */
export const T = Object.fromEntries(TOKEN_NAMES.map((name, index) => [name, index])) as { [K in TokenName]: number }

export interface LineTokens {
  /** Flat [start, kind, start, kind, ...]: each token runs to the next one's start, the last to the end of the line. */
  tokens: number[]
  /** The tokenizer state at the end of the line. */
  state: string
}

/**
 * Tokenizes a document one line at a time. A state is an opaque string that
 * carries multi-line constructs (an open block comment, a template literal)
 * from one line to the next; equal strings mean equal states, which is how
 * the highlighter knows re-tokenizing after an edit can stop.
 */
export interface Tokenizer {
  readonly start: string
  line(text: string, state: string): LineTokens
}

export interface Language {
  readonly id: string
  readonly name: string
  readonly lineComment?: string
  readonly blockComment?: readonly [string, string]
  /** Bracket pairs, for matching and auto-closing. */
  readonly brackets: readonly (readonly [string, string])[]
  /** Quote characters that auto-close. */
  readonly quotes: readonly string[]
  /** Characters besides letters, digits and `_` that belong to words (`$` in JavaScript, `-` in CSS). */
  readonly wordChars?: string
  /** When the text before the cursor matches, Enter indents the next line one more level (Python's `:`). */
  readonly indentAfter?: RegExp
  /** A line that, once typed, closes a block and moves back one level (Lua's `end`, a closing HTML tag). */
  readonly dedentOn?: RegExp
  readonly tokenizer: Tokenizer
}

const plainTokenizer: Tokenizer = {
  start: '',
  line: (text) => ({ tokens: text ? [0, T.plain] : [], state: '' }),
}

export const BRACKETS: readonly (readonly [string, string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]

export const plainText: Language = {
  id: 'plaintext',
  name: 'Plain Text',
  brackets: BRACKETS,
  quotes: [],
  tokenizer: plainTokenizer,
}

/** Builds a token list, merging neighbours of the same kind. */
export class TokenBuilder {
  readonly tokens: number[] = []

  push(start: number, kind: number): void {
    const count = this.tokens.length
    if (count && this.tokens[count - 1] === kind) return
    if (count && this.tokens[count - 2] === start) {
      // The previous token was empty: replace it.
      this.tokens[count - 1] = kind
      if (count >= 4 && this.tokens[count - 3] === kind) this.tokens.length = count - 2
      return
    }
    this.tokens.push(start, kind)
  }
}
