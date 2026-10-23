/**
 * A report of something the editor did wrong (ADR 0088): what the person says, how the editor was set up, and a trace
 * of what happened in the file, replayable step by step (packages/editor/src/trace.ts). The page makes the draft; the
 * main process checks it here, adds the build, and writes the file where the person says. Nothing is sent anywhere.
 */
import type { EditorTrace } from '@encode/editor'

export const EDITOR_ISSUE_KIND = 'encode-editor-issue'

/** The most a report holds. A trace is kept within these by the recorder (EDIT_RECORD_LIMITS) already. */
export const ISSUE_LIMITS = {
  description: 4_000,
  doc: 2_000_000,
  steps: 20_100,
  /** Characters across every text a trace's steps carry. */
  stepChars: 4_500_000,
  ranges: 10_000,
  problems: 20,
  options: 40,
} as const

/** What the page sends. */
export interface EditorIssueDraft {
  description: string
  /** The file's path in the folder: checked for a secret file, then left out of the report. */
  path: string
  language: string
  /** Whether the words of the file were replaced (scrambleTrace). */
  scrambled: boolean
  /** The editor's options as they were: names to plain values. */
  editor: Record<string, string | number | boolean>
  recorded: { steps: number; minutes: number; trimmed: boolean }
  /** What replaying the trace on the person's computer found. */
  problems: { step: number; problem: string }[]
  trace: EditorTrace
}

/** The file written. */
export interface EditorIssue extends Omit<EditorIssueDraft, 'path'> {
  kind: typeof EDITOR_ISSUE_KIND
  version: 1
  createdAt: string
  build: string
  system: string
  /** The file's extension, the one part of its path that is kept. */
  extension: string
  lines: number
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

function readRanges(value: unknown): [number, number][] | null {
  if (!Array.isArray(value) || value.length > ISSUE_LIMITS.ranges) return null
  const out: [number, number][] = []
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2 || !isCount(range[0]) || !isCount(range[1])) return null
    out.push([range[0], range[1]])
  }
  return out
}

/**
 * A trace as a report may carry it, rebuilt from known fields only; null when anything is not what a trace holds.
 * Its texts are counted against `stepChars`, so a report cannot grow past what the recorder keeps.
 */
export function readTrace(value: unknown): EditorTrace | null {
  if (!isObject(value) || value.version !== 1 || !isText(value.doc, ISSUE_LIMITS.doc) || !Array.isArray(value.steps) || value.steps.length > ISSUE_LIMITS.steps) return null
  const trace: { -readonly [K in keyof EditorTrace]: EditorTrace[K] } = { version: 1, doc: value.doc, steps: [] }
  if (value.name !== undefined) {
    if (!isText(value.name, 200)) return null
    trace.name = value.name
  }
  if (value.language !== undefined) {
    if (!isText(value.language, 64)) return null
    trace.language = value.language
  }
  if (value.tabSize !== undefined) {
    if (!isCount(value.tabSize, 32)) return null
    trace.tabSize = value.tabSize
  }
  if (value.indentUnit !== undefined) {
    if (!isText(value.indentUnit, 32) || !/^(?:\t| *)$/.test(value.indentUnit)) return null
    trace.indentUnit = value.indentUnit
  }
  if (value.lineSeparator !== undefined) {
    if (value.lineSeparator !== '\n' && value.lineSeparator !== '\r\n') return null
    trace.lineSeparator = value.lineSeparator
  }
  if (value.readOnly !== undefined) {
    if (typeof value.readOnly !== 'boolean') return null
    trace.readOnly = value.readOnly
  }
  if (value.selection !== undefined) {
    const ranges = readRanges(value.selection)
    if (!ranges) return null
    trace.selection = ranges
  }
  let chars = 0
  const steps: EditorTrace['steps'][number][] = []
  for (const raw of value.steps) {
    if (!isObject(raw)) return null
    const t = raw.t
    if (t !== undefined && !isCount(t)) return null
    const time = t === undefined ? {} : { t: t as number }
    if ('changes' in raw) {
      if (!Array.isArray(raw.changes) || raw.changes.length > ISSUE_LIMITS.ranges) return null
      const changes: [number, number, string][] = []
      for (const change of raw.changes) {
        if (!Array.isArray(change) || change.length !== 3 || !isCount(change[0]) || !isCount(change[1]) || change[0] > change[1] || typeof change[2] !== 'string') return null
        chars += change[2].length
        changes.push([change[0], change[1], change[2]])
      }
      if (raw.origin !== undefined && !isText(raw.origin, 64)) return null
      steps.push({ changes, ...(raw.origin !== undefined ? { origin: raw.origin as string } : {}), ...time })
    } else if ('select' in raw) {
      const ranges = readRanges(raw.select)
      if (!ranges || !ranges.length) return null
      if (raw.main !== undefined && !isCount(raw.main, ranges.length - 1)) return null
      steps.push({ select: ranges, ...(raw.main !== undefined ? { main: raw.main as number } : {}), ...time })
    } else if ('reload' in raw) {
      if (typeof raw.reload !== 'string') return null
      chars += raw.reload.length
      steps.push({ reload: raw.reload, ...time })
    } else if ('expect' in raw) {
      const expect = raw.expect
      if (!isObject(expect) || !isCount(expect.length) || !isCount(expect.lines) || !isText(expect.hash, 16) || !/^[0-9a-f]+$/.test(expect.hash)) return null
      steps.push({ expect: { length: expect.length, lines: expect.lines, hash: expect.hash }, ...time })
    } else return null
    if (chars > ISSUE_LIMITS.stepChars) return null
  }
  trace.steps = steps
  return trace
}

/** The page's draft, rebuilt from known fields; null when it is not one. */
export function readEditorIssueDraft(value: unknown): EditorIssueDraft | null {
  if (!isObject(value)) return null
  const { description, path, language, scrambled, editor, recorded, problems } = value
  if (!isText(description, ISSUE_LIMITS.description) || !isText(path, 4_096) || !path || !isText(language, 64) || typeof scrambled !== 'boolean') return null
  if (!isObject(editor) || Object.keys(editor).length > ISSUE_LIMITS.options) return null
  const options: Record<string, string | number | boolean> = {}
  for (const [name, option] of Object.entries(editor)) {
    if (!/^[A-Za-z][\w.]{0,40}$/.test(name)) return null
    if (typeof option === 'boolean' || (typeof option === 'number' && Number.isFinite(option)) || isText(option, 64)) options[name] = option as string | number | boolean
    else return null
  }
  if (!isObject(recorded) || !isCount(recorded.steps) || typeof recorded.minutes !== 'number' || !Number.isFinite(recorded.minutes) || recorded.minutes < 0 || typeof recorded.trimmed !== 'boolean') return null
  if (!Array.isArray(problems) || problems.length > ISSUE_LIMITS.problems) return null
  const found: { step: number; problem: string }[] = []
  for (const problem of problems) {
    if (!isObject(problem) || !isCount(problem.step) || !isText(problem.problem, 500)) return null
    found.push({ step: problem.step, problem: problem.problem })
  }
  const trace = readTrace(value.trace)
  if (!trace) return null
  return {
    description,
    path,
    language,
    scrambled,
    editor: options,
    recorded: { steps: recorded.steps, minutes: Math.round(recorded.minutes * 10) / 10, trimmed: recorded.trimmed },
    problems: found,
    trace,
  }
}

/** Every text a trace carries: its start, what its steps put in, and its name. */
export function traceTexts(trace: EditorTrace): string[] {
  const texts = [trace.doc]
  if (trace.name) texts.push(trace.name)
  for (const step of trace.steps) {
    if ('changes' in step) for (const [, , insert] of step.changes) texts.push(insert)
    else if ('reload' in step) texts.push(step.reload)
    else if ('type' in step) texts.push(step.type)
    else if ('insert' in step) texts.push(step.insert)
    else if ('paste' in step && typeof step.paste === 'string') texts.push(step.paste)
  }
  return texts
}

/** The name a report is saved under: encode-editor-issue-2026-10-23-1405.json. */
export function editorIssueFileName(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${EDITOR_ISSUE_KIND}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}
