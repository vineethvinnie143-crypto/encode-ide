/**
 * A reader for the part of PowerShell whose meaning is fixed by the text:
 * commands with literal arguments, pipelines, `;` and newlines, `&&` and
 * `||`, quoted strings without expansions, `#` comments, and redirections.
 * Everything else is refused, so a policy built on it never guesses:
 *
 * - variables and subexpressions (`$` outside single quotes, except the
 *   redirection target `$null`),
 * - script blocks, grouping, arrays and attributes (`{ } ( ) , [` at the
 *   start of a word),
 * - splatting and here-strings (`@` at the start of a word),
 * - the call, background and dot-source operators (`&`, a lone `.`),
 * - keywords (if, foreach, function and the rest), stop-parsing (`--%`),
 *   block comments, `<`, and backtick escapes other than a line
 *   continuation.
 *
 * PowerShell also reads typographic quotes and dashes as quotes and dashes,
 * and some Unicode spaces as spaces, so a line with any of them is refused
 * rather than read differently from PowerShell.
 */

export interface PwshWord {
  /** The word as typed. */
  text: string
  /** The word with quotes removed. */
  value: string
  /** Whether the word starts inside quotes. Only an unquoted `-name` is a parameter. */
  quotedStart: boolean
  /** Whether `*`, `?` or `[` appear outside quotes, where PowerShell may expand them to file names. */
  unquotedWildcard: boolean
}

export interface PwshRedirect {
  /** `1` to `6`, or `*` for every stream. */
  stream: string
  append: boolean
  /** The file written; null for `n>&1` and for `> $null`. */
  target: PwshWord | null
  /** For `n>&m`: the stream merged into. */
  merge?: string
  /** `> $null`: the output is discarded. */
  discard?: boolean
}

export interface PwshCommand {
  name: PwshWord
  args: PwshWord[]
  redirects: PwshRedirect[]
}

export interface PwshPipeline {
  commands: PwshCommand[]
}

/** Pipelines joined by `&&` and `||` (PowerShell 7). */
export interface PwshStatement {
  pipelines: PwshPipeline[]
  operators: Array<'&&' | '||'>
}

export interface PwshScript {
  statements: PwshStatement[]
}

export type PwshParse = { ok: true; script: PwshScript } | { ok: false; reason: string }

/** Statement keywords. As a command name each of them starts syntax this reader does not follow. */
const KEYWORDS = new Set([
  'begin', 'break', 'catch', 'class', 'clean', 'configuration', 'continue', 'data', 'define', 'do', 'dynamicparam',
  'else', 'elseif', 'end', 'enum', 'exit', 'filter', 'finally', 'for', 'foreach', 'from', 'function', 'hidden',
  'if', 'in', 'inlinescript', 'interface', 'module', 'namespace', 'parallel', 'param', 'private', 'process',
  'public', 'return', 'sequence', 'static', 'switch', 'throw', 'trap', 'try', 'until', 'using', 'var',
  'while', 'workflow',
])

/** Typographic quotes and dashes, and the spaces PowerShell treats like a space or a newline. */
const UNICODE_SYNTAX = /[\u2018-\u201e\u2013-\u2015\u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** Ends an unquoted word. */
const WORD_END = new Set([' ', '\t', '\n', ';', '|', '&', '>', '<', '(', ')', '{', '}', ','])

type Token =
  | { kind: 'word'; word: PwshWord }
  | { kind: 'separator' }
  | { kind: 'pipe' }
  | { kind: 'chain'; operator: '&&' | '||' }
  | { kind: 'redirect'; redirect: PwshRedirect }

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason)
}

class Reader {
  private pos = 0

  constructor(private readonly src: string) {}

  tokens(): Token[] {
    const out: Token[] = []
    for (;;) {
      this.skipBlanks()
      if (this.pos >= this.src.length) return out
      const char = this.src[this.pos]
      const next = this.src[this.pos + 1]
      if (char === '\n' || char === ';') {
        this.pos++
        out.push({ kind: 'separator' })
      } else if (char === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
      } else if (char === '|') {
        this.pos += next === '|' ? 2 : 1
        out.push(next === '|' ? { kind: 'chain', operator: '||' } : { kind: 'pipe' })
      } else if (char === '<' && next === '#') {
        refuse('uses a block comment')
      } else if (char === '&') {
        if (next !== '&') refuse('uses &, which runs a command by name or in the background')
        this.pos += 2
        out.push({ kind: 'chain', operator: '&&' })
      } else if (this.redirectAhead()) {
        out.push({ kind: 'redirect', redirect: this.redirect() })
      } else {
        out.push({ kind: 'word', word: this.word() })
      }
    }
  }

  private skipBlanks(): void {
    for (;;) {
      const char = this.src[this.pos]
      if (char === ' ' || char === '\t') this.pos++
      else if (char === '`' && this.src[this.pos + 1] === '\n') this.pos += 2
      else return
    }
  }

  private redirectAhead(): boolean {
    return /^[1-6*]?>/.test(this.src.slice(this.pos, this.pos + 2)) || this.src[this.pos] === '<'
  }

  private redirect(): PwshRedirect {
    const match = /^([1-6*]?)(>>?)(?:&([1-6]))?/.exec(this.src.slice(this.pos))
    if (!match) refuse('uses <, which PowerShell reserves')
    this.pos += match[0].length
    const stream = match[1] || '1'
    const append = match[2] === '>>'
    if (match[3]) return { stream, append, target: null, merge: match[3] }
    this.skipBlanks()
    if (this.src.startsWith('$null', this.pos) && (this.pos + 5 >= this.src.length || WORD_END.has(this.src[this.pos + 5]))) {
      this.pos += 5
      return { stream, append, target: null, discard: true }
    }
    const char = this.src[this.pos]
    if (char === undefined || WORD_END.has(char)) refuse('has a redirection without a target')
    return { stream, append, target: this.word() }
  }

  /** A word: unquoted runs and quoted strings with nothing between them. */
  private word(): PwshWord {
    const start = this.pos
    let value = ''
    let quotedStart = false
    let unquotedWildcard = false
    const first = this.src[this.pos]
    if (first === '@') refuse('uses @, which splats variables or starts an array, hash table or here-string')
    if (first === '[') refuse('uses [ at the start of a word, which PowerShell may read as a type')
    if (this.src.startsWith('--%', this.pos)) refuse('uses --%, which passes the rest of the line unparsed')
    while (this.pos < this.src.length) {
      const char = this.src[this.pos]
      if (WORD_END.has(char)) {
        if (char === '(' || char === ')' || char === '{' || char === '}' || char === ',') {
          refuse(`uses ${char}, which starts an expression, script block or array`)
        }
        if (char === '<') refuse('uses <, which PowerShell reserves')
        break
      }
      if (char === '$') refuse('uses $, which expands a variable or expression when the line runs')
      if (char === '`') {
        if (this.src[this.pos + 1] === '\n') break
        refuse('uses a backtick escape')
      }
      if (char === "'") {
        if (this.pos === start) quotedStart = true
        value += this.singleQuoted()
        continue
      }
      if (char === '"') {
        if (this.pos === start) quotedStart = true
        value += this.doubleQuoted()
        continue
      }
      if (char === '*' || char === '?' || char === '[') unquotedWildcard = true
      value += char
      this.pos++
    }
    return { text: this.src.slice(start, this.pos), value, quotedStart, unquotedWildcard }
  }

  private singleQuoted(): string {
    let value = ''
    for (this.pos++; ; this.pos++) {
      if (this.pos >= this.src.length) refuse('has an unterminated quote')
      if (this.src[this.pos] === "'") {
        if (this.src[this.pos + 1] !== "'") break
        this.pos++
      }
      value += this.src[this.pos]
    }
    this.pos++
    return value
  }

  private doubleQuoted(): string {
    let value = ''
    for (this.pos++; ; this.pos++) {
      if (this.pos >= this.src.length) refuse('has an unterminated quote')
      const char = this.src[this.pos]
      if (char === '"') {
        if (this.src[this.pos + 1] !== '"') break
        this.pos++
      } else if (char === '$') {
        refuse('uses $ inside double quotes, which expands a variable or expression when the line runs')
      } else if (char === '`') {
        refuse('uses a backtick escape')
      }
      value += char
    }
    this.pos++
    return value
  }
}

function buildScript(tokens: Token[]): PwshScript {
  const statements: PwshStatement[] = []
  let statement: PwshStatement = { pipelines: [], operators: [] }
  let pipeline: PwshPipeline = { commands: [] }
  let command: PwshCommand | null = null
  /** What must come next: a command after |, && or ||. */
  let needCommand = false

  const endPipeline = () => {
    if (!command) refuse('has an empty command')
    pipeline.commands.push(command)
    statement.pipelines.push(pipeline)
    command = null
    pipeline = { commands: [] }
  }
  for (const token of tokens) {
    switch (token.kind) {
      case 'word':
        if (command) command.args.push(token.word)
        else command = { name: token.word, args: [], redirects: [] }
        needCommand = false
        break
      case 'redirect':
        if (!command) refuse('starts a command with a redirection')
        command.redirects.push(token.redirect)
        break
      case 'pipe':
        if (!command) refuse('has an empty command')
        pipeline.commands.push(command)
        command = null
        needCommand = true
        break
      case 'chain':
        endPipeline()
        statement.operators.push(token.operator)
        needCommand = true
        break
      case 'separator':
        if (needCommand) refuse('ends the line in the middle of a pipeline')
        if (command) endPipeline()
        if (statement.pipelines.length) statements.push(statement)
        statement = { pipelines: [], operators: [] }
        break
    }
  }
  if (needCommand) refuse('ends the line in the middle of a pipeline')
  if (command) endPipeline()
  if (statement.pipelines.length) statements.push(statement)
  return { statements }
}

function checkNames(script: PwshScript): void {
  for (const statement of script.statements) {
    for (const pipeline of statement.pipelines) {
      for (const { name } of pipeline.commands) {
        if (name.quotedStart) refuse(`starts with the string ${name.text}, which PowerShell reads as an expression`)
        if (KEYWORDS.has(name.value.toLowerCase())) refuse(`uses the keyword ${name.value}`)
        if (/^[-.+0-9]/.test(name.value) && !/^[0-9]+[A-Za-z_]/.test(name.value)) {
          refuse(`starts with ${name.text}, which PowerShell reads as an expression or a dot-sourced script`)
        }
      }
    }
  }
}

export function parsePwsh(line: string): PwshParse {
  const source = line.replace(/\r\n/g, '\n')
  try {
    if (UNICODE_SYNTAX.test(source)) refuse('uses typographic quotes, dashes or spaces, which PowerShell reads as syntax')
    const script = buildScript(new Reader(source).tokens())
    checkNames(script)
    return { ok: true, script }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message }
    throw error
  }
}
