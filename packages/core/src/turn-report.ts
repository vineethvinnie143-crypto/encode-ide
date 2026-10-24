/**
 * A report of one request the agent got wrong, made by the person from the chat (ADR 0092): the request, every step
 * the main agent took (its text and its tool calls, as the model sent them), what the tools answered, and the project
 * files those calls named, as they were before the request. `node scripts/turn-report.mjs` replays it against eNCode
 * as it is now, and keeps it as a benchmark task, so that what went wrong stays fixed.
 *
 * Paths inside the project are written relative to it, so a report never names the folder it came from. Scrambled,
 * every word is replaced by another of the same shape, the same word by the same one everywhere, with keywords, file
 * extensions and program names kept: the calls still match the files, and the code itself is not in the report.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RuleJudge } from './approval'
import type { MessageRecord } from './session-records'
import type { ApprovalPolicy, TurnFileChange } from './ui'

export const TURN_REPORT_KIND = 'encode-turn-report'

export const TURN_REPORT_LIMITS = {
  steps: 200,
  calls: 20,
  files: 40,
  fileBytes: 512 * 1024,
  totalBytes: 4 * 1024 * 1024,
  /** Of each tool result: enough to see what went wrong, not the whole of a long read. */
  resultChars: 2_000,
  prompt: 20_000,
  description: 4_000,
  /** Of one call's input, as JSON: a Write of a large file is cut out of a replay, not the report. */
  inputChars: 600_000,
}

export interface TurnReportCall {
  name: string
  input: Record<string, unknown>
  /** The call came with arguments that were not JSON: exactly as sent, and why they could not be used. */
  invalid?: { raw: string; error: string }
}

export interface TurnReportStep {
  text?: string
  calls?: TurnReportCall[]
}

export interface TurnReportResult {
  tool: string
  ok: boolean
  /** The start of what the model was sent. */
  text: string
}

export interface TurnReportFile {
  /** Inside the project, with `/`. */
  path: string
  text: string
}

/** What the agent host makes of a request; the app adds the rest of `TurnReport` when it saves it. */
export interface TurnRecord {
  scrambled: boolean
  prompt: string
  policy: ApprovalPolicy
  /** `provider:model` of the replies. */
  models: string[]
  /** The main agent's calls to the model for the request. */
  usage: { requests: number; inputTokens: number; cachedTokens: number; outputTokens: number }
  steps: TurnReportStep[]
  results: TurnReportResult[]
  files: TurnReportFile[]
  /** Files the calls named that are not in the report, and why, one line each. */
  left: string[]
}

export interface TurnReport extends TurnRecord {
  kind: typeof TURN_REPORT_KIND
  version: 1
  createdAt: string
  /** eNCode's build and the system it ran on. */
  build: string
  system: string
  /** What went wrong, in the person's words. */
  description: string
}

export type TurnRecordOutcome = { ok: true; record: TurnRecord } | { ok: false; reason: string }

/** The tools whose `file_path` (or `notebook_path`) is a file the replay needs. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** A path a report may hold: inside the project, written with `/`, and nothing a shell or Windows reads otherwise. */
export function isReportPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 300) return false
  if (/[\\:*?"<>|\u0000-\u001f]/.test(value) || value.startsWith('/')) return false
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.endsWith(' ') && !part.endsWith('.'))
}

/** Every path into the project, in the forms it can be written in, longest first. */
function rootForms(root: string): string[] {
  const forms = new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length)
}

/** `text` with the project's folder taken out of the paths in it: `C:\work\shop\src\a.js` becomes `src/a.js`. */
export function relativeTo(root: string, text: string): string {
  // Windows paths are compared without case, as Windows compares them: c:\Work is C:\work.
  const flags = /^(?:[A-Za-z]:|\\\\)/.test(root) ? 'gi' : 'g'
  let out = text
  for (const form of rootForms(root)) {
    // A path under the folder loses the folder and its separator, and keeps `/` as Windows tools accept it.
    out = out.replace(new RegExp(`${escape(form)}[\\\\/]([^\\s'"\`]*)`, flags), (_match, rest: string) => rest.replace(/\\/g, '/'))
    // The folder itself, but not a longer name that starts like it (/work/shop2).
    out = out.replace(new RegExp(`${escape(form)}(?![\\w.-])`, flags), '.')
  }
  return out
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]))
  return value
}

/** The project files the main agent's file tools named in these records, inside the project, by absolute path. */
export function filesNamed(records: readonly MessageRecord[], root: string): string[] {
  const found = new Set<string>()
  for (const record of records) {
    if (record.agentId !== undefined && record.agentId !== 'main') continue
    if (record.message.role !== 'assistant') continue
    for (const block of record.message.content) {
      if (block.type !== 'tool-use' || !FILE_TOOLS.has(block.name)) continue
      const named = block.input.file_path ?? block.input.notebook_path
      if (typeof named !== 'string' || !named) continue
      const absolute = path.resolve(root, named)
      const inside = path.relative(root, absolute)
      if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) found.add(absolute)
    }
  }
  return [...found]
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** Bytes as text, when they are text: no NUL, valid UTF-8. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export interface GatherOptions {
  root: string
  rules?: RuleJudge
  /** What the record kept of the files the request changed. */
  changes: readonly TurnFileChange[]
}

/**
 * The files of the report: those the calls named, and those the request changed, as they were before it. A file the
 * request changed comes from the record; one it only read, from disk now. Nothing outside the project, nothing the
 * person's rules keep from reading, no link out of the folder.
 */
export async function gatherFiles(named: readonly string[], options: GatherOptions): Promise<{ files: TurnReportFile[]; left: string[] }> {
  const { root, rules } = options
  const realRoot = await fs.realpath(root).catch(() => root)
  const changed = new Map(options.changes.map((change) => [path.resolve(change.file), change]))
  const all = [...new Set([...named.map((file) => path.resolve(file)), ...changed.keys()])]
  const files: TurnReportFile[] = []
  const left: string[] = []
  let total = 0
  for (const file of all) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (!isReportPath(relative)) continue
    if (files.length >= TURN_REPORT_LIMITS.files) {
      left.push(`${relative}: the report holds ${TURN_REPORT_LIMITS.files} files at most`)
      continue
    }
    if (rules?.evaluate({ type: 'read', paths: [file] })?.decision === 'deny') {
      left.push(`${relative}: your permission rules keep it from being read`)
      continue
    }
    let bytes: Uint8Array | undefined
    const change = changed.get(file)
    if (change) {
      if (change.before.state === 'missing') continue
      if (change.before.state === 'unread') {
        left.push(`${relative}: the record did not keep it (${change.before.why})`)
        continue
      }
      bytes = change.before.bytes
    } else {
      try {
        const stat = await fs.lstat(file)
        if (!stat.isFile()) continue
        if (stat.size > TURN_REPORT_LIMITS.fileBytes) {
          left.push(`${relative}: larger than ${TURN_REPORT_LIMITS.fileBytes / 1024} KB`)
          continue
        }
        const real = await fs.realpath(file)
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) continue
        bytes = await fs.readFile(file)
      } catch {
        continue
      }
    }
    if (bytes.byteLength > TURN_REPORT_LIMITS.fileBytes) {
      left.push(`${relative}: larger than ${TURN_REPORT_LIMITS.fileBytes / 1024} KB`)
      continue
    }
    const text = textOf(bytes)
    if (text === undefined) {
      left.push(`${relative}: not text`)
      continue
    }
    if (total + bytes.byteLength > TURN_REPORT_LIMITS.totalBytes) {
      left.push(`${relative}: the report holds ${TURN_REPORT_LIMITS.totalBytes / 1024 / 1024} MB of files at most`)
      continue
    }
    total += bytes.byteLength
    files.push({ path: relative, text })
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), left }
}

export interface TurnRecordInput {
  root: string
  prompt: string
  policy: ApprovalPolicy
  /** The request's message records, in order. */
  records: readonly MessageRecord[]
  files: TurnReportFile[]
  left: string[]
}

/** The record of a request, paths made relative and, when asked, every word replaced. */
export function turnRecord(input: TurnRecordInput, options: { scramble: boolean }): TurnRecord {
  const relative = (text: string) => relativeTo(input.root, text)
  const names = new Map<string, string>()
  const steps: TurnReportStep[] = []
  const results: TurnReportResult[] = []
  const models = new Set<string>()
  const usage = { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
  for (const record of input.records) {
    if (record.agentId !== undefined && record.agentId !== 'main') continue
    const message = record.message
    if (message.role === 'assistant') {
      if (message.origin) models.add(`${message.origin.provider}:${message.origin.model}`)
      if (record.usage) {
        usage.requests++
        usage.inputTokens += record.usage.inputTokens
        usage.cachedTokens += record.usage.cacheReadTokens
        usage.outputTokens += record.usage.outputTokens
      }
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
      const calls: TurnReportCall[] = []
      for (const block of message.content) {
        if (block.type !== 'tool-use' || calls.length >= TURN_REPORT_LIMITS.calls) continue
        names.set(block.id, block.name)
        const input = mapStrings(block.input, relative) as Record<string, unknown>
        if (JSON.stringify(input).length > TURN_REPORT_LIMITS.inputChars) continue
        calls.push({ name: block.name, input, ...(block.invalid ? { invalid: { raw: relative(block.invalid.raw).slice(0, TURN_REPORT_LIMITS.inputChars), error: block.invalid.error } } : {}) })
      }
      if (steps.length < TURN_REPORT_LIMITS.steps) steps.push({ ...(text ? { text: relative(text) } : {}), ...(calls.length ? { calls } : {}) })
    } else {
      for (const block of message.content) {
        if (block.type !== 'tool-result' || results.length >= TURN_REPORT_LIMITS.steps * TURN_REPORT_LIMITS.calls) continue
        const text = block.content.map((part) => (part.type === 'text' || part.type === 'document' ? part.text : '[image]')).join('\n')
        results.push({ tool: names.get(block.toolUseId) ?? 'unknown', ok: block.isError !== true, text: relative(text).slice(0, TURN_REPORT_LIMITS.resultChars) })
      }
    }
  }
  const record: TurnRecord = {
    scrambled: false,
    prompt: relative(input.prompt).slice(0, TURN_REPORT_LIMITS.prompt),
    policy: input.policy,
    models: [...models].sort(),
    usage,
    steps,
    results,
    files: input.files,
    left: input.left,
  }
  return options.scramble ? scrambleRecord(record) : record
}

/**
 * Words kept as they are when the rest are replaced: keywords (what indentation and comments depend on, as the
 * editor's report keeps them), file extensions (what a language is told by) and programs (what a command runs).
 */
const KEPT = new Set(
  (
    'if else elif elseif end then do function return local for while repeat until def class const let var import export from ' +
    'true false nil null undefined None True False async await new this self try catch except finally switch case default ' +
    'break continue in of and or not is with as pass lambda yield interface type enum public private protected static void ' +
    'fn mut pub struct impl use mod match loop goto require module exports ' +
    'js mjs cjs jsx ts mts cts tsx json jsonc md txt py pyi lua rs go c h cc cpp hpp cs java kt kts rb php html htm css scss less ' +
    'svelte vue yml yaml toml ini cfg xml sql sh bash ps1 bat cmd lock env gitignore ' +
    'node npm npx pnpm yarn bun deno python python3 py pip pytest git cargo rustc gcc make cmake dotnet java javac lua luajit test run build'
  ).split(' '),
)

/** The record with every word but the kept ones replaced, consistently, by another of the same length and kinds. */
export function scrambleRecord(record: TurnRecord, seed = 1): TurnRecord {
  const map = new Map<string, string>()
  const used = new Set<string>()
  let state = seed >>> 0 || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const swap = (word: string): string => {
    if (KEPT.has(word) || /^_+$/.test(word)) return word
    const known = map.get(word)
    if (known !== undefined) return known
    let made = word
    for (let attempt = 0; attempt < 20; attempt++) {
      made = Array.from(word, (char) => {
        if (/\p{Lu}/u.test(char)) return String.fromCharCode(65 + Math.floor(next() * 26))
        if (/\p{L}/u.test(char)) return String.fromCharCode(97 + Math.floor(next() * 26))
        if (/\p{N}/u.test(char)) return String.fromCharCode(48 + Math.floor(next() * 10))
        return char
      }).join('')
      if (!used.has(made) && !KEPT.has(made)) break
    }
    map.set(word, made)
    used.add(made)
    return made
  }
  const scramble = (text: string) => text.replace(/[\p{L}\p{N}_]+/gu, swap)
  return {
    ...record,
    scrambled: true,
    prompt: scramble(record.prompt),
    steps: record.steps.map((step) => ({
      ...(step.text !== undefined ? { text: scramble(step.text) } : {}),
      ...(step.calls ? { calls: step.calls.map((call) => ({ name: call.name, input: mapStrings(call.input, scramble) as Record<string, unknown>, ...(call.invalid ? { invalid: { raw: scramble(call.invalid.raw), error: call.invalid.error } } : {}) })) } : {}),
    })),
    results: record.results.map((result) => ({ ...result, text: scramble(result.text) })),
    files: record.files.map((file) => ({ path: scramble(file.path), text: scramble(file.text) })),
    left: record.left.map(scramble),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const TOOL_NAME = /^[A-Za-z][\w-]{0,63}$/

/** A report read back, checked field by field: the report or why it is not one. */
export function readTurnReport(value: unknown): TurnReport | string {
  if (!isObject(value) || value.kind !== TURN_REPORT_KIND) return 'This is not a report of a request.'
  if (value.version !== 1) return `This report is version ${String(value.version)}; this eNCode reads version 1.`
  const { createdAt, build, system, description, scrambled, prompt, policy, models, usage, steps, results, files, left } = value
  if (!isText(createdAt, 40) || !isText(build, 200) || !isText(system, 200) || !isText(description, TURN_REPORT_LIMITS.description) || typeof scrambled !== 'boolean') return 'The report is missing what it is about.'
  if (!isText(prompt, TURN_REPORT_LIMITS.prompt) || !['read-only', 'workspace-write', 'full-access', 'auto-review'].includes(policy as string)) return 'The report has no request.'
  if (!Array.isArray(models) || models.length > 20 || !models.every((model) => isText(model, 200))) return 'The report lists its models wrongly.'
  if (!isObject(usage) || !['requests', 'inputTokens', 'cachedTokens', 'outputTokens'].every((key) => Number.isFinite(usage[key]))) return 'The report has no usage.'
  if (!Array.isArray(steps) || !steps.length || steps.length > TURN_REPORT_LIMITS.steps) return `The report must hold 1 to ${TURN_REPORT_LIMITS.steps} steps.`
  for (const [index, step] of steps.entries()) {
    if (!isObject(step) || (step.text !== undefined && typeof step.text !== 'string')) return `Step ${index + 1} is not a step.`
    if (step.calls === undefined) continue
    if (!Array.isArray(step.calls) || step.calls.length > TURN_REPORT_LIMITS.calls) return `Step ${index + 1} has too many calls.`
    for (const call of step.calls) {
      if (!isObject(call) || typeof call.name !== 'string' || !TOOL_NAME.test(call.name) || !isObject(call.input)) return `Step ${index + 1} has a call that is not one.`
      if (JSON.stringify(call.input).length > TURN_REPORT_LIMITS.inputChars) return `Step ${index + 1} has a call too large to replay.`
      if (call.invalid !== undefined && (!isObject(call.invalid) || !isText(call.invalid.raw, TURN_REPORT_LIMITS.inputChars) || !isText(call.invalid.error, 2_000))) return `Step ${index + 1} has a call that is not one.`
    }
  }
  if (!Array.isArray(results) || !results.every((result) => isObject(result) && isText(result.tool, 64) && typeof result.ok === 'boolean' && isText(result.text, TURN_REPORT_LIMITS.resultChars))) return 'The report lists what the tools answered wrongly.'
  if (!Array.isArray(files) || files.length > TURN_REPORT_LIMITS.files) return `The report holds more than ${TURN_REPORT_LIMITS.files} files.`
  const seen = new Set<string>()
  let total = 0
  for (const file of files) {
    if (!isObject(file) || !isReportPath(file.path) || typeof file.text !== 'string') return 'The report holds a file that is not inside its project.'
    if (seen.has(file.path.toLowerCase())) return `The report holds ${file.path} twice.`
    seen.add(file.path.toLowerCase())
    total += Buffer.byteLength(file.text)
    if (Buffer.byteLength(file.text) > TURN_REPORT_LIMITS.fileBytes || total > TURN_REPORT_LIMITS.totalBytes) return 'The report holds more of its files than a report may.'
  }
  if (!Array.isArray(left) || left.length > 200 || !left.every((line) => isText(line, 400))) return 'The report lists what it left out wrongly.'
  // Rebuilt from the fields read above, so nothing else in the file travels on.
  const counts = usage as Record<'requests' | 'inputTokens' | 'cachedTokens' | 'outputTokens', number>
  return {
    kind: TURN_REPORT_KIND,
    version: 1,
    createdAt,
    build,
    system,
    description,
    scrambled,
    prompt,
    policy: policy as ApprovalPolicy,
    models: [...(models as string[])],
    usage: { requests: counts.requests, inputTokens: counts.inputTokens, cachedTokens: counts.cachedTokens, outputTokens: counts.outputTokens },
    steps: (steps as Record<string, unknown>[]).map((step): TurnReportStep => ({
      ...(step.text !== undefined ? { text: step.text as string } : {}),
      ...(step.calls !== undefined
        ? {
            calls: (step.calls as Record<string, unknown>[]).map((call): TurnReportCall => {
              const invalid = call.invalid as { raw: string; error: string } | undefined
              return { name: call.name as string, input: call.input as Record<string, unknown>, ...(invalid ? { invalid: { raw: invalid.raw, error: invalid.error } } : {}) }
            }),
          }
        : {}),
    })),
    results: (results as Record<string, unknown>[]).map((result) => ({ tool: result.tool as string, ok: result.ok as boolean, text: result.text as string })),
    files: (files as Record<string, unknown>[]).map((file) => ({ path: file.path as string, text: file.text as string })),
    left: [...(left as string[])],
  }
}
