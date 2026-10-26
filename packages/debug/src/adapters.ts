/**
 * What eNCode knows of each language's own debugger (ADR 0144): the name it is told in `initialize`, how it reads a
 * hit count, which of its exception filters stand for "uncaught" and "every exception", and how it says why a program
 * stopped. Each is a separate program; eNCode carries none of them.
 */
import type { ExceptionFilters, PauseReason } from './types'

export type AdapterKind = 'debugpy' | 'delve' | 'lldb'

export interface AdapterProfile {
  kind: AdapterKind
  /** For people. */
  label: string
  /** The `adapterID` of `initialize`. */
  adapterId: string
  /** A hit count of eNCode's (`5`, `== 5`, `> 5`, `% 5`; `5` is from the fifth hit on), as this debugger writes it. */
  hitCondition(ours: string): { value: string } | { problem: string }
  /** The exception filters to turn on, of those the debugger offered. */
  exceptionFilters(ours: ExceptionFilters, offered: readonly string[]): string[]
  /** Functions to stop in for the exceptions asked for: every Go panic, a Rust program's panics. */
  exceptionFunctions(ours: ExceptionFilters, options: { rust: boolean }): string[]
  /** What a stop in one of those functions is, in words; null for a function that is not one of them. */
  exceptionStop(functionName: string): string | null
  /**
   * When it offers no filters, it stops for a crash whatever it was told (an older Delve, for a panic): when the person
   * asked for no exceptions, the run goes on, and the program ends as it would without a debugger.
   */
  alwaysStopsOnCrash: boolean
  /**
   * What the console's expressions are sent as. lldb-dap answers a `repl` one as its own command line does
   * (`(int) $0 = 4`); as `watch`, with the value alone.
   */
  replContext: 'repl' | 'watch'
  /** Lines the debugger prints to its console about itself, which are not the program's: left out. */
  chatter: readonly RegExp[]
}

const HIT = /^\s*(==|>=|<=|>|<|%)?\s*(\d{1,9})\s*$/

/** A hit count's operator and number; `>=` when it has none. */
export function readHitCondition(text: string): { op: '==' | '>=' | '<=' | '>' | '<' | '%'; count: number } | null {
  const match = HIT.exec(text)
  if (!match) return null
  return { op: (match[1] as '==' | '>=' | '<=' | '>' | '<' | '%' | undefined) ?? '>=', count: Number(match[2]) }
}

/** debugpy and Delve read the operator and the number; a bare number would mean "exactly the Nth" to debugpy. */
function withOperator(ours: string): { value: string } | { problem: string } {
  const hit = readHitCondition(ours)
  if (!hit) return { problem: 'A hit count is a number, with == > >= < <= or % before it if you like.' }
  return { value: `${hit.op} ${hit.count}` }
}

export const ADAPTERS: Readonly<Record<AdapterKind, AdapterProfile>> = {
  debugpy: {
    kind: 'debugpy',
    label: 'debugpy',
    adapterId: 'debugpy',
    hitCondition: withOperator,
    exceptionFilters: (ours, offered) => [...(ours.all ? ['raised'] : []), ...(ours.uncaught || ours.all ? ['uncaught'] : [])].filter((id) => offered.includes(id)),
    exceptionFunctions: () => [],
    exceptionStop: () => null,
    alwaysStopsOnCrash: false,
    replContext: 'repl',
    chatter: [],
  },
  delve: {
    kind: 'delve',
    label: 'Delve',
    adapterId: 'go',
    hitCondition: withOperator,
    // A panic nothing recovers, and a fatal error ("fatal error: all goroutines are asleep").
    exceptionFilters: (ours, offered) => (ours.uncaught || ours.all ? ['unrecovered-panic', 'runtime-fatal-throw'] : []).filter((id) => offered.includes(id)),
    // Every panic, recovered or not, starts in runtime.gopanic.
    exceptionFunctions: (ours) => (ours.all ? ['runtime.gopanic'] : []),
    exceptionStop: (name) => (name === 'runtime.gopanic' ? 'A panic, which may yet be recovered' : null),
    alwaysStopsOnCrash: true,
    replContext: 'repl',
    chatter: [/^Type 'dlv help' for list of commands\.$/, /^Detaching( and terminating target process)?$/, /^Process \d+ has exited with status -?\d+$/],
  },
  lldb: {
    kind: 'lldb',
    label: 'lldb-dap',
    adapterId: 'lldb-dap',
    // lldb counts hits one way: it lets the first N - 1 go by.
    hitCondition: (ours) => {
      const hit = readHitCondition(ours)
      if (!hit) return { problem: 'A hit count is a number, with == > >= < <= or % before it if you like.' }
      if (hit.op === '>=') return { value: String(Math.max(1, hit.count)) }
      if (hit.op === '>') return { value: String(hit.count + 1) }
      return { problem: `lldb counts hits only from a number on: write ${hit.count} (from hit ${hit.count} on) instead of ${ours.trim()}.` }
    },
    // C++: a throw stops, caught or not. One nothing catches ends in std::terminate, which lldb stops for anyway.
    exceptionFilters: (ours, offered) => (ours.all ? ['cpp_throw'] : []).filter((id) => offered.includes(id)),
    // Rust: every panic goes through rust_panic before it unwinds, caught (catch_unwind) or not.
    exceptionFunctions: (ours, options) => (options.rust && (ours.uncaught || ours.all) ? ['rust_panic'] : []),
    exceptionStop: (name) => (/(^|::)rust_panic$/.test(name) ? 'The program panicked: its message is in the output' : null),
    alwaysStopsOnCrash: false,
    replContext: 'watch',
    chatter: [/^Running (initCommands|preRunCommands|launchCommands|stopCommands|exitCommands|terminateCommands):$/, /^\(lldb\) /, /^Process \d+ (exited with status|launched:)/],
  },
}

/** Why a debugger says a program stopped, in eNCode's words. */
export function pauseReason(reason: unknown): PauseReason {
  switch (reason) {
    case 'breakpoint':
    case 'function breakpoint':
    case 'data breakpoint':
    case 'instruction breakpoint':
      return 'breakpoint'
    case 'step':
    case 'goto':
      return 'step'
    case 'exception':
    case 'panic':
    case 'fatal error':
    case 'signal':
      return 'exception'
    case 'pause':
      return 'pause'
    case 'entry':
      return 'entry'
    default:
      return 'other'
  }
}
