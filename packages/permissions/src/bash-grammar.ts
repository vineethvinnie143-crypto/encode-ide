/**
 * A parser for the part of bash that agent commands are written in, so the
 * permission layer sees every program a line would start before bash runs it.
 *
 * It reads lists (`;`, `&`, `&&`, `||`, newlines), pipelines (`|`, `|&`, `!`),
 * subshells and brace groups, every kind of quoting (single, double, `$'…'`,
 * backslashes, line continuations), parameter references (`$x`, `${x}`),
 * command and process substitution (`$(…)`, backquotes, `<(…)`, `>(…)`),
 * globs, tilde prefixes, comments, redirections and here-documents.
 * Substitutions are parsed recursively, so a program started by `$(…)` is a
 * command like any other.
 *
 * Constructs whose effect cannot be read off the text are reported as
 * unsupported instead of being guessed at: compound commands (`if`, `for`,
 * `while`, `case`, `[[`, `((`), function definitions, arithmetic (which can
 * evaluate a variable's text as code), parameter expansion with operators
 * (some run code, such as `${x@P}` and `${!x}`), brace expansion, `~user`,
 * array assignments and named file descriptors. The policy asks before any
 * line it cannot read completely, so it never decides what such a line does.
 *
 * Wherever this parser is more lenient or stricter than bash, the difference
 * may only make it see more commands than bash runs, never fewer.
 */

export interface BashLiteral {
  kind: 'literal'
  value: string
  /** From quotes or a backslash: not subject to globbing, tilde expansion or word splitting. */
  quoted: boolean
}

/** An unquoted `*`, `?` or `[` that starts a pathname pattern. */
export interface BashGlob {
  kind: 'glob'
  value: '*' | '?' | '['
}

/** An unquoted `~` meaning the home directory. `~user`, `~+` and `~-` are unsupported. */
export interface BashTilde {
  kind: 'tilde'
}

/** `$name`, `${name}` or a special parameter such as `$?` or `$1`. */
export interface BashParam {
  kind: 'param'
  name: string
}

/** `$(…)` or a backquoted command. */
export interface BashCommandSubstitution {
  kind: 'command'
  script: BashScript
  text: string
}

/** `<(…)` or `>(…)`: the word becomes a pipe path such as /dev/fd/63. */
export interface BashProcessSubstitution {
  kind: 'process'
  direction: '<' | '>'
  script: BashScript
  text: string
}

export type BashWordPart = BashLiteral | BashGlob | BashTilde | BashParam | BashCommandSubstitution | BashProcessSubstitution

export interface BashWord {
  /** The word as written. */
  text: string
  parts: BashWordPart[]
}

export interface BashAssignment {
  name: string
  /** The whole assignment as written, `NAME=value`. */
  text: string
  value: BashWord
}

export type BashRedirectOperator = '<' | '>' | '>>' | '>|' | '<>' | '>&' | '<&' | '&>' | '&>>' | '<<' | '<<-' | '<<<'

export interface BashRedirect {
  /** The file descriptor written before the operator, as in `2>`. */
  fd?: number
  operator: BashRedirectOperator
  /** The file, the descriptor to duplicate, the here-string, or a here-document's delimiter. */
  target: BashWord
  /** For `<<` and `<<-`, once the document's lines have been read. */
  heredoc?: BashHeredoc
}

export interface BashHeredoc {
  delimiter: string
  /** A quoted delimiter keeps the body literal; otherwise bash expands `$` and backquotes in it. */
  quoted: boolean
  body: string
}

export interface BashSimpleCommand {
  kind: 'simple'
  assignments: BashAssignment[]
  words: BashWord[]
  redirects: BashRedirect[]
  /** The command as written, without here-document bodies. */
  text: string
}

export interface BashSubshell {
  kind: 'subshell'
  body: BashScript
  redirects: BashRedirect[]
}

export interface BashGroup {
  kind: 'group'
  body: BashScript
  redirects: BashRedirect[]
}

export type BashCommand = BashSimpleCommand | BashSubshell | BashGroup

export interface BashPipeline {
  negated: boolean
  commands: BashCommand[]
}

/** Pipelines joined by `&&` and `||`, run in the background when followed by `&`. */
export interface BashList {
  pipelines: BashPipeline[]
  operators: Array<'&&' | '||'>
  background: boolean
}

export interface BashScript {
  lists: BashList[]
}

export type BashParse = { ok: true; script: BashScript } | { ok: false; reason: string }

/** Thrown for valid bash this parser deliberately does not read. */
class Unsupported extends Error {}
/** Thrown for text bash itself would reject. */
class Syntax extends Error {}

const META = new Set([' ', '\t', '\n', '|', '&', ';', '(', ')', '<', '>'])
/** Characters that make a word more than plain text, so it cannot be a reserved word. */
const QUOTING = new Set(["'", '"', '\\', '$', '`'])
const RESERVED = new Set([
  '!', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in',
  'select', 'then', 'time', 'until', 'while', '{', '}', '[[', ']]',
])
const SPECIAL_PARAMETERS = '@*#?-$!0123456789'
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const REDIRECT_OPERATORS: readonly BashRedirectOperator[] = ['>>', '>|', '>&', '<<<', '<<-', '<<', '<&', '<>', '>', '<']
/** Substitutions and groups nest at most this deep; deeper input is refused rather than risking the stack. */
const MAX_DEPTH = 24

type Terminator = 'eof' | ')' | '}'

interface PendingHeredoc {
  redirect: BashRedirect
  delimiter: string
  quoted: boolean
  strip: boolean
}

class Parser {
  private pos = 0
  private pending: PendingHeredoc[] = []

  constructor(
    private readonly src: string,
    private depth: number,
  ) {
    if (depth > MAX_DEPTH) throw new Unsupported('nests substitutions too deeply')
  }

  parseScript(end: Terminator): BashScript {
    const lists: BashList[] = []
    for (;;) {
      this.skipBlanks()
      if (this.atEnd()) {
        if (end === ')') throw new Syntax('has an unclosed parenthesis')
        if (end === '}') throw new Syntax('has an unclosed { group')
        break
      }
      const char = this.peek()
      if (char === '\n') {
        this.newline()
        continue
      }
      if (end === ')' && char === ')') break
      if (end === '}' && this.reservedAhead() === '}') break
      if (char === ';' || char === '&' || char === '|' || char === ')') throw new Syntax(`has an unexpected ${char}`)

      const list = this.parseList()
      lists.push(list)
      this.skipBlanks()
      if (this.atEnd()) continue
      const next = this.peek()
      if (next === ';') {
        if (this.peek(1) === ';') throw new Unsupported('uses ;;, which belongs to case')
        this.pos++
      } else if (next === '&') {
        // && and &> were taken by parseList and the redirection reader, so this is a lone &.
        list.background = true
        this.pos++
      } else if (next === '\n') {
        this.newline()
      } else if (!(end === ')' && next === ')')) {
        throw new Syntax(`has an unexpected ${next}`)
      }
    }
    return { lists }
  }

  private parseList(): BashList {
    const pipelines = [this.parsePipeline()]
    const operators: Array<'&&' | '||'> = []
    for (;;) {
      this.skipBlanks()
      const operator = this.src.slice(this.pos, this.pos + 2)
      if (operator !== '&&' && operator !== '||') break
      this.pos += 2
      operators.push(operator)
      this.skipLinebreaks()
      pipelines.push(this.parsePipeline())
    }
    return { pipelines, operators, background: false }
  }

  private parsePipeline(): BashPipeline {
    this.skipBlanks()
    let negated = false
    while (this.reservedAhead() === '!') {
      negated = !negated
      this.pos++
      this.skipBlanks()
    }
    const commands = [this.parseCommand()]
    for (;;) {
      this.skipBlanks()
      if (this.peek() !== '|' || this.peek(1) === '|') break
      this.pos++
      if (this.peek() === '&') this.pos++ // |& pipes stderr too
      this.skipLinebreaks()
      commands.push(this.parseCommand())
    }
    return { negated, commands }
  }

  private parseCommand(): BashCommand {
    this.skipBlanks()
    if (this.atEnd()) throw new Syntax('ends where a command was expected')
    if (this.peek() === '(') {
      if (this.peek(1) === '(') throw new Unsupported('uses an arithmetic command ((…))')
      this.pos++
      const body = this.nested(() => this.parseScript(')'))
      this.pos++
      if (!body.lists.length) throw new Syntax('has an empty subshell')
      return { kind: 'subshell', body, redirects: this.parseTrailingRedirects() }
    }
    const reserved = this.reservedAhead()
    if (reserved === '{') {
      this.pos++
      const body = this.nested(() => this.parseScript('}'))
      this.pos++
      if (!body.lists.length) throw new Syntax('has an empty { group')
      return { kind: 'group', body, redirects: this.parseTrailingRedirects() }
    }
    if (reserved) throw new Unsupported(`uses ${reserved}`)
    return this.parseSimple()
  }

  private parseSimple(): BashSimpleCommand {
    const start = this.pos
    const assignments: BashAssignment[] = []
    const words: BashWord[] = []
    const redirects: BashRedirect[] = []
    for (;;) {
      this.skipBlanks()
      if (this.atEnd()) break
      const redirect = this.parseRedirect()
      if (redirect) {
        redirects.push(redirect)
        continue
      }
      const char = this.peek()
      if (char === '(') {
        if (words.length === 1 && !assignments.length) throw new Unsupported('defines a function')
        throw new Syntax('has an unexpected (')
      }
      if (META.has(char) && !this.processAhead()) break
      const word = this.parseWord()
      if (!words.length) {
        const assignment = asAssignment(word)
        if (assignment) {
          assignments.push(assignment)
          continue
        }
      }
      words.push(word)
    }
    if (!words.length && !assignments.length && !redirects.length) throw new Syntax('has an empty command')
    return { kind: 'simple', assignments, words, redirects, text: this.src.slice(start, this.pos).trim() }
  }

  private parseTrailingRedirects(): BashRedirect[] {
    const redirects: BashRedirect[] = []
    for (;;) {
      this.skipBlanks()
      const redirect = this.parseRedirect()
      if (!redirect) return redirects
      redirects.push(redirect)
    }
  }

  /** A redirection at the current position, or null. `<(` and `>(` are process substitutions, not redirections. */
  private parseRedirect(): BashRedirect | null {
    if (this.processAhead()) return null
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}[<>]/.test(this.src.slice(this.pos, this.pos + 80))) {
      throw new Unsupported('redirects a named file descriptor')
    }
    let at = this.pos
    let fd: number | undefined
    let operator: BashRedirectOperator | undefined
    if (this.src.startsWith('&>>', at)) operator = '&>>'
    else if (this.src.startsWith('&>', at)) operator = '&>'
    else {
      const digits = /^\d+(?=[<>])/.exec(this.src.slice(at, at + 12))
      if (digits) {
        fd = Number(digits[0])
        at += digits[0].length
      }
      if ((this.src[at] === '<' || this.src[at] === '>') && this.src[at + 1] === '(') return null
      operator = REDIRECT_OPERATORS.find((candidate) => this.src.startsWith(candidate, at))
    }
    if (!operator) return null
    this.pos = at + operator.length
    this.skipBlanks()
    if (this.atEnd() || (META.has(this.peek()) && !this.processAhead())) throw new Syntax(`has ${operator} without a target`)
    const target = this.parseWord()
    const redirect: BashRedirect = { operator, target }
    if (fd !== undefined) redirect.fd = fd
    if (operator === '<<' || operator === '<<-') {
      const { delimiter, quoted } = heredocDelimiter(target.text)
      this.pending.push({ redirect, delimiter, quoted, strip: operator === '<<-' })
    }
    return redirect
  }

  private parseWord(): BashWord {
    const start = this.pos
    const parts: BashWordPart[] = []
    const literal = (value: string, quoted: boolean) => {
      const last = parts[parts.length - 1]
      if (last && last.kind === 'literal' && last.quoted === quoted) last.value += value
      else parts.push({ kind: 'literal', value, quoted })
    }
    /** Unquoted text so far is a name followed by `=`; bash then expands `~` after `=` and `:`, also in arguments. */
    let assignmentLike = false
    /** Everything so far is unquoted name characters. */
    let nameSoFar = true

    while (!this.atEnd()) {
      const char = this.peek()
      if (this.processAhead()) {
        parts.push(this.parseProcess())
        nameSoFar = false
        continue
      }
      if (META.has(char)) break
      if (char === '~' && (this.pos === start || (assignmentLike && /[=:]/.test(this.src[this.pos - 1])))) {
        this.parseTilde(parts, literal)
        nameSoFar = false
        continue
      }
      switch (char) {
        case '\\': {
          const next = this.src[this.pos + 1]
          if (next === '\n') this.pos += 2
          else if (next === undefined) {
            literal('\\', true)
            this.pos++
          } else {
            literal(next, true)
            this.pos += 2
          }
          nameSoFar = false
          break
        }
        case "'": {
          const close = this.src.indexOf("'", this.pos + 1)
          if (close === -1) throw new Syntax('has an unterminated quote')
          literal(this.src.slice(this.pos + 1, close), true)
          this.pos = close + 1
          nameSoFar = false
          break
        }
        case '"':
          this.parseDoubleQuoted(parts, literal)
          nameSoFar = false
          break
        case '$':
          this.parseDollar(parts, literal, false)
          nameSoFar = false
          break
        case '`':
          parts.push(this.parseBackquote(false))
          nameSoFar = false
          break
        case '*':
        case '?':
          parts.push({ kind: 'glob', value: char })
          this.pos++
          nameSoFar = false
          break
        case '[':
          if (this.bracketCloses()) parts.push({ kind: 'glob', value: '[' })
          else literal('[', false)
          this.pos++
          nameSoFar = false
          break
        case '{':
          if (this.braceExpands()) throw new Unsupported('uses brace expansion')
          literal('{', false)
          this.pos++
          nameSoFar = false
          break
        default:
          if (char === '=' && nameSoFar && this.pos > start) assignmentLike = true
          nameSoFar = nameSoFar && (this.pos === start ? NAME_START.test(char) : NAME_CHAR.test(char))
          literal(char, false)
          this.pos++
      }
    }
    if (this.pos === start) throw new Syntax('expected a word')
    return { text: this.src.slice(start, this.pos), parts }
  }

  private parseTilde(parts: BashWordPart[], literal: (value: string, quoted: boolean) => void): void {
    let end = this.pos + 1
    while (end < this.src.length && !META.has(this.src[end]) && this.src[end] !== '/' && this.src[end] !== ':') {
      if (QUOTING.has(this.src[end])) {
        // A quoted character in the prefix turns tilde expansion off for the whole prefix.
        literal('~', false)
        this.pos++
        return
      }
      end++
    }
    const prefix = this.src.slice(this.pos + 1, end)
    if (prefix) throw new Unsupported(`uses ~${prefix}, which names another directory`)
    parts.push({ kind: 'tilde' })
    this.pos++
  }

  private parseDoubleQuoted(parts: BashWordPart[], literal: (value: string, quoted: boolean) => void): void {
    this.pos++
    literal('', true) // "" on its own is still an (empty) argument
    for (;;) {
      if (this.atEnd()) throw new Syntax('has an unterminated quote')
      const char = this.peek()
      if (char === '"') {
        this.pos++
        return
      }
      if (char === '\\') {
        const next = this.src[this.pos + 1]
        if (next === '\n') this.pos += 2
        else if (next === '$' || next === '`' || next === '"' || next === '\\') {
          literal(next, true)
          this.pos += 2
        } else {
          literal('\\', true)
          this.pos++
        }
        continue
      }
      if (char === '$') {
        this.parseDollar(parts, literal, true)
        continue
      }
      if (char === '`') {
        parts.push(this.parseBackquote(true))
        continue
      }
      literal(char, true)
      this.pos++
    }
  }

  private parseDollar(parts: BashWordPart[], literal: (value: string, quoted: boolean) => void, inDouble: boolean): void {
    const next = this.src[this.pos + 1]
    if (next === '(') {
      if (this.src[this.pos + 2] === '(') throw new Unsupported('uses arithmetic expansion $((…))')
      const start = this.pos
      this.pos += 2
      const script = this.nested(() => this.parseScript(')'))
      this.pos++
      parts.push({ kind: 'command', script, text: this.src.slice(start, this.pos) })
      return
    }
    if (next === '[') throw new Unsupported('uses arithmetic expansion $[…]')
    if (next === '{') {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])\}/.exec(this.src.slice(this.pos, this.pos + 256))
      if (!match) throw new Unsupported('uses parameter expansion with operators, such as ${x:-y}')
      parts.push({ kind: 'param', name: match[1] })
      this.pos += match[0].length
      return
    }
    if (!inDouble && next === "'") {
      this.parseAnsiC(literal)
      return
    }
    if (!inDouble && next === '"') {
      // $"…" is a translatable string: double quotes whose text may be replaced by a translation.
      this.pos++
      this.parseDoubleQuoted(parts, literal)
      return
    }
    if (next !== undefined && NAME_START.test(next)) {
      let end = this.pos + 2
      while (end < this.src.length && NAME_CHAR.test(this.src[end])) end++
      parts.push({ kind: 'param', name: this.src.slice(this.pos + 1, end) })
      this.pos = end
      return
    }
    if (next !== undefined && SPECIAL_PARAMETERS.includes(next)) {
      parts.push({ kind: 'param', name: next })
      this.pos += 2
      return
    }
    literal('$', inDouble)
    this.pos++
  }

  /** `$'…'`: backslash escapes are decoded, as bash does before the program sees the text. */
  private parseAnsiC(literal: (value: string, quoted: boolean) => void): void {
    let index = this.pos + 2
    let value = ''
    for (;;) {
      if (index >= this.src.length) throw new Syntax('has an unterminated quote')
      const char = this.src[index]
      if (char === "'") {
        index++
        break
      }
      if (char !== '\\') {
        value += char
        index++
        continue
      }
      const escape = this.src[index + 1]
      if (escape === undefined) throw new Syntax('has an unterminated quote')
      index += 2
      const hex = (max: number): number | null => {
        const match = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(this.src.slice(index, index + max))
        if (!match) return null
        index += match[0].length
        return parseInt(match[0], 16)
      }
      switch (escape) {
        case 'a': value += '\x07'; break
        case 'b': value += '\b'; break
        case 'e':
        case 'E': value += '\x1b'; break
        case 'f': value += '\f'; break
        case 'n': value += '\n'; break
        case 'r': value += '\r'; break
        case 't': value += '\t'; break
        case 'v': value += '\v'; break
        case '\\':
        case "'":
        case '"':
        case '?':
          value += escape
          break
        case 'x': {
          const code = hex(2)
          value += code === null ? '\\x' : String.fromCharCode(code)
          break
        }
        case 'u':
        case 'U': {
          const code = hex(escape === 'u' ? 4 : 8)
          value += code === null ? `\\${escape}` : code <= 0x10ffff ? String.fromCodePoint(code) : '�'
          break
        }
        case 'c': {
          const control = this.src[index]
          if (control === undefined) throw new Syntax('has an unterminated quote')
          value += String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f)
          index++
          break
        }
        default:
          if (/[0-7]/.test(escape)) {
            const octal = /^[0-7]{0,2}/.exec(this.src.slice(index, index + 2))![0]
            value += String.fromCharCode(parseInt(escape + octal, 8) & 0xff)
            index += octal.length
          } else {
            value += `\\${escape}`
          }
      }
    }
    // Arguments end at a NUL byte, so the program would see less than the text says.
    if (value.includes('\0')) throw new Unsupported('puts a NUL character in an argument')
    literal(value, true)
    this.pos = index
  }

  private parseBackquote(inDouble: boolean): BashCommandSubstitution {
    const start = this.pos
    let index = this.pos + 1
    let inner = ''
    for (;;) {
      if (index >= this.src.length) throw new Syntax('has an unterminated backquote')
      const char = this.src[index]
      if (char === '`') {
        index++
        break
      }
      if (char === '\\') {
        const next = this.src[index + 1]
        if (next === '`' || next === '$' || next === '\\' || (inDouble && next === '"')) {
          inner += next
          index += 2
          continue
        }
      }
      inner += char
      index++
    }
    this.pos = index
    const script = new Parser(inner, this.depth + 1).parseScript('eof')
    return { kind: 'command', script, text: this.src.slice(start, index) }
  }

  private parseProcess(): BashProcessSubstitution {
    const start = this.pos
    const direction = this.peek() as '<' | '>'
    this.pos += 2
    const script = this.nested(() => this.parseScript(')'))
    this.pos++
    return { kind: 'process', direction, script, text: this.src.slice(start, this.pos) }
  }

  private nested<T>(parse: () => T): T {
    this.depth++
    if (this.depth > MAX_DEPTH) throw new Unsupported('nests substitutions too deeply')
    try {
      return parse()
    } finally {
      this.depth--
    }
  }

  /** Consumes a newline, then the bodies of here-documents started on the line it ends. */
  private newline(): void {
    this.pos++
    const pending = this.pending
    this.pending = []
    for (const document of pending) document.redirect.heredoc = this.readHeredoc(document)
  }

  private readHeredoc({ delimiter, quoted, strip }: PendingHeredoc): BashHeredoc {
    const lines: string[] = []
    while (!this.atEnd()) {
      let end = this.src.indexOf('\n', this.pos)
      if (end === -1) end = this.src.length
      let line = this.src.slice(this.pos, end)
      this.pos = Math.min(end + 1, this.src.length)
      if (strip) line = line.replace(/^\t+/, '')
      if (line === delimiter) break
      // In an unquoted document bash joins a line ending in a backslash with the next one before
      // looking for the delimiter, so the document could end somewhere other than where it seems to.
      if (!quoted && /(^|[^\\])(\\\\)*\\$/.test(line)) throw new Unsupported('continues a line inside a here-document')
      lines.push(line)
    }
    return { delimiter, quoted, body: lines.join('\n') }
  }

  private skipBlanks(): void {
    for (;;) {
      const char = this.peek()
      if (char === ' ' || char === '\t') this.pos++
      else if (char === '\\' && this.peek(1) === '\n') this.pos += 2
      else if (char === '#') {
        const end = this.src.indexOf('\n', this.pos)
        this.pos = end === -1 ? this.src.length : end
      } else return
    }
  }

  /** Blanks, comments and newlines, which may follow `&&`, `||` and `|`. */
  private skipLinebreaks(): void {
    for (;;) {
      this.skipBlanks()
      if (this.peek() !== '\n') return
      this.newline()
    }
  }

  /** The reserved word starting at the current position, when the whole next word is one. */
  private reservedAhead(): string | null {
    let end = this.pos
    while (end < this.src.length && !META.has(this.src[end]) && !QUOTING.has(this.src[end])) end++
    if (end < this.src.length && !META.has(this.src[end])) return null
    const word = this.src.slice(this.pos, end)
    return RESERVED.has(word) ? word : null
  }

  private processAhead(): boolean {
    const char = this.peek()
    return (char === '<' || char === '>') && this.peek(1) === '('
  }

  /** Whether the `[` at the current position has a `]` later in the same word, making it a pattern. */
  private bracketCloses(): boolean {
    let index = this.pos + 1
    if (this.src[index] === ']') index++ // a ] right after [ is a member of the set, not its end
    for (; index < this.src.length && !META.has(this.src[index]); index++) {
      if (this.src[index] === ']') return true
    }
    return false
  }

  /** Whether the `{` at the current position starts a brace expansion (`{a,b}` or `{1..3}`). */
  private braceExpands(): boolean {
    let depth = 0
    let comma = false
    for (let index = this.pos; index < this.src.length && !META.has(this.src[index]); index++) {
      const char = this.src[index]
      if (char === '\\') {
        index++
      } else if (char === "'" || char === '"') {
        const close = this.src.indexOf(char, index + 1)
        if (close === -1) return false
        index = close
      } else if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
        if (depth === 0) {
          const body = this.src.slice(this.pos + 1, index)
          return comma || /^(-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(\.\.-?\d+)?$/.test(body)
        }
      } else if (char === ',' && depth === 1) {
        comma = true
      }
    }
    return false
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset]
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length
  }
}

/** Quote removal on a here-document delimiter; any quoting makes the body literal. */
function heredocDelimiter(text: string): { delimiter: string; quoted: boolean } {
  let delimiter = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === "'" || char === '"') {
      quoted = true
      const close = text.indexOf(char, index + 1)
      const end = close === -1 ? text.length : close
      delimiter += text.slice(index + 1, end)
      index = end
    } else if (char === '\\') {
      quoted = true
      delimiter += text[index + 1] ?? ''
      index++
    } else {
      delimiter += char
    }
  }
  return { delimiter, quoted }
}

/** `NAME=value` before the command name. `"NAME"=value` is a command, and `NAME[i]=value` is unsupported. */
function asAssignment(word: BashWord): BashAssignment | null {
  if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(word.text) && /\]\+?=/.test(word.text)) {
    throw new Unsupported('assigns to an array element')
  }
  const first = word.parts[0]
  if (!first || first.kind !== 'literal' || first.quoted) return null
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.value)
  if (!match) return null
  const rest = first.value.slice(match[0].length)
  const parts: BashWordPart[] = [...(rest ? [{ ...first, value: rest }] : []), ...word.parts.slice(1)]
  return { name: match[1], text: word.text, value: { text: word.text.slice(match[0].length), parts } }
}

/** Parses a bash command line; `ok: false` names what made it unreadable. */
export function parseBash(line: string): BashParse {
  try {
    return { ok: true, script: new Parser(line, 0).parseScript('eof') }
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message }
    if (error instanceof Syntax) return { ok: false, reason: `${error.message}, so it is not valid bash` }
    if (error instanceof RangeError) return { ok: false, reason: 'is too deeply nested to read' }
    throw error
  }
}

/**
 * Every simple command in a script, in the order bash starts them: the
 * substitutions inside a command's words and redirections come before the
 * command itself.
 */
export function simpleCommands(script: BashScript): BashSimpleCommand[] {
  const out: BashSimpleCommand[] = []
  const visitWord = (word: BashWord) => {
    for (const part of word.parts) {
      if (part.kind === 'command' || part.kind === 'process') visitScript(part.script)
    }
  }
  const visitRedirects = (redirects: BashRedirect[]) => {
    for (const redirect of redirects) visitWord(redirect.target)
  }
  const visitCommand = (command: BashCommand) => {
    if (command.kind === 'simple') {
      for (const assignment of command.assignments) visitWord(assignment.value)
      for (const word of command.words) visitWord(word)
      visitRedirects(command.redirects)
      out.push(command)
    } else {
      visitScript(command.body)
      visitRedirects(command.redirects)
    }
  }
  const visitScript = (inner: BashScript) => {
    for (const list of inner.lists) {
      for (const pipeline of list.pipelines) for (const command of pipeline.commands) visitCommand(command)
    }
  }
  visitScript(script)
  return out
}

/** The text a word stands for when it has no expansions, or null when it is only known at run time. */
export function staticValue(word: BashWord): string | null {
  let value = ''
  for (const part of word.parts) {
    if (part.kind !== 'literal') return null
    value += part.value
  }
  return value
}
