/**
 * Errors after every edit, as Claude Code reports them: once a call changed files a language server covers, the
 * problems it introduced reach the model with the step's results (or with the next step's, when the server was still
 * checking). Only errors, only new ones: a file's problems before the turn's first change to it are its baseline, and
 * what is still there is not told again. A file the agent read was opened in its server then, so the baseline is
 * usually known; when it is not, the errors are told with a note that some may be older.
 *
 * The gate: when the agent ends its turn while errors it introduced are still there, it is told once (or up to three
 * times with the gate on) and goes on, to fix them or to say why they are fine.
 */
import fs from 'node:fs/promises'
import { plural, realPathOf, type CodeDiagnostic, type CodeIntelligence } from '@encode/tools'

export type ErrorGate = 'auto' | 'on' | 'off'

/** Rounds the gate may send the agent back for, in one turn. */
export const GATE_ROUNDS: Record<ErrorGate, number> = { auto: 1, on: 3, off: 0 }

/** How long a step waits for the servers after an edit; a slower answer comes with the next step. */
export const STEP_WAIT_MS = 3_000
/** How long the gate waits for what is still being checked when the agent wants to finish. */
export const GATE_WAIT_MS = 8_000

const SHOWN_PER_FILE = 10
const SHOWN_FILES = 8
/** A file the server is still checking is asked again at the next steps, this many times in all. */
const TRIES = 3

const identity = (item: CodeDiagnostic) => `${item.source ?? ''}\0${item.code ?? ''}\0${item.message}`

/** The errors of `after` that `before` did not have, counted by message, source and code: lines move with edits. */
export function introduced(after: readonly CodeDiagnostic[], before: readonly CodeDiagnostic[]): CodeDiagnostic[] {
  const left = new Map<string, number>()
  for (const item of before) left.set(identity(item), (left.get(identity(item)) ?? 0) + 1)
  const out: CodeDiagnostic[] = []
  for (const item of after) {
    const key = identity(item)
    const count = left.get(key) ?? 0
    if (count > 0) left.set(key, count - 1)
    else out.push(item)
  }
  return out
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

interface FileState {
  /** The errors before the turn changed the file; null when the server had not said. */
  baseline: CodeDiagnostic[] | null
  /** The errors the turn introduced, as last checked. */
  introduced: CodeDiagnostic[]
  /** What the model was last told of the file, to tell only what changed. */
  told: string
}

export class EditDiagnostics {
  private readonly files = new Map<string, FileState>()
  /** Files changed and not yet checked, with the times they were asked. */
  private readonly pending = new Map<string, number>()
  private gateRounds = 0

  constructor(
    private readonly code: CodeIntelligence,
    private readonly shown: (file: string) => string,
  ) {}

  /** A new turn: what the agent introduces is counted from here. */
  startTurn(): void {
    this.files.clear()
    this.pending.clear()
    this.gateRounds = 0
  }

  /** Read opens the files in their servers, so their problems are known before they are edited. */
  read(paths: readonly string[]): void {
    const covered = paths.filter((file) => this.code.covers(file).ok)
    if (covered.length) this.code.prefetch(covered)
  }

  /** Before a call writes these files (real paths): their problems now are the baseline. Returns those that exist. */
  async before(paths: readonly string[]): Promise<Set<string>> {
    const existed = new Set<string>()
    for (const file of paths) {
      const there = await exists(file)
      if (there) existed.add(file)
      if (this.files.has(file) || !this.code.covers(file).ok) continue
      // A file that did not exist had no problems.
      this.files.set(file, { baseline: there ? (this.code.known([file]).get(file) ?? null) : [], introduced: [], told: '' })
    }
    return existed
  }

  /** After a call changed files: the servers are told, and the files are checked at the end of the step. */
  async after(changed: readonly string[], existed: ReadonlySet<string>): Promise<void> {
    const changes = await Promise.all(
      changed.map(async (given) => {
        const file = await realPathOf(given).catch(() => given)
        const kind: 'created' | 'changed' | 'deleted' = !(await exists(file)) ? 'deleted' : existed.has(file) ? 'changed' : 'created'
        return { file, kind }
      }),
    )
    await this.code.changed(changes).catch(() => undefined)
    for (const { file, kind } of changes) {
      if (kind === 'deleted') {
        this.pending.delete(file)
        this.files.delete(file)
        continue
      }
      if (!this.code.covers(file).ok) continue
      if (!this.files.has(file)) this.files.set(file, { baseline: kind === 'created' ? [] : null, introduced: [], told: '' })
      this.pending.set(file, 0)
    }
  }

  /** What the step's changes introduced, as a reminder for the model, or null. Waits at most `waitMs`. */
  async collect(waitMs: number, signal: AbortSignal): Promise<string | null> {
    if (!this.pending.size) return null
    const results = await this.code.diagnostics([...this.pending.keys()], { waitMs, signal }).catch(() => [])
    const parts: string[] = []
    let shownFiles = 0
    for (const result of results) {
      if (!result.ok) {
        this.pending.delete(result.file)
        continue
      }
      if (result.stale) {
        const tries = (this.pending.get(result.file) ?? 0) + 1
        if (tries < TRIES) {
          this.pending.set(result.file, tries)
          continue
        }
      }
      this.pending.delete(result.file)
      const state = this.files.get(result.file) ?? { baseline: null, introduced: [], told: '' }
      this.files.set(result.file, state)
      const errors = result.diagnostics.filter((item) => item.severity === 'error')
      state.introduced = state.baseline ? introduced(errors, state.baseline) : errors
      const told = state.introduced.map(identity).sort().join('\n')
      if (told === state.told) continue
      const before = state.told
      state.told = told
      if (!state.introduced.length) {
        if (before) parts.push(`${this.shown(result.file)}: the errors reported before are fixed.`)
        continue
      }
      if (shownFiles++ < SHOWN_FILES) parts.push(this.describe(result.file, state, result.unsaved === true))
    }
    if (!parts.length) return null
    return `The language servers found errors after your changes:\n${parts.join('\n')}`
  }

  private describe(file: string, state: FileState, unsaved: boolean): string {
    const items = [...state.introduced].sort((a, b) => a.line - b.line || a.character - b.character)
    const notes = [state.baseline === null ? 'some may be older than your change' : '', unsaved ? "for the editor's unsaved text" : ''].filter(Boolean)
    const head = `${this.shown(file)}: ${plural(items.length, 'error')}${notes.length ? ` (${notes.join('; ')})` : ''}`
    const lines = items.slice(0, SHOWN_PER_FILE).map((item) => `  ${item.line + 1}:${item.character + 1} ${item.message.replace(/\s*\n\s*/g, ' ').slice(0, 400)}${item.source || item.code ? ` [${[item.source, item.code].filter(Boolean).join(' ')}]` : ''}`)
    if (items.length > SHOWN_PER_FILE) lines.push(`  ... and ${items.length - SHOWN_PER_FILE} more.`)
    return [head, ...lines].join('\n')
  }

  /**
   * The gate, when the agent wants to end its turn: what it introduced and left, as a reminder that sends it back, or
   * null to let it finish. Each turn sends it back at most `GATE_ROUNDS[gate]` times.
   */
  async gate(gate: ErrorGate, signal: AbortSignal): Promise<string | null> {
    if (this.gateRounds >= GATE_ROUNDS[gate]) return null
    if (this.pending.size) await this.collect(GATE_WAIT_MS, signal)
    const left = [...this.files].filter(([, state]) => state.introduced.length)
    if (!left.length) return null
    this.gateRounds++
    const parts = left.slice(0, SHOWN_FILES).map(([file, state]) => this.describe(file, state, false))
    if (left.length > SHOWN_FILES) parts.push(`... and ${left.length - SHOWN_FILES} more files.`)
    return `Before you finish: your changes this turn left errors the language servers report:\n${parts.join('\n')}\nFix them. If they are expected (work in progress, a file you will change next), say so in your reply instead.`
  }
}
