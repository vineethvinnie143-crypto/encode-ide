import path from 'node:path'
import { shellLineProblem, type BashContext } from './bash-policy'
import {
  changeDirectory,
  checkExternal,
  checkPath,
  type CommandAssessment,
  type ExternalRule,
  type Scope,
} from './command-policy'
import { envValue, gitSafetyProblem, riskyVariable } from './environment'
import { isInside } from './paths'
import { parsePwsh, type PwshCommand, type PwshWord } from './pwsh-grammar'
import { resolveShellPath, type PathApi } from './shell-grammar'

/**
 * Decides whether a PowerShell line is read-only enough to run without
 * asking. `parsePwsh` reads the line; a line it cannot read completely asks.
 * Cmdlets are allowed from a short list, each with the parameters it may
 * take, bound the way PowerShell binds them (by name, by unambiguous prefix
 * or alias, then by position). Path parameters must stay in the workspace
 * and may not use wildcards (PowerShell expands them even when quoted) or
 * PowerShell drives (Env:, HKLM:, Cert:). Other programs follow the same
 * allow list as the eNCode Shell and bash.
 *
 * The verdict is lexical; `confirmOnDisk` finishes it. On Windows the
 * caller's program lookup must include PowerShell's own: `.ps1` scripts on
 * PATH as well as PATHEXT.
 */

export type PwshContext = BashContext

type ParameterKind = 'path' | 'location' | 'value' | 'switch'

interface ParameterRule {
  /** Name and aliases, lower case; the first is the name. */
  names: readonly string[]
  kind: ParameterKind
}

interface CmdletRule {
  name: string
  parameters: readonly ParameterRule[]
  /** Parameters filled by position, in order. */
  positional: readonly string[]
  /** Every argument without a parameter name is text (Write-Output). */
  textRest?: boolean
}

const pathParameter = (...names: string[]): ParameterRule => ({ names, kind: 'path' })
const value = (...names: string[]): ParameterRule => ({ names, kind: 'value' })
const flag = (...names: string[]): ParameterRule => ({ names, kind: 'switch' })

/** Parameters every cmdlet takes. The *Variable ones set variables in a shell that ends with the line. */
const COMMON: readonly ParameterRule[] = [
  flag('verbose', 'vb'), flag('debug', 'db'), value('erroraction', 'ea'), value('warningaction', 'wa'),
  value('informationaction', 'infa'), value('progressaction', 'proga'), value('errorvariable', 'ev'),
  value('warningvariable', 'wv'), value('informationvariable', 'iv'), value('outvariable', 'ov'),
  value('outbuffer', 'ob'), value('pipelinevariable', 'pv'),
]

/** Path parameters. -LiteralPath takes no wildcards, so they may appear in it. */
const PATHS = [pathParameter('path'), pathParameter('literalpath', 'lp', 'pspath')]
const FILTERS = [value('filter'), value('include'), value('exclude')]

const CMDLETS: readonly CmdletRule[] = [
  {
    name: 'get-childitem',
    // Not -FollowSymlink: it walks into links while recursing.
    parameters: [
      ...PATHS, ...FILTERS, flag('recurse', 's'), value('depth'), flag('force'), flag('name'), value('attributes'),
      flag('directory', 'ad', 'd'), flag('file', 'af'), flag('hidden', 'ah', 'h'), flag('readonly', 'ar'),
      flag('system', 'as'),
    ],
    positional: ['path', 'filter'],
  },
  {
    name: 'get-content',
    parameters: [
      ...PATHS, ...FILTERS, value('totalcount', 'first', 'head'), value('tail', 'last'), value('readcount'),
      flag('raw'), value('encoding'), value('delimiter'), flag('wait'), value('stream'), flag('asbytestream'),
      flag('force'),
    ],
    positional: ['path'],
  },
  { name: 'get-location', parameters: [value('psprovider'), value('psdrive'), flag('stack'), value('stackname')], positional: [] },
  {
    name: 'set-location',
    parameters: [
      { names: ['path'], kind: 'location' }, { names: ['literalpath', 'lp', 'pspath'], kind: 'location' },
      flag('passthru'), value('stackname'),
    ],
    positional: ['path'],
  },
  { name: 'write-output', parameters: [flag('noenumerate')], positional: [], textRest: true },
  {
    name: 'write-host',
    parameters: [flag('nonewline'), value('separator'), value('foregroundcolor'), value('backgroundcolor')],
    positional: [],
    textRest: true,
  },
  {
    name: 'select-string',
    parameters: [
      value('pattern'), ...PATHS, flag('simplematch'), flag('casesensitive'), value('context'), flag('list'),
      flag('notmatch'), flag('allmatches'), flag('raw'), flag('quiet'), value('encoding'), value('include'),
      value('exclude'), flag('noemphasis'), value('culture'),
    ],
    positional: ['pattern', 'path'],
  },
  {
    name: 'measure-object',
    parameters: [
      value('property'), flag('line'), flag('word'), flag('character'), flag('sum'), flag('average'), flag('maximum'),
      flag('minimum'), flag('standarddeviation'), flag('allstats'), flag('ignorewhitespace'),
    ],
    positional: ['property'],
  },
  {
    name: 'sort-object',
    parameters: [
      value('property'), flag('descending'), flag('unique'), flag('casesensitive'), flag('stable'), value('top'),
      value('bottom'), value('culture'),
    ],
    positional: ['property'],
  },
  {
    name: 'select-object',
    parameters: [
      value('property'), value('excludeproperty'), value('expandproperty'), value('first'), value('last'),
      value('skip'), value('skiplast'), value('index'), value('skipindex'), flag('unique'), flag('wait'),
    ],
    positional: ['property'],
  },
  {
    name: 'where-object',
    // Simplified syntax only (Where-Object Name -eq x); a script block is refused by the grammar.
    parameters: [
      value('property'), value('value'), flag('not'),
      ...['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains',
        'in', 'notin', 'is', 'isnot'].flatMap((operator) => [flag(operator), flag(`c${operator}`)]),
    ],
    positional: ['property', 'value'],
  },
  {
    name: 'group-object',
    parameters: [value('property'), flag('noelement'), flag('asstring'), flag('ashashtable'), flag('casesensitive'), value('culture')],
    positional: ['property'],
  },
  { name: 'get-item', parameters: [...PATHS, ...FILTERS, value('stream'), flag('force')], positional: ['path'] },
  {
    name: 'test-path',
    parameters: [...PATHS, ...FILTERS, value('pathtype', 'type'), flag('isvalid'), value('olderthan'), value('newerthan')],
    positional: ['path'],
  },
  { name: 'resolve-path', parameters: [...PATHS, flag('relative'), pathParameter('relativebasepath')], positional: ['path'] },
  {
    name: 'split-path',
    parameters: [
      ...PATHS, flag('parent'), flag('leaf'), flag('leafbase'), flag('extension'), flag('qualifier'),
      flag('noqualifier'), flag('isabsolute'), flag('resolve'),
    ],
    positional: ['path'],
  },
  { name: 'get-filehash', parameters: [...PATHS, value('algorithm')], positional: ['path', 'algorithm'] },
  {
    name: 'get-date',
    parameters: [
      value('date'), value('format'), value('uformat'), value('year'), value('month'), value('day'), value('hour'),
      value('minute'), value('second'), value('millisecond'), value('displayhint'), flag('asutc'), value('unixtimeseconds'),
    ],
    positional: ['date'],
  },
  ...['format-table', 'format-list', 'format-wide'].map(
    (name): CmdletRule => ({
      name,
      parameters: [value('property'), flag('autosize'), flag('wrap'), flag('hidetableheaders'), value('groupby'), value('column'), flag('force')],
      positional: ['property'],
    }),
  ),
  { name: 'out-string', parameters: [flag('stream'), value('width'), flag('nonewline')], positional: [] },
  { name: 'out-null', parameters: [], positional: [] },
  { name: 'get-unique', parameters: [flag('asstring'), flag('ontype'), flag('caseinsensitive')], positional: [] },
  { name: 'clear-host', parameters: [], positional: [] },
  { name: 'start-sleep', parameters: [value('seconds', 's'), value('milliseconds', 'ms'), value('duration')], positional: ['seconds'] },
]

const CMDLET_RULES = new Map(CMDLETS.map((rule) => [rule.name, rule]))

/** Aliases for the cmdlets above, as Windows PowerShell 5.1 and PowerShell 7 on Windows define them. */
const ALIASES = new Map<string, string>([
  ['gci', 'get-childitem'], ['ls', 'get-childitem'], ['dir', 'get-childitem'],
  ['gc', 'get-content'], ['cat', 'get-content'], ['type', 'get-content'],
  ['gl', 'get-location'], ['pwd', 'get-location'],
  ['sl', 'set-location'], ['cd', 'set-location'], ['chdir', 'set-location'],
  ['echo', 'write-output'], ['write', 'write-output'],
  ['sls', 'select-string'], ['measure', 'measure-object'], ['sort', 'sort-object'], ['select', 'select-object'],
  ['where', 'where-object'], ['group', 'group-object'], ['gi', 'get-item'], ['rvpa', 'resolve-path'],
  ['ft', 'format-table'], ['fl', 'format-list'], ['fw', 'format-wide'], ['gu', 'get-unique'],
  ['cls', 'clear-host'], ['clear', 'clear-host'], ['sleep', 'start-sleep'],
])

/**
 * Aliases PowerShell on macOS and Linux leaves out, so the native program of
 * that name runs instead. There the name must pass both rules.
 */
const NATIVE_ON_POSIX = new Set(['ls', 'dir', 'cat', 'pwd', 'echo', 'write', 'sort', 'clear', 'sleep', 'type'])

/** Programs the PowerShell policy adds to the shared list: the natives behind those aliases. */
const PWSH_PROGRAMS = new Map<string, ExternalRule>([
  ['ls', { denyShort: 'L', denyLong: ['--dereference', '--dereference-command-line'] }],
  ['cat', {}],
  ['echo', { textOnly: true }],
  ['pwd', { textOnly: true }],
  ['clear', { textOnly: true }],
  ['sleep', { textOnly: true }],
  ['head', {}],
  ['tail', {}],
  ['wc', { denyLong: ['--files0-from'] }],
  ['whoami', { textOnly: true }],
  ['where', { textOnly: true }],
])

function ask(reason: string): CommandAssessment {
  return { decision: 'ask', reason, paths: [], programs: [] }
}

function apiFor(platform: PwshContext['platform']): PathApi {
  return platform === 'win32' ? path.win32 : platform === 'posix' ? path.posix : path
}

/** `-Name` or `-Name:value` typed without quotes: a parameter. `-5` is a number. */
function parameterOf(word: PwshWord): { name: string; inline?: string } | null {
  if (word.quotedStart) return null
  const match = /^-([A-Za-z_?][\w?-]*)(?::(.*))?$/s.exec(word.value)
  if (!match) return null
  return { name: match[1].toLowerCase(), inline: match[2] }
}

/** The rule a parameter name selects: exact name or alias first, then a unique prefix of one. */
function findParameter(rules: readonly ParameterRule[], name: string): ParameterRule | 'ambiguous' | null {
  const exact = rules.find((rule) => rule.names.includes(name))
  if (exact) return exact
  const prefixed = rules.filter((rule) => rule.names.some((candidate) => candidate.startsWith(name)))
  if (prefixed.length > 1) return 'ambiguous'
  return prefixed[0] ?? null
}

/**
 * A PowerShell drive or provider path: `Env:`, `HKLM:\…`, `Cert:`, or a
 * provider-qualified `FileSystem::C:\…`. Single-letter drives are files.
 */
function providerPath(target: string): boolean {
  return /^[A-Za-z][\w-]+:/.test(target) || target.includes('::')
}

function checkPathValue(word: PwshWord, literal: boolean, scope: Scope): string | null {
  const target = word.value
  if (providerPath(target)) return `names a PowerShell drive or provider (${word.text})`
  if (!literal && /[*?[]/.test(target)) return `uses a wildcard in ${word.text}, which PowerShell expands to file names`
  return checkPath(target, scope)
}

/** Set-Location, run on paper. */
function setLocation(word: PwshWord | undefined, literal: boolean, scope: Scope): string | null {
  if (!word) return 'Set-Location without a path goes to the home directory'
  const target = word.value
  if (target === '-' || target === '+') return 'Set-Location - and + go to directories the policy cannot see'
  if (providerPath(target)) return `names a PowerShell drive or provider (${word.text})`
  if (!literal && /[*?[]/.test(target)) return `uses a wildcard in ${word.text}, which PowerShell expands to file names`
  return changeDirectory(target, scope)
}

/** Binds a cmdlet's arguments the way PowerShell does and checks each by its parameter's kind. */
function checkCmdlet(rule: CmdletRule, args: PwshWord[], scope: Scope): string | null {
  const parameters = [...rule.parameters, ...COMMON]
  const bound = new Set<string>()
  const positional: PwshWord[] = []
  const named: Array<[ParameterRule, PwshWord | undefined]> = []
  let endOfParameters = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!endOfParameters && !arg.quotedStart && arg.value === '--') {
      endOfParameters = true
      continue
    }
    const parameter = endOfParameters ? null : parameterOf(arg)
    if (!parameter) {
      positional.push(arg)
      continue
    }
    const match = findParameter(parameters, parameter.name)
    if (match === 'ambiguous') return `passes ${arg.text}, which could name more than one parameter`
    if (!match) return `passes ${arg.text}, which is not on the read-only list for ${rule.name}`
    if (bound.has(match.names[0])) return `passes -${match.names[0]} twice`
    bound.add(match.names[0])
    if (match.kind === 'switch') {
      if (parameter.inline !== undefined && !/^(true|false)$/i.test(parameter.inline)) {
        return `passes ${arg.text}, which sets a switch to something other than true or false`
      }
      continue
    }
    if (parameter.inline !== undefined) {
      named.push([match, { text: arg.text, value: parameter.inline, quotedStart: false, unquotedWildcard: /[*?[]/.test(parameter.inline) }])
    } else {
      named.push([match, args[++index]])
    }
  }

  const slots = rule.positional.filter((name) => !bound.has(name))
  if (!rule.textRest && positional.length > slots.length) {
    return `passes more arguments to ${rule.name} than the read-only list knows how to read`
  }
  for (const [index, word] of positional.entries()) {
    if (rule.textRest && index >= slots.length) continue
    const match = parameters.find((parameter) => parameter.names[0] === slots[index])
    if (match) named.push([match, word])
  }

  for (const [parameter, word] of named) {
    if (!word) return `passes -${parameter.names[0]} without a value`
    const literal = parameter.names[0] === 'literalpath'
    if (parameter.kind === 'path') {
      const problem = checkPathValue(word, literal, scope)
      if (problem) return problem
    } else if (parameter.kind === 'location') {
      const problem = setLocation(word, literal, scope)
      if (problem) return problem
    }
  }
  if (rule.name === 'set-location' && !named.some(([parameter]) => parameter.kind === 'location')) {
    return setLocation(undefined, false, scope)
  }
  return null
}

/**
 * Arguments PowerShell may hand to a program as something else. Before 7.3
 * it drops empty arguments and does not escape embedded quotes, a trailing
 * backslash in a quoted argument escapes the closing quote, an unquoted
 * `-name.ext` is split at the dot (`-Dmaven.test=1` arrives as two
 * arguments), and some versions drop `--`, which would turn the operands
 * after it into options.
 */
function nativeArgumentsProblem(args: PwshWord[]): string | null {
  let afterDoubleDash = false
  for (const word of args) {
    const text = word.value
    if (text === '') return 'passes an empty argument, which older PowerShell drops'
    if (text.includes('"') || (/\s/.test(text) && text.endsWith('\\')) || (!word.quotedStart && /^-[^.]*\./.test(text))) {
      return `passes ${word.text}, which PowerShell may hand to the program as more than one argument`
    }
    if (afterDoubleDash && text.startsWith('-')) {
      return `passes ${word.text} after --, which some PowerShell versions do not pass on`
    }
    if (text === '--') afterDoubleDash = true
    if (word.unquotedWildcard) return `uses a wildcard in ${word.text}, which may be expanded to file names`
  }
  return null
}

function nativeProblem(name: string, args: PwshWord[], scope: Scope, context: PwshContext): string | null {
  const windows = scope.host.path === path.win32
  const problem = nativeArgumentsProblem(args)
  if (problem) return problem
  if (/^git(\.exe)?$/i.test(name) && !context.trusted) {
    return "runs git in a folder you have not trusted, and a folder's git config can start programs"
  }
  return checkExternal(name, args.map((arg) => arg.value), scope, windows, PWSH_PROGRAMS)
}

function commandProblem(command: PwshCommand, scope: Scope, programs: Set<string>, context: PwshContext): string | null {
  for (const redirect of command.redirects) {
    if (redirect.target) return 'writes its output to a file'
  }
  const windows = scope.host.path === path.win32
  let name = command.name.value
  let args = command.args
  // cd.. and cd\ are functions PowerShell defines on Windows.
  if (/^cd(\.\.|\\)$/i.test(name)) {
    args = [{ text: name.slice(2), value: name.slice(2), quotedStart: false, unquotedWildcard: false }, ...args]
    name = 'cd'
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return `runs ${command.name.text} by path`
  const lower = name.toLowerCase()
  const cmdlet = CMDLET_RULES.get(ALIASES.get(lower) ?? lower)
  if (cmdlet) {
    const problem = checkCmdlet(cmdlet, args, scope)
    if (problem) return problem
    if (windows || !NATIVE_ON_POSIX.has(lower)) return null
  }
  const problem = nativeProblem(name, args, scope, context)
  if (problem) return problem
  programs.add(name)
  return null
}

/** PowerShell loads modules from PSModulePath to find commands; one inside the workspace could replace a cmdlet. */
function moduleProblem(context: PwshContext, scope: Scope): string | null {
  const windows = scope.host.path === path.win32
  const list = envValue(context.env, 'PSModulePath', windows)
  if (!list) return null
  for (const entry of list.split(windows ? ';' : ':')) {
    const dir = entry.trim()
    if (!dir) continue
    const resolved = resolveShellPath(scope.root, dir, scope.host)
    if (isInside(scope.root, resolved, scope.host.path)) return `loads PowerShell modules from inside the workspace (${dir})`
  }
  return null
}

export function assessPwshCommand(line: string, context: PwshContext): CommandAssessment {
  const source = line.replace(/\r\n/g, '\n')
  const lineProblem = shellLineProblem(source)
  if (lineProblem) return ask(lineProblem)
  const parsed = parsePwsh(source)
  if (!parsed.ok) return ask(parsed.reason)

  const api = apiFor(context.platform)
  const root = api.resolve(context.root)
  const start = api.resolve(context.cwd)
  if (!isInside(root, start, api)) return ask('starts outside the workspace')
  const scope: Scope = { host: { home: context.home, path: api }, root, cwds: new Set([start]), paths: new Set() }
  const windows = api === path.win32

  const modules = moduleProblem(context, scope)
  if (modules) return ask(modules)
  const programs = new Set<string>()
  for (const statement of parsed.script.statements) {
    for (const pipeline of statement.pipelines) {
      for (const command of pipeline.commands) {
        const problem = commandProblem(command, scope, programs, context)
        if (problem) return ask(problem)
      }
    }
  }

  const risky = riskyVariable(context.env, programs, windows)
  if (risky) return ask(`runs with ${risky} set, which can make read-only commands run other programs`)
  if ([...programs].some((program) => /^git(\.exe)?$/i.test(program))) {
    const unsafe = gitSafetyProblem(context.env, windows)
    if (unsafe) return ask(`runs git, but ${unsafe}`)
  }
  for (const cwd of scope.cwds) scope.paths.add(cwd)
  return { decision: 'allow', reason: 'read-only', paths: [...scope.paths], programs: [...programs], cwds: [...scope.cwds] }
}
