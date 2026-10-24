/**
 * A shell line read as the commands it runs: each program as written, its file name, its words and its
 * redirections. Shared by the floor under Auto review and the reading of hard-to-undo commands, so both see a
 * command the same way.
 */
import type { BashRedirect, BashSimpleCommand, BashWord } from './bash-grammar'
import type { PwshCommand } from './pwsh-grammar'

/** A word of a command: its text, or null when it is only known when the line runs. */
export interface Arg {
  value: string | null
  glob: boolean
  /** The word as written, with its quotes and expansions. */
  text: string
}

export interface Call {
  /** The program as typed; '' for a line that only sets variables; null when only known at run time. */
  written: string | null
  /** Its file name without directory or extension, in lower case. */
  name: string | null
  args: Arg[]
  /** Variables set for this command only. */
  assigns: string[]
  redirects: Array<{ write: boolean; target: Arg }>
}

/** PowerShell's short names for the cmdlets that matter here. */
export const PWSH_ALIASES = new Map<string, string>([
  ['rm', 'remove-item'], ['del', 'remove-item'], ['erase', 'remove-item'], ['rd', 'remove-item'], ['rmdir', 'remove-item'],
  ['ri', 'remove-item'], ['cp', 'copy-item'], ['copy', 'copy-item'], ['cpi', 'copy-item'], ['mv', 'move-item'],
  ['move', 'move-item'], ['mi', 'move-item'], ['ni', 'new-item'], ['sc', 'set-content'], ['ac', 'add-content'],
  ['gc', 'get-content'], ['cat', 'get-content'], ['type', 'get-content'], ['ls', 'get-childitem'], ['dir', 'get-childitem'],
  ['gci', 'get-childitem'], ['gi', 'get-item'], ['wget', 'invoke-webrequest'], ['curl', 'invoke-webrequest'],
  ['iwr', 'invoke-webrequest'], ['kill', 'stop-process'], ['sl', 'set-location'], ['cd', 'set-location'],
  ['chdir', 'set-location'], ['pushd', 'push-location'], ['rni', 'rename-item'], ['ren', 'rename-item'],
])

export function nameOf(written: string): string {
  const base = written.split(/[\\/]/).pop() ?? written
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')
}

export function bashArg(word: BashWord, home: string): Arg {
  let value = ''
  let glob = false
  for (const part of word.parts) {
    if (part.kind === 'literal') value += part.value
    else if (part.kind === 'glob') {
      value += part.value
      glob = true
    } else if (part.kind === 'tilde') value += home
    else return { value: null, glob, text: word.text }
  }
  return { value, glob, text: word.text }
}

const WRITING_REDIRECTS = new Set<string>(['>', '>>', '>|', '<>', '&>', '&>>', '>&'])

export function bashCall(command: BashSimpleCommand, home: string): Call {
  const [head, ...rest] = command.words
  const redirects = command.redirects.flatMap((redirect: BashRedirect) => {
    const target = bashArg(redirect.target, home)
    // `>&2` duplicates a descriptor and `<<` reads a here-document: neither names a file.
    const duplicates = (redirect.operator === '>&' || redirect.operator === '<&') && target.value !== null && /^(?:\d+|-)$/.test(target.value)
    if (redirect.operator === '<<' || redirect.operator === '<<-' || redirect.operator === '<<<' || duplicates) return []
    return [{ write: WRITING_REDIRECTS.has(redirect.operator), target }]
  })
  const program = head ? bashArg(head, home) : undefined
  return {
    written: program ? program.value : '',
    name: program ? (program.value === null ? null : nameOf(program.value)) : '',
    args: rest.map((word) => bashArg(word, home)),
    assigns: command.assignments.map((assignment) => assignment.name),
    redirects,
  }
}

export function pwshCall(command: PwshCommand): Call {
  const written = command.name.value
  const name = nameOf(written)
  return {
    written,
    // `sc.exe` is the service controller; only the bare `sc` is Set-Content.
    name: /\.exe$/i.test(written) ? name : (PWSH_ALIASES.get(name) ?? name),
    args: command.args.map((word) => ({ value: word.value, glob: word.unquotedWildcard, text: word.text })),
    assigns: [],
    redirects: command.redirects.flatMap((redirect) =>
      redirect.target ? [{ write: true, target: { value: redirect.target.value, glob: redirect.target.unquotedWildcard, text: redirect.target.text } }] : [],
    ),
  }
}

export interface Split {
  /** Letters of single-dash options: r and f of `-rf`. */
  short: Set<string>
  /** Double-dash options without their values, in lower case (PowerShell's `-Recurse` is kept as `--recurse`). */
  long: Set<string>
  /** Everything else: operands, and every word after `--`. */
  operands: Arg[]
}

export function split(args: readonly Arg[], pwsh: boolean): Split {
  const short = new Set<string>()
  const long = new Set<string>()
  const operands: Arg[] = []
  let ended = false
  for (const arg of args) {
    const value = arg.value
    if (ended || value === null || !value.startsWith('-') || value === '-') {
      operands.push(arg)
      continue
    }
    if (value === '--') {
      ended = true
      continue
    }
    if (pwsh) long.add(`--${value.slice(1).split(/[:=]/, 1)[0].toLowerCase()}`)
    else if (value.startsWith('--')) long.add(value.split('=', 1)[0].toLowerCase())
    else for (const letter of value.slice(1)) short.add(letter)
  }
  return { short, long, operands }
}

/** Whether a PowerShell parameter written as `-Rec` (any start of the name) means `-Recurse`. */
export function pwshHas(options: Split, full: string): boolean {
  for (const option of options.long) {
    const given = option.slice(2)
    if (given.length >= 1 && full.startsWith(given)) return true
  }
  return false
}
