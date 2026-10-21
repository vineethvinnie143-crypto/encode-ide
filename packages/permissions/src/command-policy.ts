import path from 'node:path'
import { isInside } from './paths'
import {
  SHELL_BUILTINS,
  commandName,
  hasUnterminatedQuote,
  isBuiltin,
  parseLine,
  resolveShellPath,
  unfoldedShellPath,
  type PathApi,
  type ShellHost,
} from './shell-grammar'

/**
 * Decides whether an eNCode Shell line is read-only enough to run without
 * asking (the Auto review policy). The answer is "allow" only when every
 * command in every statement is on a read-only list, no output is redirected,
 * and every path argument stays inside the workspace. Anything the policy
 * cannot prove harmless is "ask", never "deny": the user still decides.
 *
 * The verdict is lexical. The caller finishes the job on the real filesystem:
 * it realpath-checks `paths` (symlinks) and resolves `programs` on PATH to
 * make sure none of them is a binary inside the workspace.
 */

export interface CommandContext {
  /** Absolute workspace root. */
  root: string
  /** Absolute directory the line starts in. */
  cwd: string
  /** Home directory, for the shell's `~` expansion. */
  home: string
  /** Path rules of the machine that runs the line. Defaults to this machine's. */
  platform?: 'win32' | 'posix'
}

export interface CommandAssessment {
  decision: 'allow' | 'ask'
  /** Short, user-facing explanation. */
  reason: string
  /** Absolute paths the line may read, including every directory it may run in. Each is lexically inside the workspace. */
  paths: string[]
  /** External programs the line starts, as typed. */
  programs: string[]
  /** Directories the line may run commands in; also listed in `paths`. */
  cwds?: string[]
}

const MAX_LINE_LENGTH = 2000

/** C0 controls except tab, DEL, C1 controls, and zero-width or bidirectional formatting characters. */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

const READ_ONLY_BUILTINS = new Set(['help', 'clear', 'pwd', 'echo', 'date', 'whoami', 'history', 'ver', 'exit'])
/** Built-ins that read the paths they are given; every argument is checked. */
const READING_BUILTINS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'which'])
const WRITING_BUILTINS = new Set(['mkdir', 'rm', 'mv', 'cp', 'touch'])
const ENVIRONMENT_BUILTINS = new Set(['env', 'set', 'export', 'unset'])

/** Every built-in must be classified; a new one fails this at load time until it is. */
for (const builtin of SHELL_BUILTINS) {
  const classified =
    builtin === 'cd' ||
    READ_ONLY_BUILTINS.has(builtin) ||
    READING_BUILTINS.has(builtin) ||
    WRITING_BUILTINS.has(builtin) ||
    ENVIRONMENT_BUILTINS.has(builtin)
  if (!classified) throw new Error(`command policy: shell built-in "${builtin}" has no rule`)
}

export interface OptionRule {
  /** Short option letters that write, execute, follow symlinks or read file lists. */
  denyShort?: string
  /**
   * Long options with the same effects; `--name` also matches `--name=value`.
   * getopt_long and git accept any unambiguous prefix of a long option, so
   * every prefix of a denied option (`--compress-prog`) is denied too.
   */
  denyLong?: readonly string[]
  /** Exact long options that are also prefixes of denied ones (`--exclude` next to `--exclude-from`). */
  allowLong?: readonly string[]
  /** Options are whole words (`-name`, `-exec`), as in find. */
  wordOptions?: boolean
  /** For word options: the forbidden words. */
  denyWords?: readonly string[]
  /** Arguments are text, not paths (tr, printf, basename). */
  textOnly?: boolean
  /** Upper bound on operands, for tools whose extra operand is an output file. */
  maxOperands?: number
}

export interface ExternalRule extends OptionRule {
  /** Only `<program> <flag>` with one of these flags (version queries). */
  versionFlags?: readonly string[]
  /** Hand-written rule; returns a reason to ask, or null. */
  custom?: (args: string[], scope: Scope) => string | null
}

/** What a line has done so far: where it may be running, and what it may read. */
export interface Scope {
  host: ShellHost
  root: string
  cwds: Set<string>
  paths: Set<string>
}

const GREP: OptionRule = {
  denyShort: 'fR',
  denyLong: ['--file', '--dereference-recursive', '--exclude-from'],
  allowLong: ['--exclude'],
}

const EXTERNAL_RULES = new Map<string, ExternalRule>([
  ['grep', GREP],
  ['egrep', GREP],
  ['fgrep', GREP],
  [
    'rg',
    {
      denyShort: 'fLz',
      denyLong: ['--file', '--follow', '--pre', '--pre-glob', '--search-zip', '--ignore-file', '--hostname-bin'],
      allowLong: ['--ignore'],
    },
  ],
  [
    'find',
    {
      wordOptions: true,
      denyWords: [
        '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls',
        '-L', '-H', '-follow', '-files0-from',
      ],
    },
  ],
  ['findstr', {}],
  ['sort', { denyShort: 'oT', denyLong: ['--output', '--compress-program', '--temporary-directory', '--files0-from'] }],
  ['uniq', { maxOperands: 1 }],
  ['cut', {}],
  ['tr', { textOnly: true }],
  // GNU diff follows symlinks while recursing.
  ['diff', { denyShort: 'r', denyLong: ['--recursive'] }],
  ['cmp', {}],
  ['comm', {}],
  ['stat', {}],
  ['file', { denyShort: 'Cfm', denyLong: ['--compile', '--files-from', '--magic-file'] }],
  ['du', { denyShort: 'LX', denyLong: ['--dereference', '--exclude-from', '--files0-from'], allowLong: ['--exclude'] }],
  ['tree', { denyShort: 'olR', denyLong: ['--fromfile', '--output'] }],
  ['basename', { textOnly: true }],
  ['dirname', { textOnly: true }],
  ['realpath', {}],
  ['readlink', {}],
  ['uname', { textOnly: true }],
  ['nl', {}],
  ['rev', {}],
  ['fold', {}],
  ['column', {}],
  ['printf', { textOnly: true }],
  ['true', { textOnly: true }],
  ['false', { textOnly: true }],
  // Version queries only: anything more runs project code or scripts. Not npm: on Windows,
  // npm.cmd loads the project's npm config to locate npm before it prints a version.
  ['node', { versionFlags: ['--version', '-v'] }],
  ['python', { versionFlags: ['--version', '-V'] }],
  ['python3', { versionFlags: ['--version', '-V'] }],
  ['tsc', { versionFlags: ['--version', '-v'] }],
  ['git', { custom: assessGit }],
])

/** git options that write files, run external programs or read outside the repository. */
const GIT_HISTORY: OptionRule = {
  denyShort: 'O',
  denyLong: ['--output', '--ext-diff', '--no-index', '--textconv', '--open-files-in-pager'],
  allowLong: ['--text'],
}

interface GitRule extends OptionRule {
  /** Operands are allowed only together with one of these listing options. */
  listingOptions?: readonly string[]
  custom?: (args: string[], scope: Scope) => string | null
}

const GIT_RULES = new Map<string, GitRule>([
  ['status', {}],
  ['diff', GIT_HISTORY],
  ['log', GIT_HISTORY],
  ['show', GIT_HISTORY],
  ['shortlog', GIT_HISTORY],
  ['blame', { denyShort: 'S' }],
  ['grep', { denyShort: 'Of', denyLong: ['--open-files-in-pager', '--textconv'], allowLong: ['--text'] }],
  ['ls-files', { denyShort: 'X' }],
  ['ls-tree', {}],
  ['rev-parse', {}],
  ['rev-list', {}],
  ['merge-base', {}],
  ['describe', {}],
  ['show-ref', {}],
  [
    'branch',
    {
      denyShort: 'dDmMcCfut',
      denyLong: [
        '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream',
        '--edit-description', '--track', '--no-track', '--create-reflog', '--recurse-submodules',
      ],
      listingOptions: ['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'],
    },
  ],
  [
    'tag',
    {
      denyShort: 'dasmfFuev',
      denyLong: [
        '--delete', '--annotate', '--sign', '--message', '--file', '--force', '--local-user', '--edit',
        '--verify', '--create-reflog', '--cleanup',
      ],
      listingOptions: ['--list', '-l', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'],
    },
  ],
  [
    'remote',
    {
      custom: (args) => {
        if (!args.length || (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose'))) return null
        if (args[0] === 'get-url') {
          const rest = args.slice(1)
          const operands = rest.filter((arg) => !arg.startsWith('-'))
          const flagsOk = rest.every((arg) => !arg.startsWith('-') || arg === '--push' || arg === '--all')
          if (flagsOk && operands.length <= 1) return null
        }
        return 'changes or contacts a git remote'
      },
    },
  ],
  [
    'stash',
    {
      custom: (args, scope) => {
        if (args[0] === 'list' || args[0] === 'show') return checkOptions(args.slice(1), GIT_HISTORY, scope)
        return 'changes the git stash'
      },
    },
  ],
])

function assessGit(args: string[], scope: Scope): string | null {
  let index = 0
  while (args[index] === '--no-pager' || args[index] === '-P') index++
  const sub = args[index]
  const rest = args.slice(index + 1)
  if (sub === undefined) return null
  if (sub === '--version' || sub === 'version') return rest.length ? 'passes unexpected arguments to git' : null
  if (sub.startsWith('-')) return 'sets git options that can change what git runs'
  const rule = GIT_RULES.get(sub)
  if (!rule) return `runs git ${sub}, which is not on the read-only list`
  if (rule.custom) return rule.custom(rest, scope)
  const problem = checkOptions(rest, rule, scope) ?? checkRevisionPaths(rest)
  if (problem) return problem
  if (rule.listingOptions && operandsOf(rest).length) {
    const listing = rest.some((arg) =>
      rule.listingOptions!.some((option) => arg === option || arg.startsWith(`${option}=`) || (option.length === 2 && arg.startsWith(option))),
    )
    if (!listing) return `creates a git ${sub}`
  }
  return null
}

/**
 * `<rev>:<path>` reads a file from history. The path is relative to the
 * repository root, which can lie above the workspace, or to the current
 * directory when it starts with `./` or `../`; either way `..` and absolute
 * paths can name files outside the workspace. GIT_CEILING_DIRECTORIES keeps
 * the repository inside the workspace (see gitBoundaryEnvironment); this
 * check is the lexical half.
 */
function checkRevisionPaths(args: string[]): string | null {
  for (const operand of operandsOf(args)) {
    const colon = operand.indexOf(':')
    if (colon === -1 || /^[A-Za-z]:[\\/]/.test(operand)) continue
    const target = operand.slice(colon + 1)
    if (/^[\\/]/.test(target) || /^[A-Za-z]:/.test(target) || target.split(/[\\/]+/).includes('..')) {
      return `reads ${operand} from git history, which may lie outside the workspace`
    }
  }
  return null
}

function operandsOf(args: string[]): string[] {
  const out: string[] = []
  let endOfOptions = false
  for (const arg of args) {
    if (endOfOptions || arg === '-' || !arg.startsWith('-')) out.push(arg)
    else if (arg === '--') endOfOptions = true
  }
  return out
}

/**
 * Checks options against a rule and records every operand and option value as
 * a path the line may read. Returns a reason to ask, or null.
 */
export function checkOptions(args: string[], rule: OptionRule, scope: Scope): string | null {
  const candidates: string[] = []
  let operands = 0
  let endOfOptions = false
  const denyShort = rule.denyShort ?? ''
  const denyLong = rule.denyLong ?? []

  for (const arg of args) {
    if (endOfOptions || arg === '-' || !arg.startsWith('-')) {
      operands++
      candidates.push(arg)
      continue
    }
    if (arg === '--') {
      endOfOptions = true
      continue
    }
    if (rule.wordOptions) {
      if (rule.denyWords?.includes(arg)) return `uses ${arg}`
      continue
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals === -1 ? arg : arg.slice(0, equals)
      const denied = rule.allowLong?.includes(name) ? undefined : denyLong.find((option) => option.startsWith(name))
      if (denied) return `uses ${denied}`
      if (equals !== -1) candidates.push(arg.slice(equals + 1))
      continue
    }
    for (const letter of arg.slice(1)) {
      if (denyShort.includes(letter)) return `uses -${letter}`
    }
  }

  if (rule.maxOperands !== undefined && operands > rule.maxOperands) return 'may write its output to a file'
  if (!rule.textOnly) {
    for (const candidate of candidates) {
      const problem = checkPath(candidate, scope)
      if (problem) return problem
    }
  }
  return null
}

export function checkPath(target: string, scope: Scope): string | null {
  for (const cwd of scope.cwds) {
    const absolute = resolveShellPath(cwd, target, scope.host)
    if (!isInside(scope.root, absolute, scope.host.path)) return `reaches outside the workspace (${target})`
    scope.paths.add(absolute)
    const unfolded = unfoldedShellPath(cwd, target, scope.host)
    if (unfolded) scope.paths.add(unfolded)
  }
  return null
}

/**
 * Runs `cd target` on paper: every directory the line may then be in must be
 * inside the workspace. `cd` may fail or be skipped by `&&` and `||`, so
 * later commands may run in the old directories too and all are kept.
 */
export function changeDirectory(target: string, scope: Scope): string | null {
  const next = new Set(scope.cwds)
  for (const cwd of scope.cwds) {
    const resolved = resolveShellPath(cwd, target, scope.host)
    if (!isInside(scope.root, resolved, scope.host.path)) return `reaches outside the workspace (${target})`
    next.add(resolved)
    const unfolded = unfoldedShellPath(cwd, target, scope.host)
    if (unfolded) next.add(unfolded)
  }
  scope.cwds = next
  return null
}

function ask(reason: string): CommandAssessment {
  return { decision: 'ask', reason, paths: [], programs: [] }
}

/** A plain program name: no path, no drive, no leading dot. */
const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/

/**
 * Whether starting the external program `first` with `args` is read-only:
 * null when it is, otherwise the reason to ask. Paths it may read are added
 * to `scope`. `extra` adds rules for programs that are built-ins in the
 * eNCode Shell but separate programs in other shells (ls, cat). Shared by
 * every shell grammar eNCode reads, so all of them use one allow list.
 */
export function checkExternal(
  first: string,
  args: string[],
  scope: Scope,
  windows: boolean,
  extra?: ReadonlyMap<string, ExternalRule>,
): string | null {
  if (!PROGRAM_NAME.test(first)) return `runs ${first} by path`
  const key = windows ? first.toLowerCase().replace(/\.(exe|com)$/, '') : first
  const rule = EXTERNAL_RULES.get(key) ?? extra?.get(key)
  if (!rule) return `${first} is not on the read-only list`
  if (rule.versionFlags) {
    return args.length === 1 && rule.versionFlags.includes(args[0]) ? null : `only version queries of ${first} run unasked`
  }
  return rule.custom ? rule.custom(args, scope) : checkOptions(args, rule, scope)
}

export function assessCommand(line: string, context: CommandContext): CommandAssessment {
  const api: PathApi =
    context.platform === 'win32' ? path.win32 : context.platform === 'posix' ? path.posix : path
  const windows = api === api.win32

  if (!line.trim()) return ask('empty command')
  if (line.length > MAX_LINE_LENGTH) return ask('too long to review automatically')
  if (HIDDEN_CHARACTERS.test(line)) return ask('contains control or invisible characters')
  if (hasUnterminatedQuote(line)) return ask('has an unterminated quote')

  const root = api.resolve(context.root)
  const start = api.resolve(context.cwd)
  if (!isInside(root, start, api)) return ask('starts outside the workspace')

  const scope: Scope = { host: { home: context.home, path: api }, root, cwds: new Set([start]), paths: new Set() }
  const programs = new Set<string>()

  for (const statement of parseLine(line)) {
    for (const segment of statement.segments) {
      if (segment.redirect) return ask('writes its output to a file')
      const [first, ...args] = segment.tokens
      const name = commandName(first)

      if (isBuiltin(name)) {
        if (WRITING_BUILTINS.has(name)) return ask(`${name} changes files`)
        if (ENVIRONMENT_BUILTINS.has(name)) return ask(`${name} reads or changes environment variables`)
        if (READ_ONLY_BUILTINS.has(name)) continue
        if (name === 'cd') {
          if (!args.length) return ask('cd without a directory goes to the home directory')
          const problem = changeDirectory(args[0], scope)
          if (problem) return ask(problem)
          continue
        }
        // Reading built-ins treat every argument that is not an option as a path (cat: every argument).
        const targets = name === 'cat' || name === 'which' ? args : args.filter((arg) => !arg.startsWith('-'))
        for (const target of targets) {
          const problem = checkPath(target, scope)
          if (problem) return ask(problem)
        }
        continue
      }

      const problem = checkExternal(first, args, scope, windows)
      if (problem) return ask(problem)
      programs.add(first)
    }
  }

  // Every directory the line may run in is read too (ls, git status), so it is checked like a path.
  for (const cwd of scope.cwds) scope.paths.add(cwd)
  return {
    decision: 'allow',
    reason: 'read-only',
    paths: [...scope.paths],
    programs: [...programs],
    cwds: [...scope.cwds],
  }
}
