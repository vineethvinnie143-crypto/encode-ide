/**
 * LSP and LSPEdit: what the project's language servers know, for the agent. LSP looks things up as Claude Code's LSP
 * tool does (definitions, references, hovers, outlines, symbols, calls) and adds what eNCode's servers report
 * (diagnostics, code actions). LSPEdit renames a symbol and applies a code action. Positions are 1-based, as Read
 * numbers lines; a `symbol` name finds the column, since a model counts columns badly.
 *
 * LSPEdit's change is planned before it is approved (`access`, `describe`) and the same plan is applied, so the person
 * approves exactly what is written. A plan carries each file's text as the server saw it: a file that reads otherwise
 * now (changed since, or with edits the editor has not saved) refuses the whole plan, and nothing is written outside
 * the project. Every write goes through the checkpoint seam, so Rewind takes a rename back like any edit.
 */
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CodeLocation, CodeSymbol, EditPlan, FileDiagnostics } from '@encode/lsp'
import { buildDiff } from './diff'
import { stateOf } from './file-state'
import { fail } from './files'
import { displayPath, isInsideReal, realPathOf, resolveInputPath } from './paths'
import { decodeText, encodeText, MAX_TEXT_FILE_BYTES, plural, UnencodableTextError, type TextEncodingName } from './text'
import type { CodeIntelligence, Tool, ToolContext, ToolOutcome } from './types'

const SHOWN_LOCATIONS = 60
const SHOWN_SYMBOLS = 400
const SHOWN_DIAGNOSTICS = 100
const SNIPPET_CHARS = 160
/** How long an explicit diagnostics request waits: a server may have to start and read the project first. */
const DIAGNOSTICS_WAIT_MS = 20_000

const LOOKUPS = ['goToDefinition', 'goToTypeDefinition', 'goToImplementation', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls', 'diagnostics', 'codeActions'] as const
type Lookup = (typeof LOOKUPS)[number]
const AT_POSITION = new Set<string>(['goToDefinition', 'goToTypeDefinition', 'goToImplementation', 'findReferences', 'hover', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls'])

function fileOf(input: { filePath?: unknown }, ctx: ToolContext): string {
  return resolveInputPath(typeof input.filePath === 'string' ? input.filePath : '', { root: ctx.cwd ?? ctx.root, home: ctx.home, platform: ctx.platform })
}

const shown = (file: string, ctx: ToolContext) => displayPath(file, ctx)


/** The lines of a file as text, read once per call. */
class Lines {
  private readonly cache = new Map<string, string[] | null>()

  async of(file: string): Promise<string[] | null> {
    if (this.cache.has(file)) return this.cache.get(file)!
    let lines: string[] | null = null
    try {
      const stats = await fs.stat(file)
      if (stats.isFile() && stats.size <= MAX_TEXT_FILE_BYTES) {
        const decoded = decodeText(await fs.readFile(file))
        if (decoded) lines = decoded.text.split(/\r\n|\r|\n/)
      }
    } catch {
      lines = null
    }
    // Snippets for a long list come from a bounded number of files.
    if (this.cache.size < 40) this.cache.set(file, lines)
    return lines
  }

  async snippet(file: string, line: number): Promise<string> {
    const text = (await this.of(file))?.[line]?.trim() ?? ''
    return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 3)}...` : text
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The zero-based position the input names. With a symbol, its column on the line (the occurrence nearest `character`
 * when there are several), or on a line near it when the model was a line or two off.
 */
async function positionOf(input: PositionInput, file: string, lines: Lines, ctx: ToolContext): Promise<{ line: number; character: number; note?: string } | string> {
  const line = (input.line ?? 1) - 1
  const symbol = input.symbol?.trim()
  if (!symbol) return { line, character: Math.max(0, (input.character ?? 1) - 1) }
  const text = await lines.of(file)
  if (!text) return `${shown(file, ctx)} could not be read as text.`
  const pattern = new RegExp(`(?<![\\w$])${escapeRegex(symbol)}(?![\\w$])`, 'g')
  const near = input.character ? input.character - 1 : 0
  const columns = (index: number) => [...(text[index] ?? '').matchAll(pattern)].map((match) => match.index ?? 0)
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    const index = line + offset
    const found = columns(index)
    if (!found.length) continue
    const character = found.reduce((best, column) => (Math.abs(column - near) < Math.abs(best - near) ? column : best), found[0])
    return { line: index, character, ...(offset ? { note: `${symbol} is on line ${index + 1}, not ${line + 1}; used line ${index + 1}.` } : {}) }
  }
  const said = (text[line] ?? '').trim()
  return `${symbol} is not on line ${line + 1} of ${shown(file, ctx)}${said ? ` (it reads: ${said.slice(0, SNIPPET_CHARS)})` : line >= text.length ? ` (the file has ${text.length} lines)` : ''}. Give the line where it appears.`
}

interface PositionInput {
  line?: number
  character?: number
  symbol?: string
}

function needsPosition(input: PositionInput): string | undefined {
  if (!input.line) return 'line is needed: the 1-based line of the symbol.'
  if (!input.character && !input.symbol?.trim()) return 'Give symbol (the name on that line) or character (its 1-based column).'
  return undefined
}

const where = (item: { file: string; line: number; character: number }, ctx: ToolContext) => `${shown(item.file, ctx)}:${item.line + 1}:${item.character + 1}`

/** Files in a stable order for the model: the one asked about first, then by path. */
function byHome<T>(entries: [string, T][], home: string): [string, T][] {
  return entries.sort(([a], [b]) => (a === home ? -1 : b === home ? 1 : a < b ? -1 : a > b ? 1 : 0))
}

async function listLocations(items: CodeLocation[], lines: Lines, ctx: ToolContext, home: string): Promise<string> {
  const grouped = new Map<string, CodeLocation[]>()
  for (const item of items) grouped.set(item.file, [...(grouped.get(item.file) ?? []), item])
  const byFile = byHome([...grouped], home)
  const out: string[] = []
  let count = 0
  for (const [file, list] of byFile) {
    if (count >= SHOWN_LOCATIONS) break
    out.push(byFile.length > 1 || items.length > 3 ? `${shown(file, ctx)} (${list.length})` : shown(file, ctx))
    for (const item of list.sort((a, b) => a.line - b.line || a.character - b.character)) {
      if (count++ >= SHOWN_LOCATIONS) break
      out.push(`  ${item.line + 1}:${item.character + 1}  ${await lines.snippet(file, item.line)}`)
    }
  }
  if (items.length > count) out.push(`... and ${items.length - count} more.`)
  return out.join('\n')
}

function listSymbols(items: CodeSymbol[], ctx: ToolContext, outline: boolean): string {
  const out = items.slice(0, SHOWN_SYMBOLS).map((item) => {
    if (outline) return `${'  '.repeat(item.depth ?? 0)}${item.kind} ${item.name}${item.detail ? ` ${item.detail}` : ''} (line ${item.line + 1}${item.endLine > item.line ? `-${item.endLine + 1}` : ''})`
    return `${item.kind} ${item.name}${item.container ? ` in ${item.container}` : ''}  ${where(item, ctx)}`
  })
  if (items.length > SHOWN_SYMBOLS) out.push(`... and ${items.length - SHOWN_SYMBOLS} more.`)
  return out.join('\n')
}

export function formatDiagnostics(result: FileDiagnostics, ctx: ToolContext, limit = SHOWN_DIAGNOSTICS): string {
  if (!result.ok) return `${shown(result.file, ctx)}: ${result.reason}`
  const notes = [result.unsaved ? 'for the editor\'s unsaved text' : '', result.stale ? `${result.server}'s server had not finished checking; this is what it said last` : ''].filter(Boolean).join('; ')
  if (!result.diagnostics.length) return `No problems in ${shown(result.file, ctx)}${notes ? ` (${notes})` : ''}.`
  const order = { error: 0, warning: 1, info: 2, hint: 3 }
  const sorted = [...result.diagnostics].sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line || a.character - b.character)
  const counts = (['error', 'warning', 'info', 'hint'] as const).map((severity) => [severity, sorted.filter((item) => item.severity === severity).length] as const).filter(([, count]) => count)
  const head = `${shown(result.file, ctx)}: ${counts.map(([severity, count]) => plural(count, severity === 'info' ? 'note' : severity)).join(', ')}${notes ? ` (${notes})` : ''}`
  const lines = sorted.slice(0, limit).map((item) => `  ${item.line + 1}:${item.character + 1} ${item.severity}: ${item.message.replace(/\s*\n\s*/g, ' ')}${item.source || item.code ? ` [${[item.source, item.code].filter(Boolean).join(' ')}]` : ''}`)
  if (sorted.length > limit) lines.push(`  ... and ${sorted.length - limit} more.`)
  return [head, ...lines].join('\n')
}

// ---------------------------------------------------------------------------
// LSP

interface LspInput extends Record<string, unknown>, PositionInput {
  operation: Lookup
  filePath: string
  query?: string
  endLine?: number
}

const positionProperties = {
  line: { type: 'integer', minimum: 1, description: 'The 1-based line, as Read numbers it.' },
  character: { type: 'integer', minimum: 1, description: 'The 1-based column of the symbol. Optional with symbol.' },
  symbol: { type: 'string', maxLength: 200, description: 'The name at that line; its column is found for you. Prefer it to character.' },
}

export const lspTool: Tool<LspInput> = {
  definition: {
    name: 'LSP',
    description: [
      'Asks the project\'s language server about code: exact answers where Grep guesses.',
      '',
      'Operations:',
      '- goToDefinition, goToTypeDefinition, goToImplementation: where the symbol at a position is defined.',
      '- findReferences: every use of it across the project.',
      '- hover: its type and documentation.',
      '- documentSymbol: the outline of filePath. workspaceSymbol: symbols named like query across the project.',
      '- prepareCallHierarchy, incomingCalls, outgoingCalls: the function at a position, who calls it, what it calls.',
      '- diagnostics: the errors and warnings the server reports for filePath now.',
      '- codeActions: the fixes and refactors offered for line (to endLine); apply one with LSPEdit.',
      '',
      'Positions: line is 1-based. Give symbol (the name on that line) rather than character.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...LOOKUPS] },
        filePath: { type: 'string', description: 'The file, absolute or relative to the project. For workspaceSymbol, a file of the language to search.' },
        ...positionProperties,
        query: { type: 'string', maxLength: 200, description: 'workspaceSymbol: the name, or part of it.' },
        endLine: { type: 'integer', minimum: 1, description: 'codeActions: the last line of the range. Default line.' },
      },
      required: ['operation', 'filePath'],
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  defer: 'always',
  check(input) {
    if (AT_POSITION.has(input.operation)) return needsPosition(input)
    if (input.operation === 'workspaceSymbol' && !input.query?.trim()) return 'workspaceSymbol needs query.'
    if (input.operation === 'codeActions' && !input.line) return 'codeActions needs line.'
    if (input.endLine && input.line && input.endLine < input.line) return 'endLine comes before line.'
    return undefined
  },
  async access(input, ctx) {
    return { type: 'read', paths: [await realPathOf(fileOf(input, ctx))] }
  },
  describe(input, ctx) {
    const file = shown(fileOf(input, ctx), ctx)
    const at = input.symbol ? `${input.symbol} in ${file}` : input.line ? `${file}:${input.line}` : file
    return { title: `LSP ${input.operation}`, detail: input.operation === 'workspaceSymbol' ? input.query : at }
  },
  async run(input, ctx) {
    const code = ctx.code
    if (!code) return fail(`${unavailableText} Use Grep and Read instead.`)
    const file = fileOf(input, ctx)
    const coverage = code.covers(file)
    if (!coverage.ok) return fail(`${coverage.reason} Use Grep and Read instead.`)
    const lines = new Lines()
    try {
      return await lookup(input, file, code, lines, ctx)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}

async function lookup(input: LspInput, file: string, code: CodeIntelligence, lines: Lines, ctx: ToolContext): Promise<ToolOutcome> {
  const signal = ctx.signal
  const ok = (content: string, output?: string): ToolOutcome => ({ ok: true, content, ...(output ? { display: { output } } : {}) })
  switch (input.operation) {
    case 'documentSymbol': {
      const symbols = await code.documentSymbols(file, signal)
      return ok(symbols.length ? `Outline of ${shown(file, ctx)}:\n${listSymbols(symbols, ctx, true)}` : `The server found no symbols in ${shown(file, ctx)}.`)
    }
    case 'workspaceSymbol': {
      const symbols = await code.workspaceSymbols(input.query!.trim(), file, signal)
      return ok(symbols.length ? `${plural(symbols.length, 'symbol')} matching ${input.query!.trim()}:\n${listSymbols(symbols, ctx, false)}` : `No symbol matches ${input.query!.trim()}.`)
    }
    case 'diagnostics': {
      const [result] = await code.diagnostics([file], { waitMs: DIAGNOSTICS_WAIT_MS, signal })
      if (!result.ok) return fail(result.reason)
      return ok(formatDiagnostics(result, ctx))
    }
    case 'codeActions': {
      const text = await lines.of(file)
      const start = input.line! - 1
      const end = (input.endLine ?? input.line!) - 1
      const range = { start: { line: start, character: 0 }, end: { line: end, character: text?.[end]?.length ?? 0 } }
      const actions = await code.codeActions(file, range, signal)
      if (!actions.length) return ok(`No code actions for ${shown(file, ctx)}:${input.line}${input.endLine && input.endLine !== input.line ? `-${input.endLine}` : ''}.`)
      const list = actions.map((action) => `${action.id}. ${action.title}${[action.kind, action.preferred ? 'preferred' : ''].filter(Boolean).length ? ` (${[action.kind, action.preferred ? 'preferred' : ''].filter(Boolean).join(', ')})` : ''}${action.disabled ? ` [not available: ${action.disabled}]` : ''}`)
      return ok(`Code actions for ${shown(file, ctx)}:${input.line}${input.endLine && input.endLine !== input.line ? `-${input.endLine}` : ''}:\n${list.join('\n')}\nApply one with LSPEdit (operation applyCodeAction, the same filePath, actionId).`)
    }
    default:
      break
  }
  const position = await positionOf(input, file, lines, ctx)
  if (typeof position === 'string') return fail(position)
  const note = position.note ? `${position.note}\n` : ''
  const subject = input.symbol?.trim() || `${shown(file, ctx)}:${position.line + 1}:${position.character + 1}`
  switch (input.operation) {
    case 'goToDefinition':
    case 'goToTypeDefinition':
    case 'goToImplementation': {
      const ask = input.operation === 'goToDefinition' ? code.definition : input.operation === 'goToTypeDefinition' ? code.typeDefinition : code.implementation
      const found = await ask.call(code, file, position.line, position.character, signal)
      const what = input.operation === 'goToDefinition' ? 'definition' : input.operation === 'goToTypeDefinition' ? 'type definition' : 'implementation'
      if (!found.length) return ok(`${note}No ${what} found for ${subject}.`)
      return ok(`${note}${found.length === 1 ? `The ${what} of ${subject}:` : `${found.length} ${what}s of ${subject}:`}\n${await listLocations(found, lines, ctx, file)}`)
    }
    case 'findReferences': {
      const found = await code.references(file, position.line, position.character, true, signal)
      if (!found.length) return ok(`${note}No references found for ${subject}.`)
      const files = new Set(found.map((item) => item.file)).size
      return ok(`${note}${plural(found.length, 'reference')} to ${subject} in ${plural(files, 'file')}:\n${await listLocations(found, lines, ctx, file)}`)
    }
    case 'hover': {
      const text = await code.hover(file, position.line, position.character, signal)
      return ok(`${note}${text ? (text.length > 6_000 ? `${text.slice(0, 6_000)}\n...` : text) : `Nothing is known about ${subject}.`}`)
    }
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls': {
      const result = await code.calls(file, position.line, position.character, input.operation === 'outgoingCalls' ? 'outgoing' : 'incoming', signal)
      if (!result) return ok(`${note}There is no function at ${subject}.`)
      const head = `${result.item.kind} ${result.item.name}  ${where(result.item, ctx)}`
      if (input.operation === 'prepareCallHierarchy') return ok(`${note}${head}`)
      const label = input.operation === 'incomingCalls' ? 'Called from' : 'Calls'
      if (!result.calls.length) return ok(`${note}${head}\n${input.operation === 'incomingCalls' ? 'Nothing calls it.' : 'It calls nothing the server knows of.'}`)
      return ok(`${note}${head}\n${label}:\n${listSymbols(result.calls, ctx, false)}`)
    }
    default:
      return fail(`Unknown operation ${String(input.operation)}.`)
  }
}

// ---------------------------------------------------------------------------
// LSPEdit

interface LspEditInput extends Record<string, unknown>, PositionInput {
  operation: 'rename' | 'applyCodeAction'
  filePath: string
  newName?: string
  actionId?: number
}

type Prepared = { ok: true; plan: EditPlan } | { ok: true; command: string } | { ok: false; reason: string }

/** Plans by call, so the plan approved is the plan applied. */
const prepared = new Map<string, Promise<Prepared>>()
const MAX_PREPARED = 32

function prepare(input: LspEditInput, ctx: ToolContext): Promise<Prepared> {
  const key = `${ctx.sessionId}\0${ctx.agentId}\0${ctx.toolUseId}`
  const known = prepared.get(key)
  if (known) return known
  const work = (async (): Promise<Prepared> => {
    const code = ctx.code
    if (!code) return { ok: false, reason: unavailableText }
    const file = fileOf(input, ctx)
    const coverage = code.covers(file)
    if (!coverage.ok) return { ok: false, reason: coverage.reason }
    try {
      if (input.operation === 'rename') {
        const position = await positionOf(input, file, new Lines(), ctx)
        if (typeof position === 'string') return { ok: false, reason: position }
        return { ok: true, plan: await code.rename(file, position.line, position.character, input.newName!.trim(), ctx.signal) }
      }
      const got = await code.actionEdit(file, input.actionId!, ctx.signal)
      return 'plan' in got ? { ok: true, plan: got.plan } : { ok: true, command: got.command }
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })()
  prepared.set(key, work)
  while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value!)
  return work
}

const unavailableText = 'Language servers are not available here: they run only in a folder you trust, with language servers turned on in Settings.'

export const lspEditTool: Tool<LspEditInput> = {
  definition: {
    name: 'LSPEdit',
    description: [
      'Changes code through the project\'s language server, which knows every use of a symbol.',
      '',
      '- rename: renames the symbol at a position to newName everywhere it is used, across files. Prefer it to editing each use by hand.',
      '- applyCodeAction: applies an action that LSP codeActions listed for the same filePath, by actionId.',
      '',
      'Positions: line is 1-based. Give symbol (the current name on that line) rather than character. Read a file before you edit it further by hand.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['rename', 'applyCodeAction'] },
        filePath: { type: 'string', description: 'The file, absolute or relative to the project.' },
        ...positionProperties,
        newName: { type: 'string', minLength: 1, maxLength: 200, description: 'rename: the new name.' },
        actionId: { type: 'integer', minimum: 1, description: 'applyCodeAction: the number LSP codeActions gave the action.' },
      },
      required: ['operation', 'filePath'],
      additionalProperties: false,
    },
  },
  kind: 'write',
  readOnly: false,
  defer: 'always',
  check(input) {
    if (input.operation === 'rename') {
      const missing = needsPosition(input)
      if (missing) return missing
      if (!input.newName?.trim()) return 'rename needs newName.'
      if (/[\r\n]/.test(input.newName)) return 'newName is one line.'
      return undefined
    }
    if (!input.actionId) return 'applyCodeAction needs actionId, from LSP codeActions.'
    return undefined
  },
  async access(input, ctx) {
    const file = await realPathOf(fileOf(input, ctx))
    const ready = await prepare(input, ctx)
    if (!ready.ok || !('plan' in ready)) return { type: 'write', paths: [file] }
    const others = await Promise.all(ready.plan.files.map((item) => realPathOf(item)))
    return { type: 'write', paths: [...new Set([file, ...others])] }
  },
  async describe(input, ctx) {
    const file = fileOf(input, ctx)
    const ready = await prepare(input, ctx)
    const title = input.operation === 'rename' ? `Rename ${input.symbol?.trim() || `the symbol at ${shown(file, ctx)}:${input.line}`} to ${input.newName?.trim()}` : `Apply code action ${input.actionId} in ${shown(file, ctx)}`
    if (!ready.ok) return { title, detail: ready.reason }
    if ('command' in ready) return { title, detail: `Runs the language server's command "${ready.command}", which may change ${shown(file, ctx)} only.` }
    const edits = ready.plan.changes.filter((change) => change.kind === 'edit')
    const first = edits.find((change) => change.file === file) ?? edits[0]
    return {
      title,
      detail: summarizePlan(ready.plan, ctx, file),
      ...(first && first.kind === 'edit' ? { preview: buildDiff(first.file, first.before, first.after) } : {}),
    }
  },
  async run(input, ctx) {
    if (!ctx.code) return fail(unavailableText)
    const key = `${ctx.sessionId}\0${ctx.agentId}\0${ctx.toolUseId}`
    try {
      const ready = await prepare(input, ctx)
      if (!ready.ok) return fail(ready.reason)
      const file = fileOf(input, ctx)
      if ('plan' in ready) {
        const applied = await applyPlan(ready.plan, ctx)
        if (!applied.ok) return fail(applied.reason)
        const what = input.operation === 'rename' ? `Renamed ${input.symbol?.trim() ?? 'the symbol'} to ${input.newName!.trim()}` : `Applied code action ${input.actionId}`
        return finished(what, ready.plan, applied.changed, ctx, file)
      }
      // A command: the server sends its edits while it runs, and only edits to this file are applied.
      const allowed = await realPathOf(file)
      const changed: string[] = []
      const plans: EditPlan[] = []
      const ran = await ctx.code.runActionCommand(
        file,
        input.actionId!,
        async (plan) => {
          for (const item of plan.files) {
            if ((await realPathOf(item)) !== allowed) return { applied: false, failureReason: `eNCode lets this command change ${shown(file, ctx)} only, and it also changes ${shown(item, ctx)}.` }
          }
          const applied = await applyPlan(plan, ctx)
          if (!applied.ok) return { applied: false, failureReason: applied.reason }
          changed.push(...applied.changed)
          plans.push(plan)
          return { applied: true }
        },
        ctx.signal,
      )
      if (!ran.applied) return fail(ran.refused.length ? `Nothing was changed: ${ran.refused.join(' ')}` : `The command "${ready.command}" ran and changed nothing.`)
      const merged: EditPlan = { server: plans[0].server, changes: plans.flatMap((plan) => plan.changes), files: [...new Set(plans.flatMap((plan) => plan.files))] }
      const outcome = finished(`Applied code action ${input.actionId} ("${ready.command}")`, merged, [...new Set(changed)], ctx, file)
      return ran.refused.length ? { ...outcome, content: `${String(outcome.content)}\nRefused: ${ran.refused.join(' ')}` } : outcome
    } catch (error) {
      if (ctx.signal.aborted) throw error
      return fail(error instanceof Error ? error.message : String(error))
    } finally {
      prepared.delete(key)
    }
  },
}

function summarizePlan(plan: EditPlan, ctx: ToolContext, home?: string): string {
  const parts: string[] = []
  const edits = new Map<string, number>()
  for (const change of plan.changes) {
    if (change.kind === 'edit') edits.set(change.file, (edits.get(change.file) ?? 0) + change.edits)
    else if (change.kind === 'create') parts.push(`creates ${shown(change.file, ctx)}`)
    else if (change.kind === 'rename') parts.push(`moves ${shown(change.from, ctx)} to ${shown(change.to, ctx)}`)
    else parts.push(`deletes ${shown(change.file, ctx)}`)
  }
  const total = [...edits.values()].reduce((sum, count) => sum + count, 0)
  const files = byHome([...edits], home ?? '').slice(0, 12).map(([file, count]) => `${shown(file, ctx)} ${count}`)
  const head = total ? `${plural(total, 'edit')} in ${plural(edits.size, 'file')} (${files.join(', ')}${edits.size > 12 ? ', ...' : ''})` : 'no text edits'
  return [head, ...parts].join('; ')
}

function finished(what: string, plan: EditPlan, changed: string[], ctx: ToolContext, home: string): ToolOutcome {
  const summary = `${what}: ${summarizePlan(plan, ctx, home)}.`
  const edits = plan.changes.filter((change) => change.kind === 'edit')
  const first = edits.find((change) => change.file === home) ?? edits[0]
  return {
    ok: true,
    content: `${summary} Read a file again before you edit it by hand.`,
    display: { output: summary, ...(first && first.kind === 'edit' ? { diff: buildDiff(first.file, first.before, first.after) } : {}) },
    changed,
  }
}

// ---------------------------------------------------------------------------
// Applying a plan

interface Sim {
  exists: boolean
  directory?: boolean
  bytes?: Buffer
  text?: string
  encoding?: TextEncodingName
}

type Step =
  | { kind: 'write'; file: string; bytes: Buffer; previous: Buffer | null }
  | { kind: 'move'; from: string; to: string; bytes: Buffer; previousTo: Buffer | null }
  | { kind: 'delete'; file: string; previous: Buffer }

async function statOf(file: string): Promise<Stats | null> {
  try {
    return await fs.stat(file)
  } catch {
    return null
  }
}

/**
 * Checks the whole plan against the disk first, as if applied in order, and writes only when every step holds: the
 * text each edit was computed for is the text there, and every path is inside the project.
 */
export async function applyPlan(plan: EditPlan, ctx: ToolContext): Promise<{ ok: true; changed: string[] } | { ok: false; reason: string }> {
  for (const file of plan.files) {
    if (!(await isInsideReal(ctx.root, file))) return { ok: false, reason: `The change reaches outside the project (${file}); nothing was changed.` }
  }
  const key = (file: string) => (ctx.platform === 'win32' || ctx.platform === 'darwin' ? path.resolve(file).toLowerCase() : path.resolve(file))
  const sims = new Map<string, Sim>()
  const sim = async (file: string): Promise<Sim> => {
    const known = sims.get(key(file))
    if (known) return known
    const stats = await statOf(file)
    let value: Sim
    if (!stats) value = { exists: false }
    else if (stats.isDirectory()) value = { exists: true, directory: true }
    else if (stats.size > MAX_TEXT_FILE_BYTES) value = { exists: true }
    else {
      const bytes = await fs.readFile(file)
      const decoded = decodeText(bytes)
      value = { exists: true, bytes, ...(decoded ? { text: decoded.text, encoding: decoded.encoding } : {}) }
    }
    sims.set(key(file), value)
    return value
  }
  const set = (file: string, value: Sim) => sims.set(key(file), value)
  const steps: Step[] = []
  const name = (file: string) => shown(file, ctx)
  for (const change of plan.changes) {
    if (change.kind === 'edit') {
      const now = await sim(change.file)
      if (!now.exists || now.directory) return { ok: false, reason: `${name(change.file)} is not there any more; nothing was changed.` }
      if (now.text === undefined) return { ok: false, reason: `${name(change.file)} is not a text file eNCode can change; nothing was changed.` }
      if (now.text !== change.before) return { ok: false, reason: `${name(change.file)} is not what the language server read (it changed since, or has unsaved changes in the editor). Nothing was changed: save it or read it again, then retry.` }
      let bytes: Buffer
      try {
        bytes = encodeText(change.after, now.encoding ?? 'utf8')
      } catch (error) {
        if (error instanceof UnencodableTextError) return { ok: false, reason: `${name(change.file)} is an older ANSI text file and cannot hold ${JSON.stringify(error.character)}; nothing was changed.` }
        throw error
      }
      steps.push({ kind: 'write', file: change.file, bytes, previous: now.bytes ?? null })
      set(change.file, { exists: true, bytes, text: change.after, encoding: now.encoding ?? 'utf8' })
    } else if (change.kind === 'create') {
      const now = await sim(change.file)
      if (now.directory) return { ok: false, reason: `${name(change.file)} is a folder; nothing was changed.` }
      if (now.exists && !change.overwrite) {
        if (change.ignoreIfExists) continue
        return { ok: false, reason: `${name(change.file)} already exists; nothing was changed.` }
      }
      const bytes = Buffer.alloc(0)
      steps.push({ kind: 'write', file: change.file, bytes, previous: now.bytes ?? null })
      set(change.file, { exists: true, bytes, text: '', encoding: 'utf8' })
    } else if (change.kind === 'rename') {
      const from = await sim(change.from)
      const to = await sim(change.to)
      if (!from.exists) return { ok: false, reason: `${name(change.from)} is not there to move; nothing was changed.` }
      if (from.directory || to.directory || !from.bytes) return { ok: false, reason: `eNCode moves single text files for a language server, not folders (${name(change.from)}); nothing was changed.` }
      if (to.exists && !change.overwrite) {
        if (change.ignoreIfExists) continue
        return { ok: false, reason: `${name(change.to)} already exists; nothing was changed.` }
      }
      steps.push({ kind: 'move', from: change.from, to: change.to, bytes: from.bytes, previousTo: to.bytes ?? null })
      set(change.to, from)
      set(change.from, { exists: false })
    } else {
      const now = await sim(change.file)
      if (!now.exists) {
        if (change.ignoreIfNotExists) continue
        return { ok: false, reason: `${name(change.file)} is not there to delete; nothing was changed.` }
      }
      if (now.directory || !now.bytes) return { ok: false, reason: `eNCode deletes single files for a language server, not folders (${name(change.file)}); nothing was changed.` }
      steps.push({ kind: 'delete', file: change.file, previous: now.bytes })
      set(change.file, { exists: false })
    }
  }
  const changed: string[] = []
  const info = { turnId: ctx.turnId, toolUseId: ctx.toolUseId }
  for (const step of steps) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    if (step.kind === 'write') {
      // A file the agent has not read stays one it must read before it writes it by hand.
      const known = ctx.files.get(step.file)
      await ctx.beforeWrite?.(step.file, step.previous, info)
      await fs.mkdir(path.dirname(step.file), { recursive: true })
      await fs.writeFile(step.file, step.bytes)
      if (known) ctx.files.set(step.file, stateOf(step.bytes, await fs.stat(step.file), false))
      changed.push(step.file)
    } else if (step.kind === 'move') {
      await ctx.beforeWrite?.(step.from, step.bytes, info)
      await ctx.beforeWrite?.(step.to, step.previousTo, info)
      await fs.mkdir(path.dirname(step.to), { recursive: true })
      await fs.rename(step.from, step.to)
      ctx.files.delete(step.from)
      changed.push(step.from, step.to)
    } else {
      await ctx.beforeWrite?.(step.file, step.previous, info)
      await fs.rm(step.file)
      ctx.files.delete(step.file)
      changed.push(step.file)
    }
  }
  return { ok: true, changed: [...new Set(changed)] }
}
