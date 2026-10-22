import { T, type Tokenizer } from '../language'
import { Scanner, WHITESPACE, stackOf, words } from './scan'

// ---------------------------------------------------------------- POSIX shells (bash, sh, zsh)

const SH_KEYWORDS = words('if then else elif fi case esac for select while until do done in function time coproc')
/** After these, the next word is a command name again. */
const SH_COMMAND_AFTER = words('then else elif do if while until time ! {')
const SH_WORD = /[^\s;|&<>()`'"$\\#{}][^\s;|&<>()`'"$\\{}]*/y
const SH_ASSIGN = /[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/y
const SH_HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/y

class ShellRun {
  readonly s: Scanner
  readonly stack: string[]
  /** The next word is a command name. */
  command = true
  /** A heredoc whose body starts on the next line. */
  pending = ''

  constructor(text: string, state: string) {
    this.s = new Scanner(text)
    this.stack = stackOf(state)
  }

  run() {
    const { s, stack } = this
    const top = stack[stack.length - 1]
    if (top?.startsWith('h')) {
      this.heredocLine(top)
      return { tokens: s.tokens(), state: stack.join(',') }
    }
    while (!s.eol) {
      const context = stack[stack.length - 1]
      if (context === "'") this.single()
      else if (context === '"') this.double()
      else this.code()
    }
    if (this.pending) stack.push(this.pending)
    return { tokens: s.tokens(), state: stack.join(',') }
  }

  private heredocLine(top: string): void {
    const { s, stack } = this
    const [, dash, quoted, delimiter] = /^h(-?)(q?):(.*)$/.exec(top)!
    const line = dash ? s.text.replace(/^\t+/, '') : s.text
    if (line === delimiter) {
      s.rest(T.keyword)
      stack.pop()
      return
    }
    while (!s.eol) {
      if (!quoted && s.peek() === '$' && this.expansion()) continue
      if (!s.token(quoted ? /[^]+/y : /[^$]+/y, T.string)) s.take(1, T.string)
    }
  }

  private single(): void {
    const { s } = this
    const end = s.text.indexOf("'", s.pos)
    s.mark(s.pos, T.string)
    s.pos = end < 0 ? s.text.length : end + 1
    if (end >= 0) this.stack.pop()
  }

  private double(): void {
    const { s } = this
    while (!s.eol) {
      const char = s.peek()
      if (char === '"') {
        s.take(1, T.string)
        this.stack.pop()
        return
      }
      if (char === '\\') {
        s.take(2, /["\\$`\n]/.test(s.peek(1)) ? T.escape : T.string)
        continue
      }
      if (char === '$' && this.expansion()) {
        if (this.stack[this.stack.length - 1] !== '"') return
        continue
      }
      if (!s.token(/[^"\\$]+/y, T.string)) s.take(1, T.string)
    }
  }

  /** `$name`, `${...}`, `$(` or `$((`; false when the `$` is just a character. */
  private expansion(): boolean {
    const { s, stack } = this
    const start = s.pos
    if (s.startsWith('$((')) {
      s.take(3, T.punct)
      stack.push('((')
      this.command = false
      return true
    }
    if (s.startsWith('$(')) {
      s.take(2, T.punct)
      stack.push('(')
      this.command = true
      return true
    }
    if (s.startsWith('${')) {
      const end = s.text.indexOf('}', s.pos)
      s.mark(start, T.variable)
      s.pos = end < 0 ? s.text.length : end + 1
      return true
    }
    if (s.match(/\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/y) !== null) {
      s.mark(start, T.variable)
      return true
    }
    return false
  }

  private code(): void {
    const { s, stack } = this
    const start = s.pos
    const char = s.peek()
    if (char === ' ' || char === '\t') {
      s.token(WHITESPACE, T.plain)
      return
    }
    if (char === '#') {
      s.rest(T.comment)
      return
    }
    if (char === "'") {
      s.take(1, T.string)
      stack.push("'")
      this.single()
      this.command = false
      return
    }
    if (char === '"') {
      s.take(1, T.string)
      stack.push('"')
      this.command = false
      return
    }
    if (s.startsWith("$'")) {
      s.take(2, T.string)
      while (!s.eol && s.peek() !== "'") {
        if (s.peek() === '\\') s.take(2, T.escape)
        else s.take(1, T.string)
      }
      if (!s.eol) s.take(1, T.string)
      return
    }
    if (char === '$' && this.expansion()) {
      this.command = false
      return
    }
    if (char === '\\') {
      s.take(2, T.escape)
      return
    }
    if (char === '`') {
      const end = s.text.indexOf('`', s.pos + 1)
      s.mark(start, T.string)
      s.pos = end < 0 ? s.text.length : end + 1
      return
    }
    if (char === ')') {
      s.take(1, T.punct)
      const top = stack[stack.length - 1]
      if (top === '(') stack.pop()
      else if (top === '((' && s.peek() === ')') {
        s.take(1, T.punct)
        stack.pop()
      }
      this.command = false
      return
    }
    if (char === '(') {
      s.take(1, T.punct)
      if (stack.length) stack.push('(')
      this.command = true
      return
    }
    if (s.sees(SH_HEREDOC)) {
      SH_HEREDOC.lastIndex = s.pos
      const [all, dash, quote, delimiter] = SH_HEREDOC.exec(s.text)!
      s.take(2 + dash.length, T.operator)
      s.mark(s.pos, T.keyword)
      s.pos = start + all.length
      this.pending = `h${dash}${quote ? 'q' : ''}:${delimiter}`
      return
    }
    if (s.token(/\|\||&&|;;&?|\|&|[|&;]/y, T.operator)) {
      this.command = true
      return
    }
    if (s.token(/\d*(?:>>|>&|<&|&>>?|<<<|<>|>\||[<>])\d*-?/y, T.operator)) return
    if (char === '{' || char === '}') {
      s.take(1, T.punct)
      this.command = char === '{'
      return
    }
    if (this.command && s.sees(SH_ASSIGN)) {
      s.match(/[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?/y)
      s.mark(start, T.variable)
      s.take(s.peek() === '+' ? 2 : 1, T.operator)
      return
    }
    const word = s.match(SH_WORD)
    if (word !== null) {
      let kind: number
      if (SH_KEYWORDS.has(word) || word === '[[' || word === ']]') kind = T.keyword
      else if (this.command) kind = T.function
      else if (/^-?\d+$/.test(word)) kind = T.number
      else kind = T.plain
      s.mark(start, kind)
      this.command = SH_COMMAND_AFTER.has(word) || (kind === T.function && (word === 'sudo' || word === 'exec' || word === 'command' || word === 'env'))
      return
    }
    s.take(1, T.plain)
  }
}

/** Bash and friends. State: open strings, substitutions and heredocs, comma-separated. */
export const shell: Tokenizer = {
  start: '',
  line: (text, state) => new ShellRun(text, state).run(),
}

// ---------------------------------------------------------------- PowerShell

const PS_KEYWORDS = words(
  'begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while workflow parallel sequence inlinescript configuration',
)
const PS_OPERATORS = words(
  'eq ne gt ge lt le like notlike match notmatch replace contains notcontains in notin and or not xor band bor bxor bnot is isnot as f split join shl shr ceq cne cgt cge clt cle clike cnotlike cmatch cnotmatch creplace ieq ine imatch ireplace',
)

class PowerShellRun {
  readonly s: Scanner
  readonly stack: string[]
  command = true
  afterFunction = false

  constructor(text: string, state: string) {
    this.s = new Scanner(text)
    this.stack = stackOf(state)
  }

  run() {
    const { s, stack } = this
    while (!s.eol) {
      const top = stack[stack.length - 1]
      if (top === 'c') this.comment()
      else if (top === '@"' || top === "@'") this.hereString(top)
      else if (top === '"') this.double()
      else if (top === "'") this.single()
      else this.code()
    }
    return { tokens: s.tokens(), state: stack.join(',') }
  }

  private comment(): void {
    const { s } = this
    const end = s.text.indexOf('#>', s.pos)
    s.mark(s.pos, T.comment)
    s.pos = end < 0 ? s.text.length : end + 2
    if (end >= 0) this.stack.pop()
  }

  private hereString(top: string): void {
    const { s } = this
    const close = `${top[1]}@`
    if (s.pos === 0 && s.text.startsWith(close)) {
      s.take(2, T.string)
      this.stack.pop()
      return
    }
    while (!s.eol) {
      if (top === '@"' && s.peek() === '$' && this.variable()) continue
      if (!s.token(top === '@"' ? /[^$]+/y : /[^]+/y, T.string)) s.take(1, T.string)
    }
  }

  private double(): void {
    const { s } = this
    while (!s.eol) {
      const char = s.peek()
      if (char === '"') {
        if (s.peek(1) === '"') {
          s.take(2, T.escape)
          continue
        }
        s.take(1, T.string)
        this.stack.pop()
        return
      }
      if (char === '`') {
        s.take(2, T.escape)
        continue
      }
      if (char === '$') {
        if (s.startsWith('$(')) {
          s.take(2, T.punct)
          this.stack.push('(')
          this.command = true
          return
        }
        if (this.variable()) continue
      }
      if (!s.token(/[^"`$]+/y, T.string)) s.take(1, T.string)
    }
  }

  private single(): void {
    const { s } = this
    while (!s.eol) {
      if (s.startsWith("''")) s.take(2, T.escape)
      else if (s.peek() === "'") {
        s.take(1, T.string)
        this.stack.pop()
        return
      } else if (!s.token(/[^']+/y, T.string)) s.take(1, T.string)
    }
  }

  private variable(): boolean {
    const { s } = this
    const start = s.pos
    if (s.startsWith('${')) {
      const end = s.text.indexOf('}', s.pos)
      s.pos = end < 0 ? s.text.length : end + 1
    } else if (s.match(/\$(?:[A-Za-z_][\w]*:)?[A-Za-z_][\w]*|\$[$?^_]/y) === null) return false
    const name = s.text.slice(start, s.pos).toLowerCase()
    s.mark(start, name === '$true' || name === '$false' ? T.bool : name === '$null' ? T.constant : T.variable)
    return true
  }

  private code(): void {
    const { s, stack } = this
    const start = s.pos
    const char = s.peek()
    if (char === ' ' || char === '\t') {
      s.token(WHITESPACE, T.plain)
      return
    }
    if (s.startsWith('<#')) {
      s.take(2, T.comment)
      stack.push('c')
      return
    }
    if (char === '#') {
      s.rest(T.comment)
      return
    }
    if (s.startsWith('@"') || s.startsWith("@'")) {
      s.take(2, T.string)
      stack.push(s.text.slice(start, start + 2))
      s.rest(T.string)
      this.command = false
      return
    }
    if (char === '"' || char === "'") {
      s.take(1, T.string)
      stack.push(char)
      this.command = false
      return
    }
    if (char === '$') {
      if (s.startsWith('$(')) {
        s.take(2, T.punct)
        if (stack.length) stack.push('(')
        this.command = true
        return
      }
      if (this.variable()) {
        this.command = false
        return
      }
    }
    if (char === '@' && s.sees(/@[A-Za-z_]\w*/y)) {
      s.token(/@[A-Za-z_]\w*/y, T.variable)
      return
    }
    if (char === '[' && s.sees(/\[[A-Za-z_][\w.]*(?:\[[^\]]*\])?\]/y)) {
      s.take(1, T.punct)
      s.token(/[A-Za-z_][\w.]*(?:\[[^\]]*\])?/y, T.type)
      s.take(1, T.punct)
      return
    }
    if (char === '-' && /[\s(=,|]|^$/.test(s.text[s.pos - 1] ?? '') && s.sees(/-[A-Za-z][\w-]*/y)) {
      const flag = s.match(/-[A-Za-z][\w-]*/y)!
      s.mark(start, PS_OPERATORS.has(flag.slice(1).toLowerCase()) ? T.operator : T.attr)
      this.command = false
      return
    }
    if (/\d/.test(char) && s.token(/0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:kb|mb|gb|tb|pb|l|d)?(?![\w-])/iy, T.number)) {
      this.command = false
      return
    }
    const word = s.match(/[A-Za-z_][\w]*(?:-[A-Za-z_][\w]*)*/y)
    if (word !== null) {
      const lower = word.toLowerCase()
      let kind: number
      if (PS_KEYWORDS.has(lower)) kind = T.keyword
      else if (this.afterFunction || word.includes('-') || this.command || s.peek() === '(') kind = T.function
      else kind = T.plain
      s.mark(start, kind)
      this.afterFunction = lower === 'function' || lower === 'filter'
      this.command = lower === 'if' || lower === 'else' || lower === 'elseif' || lower === 'do'
      return
    }
    if (char === ')') {
      s.take(1, T.punct)
      if (stack[stack.length - 1] === '(') stack.pop()
      this.command = false
      return
    }
    if (char === '(' || char === '{') {
      s.take(1, T.punct)
      if (stack.length) stack.push('(')
      this.command = true
      return
    }
    if (char === '}') {
      s.take(1, T.punct)
      if (stack[stack.length - 1] === '(') stack.pop()
      this.command = true
      return
    }
    if (s.token(/[|;]/y, T.operator)) {
      this.command = true
      return
    }
    if (s.token(/::|\.\.|[+\-*/%]=?|=|!|>|<|&&|\|\||,|\./y, char === ',' || char === '.' ? T.punct : T.operator)) return
    s.take(1, T.plain)
  }
}

/** PowerShell. State: open comments, strings and subexpressions, comma-separated. */
export const powershell: Tokenizer = {
  start: '',
  line: (text, state) => new PowerShellRun(text, state).run(),
}

// ---------------------------------------------------------------- Windows batch files

const BAT_KEYWORDS = words('if else for in do goto call exit not exist defined errorlevel equ neq lss leq gtr geq setlocal endlocal shift')

/** cmd.exe batch files; every construct ends with its line. */
export const batch: Tokenizer = {
  start: '',
  line(text) {
    const s = new Scanner(text)
    let command = true
    s.token(WHITESPACE, T.plain)
    if (s.sees(/(?:rem\b|::)/iy)) {
      s.rest(T.comment)
      return { tokens: s.tokens(), state: '' }
    }
    if (s.peek() === ':') {
      s.rest(T.meta)
      return { tokens: s.tokens(), state: '' }
    }
    while (!s.eol) {
      const start = s.pos
      const char = s.peek()
      if (char === ' ' || char === '\t') s.token(WHITESPACE, T.plain)
      else if (char === '"') {
        const end = text.indexOf('"', s.pos + 1)
        s.mark(start, T.string)
        s.pos = end < 0 ? text.length : end + 1
      } else if (char === '%' || char === '!') {
        if (!s.token(char === '%' ? /%%~?[A-Za-z]|%~[a-zA-Z]*\d|%\d|%[^%\s]+%/y : /![^!\s]+!/y, T.variable)) s.take(1, T.plain)
      } else if (char === '^') s.take(2, T.escape)
      else if (s.token(/&&|\|\||==|>>|[&|<>@()]/y, T.operator)) command = char === '&' || char === '|' || char === '(' || char === '@'
      else {
        const word = s.match(/[^\s"%!^&|<>()=]+/y)
        if (word === null) {
          s.take(1, T.plain)
          continue
        }
        const lower = word.toLowerCase()
        s.mark(start, BAT_KEYWORDS.has(lower) ? T.keyword : command ? T.function : /^\d+$/.test(word) ? T.number : T.plain)
        command = lower === 'do' || lower === 'else'
      }
    }
    return { tokens: s.tokens(), state: '' }
  },
}
