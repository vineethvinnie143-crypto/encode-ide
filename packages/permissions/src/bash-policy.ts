import path from 'node:path'
import { parseBash, type BashCommand, type BashRedirect, type BashScript, type BashSimpleCommand, type BashWord } from './bash-grammar'
import {
  changeDirectory,
  checkExternal,
  checkPath,
  type CommandAssessment,
  type ExternalRule,
  type Scope,
} from './command-policy'
import { envValue, gitSafetyProblem, riskyVariable, type Environment } from './environment'
import { isInside } from './paths'
import type { PathApi } from './shell-grammar'

/**
 * Decides whether a bash line is read-only enough to run without asking, the
 * question `assessCommand` answers for the eNCode Shell, with the same allow
 * list of programs and options. `parseBash` reads the line; a line it cannot
 * read completely asks.
 *
 * On top of that grammar's rules, bash brings expansions. A word whose value
 * is only known when the line runs (a variable, a command's output, a glob)
 * may not be a path or an option, because the policy could not check it.
 * Only printing built-ins such as echo may take such words, and only from
 * parameters that hold no secrets. Commands inside `$(…)`, backquotes and
 * process substitutions must be read-only themselves.
 *
 * Like `assessCommand`, the verdict is lexical: `confirmOnDisk` finishes it
 * by resolving the paths through links and the programs through PATH.
 */

export interface BashContext {
  /** Absolute workspace root. */
  root: string
  /** Absolute directory the line starts in. */
  cwd: string
  /** Home directory, for `~` when the environment has no HOME. */
  home: string
  /**
   * Environment the line runs with. Variables carry over between agent
   * commands, and some make read-only programs run others.
   */
  env?: Environment
  /** Path rules of the machine that runs the line. Defaults to this machine's. */
  platform?: 'win32' | 'posix'
  /**
   * Whether the user trusts the workspace. git reads its configuration from
   * the folder, and that configuration can start programs (`diff.external`,
   * textconv drivers, filters), so git runs unasked only in trusted folders.
   */
  trusted?: boolean
}

const MAX_LINE_LENGTH = 8000

/** Control characters except tab and newline, and zero-width or direction-changing characters. */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

/** bash built-ins that only print or test. Their arguments may be any text. */
const PRINTING_BUILTINS = new Set(['echo', 'printf', 'true', 'false', ':', 'pwd', 'type', 'help', 'exit'])
/** `test` and `[` read paths: every argument that is not an operator is checked like a path. */
const TEST_BUILTINS = new Set(['test', '['])
const TEST_OPERATORS = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N',
  '-O', '-S', '-nt', '-ot', '-ef', '-o', '-z', '-n', '-v', '-R', '=', '==', '!=', '<', '>', '-eq', '-ne', '-lt',
  '-le', '-gt', '-ge', '!', '(', ')', ']',
])

/** Every other bash built-in, and why it asks. A name bash does not know is looked up as a program. */
const OTHER_BUILTINS = new Map<string, string>([
  ...['.', 'source', 'eval', 'exec', 'builtin', 'command', 'enable', 'trap', 'fc', 'coproc'].map(
    (name): [string, string] => [name, `runs ${name}, which runs code the policy cannot see`],
  ),
  ...[
    'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shopt', 'alias', 'unalias', 'hash', 'read',
    'readarray', 'mapfile', 'getopts', 'let', 'shift', 'umask', 'ulimit', 'bind', 'complete', 'compopt', 'compgen',
  ].map((name): [string, string] => [name, `runs ${name}, which changes the shell's state`]),
  ...[
    'kill', 'wait', 'jobs', 'fg', 'bg', 'disown', 'suspend', 'logout', 'return', 'break', 'continue', 'times',
    'caller', 'dirs', 'pushd', 'popd', 'history',
  ].map((name): [string, string] => [name, `${name} is not on the read-only list`]),
])

/**
 * Programs that are eNCode Shell built-ins but separate programs under bash,
 * plus a few more read-only tools, in the eNCode Shell's rule format.
 */
const BASH_PROGRAMS = new Map<string, ExternalRule>([
  // -L and --dereference list what symlinks point to, which may be outside the workspace.
  ['ls', { denyShort: 'L', denyLong: ['--dereference', '--dereference-command-line'] }],
  ['cat', {}],
  ['tac', {}],
  ['head', {}],
  ['tail', {}],
  ['wc', { denyLong: ['--files0-from'] }],
  ['date', { denyShort: 'sf', denyLong: ['--set', '--file'] }],
  ['whoami', { textOnly: true }],
  ['id', { textOnly: true }],
  ['which', { textOnly: true }],
  ['seq', { textOnly: true }],
  ['sleep', { textOnly: true }],
  ['nproc', { textOnly: true }],
  ['cygpath', { textOnly: true }],
  // --check reads a list of files from a file, which the policy cannot see.
  ...['md5sum', 'sha1sum', 'sha256sum', 'sha512sum'].map(
    (name): [string, ExternalRule] => [name, { denyShort: 'c', denyLong: ['--check'] }],
  ),
])

/** Parameters that may appear in printed text: they hold no secrets. */
const PRINTABLE_PARAMETERS = new Set(['?', '#', '$', '!', '-', '0', 'PWD', 'OLDPWD', 'HOME', 'USER', 'SHELL', 'PATH'])

function ask(reason: string): CommandAssessment {
  return { decision: 'ask', reason, paths: [], programs: [] }
}

function apiFor(platform: BashContext['platform']): PathApi {
  return platform === 'win32' ? path.win32 : platform === 'posix' ? path.posix : path
}

/** Where Git Bash keeps paths that are not on a drive (/tmp, /usr): nowhere a workspace can be. */
const OUTSIDE_EVERY_WORKSPACE = '\\\\?\\msys'

/**
 * Turns a path as Git Bash writes it into a Windows path. Git Bash spells
 * drive paths as `/c/Users/…`, which Windows would read as a folder on the
 * current drive. Its other absolute paths (/tmp, /usr, /) live in Git's own
 * folder or the user's temp folder, never in a workspace, so they map to a
 * path no workspace contains and fail the workspace check.
 */
export function gitBashToWindows(target: string): string {
  const drive = /^\/([A-Za-z])(\/|$)/.exec(target)
  if (drive) return `${drive[1].toUpperCase()}:\\${target.slice(drive[0].length).replace(/\//g, '\\')}`
  if (/^\/(?!\/)/.test(target)) return OUTSIDE_EVERY_WORKSPACE + target.replace(/\//g, '\\')
  return target
}

type WordValue = { value: string } | { problem: string }

/**
 * The text a word stands for. `printable` allows run-time values that cannot
 * be a path or option because the command only prints them.
 */
function wordValue(word: BashWord, scope: Scope, printable: boolean): WordValue {
  let value = ''
  for (const part of word.parts) {
    switch (part.kind) {
      case 'literal':
        value += part.value
        break
      case 'tilde':
        value += scope.host.home
        break
      case 'glob':
        return { problem: `uses the wildcard ${part.value} in ${word.text}, which the shell expands to file names` }
      case 'param':
        if (!printable) return { problem: `uses $${part.name}, whose value is only known when the line runs` }
        if (!PRINTABLE_PARAMETERS.has(part.name) && !/^\d+$/.test(part.name)) {
          return { problem: `prints $${part.name}, which may hold a secret` }
        }
        break
      case 'command':
        if (!printable) return { problem: `passes the output of ${part.text} as an argument` }
        break
      case 'process':
        // A word that is only a process substitution is a pipe the shell creates, such as /dev/fd/63.
        if (word.parts.length === 1) return { value: '.' }
        return { problem: `uses ${part.text} inside a word` }
    }
  }
  return { value }
}

const OUTPUT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])

function checkRedirect(redirect: BashRedirect, scope: Scope): string | null {
  const { operator } = redirect
  if (operator === '<<' || operator === '<<-') {
    const body = redirect.heredoc?.body ?? ''
    if (!redirect.heredoc?.quoted && /[$`]/.test(body)) return 'expands $ or backquotes inside a here-document'
    return null
  }
  if (operator === '<<<') {
    const value = wordValue(redirect.target, scope, true)
    return 'problem' in value ? value.problem : null
  }
  const target = wordValue(redirect.target, scope, false)
  if ('problem' in target) return target.problem
  if (target.value === '/dev/null') return null
  if (operator === '>&' || operator === '<&') return /^(\d+|-)$/.test(target.value) ? null : 'writes its output to a file'
  if (OUTPUT_OPERATORS.has(operator)) return 'writes its output to a file'
  // `<` reads a file, which is a path like any other.
  return checkPath(target.value, scope)
}

/** `cd [-L|-e|-@] [--] dir`, run on paper. */
function bashChangeDirectory(args: string[], scope: Scope, env: Environment | undefined, windows: boolean): string | null {
  let index = 0
  for (; index < args.length && /^-[LPe@]+$/.test(args[index]); index++) {
    // -P resolves links first, so `..` is taken from the link's target rather than from the path as written.
    if (args[index].includes('P')) return 'cd -P follows links the policy cannot see'
  }
  if (args[index] === '--') index++
  const operands = args.slice(index)
  if (operands.length !== 1) {
    return operands.length ? 'cd takes one directory' : 'cd without a directory goes to the home directory'
  }
  const [target] = operands
  if (target === '-') return 'cd - goes back to a directory the policy cannot see'
  if (envValue(env, 'CDPATH', windows) && !/^[\\/.~]/.test(target) && !/^[A-Za-z]:/.test(target)) {
    return 'CDPATH is set, so cd may go elsewhere'
  }
  return changeDirectory(target, scope)
}

/**
 * Whether one simple command is read-only, once the commands inside its
 * words have been checked. Records the paths it may read in `scope` and the
 * programs it starts in `programs`. Returns the reason to ask, or null.
 */
function simpleCommandProblem(
  command: BashSimpleCommand,
  scope: Scope,
  programs: Set<string>,
  context: BashContext,
): string | null {
  if (command.assignments.length) {
    return `sets ${command.assignments[0].name}, which can change what the command does`
  }
  for (const redirect of command.redirects) {
    const problem = checkRedirect(redirect, scope)
    if (problem) return problem
  }
  if (!command.words.length) return null // only redirections, all of them checked above

  const name = wordValue(command.words[0], scope, false)
  if ('problem' in name) return `runs a command whose name is only known when the line runs (${command.words[0].text})`
  const printing = PRINTING_BUILTINS.has(name.value)
  const args: string[] = []
  for (const word of command.words.slice(1)) {
    const value = wordValue(word, scope, printing)
    if ('problem' in value) return value.problem
    args.push(value.value)
  }

  if (printing) return name.value === 'printf' && args.some((arg) => arg.startsWith('-v')) ? 'printf -v sets a variable' : null
  if (TEST_BUILTINS.has(name.value)) {
    for (const arg of args) {
      if (TEST_OPERATORS.has(arg)) continue
      const problem = checkPath(arg, scope)
      if (problem) return problem
    }
    return null
  }
  const windows = scope.host.path === path.win32
  if (name.value === 'cd') return bashChangeDirectory(args, scope, context.env, windows)
  // `command -v name` only prints where a command comes from.
  if (name.value === 'command' && (args[0] === '-v' || args[0] === '-V') && args.slice(1).every((arg) => !arg.startsWith('-'))) {
    return null
  }
  const builtin = OTHER_BUILTINS.get(name.value)
  if (builtin) return builtin
  if (name.value === 'git' && !context.trusted) {
    return "runs git in a folder you have not trusted, and a folder's git config can start programs"
  }

  const problem = checkExternal(name.value, args, scope, windows, BASH_PROGRAMS)
  if (problem) return problem
  programs.add(name.value)
  return null
}

/**
 * Checks every command in the order bash runs them: the commands inside a
 * word's `$(…)` before the command that uses the word, and a subshell's or
 * group's redirections before its body. Returns the first reason to ask.
 */
function scriptProblem(script: BashScript, scope: Scope, programs: Set<string>, context: BashContext): string | null {
  for (const list of script.lists) {
    for (const pipeline of list.pipelines) {
      for (const command of pipeline.commands) {
        const problem = commandProblem(command, scope, programs, context)
        if (problem) return problem
      }
    }
  }
  return null
}

function commandProblem(command: BashCommand, scope: Scope, programs: Set<string>, context: BashContext): string | null {
  const words =
    command.kind === 'simple'
      ? [...command.assignments.map((assignment) => assignment.value), ...command.words]
      : []
  for (const word of [...words, ...command.redirects.map((redirect) => redirect.target)]) {
    for (const part of word.parts) {
      if (part.kind !== 'command' && part.kind !== 'process') continue
      const problem = scriptProblem(part.script, scope, programs, context)
      if (problem) return problem
    }
  }
  if (command.kind === 'simple') return simpleCommandProblem(command, scope, programs, context)
  for (const redirect of command.redirects) {
    const problem = checkRedirect(redirect, scope)
    if (problem) return problem
  }
  return scriptProblem(command.body, scope, programs, context)
}

/** Starts the lexical state for a line: the directory it runs in, and the path rules of its machine. */
function bashScope(context: BashContext): Scope | string {
  const api = apiFor(context.platform)
  const windows = api === path.win32
  const translate = windows ? gitBashToWindows : undefined
  const spell = (target: string) => (translate ? translate(target) : target)
  // bash expands ~ from HOME, which Git Bash keeps in its own spelling (/c/Users/me).
  const home = spell(envValue(context.env, 'HOME', windows) || context.home)
  const root = api.resolve(context.root)
  const start = api.resolve(spell(context.cwd))
  if (!isInside(root, start, api)) return 'starts outside the workspace'
  return { host: { home, path: api, translate }, root, cwds: new Set([start]), paths: new Set() }
}

/** Checks shared by the bash and PowerShell policies, before a line is parsed. */
export function shellLineProblem(line: string): string | null {
  if (!line.trim()) return 'empty command'
  if (line.length > MAX_LINE_LENGTH) return 'too long to review automatically'
  if (HIDDEN_CHARACTERS.test(line)) return 'contains control or invisible characters'
  return null
}

export function assessBashCommand(line: string, context: BashContext): CommandAssessment {
  const lineProblem = shellLineProblem(line)
  if (lineProblem) return ask(lineProblem)
  const parsed = parseBash(line)
  if (!parsed.ok) return ask(parsed.reason)
  const scope = bashScope(context)
  if (typeof scope === 'string') return ask(scope)

  const programs = new Set<string>()
  const problem = scriptProblem(parsed.script, scope, programs, context)
  if (problem) return ask(problem)

  const windows = scope.host.path === path.win32
  const risky = riskyVariable(context.env, programs, windows)
  if (risky) return ask(`runs with ${risky} set, which can make read-only commands run other programs`)
  if ([...programs].some((program) => program.toLowerCase().replace(/\.exe$/, '') === 'git')) {
    const unsafe = gitSafetyProblem(context.env, windows)
    if (unsafe) return ask(`runs git, but ${unsafe}`)
  }

  // Every directory the line may run in is read too (ls, git status), so it is checked like a path.
  for (const cwd of scope.cwds) scope.paths.add(cwd)
  return { decision: 'allow', reason: 'read-only', paths: [...scope.paths], programs: [...programs], cwds: [...scope.cwds] }
}
