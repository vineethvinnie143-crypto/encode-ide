/**
 * The code of a file without its comments and the insides of its strings (ADR 0090), so that a definition written
 * in a comment, or a brace inside a string, does not count. Each character keeps its place: what is left out becomes
 * spaces, line breaks stay, and a string keeps its quotes. A definition found in the result is read from the same
 * place in the file as it is written, and a string named in a call (a FiveM event) is read from between its quotes.
 *
 * A lexer per family of languages, not a parser: a line it reads wrong costs one definition, never the file. A
 * string that runs to the end of its line without closing ends there, so one odd quote cannot hide what follows.
 */

export interface Syntax {
  /** What starts a comment to the end of the line. */
  line: readonly string[]
  /** Comments with an end: `/* … *\/`. */
  block: readonly (readonly [string, string])[]
  /** Quotes of strings that end at their line's end unless escaped: `"` and `'`. */
  quotes: string
  /** Quotes whose strings may span lines (shell, Ruby, PHP, SQL, PowerShell). */
  multiline?: string
  /** Backticks: a JavaScript template (with `${…}`), a raw string to the next backtick (Go), or a quote (SQL). */
  backtick?: 'template' | 'raw'
  /** `'''` and `"""` (Python, and the text blocks of Java, Kotlin, Swift and C#). */
  triple?: boolean
  /** Lua's `[[ … ]]` and `--[[ … ]]`, with any number of `=` between the brackets. */
  luaLong?: boolean
  /** JavaScript's regular expression literals. */
  regex?: boolean
  /** Rust: lifetimes are not quotes, and raw strings `r#"…"#`. */
  rust?: boolean
  /** C#'s `@"…"`, where `""` is a quote. */
  verbatim?: boolean
  /** `#` starts a comment only at the start of a word (shell): `$#` and `${#x}` are code. */
  hashAtWord?: boolean
  /** Ruby's `=begin` … `=end`. */
  rubyBlock?: boolean
}

const C_LIKE: Syntax = { line: ['//'], block: [['/*', '*/']], quotes: `"'` }

export const SYNTAX = {
  c: C_LIKE,
  js: { ...C_LIKE, backtick: 'template', regex: true },
  go: { ...C_LIKE, backtick: 'raw' },
  jvm: { ...C_LIKE, triple: true },
  csharp: { ...C_LIKE, triple: true, verbatim: true },
  rust: { line: ['//'], block: [['/*', '*/']], quotes: '"', rust: true },
  python: { line: ['#'], block: [], quotes: `"'`, triple: true },
  lua: { line: ['--'], block: [], quotes: `"'`, luaLong: true },
  ruby: { line: ['#'], block: [], quotes: '', multiline: `"'`, rubyBlock: true },
  shell: { line: ['#'], block: [], quotes: '', multiline: `"'`, hashAtWord: true },
  powershell: { line: ['#'], block: [['<#', '#>']], quotes: '', multiline: `"'` },
  php: { line: ['//', '#'], block: [['/*', '*/']], quotes: '', multiline: `"'` },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: '', multiline: `'` },
} as const satisfies Record<string, Syntax>

export type SyntaxName = keyof typeof SYNTAX

const NEWLINE = 10
const BACKSLASH = 92
const isWordCode = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127
const isSpaceCode = (code: number) => code === 32 || code === 9 || code === 13 || code === NEWLINE || code === 12 || code === 11

/** After these, a `/` starts a regular expression rather than a division. */
const BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split('').map((char) => char.charCodeAt(0)))
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

/** The text with comments and the insides of strings made spaces, each character in its place. */
export function codeOnly(text: string, syntax: Syntax): string {
  const n = text.length
  // [start, end) ranges to blank, in order.
  const blanks: number[] = []
  const blank = (start: number, end: number) => {
    if (end > start) blanks.push(start, end)
  }
  // Brace depths at which a JavaScript template's `${` was opened.
  const templates: number[] = []
  let braces = 0
  let lastCode = -1
  let lastWord = ''
  let i = 0

  /** From `start`, inside a template, to its end or its next `${`. Returns where the code goes on. */
  const template = (start: number): number => {
    let j = start
    while (j < n) {
      const code = text.charCodeAt(j)
      if (code === BACKSLASH) {
        j += 2
        continue
      }
      if (code === 96) {
        blank(start, j)
        return j + 1
      }
      if (code === 36 && text.charCodeAt(j + 1) === 123) {
        blank(start, j)
        templates.push(braces)
        braces++
        return j + 2
      }
      j++
    }
    blank(start, n)
    return n
  }

  /** A string from `start` (after its opening quote) to `quote`; `spans` lets it go past line ends. */
  const string = (start: number, quote: number, spans: boolean, escapes = true): number => {
    let j = start
    while (j < n) {
      const code = text.charCodeAt(j)
      if (escapes && code === BACKSLASH) {
        j += 2
        continue
      }
      if (code === quote) {
        blank(start, j)
        return j + 1
      }
      if (code === NEWLINE && !spans) break
      j++
    }
    blank(start, Math.min(j, n))
    return Math.min(j, n)
  }

  /** Lua's long brackets at `at` (`[`, any `=`, `[`): the level, or -1. */
  const longLevel = (at: number): number => {
    if (text.charCodeAt(at) !== 91) return -1
    let j = at + 1
    while (text.charCodeAt(j) === 61) j++
    return text.charCodeAt(j) === 91 ? j - at - 1 : -1
  }
  const longClose = (from: number, level: number): number => {
    const close = `]${'='.repeat(level)}]`
    const end = text.indexOf(close, from)
    return end < 0 ? n : end
  }

  outer: while (i < n) {
    const code = text.charCodeAt(i)
    if (isSpaceCode(code)) {
      i++
      continue
    }
    // Comments to the end of the line.
    for (const start of syntax.line) {
      if (text.startsWith(start, i) && (!syntax.hashAtWord || i === 0 || isSpaceCode(text.charCodeAt(i - 1)))) {
        if (syntax.luaLong) {
          const level = longLevel(i + start.length)
          if (level >= 0) {
            const open = i + start.length + level + 2
            const end = longClose(open, level)
            blank(i, Math.min(n, end + level + 2))
            i = Math.min(n, end + level + 2)
            continue outer
          }
        }
        const end = text.indexOf('\n', i)
        blank(i, end < 0 ? n : end)
        i = end < 0 ? n : end
        continue outer
      }
    }
    for (const [open, close] of syntax.block) {
      if (text.startsWith(open, i)) {
        const end = text.indexOf(close, i + open.length)
        const stop = end < 0 ? n : end + close.length
        blank(i, stop)
        i = stop
        continue outer
      }
    }
    if (syntax.rubyBlock && text.startsWith('=begin', i) && (i === 0 || text.charCodeAt(i - 1) === NEWLINE)) {
      const end = text.indexOf('\n=end', i)
      const stop = end < 0 ? n : end + 5
      blank(i, stop)
      i = stop
      continue
    }
    // Strings.
    if (syntax.triple && (code === 34 || code === 39) && text.charCodeAt(i + 1) === code && text.charCodeAt(i + 2) === code) {
      const close = text.slice(i, i + 3)
      const end = text.indexOf(close, i + 3)
      const stop = end < 0 ? n : end
      blank(i + 3, stop)
      i = end < 0 ? n : end + 3
      lastCode = code
      continue
    }
    if (syntax.verbatim && code === 64 && text.charCodeAt(i + 1) === 34) {
      let j = i + 2
      while (j < n) {
        if (text.charCodeAt(j) === 34) {
          if (text.charCodeAt(j + 1) === 34) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      blank(i + 2, j)
      i = j + 1
      lastCode = 34
      continue
    }
    if (syntax.rust && code === 39) {
      // 'a' or '\n' is a character; 'a without a closing quote is a lifetime.
      const escaped = text.charCodeAt(i + 1) === BACKSLASH
      const closeAt = escaped ? text.indexOf("'", i + 2) : text.codePointAt(i + 1)! > 0xffff ? i + 3 : i + 2
      if (escaped || text.charCodeAt(closeAt) === 39) {
        const stop = closeAt < 0 || closeAt - i > 12 ? i + 1 : closeAt
        blank(i + 1, stop)
        i = stop + 1
        lastCode = 39
        continue
      }
      i++
      continue
    }
    if (syntax.rust && (code === 114 || code === 98) && !isWordCode(text.charCodeAt(i - 1))) {
      // r"…", r#"…"#, br"…".
      let j = i + (code === 98 && text.charCodeAt(i + 1) === 114 ? 2 : 1)
      if (code === 114 || j === i + 2) {
        let hashes = 0
        while (text.charCodeAt(j) === 35) {
          hashes++
          j++
        }
        if (text.charCodeAt(j) === 34) {
          const close = `"${'#'.repeat(hashes)}`
          const end = text.indexOf(close, j + 1)
          const stop = end < 0 ? n : end
          blank(j + 1, stop)
          i = end < 0 ? n : end + close.length
          lastCode = 34
          continue
        }
      }
    }
    if (syntax.quotes.includes(text[i])) {
      i = string(i + 1, code, false)
      lastCode = code
      continue
    }
    if (syntax.multiline?.includes(text[i])) {
      // Single quotes in the shell and in SQL take no escapes.
      i = string(i + 1, code, true, !(code === 39 && (syntax.hashAtWord || syntax === SYNTAX.sql || syntax === SYNTAX.powershell)))
      lastCode = code
      continue
    }
    if (syntax.luaLong && code === 91) {
      const level = longLevel(i)
      if (level >= 0) {
        const open = i + level + 2
        const end = longClose(open, level)
        blank(open, end)
        i = Math.min(n, end + level + 2)
        lastCode = 93
        continue
      }
    }
    if (code === 96 && syntax.backtick === 'template') {
      i = template(i + 1)
      lastCode = 96
      continue
    }
    if (code === 96 && syntax.backtick === 'raw') {
      i = string(i + 1, 96, true, false)
      lastCode = 96
      continue
    }
    if (syntax.regex && code === 47 && (lastCode < 0 || BEFORE_REGEX.has(lastCode) || (lastCode === -2 && REGEX_AFTER_WORDS.has(lastWord)))) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === NEWLINE) break
        if (c === BACKSLASH) {
          j += 2
          continue
        }
        if (c === 91) inClass = true
        else if (c === 93) inClass = false
        else if (c === 47 && !inClass) {
          closed = true
          break
        }
        j++
      }
      if (closed && j > i + 1) {
        blank(i + 1, j)
        i = j + 1
        while (i < n && isWordCode(text.charCodeAt(i))) i++
        lastCode = 47
        continue
      }
    }
    if (isWordCode(code)) {
      let j = i + 1
      while (j < n && isWordCode(text.charCodeAt(j))) j++
      lastWord = text.slice(i, j)
      lastCode = -2
      i = j
      continue
    }
    if (templates.length) {
      if (code === 123) braces++
      else if (code === 125) {
        braces--
        if (templates[templates.length - 1] === braces) {
          templates.pop()
          i = template(i + 1)
          lastCode = 96
          continue
        }
      }
    }
    lastCode = code
    i++
  }

  if (!blanks.length) return text
  const parts: string[] = []
  let at = 0
  for (let k = 0; k < blanks.length; k += 2) {
    const start = Math.max(blanks[k], at)
    const end = Math.min(blanks[k + 1], n)
    if (end <= start) continue
    parts.push(text.slice(at, start), text.slice(start, end).replace(/[^\n]/g, ' '))
    at = end
  }
  parts.push(text.slice(at))
  return parts.join('')
}
