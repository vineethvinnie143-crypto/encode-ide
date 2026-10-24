/**
 * The file a report of a request is written as (ADR 0092). The agent host made the record with the folder taken out of
 * every path; here it is redacted like a log (the keys the settings hold, the home folder) and for anything shaped like
 * a credential, in every text it carries. A request that read a file holding secrets by its name goes only with its
 * words replaced: what the tools answered may hold that file's lines, which no pattern can tell from code.
 */
import { readTurnReport, TURN_REPORT_KIND, type TurnRecord, type TurnReport } from '@encode/core'
import type { AboutInfo } from '../../shared/types'
import { buildLine } from '../../shared/about'
import type { TurnReportDraft } from '../../shared/turn-report'
import { isSecretFile, redactForSuggestion, REDACTED } from '../secret-text'

export type TurnReportFile = { ok: true; text: string; redacted: number } | { ok: false; reason: string }

export interface TurnReportContext {
  about: AboutInfo
  now: number
  /** What the logs go through: keys the settings hold, the home folder, credential shapes. */
  redact: (text: string) => string
}

export const secretFileReason = (file: string): string =>
  `The agent read ${file}, which holds secrets by its name, so a report of this request carries its words replaced. Turn on "Replace the words" and save again.`

/** The paths a call names, where the tools take one. */
function pathsOf(input: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path', 'path'].map((key) => input[key]).filter((value): value is string => typeof value === 'string')
}

const count = (text: string, part: string): number => text.split(part).length - 1

/** Every string in a value, through `fn`; keys stay. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]))
  return value
}

export function turnReportFile(record: TurnRecord, draft: TurnReportDraft, context: TurnReportContext): TurnReportFile {
  if (!record.scrambled) {
    const named = [...record.files.map((file) => file.path), ...record.steps.flatMap((step) => (step.calls ?? []).flatMap((call) => pathsOf(call.input)))]
    const secret = named.find((file) => isSecretFile(file))
    if (secret) return { ok: false, reason: secretFileReason(secret) }
  }
  let redacted = 0
  // A file's own name decides which settings-file rules apply to it, in the file and in the calls that edit it.
  const clean = (text: string, relative = ''): string => {
    const out = redactForSuggestion(context.redact(text), relative)
    if (out !== text) redacted += Math.max(0, count(out, REDACTED) - count(text, REDACTED))
    return out
  }
  const report: TurnReport = {
    kind: TURN_REPORT_KIND,
    version: 1,
    createdAt: new Date(context.now).toISOString(),
    build: buildLine(context.about),
    system: `${context.about.os} ${context.about.arch}`,
    description: clean(draft.description.trim()),
    scrambled: record.scrambled,
    prompt: clean(record.prompt),
    policy: record.policy,
    models: record.models,
    usage: record.usage,
    steps: record.steps.map((step) => ({
      ...(step.text !== undefined ? { text: clean(step.text) } : {}),
      ...(step.calls
        ? {
            calls: step.calls.map((call) => {
              const relative = pathsOf(call.input)[0] ?? ''
              return {
                name: call.name,
                input: mapStrings(call.input, (text) => clean(text, relative)) as Record<string, unknown>,
                ...(call.invalid ? { invalid: { raw: clean(call.invalid.raw, relative), error: call.invalid.error } } : {}),
              }
            }),
          }
        : {}),
    })),
    results: record.results.map((result) => ({ ...result, text: clean(result.text) })),
    files: record.files.map((file) => ({ path: file.path, text: clean(file.text, file.path) })),
    left: record.left.map((line) => clean(line)),
  }
  // What the replay reads is what is written: a report this check refuses would be refused there too.
  const checked = readTurnReport(report)
  if (typeof checked === 'string') return { ok: false, reason: `The report could not be made: ${checked}` }
  // The facts first, easy to read; then one line for each step, answer and file, as they can be long.
  const { steps, results, files, ...facts } = checked
  const list = (items: readonly unknown[]) => (items.length ? `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]` : '[]')
  const head = JSON.stringify(facts, null, 2)
  return { ok: true, redacted, text: `${head.slice(0, -2)},\n  "steps": ${list(steps)},\n  "results": ${list(results)},\n  "files": ${list(files)}\n}\n` }
}
