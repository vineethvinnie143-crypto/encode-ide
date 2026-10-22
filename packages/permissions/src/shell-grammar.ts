import type nodePath from 'node:path'

/** `node:path`, `path.posix` or `path.win32`. */
export type PathApi = typeof nodePath

/**
 * The grammar of the eNCode Shell, shared by the interpreter that runs a line
 * and the policy that decides whether it may run unasked. Both read a line
 * through `parseLine` and `commandName`, so they cannot disagree about which
 * programs a line starts or which arguments those programs receive.
 *
 * The language is deliberately small: statements separated by `;`, `&&` and
 * `||`, pipelines with `|`, single and double quotes (no escapes), and one
 * output redirection (`>` or `>>`) that takes the rest of its segment as the
 * file name. There is no variable, glob or command substitution; `$`, `*`
 * and backticks reach programs literally. Newlines are ordinary characters.
 */

export const SHELL_BUILTINS: readonly string[] = [
  'help', 'clear', 'pwd', 'cd', 'ls', 'cat', 'echo', 'mkdir', 'rm', 'mv', 'cp', 'touch',
  'head', 'tail', 'wc', 'which', 'env', 'set', 'export', 'unset', 'date', 'whoami',
  'history', 'ver', 'exit',
]

export const SHELL_ALIASES: Readonly<Record<string, string>> = {
  dir: 'ls',
  del: 'rm',
  move: 'mv',
  copy: 'cp',
  where: 'which',
  type: 'cat',
  cls: 'clear',
}

const BUILTIN_SET = new Set(SHELL_BUILTINS)

export interface ShellStatement {
  text: string
  cond: 'always' | 'and' | 'or'
}

export interface ShellSegment {
  tokens: string[]
  redirect?: { file: string; append: boolean }
}

export interface ParsedStatement {
  cond: ShellStatement['cond']
  /** Pipeline segments with at least one token, in order. */
  segments: ShellSegment[]
}

export function splitStatements(line: string): ShellStatement[] {
  const out: ShellStatement[] = []
  let current = ''
  let quote: string | null = null
  let cond: ShellStatement['cond'] = 'always'

  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ';') {
      out.push({ text: current, cond })
      current = ''
      cond = 'always'
      continue
    }
    if (char === '&' && line[index + 1] === '&') {
      out.push({ text: current, cond })
      current = ''
      cond = 'and'
      index++
      continue
    }
    if (char === '|' && line[index + 1] === '|') {
      out.push({ text: current, cond })
      current = ''
      cond = 'or'
      index++
      continue
    }
    current += char
  }

  if (current.trim()) out.push({ text: current, cond })
  return out.filter((statement) => statement.text.trim().length > 0)
}

export function splitPipeline(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.filter((part) => part.trim().length > 0)
}

export function tokenizeSegment(text: string): ShellSegment {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let redirect: ShellSegment['redirect']

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (char === '>') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      let append = false
      if (text[index + 1] === '>') {
        append = true
        index++
      }
      let target = text.slice(index + 1).trim()
      if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
        target = target.slice(1, -1)
      }
      if (target) redirect = { file: target, append }
      break
    }
    current += char
  }

  if (current) tokens.push(current)
  return { tokens, redirect }
}

/** The exact reading of a line that the interpreter executes. */
export function parseLine(line: string): ParsedStatement[] {
  return splitStatements(line).map((statement) => ({
    cond: statement.cond,
    segments: splitPipeline(statement.text)
      .map(tokenizeSegment)
      .filter((segment) => segment.tokens.length > 0),
  }))
}

/** True when the line ends inside a quote, which the interpreter silently accepts. */
export function hasUnterminatedQuote(line: string): boolean {
  let quote: string | null = null
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    }
  }
  return quote !== null
}

/** The command a segment's first token names, after aliases (`dir` is `ls`). */
export function commandName(token: string): string {
  return Object.hasOwn(SHELL_ALIASES, token) ? SHELL_ALIASES[token] : token
}

export function isBuiltin(name: string): boolean {
  return BUILTIN_SET.has(name)
}

export interface ShellHost {
  home: string
  path: PathApi
  /**
   * Turns a path as the shell writes it into one for `path`, such as Git
   * Bash's `/c/Users` into `C:\\Users`. Applied after `~` expansion.
   */
  translate?: (target: string) => string
}

/** `~` expansion, then the host's own spelling of paths. */
function expandShellPath(target: string, host: ShellHost): string {
  let expanded = target
  if (target === '~') expanded = host.home
  else if (target.startsWith('~/') || target.startsWith('~\\')) expanded = host.path.join(host.home, target.slice(2))
  return host.translate ? host.translate(expanded) : expanded
}

/** How the interpreter turns a path argument into an absolute path, including `~` expansion. */
export function resolveShellPath(cwd: string, target: string, host: ShellHost): string {
  if (!target) return cwd
  const api = host.path
  const expanded = expandShellPath(target, host)
  return api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(cwd, expanded)
}

const PARENT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/

/**
 * The same path with its `..` segments left in place, or null when it has
 * none. `resolveShellPath` folds `link/..` away as text, but on macOS and
 * Linux the kernel walks `..` from wherever `link` points, so `cat link/../x`
 * can read a file outside the folder that `link/../x` stays in on paper.
 * Callers check this form on disk too: realpath walks it the way the kernel
 * does. (Windows folds `..` as text before it touches the disk, so there
 * both forms name the same file and the extra check costs nothing.)
 */
export function unfoldedShellPath(cwd: string, target: string, host: ShellHost): string | null {
  if (!target) return PARENT_SEGMENT.test(cwd) ? cwd : null
  const api = host.path
  const expanded = expandShellPath(target, host)
  const joined = api.isAbsolute(expanded) ? expanded : cwd.endsWith(api.sep) ? cwd + expanded : cwd + api.sep + expanded
  return PARENT_SEGMENT.test(joined) ? joined : null
}
