/**
 * Blind waits: a command that only sleeps, standing on its own at the top of what the agent runs, holds the request
 * with nothing to show for as long as it sleeps (ADR 0125). A wait inside a loop that checks for something is not one.
 */
import { parseBash, parsePwsh, staticValue, type BashScript, type PwshWord } from '@encode/permissions'
import type { ShellDialect } from '../types'

/** A wait longer than this, on its own, is refused. */
export const BLIND_WAIT_SECONDS = 10

const SUFFIX: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }

/** `sleep 90`, `sleep 1m 30s`, `sleep infinity`: the seconds GNU sleep waits, or null when an argument is not a plain time. */
function sleepSeconds(args: readonly (string | null)[]): number | null {
  if (!args.length) return null
  let total = 0
  for (const arg of args) {
    if (arg === null) return null
    if (/^inf(inity)?$/i.test(arg)) return Number.POSITIVE_INFINITY
    const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(arg)
    if (!match) return null
    total += Number(match[1]) * SUFFIX[match[2]]
  }
  return total
}

function bashWaits(script: BashScript): number {
  let longest = 0
  for (const list of script.lists) {
    // `sleep 60 &` runs beside what follows: nothing waits for it.
    if (list.background) continue
    for (const pipeline of list.pipelines) {
      for (const command of pipeline.commands) {
        if (command.kind !== 'simple') {
          longest = Math.max(longest, bashWaits(command.body))
          continue
        }
        const [name, ...args] = command.words.map(staticValue)
        if (!name || name.replace(/^.*\//, '') !== 'sleep') continue
        longest = Math.max(longest, sleepSeconds(args) ?? 0)
      }
    }
  }
  return longest
}

/** A TimeSpan as Start-Sleep -Duration reads it: `00:01:50`, `1.02:00:00`. */
function timeSpanSeconds(text: string): number | null {
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(text)
  if (!match) return null
  return Number(match[1] ?? 0) * 86_400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)
}

const number = (text: string | undefined): number | null => (text !== undefined && /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null)

/** Start-Sleep (or sleep) with its seconds, milliseconds or duration, named by any prefix or given first. */
function startSleepSeconds(args: readonly PwshWord[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.quotedStart || !arg.value.startsWith('-')) return i === 0 ? number(arg.value) : null
    const [rawName, inline] = arg.value.slice(1).split(/:(.*)/s, 2)
    const name = rawName.toLowerCase()
    const value = inline ?? args[i + 1]?.value
    if (name && 'seconds'.startsWith(name)) return number(value)
    if (name === 'ms' || (name && 'milliseconds'.startsWith(name))) {
      const ms = number(value)
      return ms === null ? null : ms / 1000
    }
    if (name && 'duration'.startsWith(name)) return value === undefined ? null : timeSpanSeconds(value)
    return null
  }
  return null
}

/** `timeout /t 60` (Windows' timeout.exe): the seconds it waits; -1 waits for a key, which no command here can press. */
function timeoutSeconds(args: readonly PwshWord[]): number | null {
  const at = args.findIndex((arg) => /^[/-]t$/i.test(arg.value))
  if (at === -1) return null
  const value = args[at + 1]?.value
  if (value === '-1') return Number.POSITIVE_INFINITY
  return number(value)
}

/**
 * The statements at the top of a PowerShell line: split at `;` and line ends outside quotes, brackets and braces, so a
 * statement PowerShell reads as an expression ("done") leaves the others to be read. Null for what is not read safely.
 */
export function topStatements(line: string): string[] | null {
  const out: string[] = []
  let current = ''
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      current += char
      if (char === '`' && quote === '"') current += line[++i] ?? ''
      else if (char === quote) {
        if (line[i + 1] === quote) current += line[++i]
        else quote = null
      }
      continue
    }
    if (char === '`') {
      current += char + (line[++i] ?? '')
      continue
    }
    if (char === '@' && (line[i + 1] === '"' || line[i + 1] === "'")) return null
    if (char === '<' && line[i + 1] === '#') return null
    // A comment starts a word and runs to the end of the line.
    if (char === '#' && (i === 0 || /[\s;]/.test(line[i - 1]))) {
      const end = line.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (depth === 0 && (char === ';' || char === '\n')) {
      out.push(current)
      current = ''
      continue
    }
    current += char
    if (char === "'" || char === '"') quote = char
    else if (char === '(' || char === '{' || char === '[') depth++
    else if (char === ')' || char === '}' || char === ']') depth = Math.max(0, depth - 1)
  }
  if (quote || depth !== 0) return null
  out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

function pwshWaits(line: string): number {
  let longest = 0
  for (const statement of topStatements(line) ?? []) {
    const parsed = parsePwsh(statement)
    if (!parsed.ok) continue
    for (const chain of parsed.script.statements) {
      for (const pipeline of chain.pipelines) {
        for (const command of pipeline.commands) {
          const name = command.name.value.toLowerCase().replace(/\.exe$/, '')
          const seconds = name === 'start-sleep' || name === 'sleep' ? startSleepSeconds(command.args) : name === 'timeout' ? timeoutSeconds(command.args) : null
          longest = Math.max(longest, seconds ?? 0)
        }
      }
    }
  }
  return longest
}

/** The longest wait the command makes on its own, outside any loop or condition, in seconds; 0 when there is none. */
export function blindWait(command: string, dialect: ShellDialect): number {
  if (dialect === 'pwsh') return pwshWaits(command)
  const parsed = parseBash(command)
  return parsed.ok ? bashWaits(parsed.script) : 0
}

/**
 * What the model is told instead of the wait: a command it started waits in BashOutput, and anything else is looked for
 * itself, with a limit that keeps one call short (ADR 0153).
 */
export function blindWaitAdvice(seconds: number, dialect: ShellDialect): string {
  const howLong = Number.isFinite(seconds) ? `${Math.round(seconds)} s` : 'without end'
  const loop =
    dialect === 'pwsh'
      ? 'for ($i = 0; $i -lt 6; $i++) { if (<a check that passes once it is ready>) { break }; Start-Sleep -Seconds 5 }'
      : 'for i in $(seq 6); do <a check that passes once it is ready> && break; sleep 5; done'
  return [
    `Not run: this command waits ${howLong} doing nothing, which holds the request with nothing to show and is usually too long or too short.`,
    'To wait for a command, run it with run_in_background and read it with BashOutput: that waits up to 30 s for new output, and you are told when the command ends. Do not poll its output in a loop.',
    `To wait for something else, check for it every few seconds, for at most 30 s a call, for example\n${loop}`,
  ].join('\n\n')
}
