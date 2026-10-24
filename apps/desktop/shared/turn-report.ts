/**
 * A report of a request that went wrong (ADR 0092): the page names the request and says what went wrong; the agent
 * host makes the record of it (packages/core/src/turn-report.ts), and the main process redacts it and writes the file
 * where the person says. Nothing is sent anywhere. `pnpm turn-report` replays the file and keeps it as a benchmark task.
 */

export const TURN_REPORT_FILE_KIND = 'encode-turn-report'

/** What the page sends. */
export interface TurnReportDraft {
  sessionId: string
  /** The request: the id of the message that started it. */
  turn: string
  description: string
  /** Whether every word but keywords and file extensions is replaced, the same way everywhere. */
  scramble: boolean
}

/** How saving a report of a request ended; `redacted` counts what looked like a key and was taken out. */
export type TurnReportSaved = { saved: string; redacted: number } | { canceled: true } | { refused: string }

export const TURN_REPORT_DESCRIPTION_CHARS = 4_000

const isId = (value: unknown): value is string => typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)

/** The page's draft, rebuilt from known fields; null when it is not one. */
export function readTurnReportDraft(value: unknown): TurnReportDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { sessionId, turn, description, scramble } = value as Record<string, unknown>
  if (!isId(sessionId) || !isId(turn) || typeof scramble !== 'boolean') return null
  if (typeof description !== 'string' || description.length > TURN_REPORT_DESCRIPTION_CHARS) return null
  return { sessionId, turn, description, scramble }
}

/** The name a report is saved under: encode-turn-report-2026-10-24-0230.json. */
export function turnReportFileName(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${TURN_REPORT_FILE_KIND}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}
