/**
 * The language servers of one folder, shared by the editor and the agent: one connection per server, started the
 * first time a file of its language needs it, stopped after a while unused, started again after a crash (three
 * times in a few minutes at most). A document the editor has open is the editor's: its text, saved or not, is what
 * the server sees, and the agent is told when what it gets is for unsaved text. Every other document is read from
 * the disk when the agent needs it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { LANGUAGE_SERVERS, serverFor, type Prepared, type ServerSpec } from './catalog'
import { LanguageClient, type EditorTriggers, type OpenDocument, type ServerProcess } from './client'
import { toEntry, type CompletionEntry, type CompletionResult, type EditorHighlight } from './completion'
import type { LaunchPlan } from './discover'
import { applyTextEdits } from './edits'
import { RpcFailure } from './jsonrpc'
import { DiagnosticSeverity, SYMBOL_KINDS, type CallHierarchyItem, type CodeAction, type CompletionItem, type Diagnostic, type DocumentSymbol, type Range, type SignatureHelp, type TextEdit, type WorkspaceEdit } from './protocol'
import { readCallHierarchyItems, readCalls, readCallSites, readCodeAction, readCodeActions, readCompletion, readDocumentSymbols, readHighlights, readHover, readLocations, readPrepareRename, readRange, readSignatureHelp, readSymbolInformation, readTextEditList, readWorkspaceEdit } from './results'
import { fromDocumentSymbols, nestSymbols, type EditorSymbol } from './symbols'
import { readFoldingRanges, type EditorFoldRange } from './folding'
import { readInlayHints, type EditorInlayHint } from './inlay'
import { readLegend, readSemanticTokens, type EditorSemanticTokens } from './semantic'
import { documentKey, uriToPath } from './uri'

export type Severity = 'error' | 'warning' | 'info' | 'hint'

/** A diagnostic with a zero-based range, as eNCode's tools and the editor read it. */
export interface CodeDiagnostic {
  line: number
  character: number
  endLine: number
  endCharacter: number
  severity: Severity
  message: string
  source?: string
  code?: string
}

export type FileDiagnostics =
  | {
      file: string
      ok: true
      server: string
      diagnostics: CodeDiagnostic[]
      /** The editor has changes not saved: these are for its text, not the file on disk. */
      unsaved?: boolean
      /** The server had not answered in time; this is what it said last. */
      stale?: boolean
    }
  | { file: string; ok: false; reason: string }

export interface CodeLocation {
  file: string
  line: number
  character: number
  endLine: number
  endCharacter: number
}

export interface CodeSymbol {
  name: string
  kind: string
  detail?: string
  container?: string
  file: string
  line: number
  character: number
  endLine: number
  /** Nesting in a document's outline, from 0. */
  depth?: number
}

export type PlannedChange =
  | {
      kind: 'edit'
      file: string
      /**
       * The text the server computed the edits for: the file must still read this when the plan is applied (after the
       * plan's earlier changes, when it has several for one file).
       */
      before: string
      after: string
      edits: number
      /** The edits themselves, for `before`, their line breaks the file's own. */
      textEdits: TextEdit[]
    }
  | { kind: 'create'; file: string; overwrite: boolean; ignoreIfExists: boolean }
  | { kind: 'rename'; from: string; to: string; overwrite: boolean; ignoreIfExists: boolean }
  | { kind: 'delete'; file: string; recursive: boolean; ignoreIfNotExists: boolean }

export interface EditPlan {
  server: string
  changes: PlannedChange[]
  /** Every path the plan writes, creates, moves or deletes. */
  files: string[]
}

export interface ActionInfo {
  /** 1-based, in the order the server gave. */
  id: number
  title: string
  kind?: string
  preferred?: boolean
  disabled?: string
  /** It runs a command of the server's instead of carrying its edit. */
  command?: boolean
}

/** A symbol found by name across the folder's files, for the editor. */
export interface EditorSymbolHit {
  name: string
  kind: string
  container?: string
  file: string
  /** The range of its name, or the start of the file when the server gave only the file. */
  range: Range
}

/** A function of a call hierarchy, numbered in the editor's newest one so that its calls can be asked for. */
export interface EditorCallItem {
  id: number
  name: string
  kind: string
  detail?: string
  file: string
  /** The range of its name. */
  range: Range
}

/** One end of the calls of a function: the caller for incoming calls, the callee for outgoing ones, and where the calls are. */
export interface EditorCall {
  item: EditorCallItem
  /** The file the calls are in: the caller's for incoming calls, the asked function's own for outgoing ones. */
  file: string
  sites: Range[]
}

export type ServerState = 'missing' | 'stopped' | 'starting' | 'running' | 'failed' | 'off'

export interface ServerView {
  id: string
  label: string
  state: ServerState
  /** Where it was found, the program, and the reason it is missing, off or failed. */
  detail?: string
  command?: string
  working?: boolean
  documents: number
}

export type Coverage = { ok: true; server: string; languageId: string } | { ok: false; reason: string }

export interface HubOptions {
  root: string
  platform?: NodeJS.Platform
  catalog?: readonly ServerSpec[]
  /** Whether servers may run now, and why not: read at each start, and by `sync`. */
  allowed(): { ok: true } | { ok: false; reason: string }
  discover(spec: ServerSpec): LaunchPlan | { missing: string }
  /** Starts the program in `cwd`: the caller confines it and gives it an environment without secrets. */
  spawn(plan: LaunchPlan, cwd: string): Promise<ServerProcess>
  /** A file's text on disk, or null when it is not a text file eNCode can read. Default: UTF-8 up to 8 MB. */
  readText?(file: string): Promise<string | null>
  exists?(file: string): boolean
  /** eNCode's tools folder and its cache folder, for what a server's `prepare` writes and reads (ADR 0084). */
  tools?: { dir: string; cacheDir: string }
  /** A server nobody used for this long stops while no editor has its files open. Default 10 minutes. */
  idleMs?: number
  /** Every publish, for the editor's marks. */
  onDiagnostics?(file: string, diagnostics: CodeDiagnostic[]): void
  /** A server started, stopped or failed. */
  onChange?(): void
  log?(line: string): void
}

const DEFAULT_IDLE_MS = 10 * 60_000
const MAX_AGENT_DOCUMENTS = 64
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const CRASH_WINDOW_MS = 3 * 60_000
const CRASHES_ALLOWED = 3
const RETRY_AFTER_FAILURE_MS = 5 * 60_000
const DISCOVERY_TTL_MS = 30_000
const REQUEST_MS = 15_000
/** Symbols found across a folder for the editor: more than a list can show. */
const MAX_SYMBOL_HITS = 1_000
/** The functions a call hierarchy starts from, and all it may grow to as it is opened. */
const MAX_CALL_ROOTS = 20
const MAX_CALL_ITEMS = 5_000
const ACTIONS_TTL_MS = 5 * 60_000
/** The most text one plan may carry, before and after together. */
const MAX_PLAN_BYTES = 64 * 1024 * 1024

const SEVERITY: Record<number, Severity> = { [DiagnosticSeverity.Error]: 'error', [DiagnosticSeverity.Warning]: 'warning', [DiagnosticSeverity.Information]: 'info', [DiagnosticSeverity.Hint]: 'hint' }

export function toCodeDiagnostic(item: Diagnostic): CodeDiagnostic {
  return {
    line: item.range.start.line,
    character: item.range.start.character,
    endLine: item.range.end.line,
    endCharacter: item.range.end.character,
    // A diagnostic without a severity is the client's to judge; the protocol suggests an error.
    severity: SEVERITY[item.severity ?? DiagnosticSeverity.Error] ?? 'error',
    message: item.message,
    ...(item.source ? { source: item.source } : {}),
    ...(item.code !== undefined ? { code: String(item.code) } : {}),
  }
}

interface Server {
  spec: ServerSpec
  client?: LanguageClient
  starting?: Promise<LanguageClient>
  state: ServerState
  detail?: string
  command?: string
  crashes: number[]
  failedAt?: number
  lastUse: number
}

interface EditorDocument {
  file: string
  text: string
  dirty: boolean
}

async function diskText(file: string): Promise<string | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) return null
    const bytes = await fs.readFile(file)
    if (bytes.includes(0)) return null
    const text = bytes.toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `over` laid on `base`: objects merge key by key, anything else (a list, a value) replaces. */
export function mergeSettings(base: Record<string, unknown> | undefined, over: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!over) return base
  if (!base) return over
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const was = merged[key]
    merged[key] = isPlainObject(was) && isPlainObject(value) ? mergeSettings(was, value) : value
  }
  return merged
}

/** A line break a server writes takes the file's own, so a file with CRLF lines keeps them and one with LF lines keeps those. */
function fitLineBreaks(edits: TextEdit[], text: string): TextEdit[] {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return edits.map((item) => (/[\r\n]/.test(item.newText) ? { range: item.range, newText: item.newText.replace(/\r\n?|\n/g, eol) } : item))
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text
}

/** A server refused an edit: `message` tells the agent what to do next, `reason` is the server's own words, for a person. */
export class EditRefused extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'EditRefused'
  }
}

/** A server's words for a person, as a sentence: trimmed, cut short, never empty. */
const serverWords = (error: unknown, fallback: string): string => {
  const words = (error instanceof Error ? error.message : String(error)).trim().slice(0, 300)
  if (!words) return fallback
  const sentence = words[0].toUpperCase() + words.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

export class LanguageServers {
  readonly root: string
  private readonly platform: NodeJS.Platform
  private readonly catalog: readonly ServerSpec[]
  private readonly servers = new Map<string, Server>()
  private readonly editorDocs = new Map<string, EditorDocument>()
  /** Documents opened for the agent, least recently used first. */
  private readonly agentDocs = new Map<string, string>()
  /** How many publishes a document had when it was last brought up to date. */
  private readonly syncedAt = new Map<string, number>()
  private readonly discovered = new Map<string, { result: LaunchPlan | { missing: string }; at: number }>()
  /** Whether servers could run at the last `sync`. */
  private wasAllowed: boolean | undefined
  /** The last completion list, kept as the server sent it so that an item can be resolved. */
  private completions: { list: number; file: string; client: LanguageClient; items: CompletionItem[] } | null = null
  private completionLists = 0
  private actions: { file: string; items: CodeAction[]; at: number; server: string } | null = null
  /** The editor's own list of actions, apart from the agent's: neither replaces the other's. Only the newest is kept. */
  private editorActions: { list: number; file: string; client: LanguageClient; server: string; items: CodeAction[] } | null = null
  private editorActionLists = 0
  /** The editor's newest call hierarchy: every function it named, numbered, with the server that named them. */
  private editorCallItems: { list: number; client: LanguageClient; items: CallHierarchyItem[] } | null = null
  private editorCallLists = 0
  /** Files with marks in the editor, by server: taken back when the server closes the file or stops. */
  private readonly marked = new Map<string, Map<string, string>>()
  private readonly idleTimer: NodeJS.Timeout
  private disposed = false

  constructor(private readonly options: HubOptions) {
    this.root = options.root
    this.platform = options.platform ?? process.platform
    this.catalog = options.catalog ?? LANGUAGE_SERVERS
    for (const spec of this.catalog) this.servers.set(spec.id, { spec, state: 'stopped', crashes: [], lastUse: 0 })
    this.idleTimer = setInterval(() => this.stopIdle(), Math.min(30_000, Math.max(20, (options.idleMs ?? DEFAULT_IDLE_MS) / 2)))
    this.idleTimer.unref?.()
  }

  // ------------------------------------------------------------ which server

  private key(file: string): string {
    return documentKey(file, this.platform)
  }

  private discover(spec: ServerSpec, fresh = false): LaunchPlan | { missing: string } {
    const known = this.discovered.get(spec.id)
    if (!fresh && known && Date.now() - known.at < DISCOVERY_TTL_MS) return known.result
    const result = this.options.discover(spec)
    this.discovered.set(spec.id, { result, at: Date.now() })
    return result
  }

  /** Whether servers may run now, and why not. */
  available(): { ok: true } | { ok: false; reason: string } {
    return this.disposed ? { ok: false, reason: 'The language servers were closed.' } : this.options.allowed()
  }

  /** Whether a server covers the file and may run, without starting one. */
  covers(file: string): Coverage {
    const found = serverFor(file, this.catalog)
    if (!found) return { ok: false, reason: `No language server covers ${path.extname(file) || path.basename(file)} files.` }
    const allowed = this.options.allowed()
    if (!allowed.ok) return { ok: false, reason: allowed.reason }
    const server = this.servers.get(found.spec.id)!
    if (server.state === 'failed' && server.failedAt && Date.now() - server.failedAt < RETRY_AFTER_FAILURE_MS) return { ok: false, reason: server.detail ?? `${found.spec.label} failed.` }
    const plan = this.discover(found.spec)
    if ('missing' in plan) return { ok: false, reason: plan.missing }
    return { ok: true, server: found.spec.label, languageId: found.languageId }
  }

  private async clientFor(file: string, signal?: AbortSignal): Promise<{ client: LanguageClient; server: Server; languageId: string } | { reason: string }> {
    if (this.disposed) return { reason: 'The language servers were closed.' }
    const coverage = this.covers(file)
    if (!coverage.ok) return { reason: coverage.reason }
    const found = serverFor(file, this.catalog)!
    const server = this.servers.get(found.spec.id)!
    server.lastUse = Date.now()
    if (server.client && !server.client.exited) return { client: server.client, server, languageId: found.languageId }
    try {
      const client = await abortable(this.start(server), signal)
      return { client, server, languageId: found.languageId }
    } catch (error) {
      if (signal?.aborted) throw error
      return { reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** What the folder adds to a server's settings and arguments; a failure there is logged and the server starts plain. */
  private prepare(spec: ServerSpec): Prepared | null {
    if (!spec.prepare) return null
    try {
      return spec.prepare({ root: this.root, platform: this.platform, ...(this.options.tools ? { tools: this.options.tools } : {}) })
    } catch (error) {
      this.options.log?.(`[${spec.id}] could not prepare the folder's settings: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private start(server: Server): Promise<LanguageClient> {
    if (server.starting) return server.starting
    const found = this.discover(server.spec, true)
    if ('missing' in found) return Promise.reject(new Error(found.missing))
    const prepared = this.prepare(server.spec)
    const plan = prepared?.args?.length ? { ...found, args: [...found.args, ...prepared.args] } : found
    const settings = mergeSettings(server.spec.settings, prepared?.settings)
    server.state = 'starting'
    server.command = `${plan.command} (${plan.found})`
    server.detail = undefined
    this.options.onChange?.()
    let made: LanguageClient | undefined
    const starting = (async () => {
      const proc = await this.options.spawn(plan, this.root)
      const exists = this.options.exists ?? (() => false)
      made = await LanguageClient.start({
        name: plan.command,
        root: this.root,
        platform: this.platform,
        process: proc,
        ...(server.spec.initializationOptions ? { initializationOptions: server.spec.initializationOptions(this.root, exists) } : {}),
        ...(settings ? { settings } : {}),
        // What a client says once it is no longer the server's (stopped, replaced) is not shown.
        onDiagnostics: (file, items) => {
          if (!made || server.client === made) this.mark(server, file, items.map(toCodeDiagnostic))
        },
        onLog: (line) => this.options.log?.(`[${plan.command}] ${line}`),
        onExit: (reason) => this.crashed(server, reason),
      })
      return made
    })()
    server.starting = starting
    starting.then(
      (client) => {
        server.starting = undefined
        if (this.disposed || !this.options.allowed().ok) {
          void client.stop()
          server.state = this.disposed ? 'stopped' : 'off'
          return
        }
        server.client = client
        server.state = 'running'
        this.options.onChange?.()
        // What the editor has open of its languages is shown to it at once.
        for (const doc of this.editorDocs.values()) {
          const found = serverFor(doc.file, this.catalog)
          if (found?.spec.id === server.spec.id) this.syncTo(client, doc.file, found.languageId, doc.text)
        }
      },
      (error: unknown) => {
        server.starting = undefined
        server.state = 'failed'
        server.failedAt = Date.now()
        server.detail = error instanceof Error ? error.message : String(error)
        this.options.onChange?.()
      },
    )
    return starting
  }

  private crashed(server: Server, reason: string): void {
    const client = server.client
    server.client = undefined
    if (client) for (const doc of client.documents()) this.forgetSync(doc.file)
    this.unmark(server)
    const now = Date.now()
    server.crashes = [...server.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    if (server.crashes.length >= CRASHES_ALLOWED) {
      server.state = 'failed'
      server.failedAt = now
      server.detail = `${server.spec.label}: the language server stopped ${CRASHES_ALLOWED} times in a few minutes, so eNCode leaves it off for a while. ${reason}`
    } else {
      server.state = 'stopped'
      server.detail = reason
      // The editor still shows its files: start again for them.
      const wanted = [...this.editorDocs.values()].some((doc) => serverFor(doc.file, this.catalog)?.spec.id === server.spec.id)
      if (wanted && !this.disposed) setTimeout(() => void this.start(server).catch(() => undefined), 1_000).unref?.()
    }
    this.options.onChange?.()
  }

  /** What a server said of a file, for the editor; a file it no longer finds anything in is no longer marked. */
  private mark(server: Server, file: string, items: CodeDiagnostic[]): void {
    const key = this.key(file)
    let files = this.marked.get(server.spec.id)
    if (items.length) {
      if (!files) this.marked.set(server.spec.id, (files = new Map()))
      files.set(key, file)
    } else {
      files?.delete(key)
    }
    this.options.onDiagnostics?.(file, items)
  }

  /** The server closed the file, or stopped: its marks are taken back, since nothing keeps them up to date. */
  private unmark(server: Server, file?: string): void {
    const files = this.marked.get(server.spec.id)
    if (!files) return
    for (const key of file ? [this.key(file)] : [...files.keys()]) {
      const known = files.get(key)
      if (known === undefined) continue
      files.delete(key)
      this.options.onDiagnostics?.(known, [])
    }
  }

  private closeIn(client: LanguageClient, file: string): void {
    client.close(file)
    const found = serverFor(file, this.catalog)
    const server = found ? this.servers.get(found.spec.id) : undefined
    if (server) this.unmark(server, file)
  }

  private forgetSync(file: string): void {
    const key = this.key(file)
    this.syncedAt.delete(key)
    this.agentDocs.delete(key)
  }

  private syncTo(client: LanguageClient, file: string, languageId: string, text: string, saved = false): void {
    const key = this.key(file)
    const before = client.document(file)
    // The editor's documents are watched: a server asked for diagnostics is asked after each change.
    const watch = this.editorDocs.has(key)
    if (before && before.text === text && !saved) {
      if (watch) client.watch(file)
      return
    }
    this.syncedAt.set(key, client.publishCount(file))
    client.sync(file, languageId, text, { saved, watch })
  }

  // ------------------------------------------------------------ documents

  /** The editor opened a file; its text is what the servers see from now on. */
  editorOpen(file: string, text: string, dirty = false): void {
    this.editorDocs.set(this.key(file), { file, text, dirty })
    this.agentDocs.delete(this.key(file))
    this.bringUp(file)
  }

  editorChange(file: string, text: string, dirty: boolean): void {
    const key = this.key(file)
    const doc = this.editorDocs.get(key)
    if (!doc) return this.editorOpen(file, text, dirty)
    doc.text = text
    doc.dirty = dirty
    const server = this.runningFor(file)
    if (server) this.syncTo(server.client, file, server.languageId, text, !dirty)
    else this.bringUp(file)
  }

  editorClose(file: string): void {
    const key = this.key(file)
    if (!this.editorDocs.delete(key)) return
    const server = this.runningFor(file)
    if (server) {
      this.closeIn(server.client, file)
      this.syncedAt.delete(key)
    }
  }

  /** Starts the server of a file the editor shows, unless it may not run, and gives it the editor's text. */
  private bringUp(file: string): void {
    void this.clientFor(file)
      .then((got) => {
        const doc = this.editorDocs.get(this.key(file))
        if ('client' in got && doc) this.syncTo(got.client, file, got.languageId, doc.text)
      })
      .catch(() => undefined)
  }

  private runningFor(file: string): { client: LanguageClient; languageId: string } | null {
    const found = serverFor(file, this.catalog)
    const client = found ? this.servers.get(found.spec.id)?.client : undefined
    return found && client && !client.exited ? { client, languageId: found.languageId } : null
  }

  /** eNCode's tools changed these files on disk. */
  async changed(changes: readonly { file: string; kind: 'created' | 'changed' | 'deleted' }[]): Promise<void> {
    const byServer = new Map<LanguageClient, { file: string; kind: 'created' | 'changed' | 'deleted' }[]>()
    for (const change of changes) {
      const key = this.key(change.file)
      const running = this.runningFor(change.file)
      for (const server of this.servers.values()) {
        if (!server.client || server.client.exited) continue
        const list = byServer.get(server.client) ?? []
        list.push(change)
        byServer.set(server.client, list)
      }
      if (!running) continue
      if (change.kind === 'deleted') {
        if (!this.editorDocs.has(key)) {
          this.closeIn(running.client, change.file)
          this.forgetSync(change.file)
        }
        continue
      }
      const editor = this.editorDocs.get(key)
      // Unsaved text in the editor wins over the disk.
      if (editor?.dirty) continue
      if (!editor && !running.client.document(change.file)) continue
      const text = await this.read(change.file)
      if (text === null) continue
      if (editor) editor.text = text
      this.syncTo(running.client, change.file, running.languageId, text, true)
    }
    for (const [client, list] of byServer) client.filesChanged(list)
  }

  private read(file: string): Promise<string | null> {
    return (this.options.readText ?? diskText)(file)
  }

  /** Opens a document for the agent, from the editor's text when it has the file open, else from the disk. */
  private async open(file: string, signal?: AbortSignal): Promise<{ client: LanguageClient; server: Server; doc: OpenDocument; unsaved: boolean } | { reason: string }> {
    const got = await this.clientFor(file, signal)
    if ('reason' in got) return got
    const key = this.key(file)
    const editor = this.editorDocs.get(key)
    if (editor) {
      this.syncTo(got.client, file, got.languageId, editor.text)
    } else {
      const text = await this.read(file)
      if (text === null) return { reason: `${path.basename(file)} is not a text file the language server can read (missing, binary or over 8 MB).` }
      this.syncTo(got.client, file, got.languageId, text)
      this.agentDocs.delete(key)
      this.agentDocs.set(key, file)
      this.trimAgentDocs(got.client)
    }
    return { client: got.client, server: got.server, doc: got.client.document(file)!, unsaved: Boolean(editor?.dirty) }
  }

  private trimAgentDocs(client: LanguageClient): void {
    while (this.agentDocs.size > MAX_AGENT_DOCUMENTS) {
      const [key, file] = this.agentDocs.entries().next().value as [string, string]
      this.agentDocs.delete(key)
      this.syncedAt.delete(key)
      this.closeIn(this.runningFor(file)?.client ?? client, file)
    }
  }

  // ------------------------------------------------------------ diagnostics

  /** What the servers already said about these files, without starting or waiting for one. */
  known(files: readonly string[]): Map<string, CodeDiagnostic[]> {
    const out = new Map<string, CodeDiagnostic[]>()
    for (const file of files) {
      const running = this.runningFor(file)
      const published = running?.client.diagnosticsOf(file)
      if (published && running?.client.document(file)) out.set(file, published.items.map(toCodeDiagnostic))
    }
    return out
  }

  /** Opens the files in their servers so that what they say is ready when it is asked for. Never waits. */
  prefetch(files: readonly string[]): void {
    for (const file of files) {
      if (!this.covers(file).ok) continue
      void this.open(file).catch(() => undefined)
    }
  }

  /**
   * The diagnostics of each file as it is now, waiting at most `waitMs` in all (a server that has to start first uses
   * part of it). A file no server covers says why.
   */
  async diagnostics(files: readonly string[], options: { waitMs: number; signal?: AbortSignal }): Promise<FileDiagnostics[]> {
    const end = Date.now() + options.waitMs
    return Promise.all(
      files.map(async (file): Promise<FileDiagnostics> => {
        const opened = await this.open(file, deadline(end, options.signal))
        if ('reason' in opened) return { file, ok: false, reason: opened.reason }
        const since = this.syncedAt.get(this.key(file)) ?? opened.client.publishCount(file)
        const result = await opened.client.diagnostics(file, { waitMs: Math.max(0, end - Date.now()), since, ...(options.signal ? { signal: options.signal } : {}) })
        if (opened.client.exited) return { file, ok: false, reason: `${opened.server.spec.label}'s language server stopped before it answered. ${opened.client.exited}` }
        return {
          file,
          ok: true,
          server: opened.server.spec.label,
          diagnostics: result.items.map(toCodeDiagnostic),
          ...(opened.unsaved ? { unsaved: true } : {}),
          ...(result.fresh ? {} : { stale: true }),
        }
      }),
    )
  }

  // ------------------------------------------------------------ lookups

  private async ask<T>(file: string, feature: Parameters<LanguageClient['supports']>[0], method: string, params: (doc: OpenDocument) => unknown, read: (value: unknown, client: LanguageClient) => T, signal?: AbortSignal): Promise<T> {
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    if (!opened.client.supports(feature)) throw new Error(`${opened.server.spec.label}'s language server (${opened.client.name}) does not offer ${describeFeature(feature)}.`)
    try {
      const value = await opened.client.request(method, params(opened.doc), { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) })
      return read(value, opened.client)
    } catch (error) {
      if (error instanceof RpcFailure && error.code === 'cancelled') throw error
      throw new Error(`${opened.client.name} could not answer: ${lowerFirst(error instanceof Error ? error.message : String(error))}`)
    }
  }

  private locations(value: unknown): CodeLocation[] {
    const out: CodeLocation[] = []
    for (const location of readLocations(value)) {
      const file = uriToPath(location.uri, this.platform)
      if (file) out.push({ file, line: location.range.start.line, character: location.range.start.character, endLine: location.range.end.line, endCharacter: location.range.end.character })
    }
    return out
  }

  definition(file: string, line: number, character: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    return this.ask(file, 'definition', 'textDocument/definition', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => this.locations(value), signal)
  }

  typeDefinition(file: string, line: number, character: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    return this.ask(file, 'typeDefinition', 'textDocument/typeDefinition', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => this.locations(value), signal)
  }

  implementation(file: string, line: number, character: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    return this.ask(file, 'implementation', 'textDocument/implementation', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => this.locations(value), signal)
  }

  references(file: string, line: number, character: number, includeDeclaration: boolean, signal?: AbortSignal): Promise<CodeLocation[]> {
    return this.ask(file, 'references', 'textDocument/references', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character }, context: { includeDeclaration } }), (value) => this.locations(value), signal)
  }

  hover(file: string, line: number, character: number, signal?: AbortSignal): Promise<string | null> {
    return this.ask(file, 'hover', 'textDocument/hover', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => readHover(value), signal)
  }

  documentSymbols(file: string, signal?: AbortSignal): Promise<CodeSymbol[]> {
    return this.ask(
      file,
      'documentSymbol',
      'textDocument/documentSymbol',
      (doc) => ({ textDocument: { uri: doc.uri } }),
      (value) => {
        const read = readDocumentSymbols(value)
        if ('flat' in read) return read.flat.map((item) => this.symbolOf(item.name, item.kind, 'range' in item.location ? item.location : { uri: item.location.uri }, item.containerName, undefined, file)).filter((item): item is CodeSymbol => Boolean(item))
        const out: CodeSymbol[] = []
        const walk = (items: DocumentSymbol[], depth: number) => {
          for (const item of items) {
            out.push({ name: item.name, kind: SYMBOL_KINDS[item.kind] ?? 'symbol', ...(item.detail ? { detail: item.detail } : {}), file, line: item.selectionRange.start.line, character: item.selectionRange.start.character, endLine: item.range.end.line, depth })
            if (item.children) walk(item.children, depth + 1)
          }
        }
        walk(read.tree, 0)
        return out
      },
      signal,
    )
  }

  private symbolOf(name: string, kind: number, location: { uri: string; range?: Range }, container: string | undefined, detail: string | undefined, fallback?: string): CodeSymbol | null {
    const file = uriToPath(location.uri, this.platform) ?? fallback
    if (!file) return null
    const range = location.range
    return {
      name,
      kind: SYMBOL_KINDS[kind] ?? 'symbol',
      ...(detail ? { detail } : {}),
      ...(container ? { container } : {}),
      file,
      line: range?.start.line ?? 0,
      character: range?.start.character ?? 0,
      endLine: range?.end.line ?? 0,
    }
  }

  /** Symbols by name across the project, from the server of `file`'s language, or of every running server. */
  async workspaceSymbols(query: string, file: string | undefined, signal?: AbortSignal): Promise<CodeSymbol[]> {
    const clients: LanguageClient[] = []
    if (file) {
      const opened = await this.open(file, signal)
      if ('reason' in opened) throw new Error(opened.reason)
      clients.push(opened.client)
    } else {
      for (const server of this.servers.values()) if (server.client && !server.client.exited) clients.push(server.client)
      if (!clients.length) throw new Error('No language server is running yet. Name a file of the language to search, so its server starts.')
    }
    const out: CodeSymbol[] = []
    for (const client of clients) {
      if (!client.supports('workspaceSymbol')) continue
      const value = await client.request('workspace/symbol', { query }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) })
      for (const item of readSymbolInformation(value)) {
        const symbol = this.symbolOf(item.name, item.kind, 'range' in item.location ? item.location : { uri: item.location.uri }, item.containerName, undefined)
        if (symbol) out.push(symbol)
      }
    }
    return out
  }

  /** Who calls the function at the position (`incoming`), or what it calls (`outgoing`). */
  async calls(file: string, line: number, character: number, direction: 'incoming' | 'outgoing', signal?: AbortSignal): Promise<{ item: CodeSymbol; calls: CodeSymbol[] } | null> {
    const items = await this.ask(file, 'callHierarchy', 'textDocument/prepareCallHierarchy', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => readCallHierarchyItems(value), signal)
    const first = items[0]
    if (!first) return null
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    const value = await opened.client.request(direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item: first }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) })
    const toSymbol = (item: CallHierarchyItem) => this.symbolOf(item.name, item.kind, { uri: item.uri, range: item.selectionRange }, undefined, item.detail)
    const item = toSymbol(first)
    if (!item) return null
    return { item, calls: readCalls(value, direction === 'incoming' ? 'from' : 'to').map(toSymbol).filter((symbol): symbol is CodeSymbol => Boolean(symbol)) }
  }

  // ------------------------------------------------------------ edits

  /** What renaming the symbol at the position to `newName` would change, without changing anything. */
  async rename(file: string, line: number, character: number, newName: string, signal?: AbortSignal): Promise<EditPlan> {
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    const { client } = opened
    if (!client.supports('rename')) throw new Error(`${opened.server.spec.label}'s language server (${client.name}) does not offer renaming.`)
    const position = { line, character }
    const textDocument = { uri: opened.doc.uri }
    const provider = client.capabilities.renameProvider
    if (typeof provider === 'object' && provider?.prepareProvider) {
      const prepared = await client.request('textDocument/prepareRename', { textDocument, position }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) }).catch((error: unknown) => {
        if (error instanceof RpcFailure && error.code === 'cancelled') throw error
        throw new EditRefused(`Nothing can be renamed there: ${lowerFirst(error instanceof Error ? error.message : String(error))}`, serverWords(error, 'This element cannot be renamed.'))
      })
      if (prepared === null) throw new EditRefused('Nothing at that position can be renamed. Give the line and column of the symbol\'s name.', 'This element cannot be renamed.')
    }
    let value: unknown
    try {
      value = await client.request('textDocument/rename', { textDocument, position, newName }, { timeoutMs: 60_000, ...(signal ? { signal } : {}) })
    } catch (error) {
      if (error instanceof RpcFailure && error.code === 'cancelled') throw error
      throw new EditRefused(`${client.name} could not rename: ${lowerFirst(error instanceof Error ? error.message : String(error))}`, serverWords(error, 'The language server could not rename it.'))
    }
    if (value === null) throw new EditRefused('Nothing at that position can be renamed. Give the line and column of the symbol\'s name.', 'This element cannot be renamed.')
    const edit = readWorkspaceEdit(value)
    if (!edit) throw new Error(`${client.name} answered with an edit eNCode could not read, so nothing was changed.`)
    return await this.plan(edit, client, opened.server.spec.label)
  }

  /** The actions the server offers for a range of a file (quick fixes, refactors), numbered for `actionEdit`. */
  async codeActions(file: string, range: Range, signal?: AbortSignal): Promise<ActionInfo[]> {
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    if (!opened.client.supports('codeAction')) throw new Error(`${opened.server.spec.label}'s language server (${opened.client.name}) does not offer code actions.`)
    // The diagnostics there go with the request: most quick fixes are offered only for them.
    const published = opened.client.diagnosticsOf(file)?.items ?? []
    const touching = published.filter((item) => !(item.range.end.line < range.start.line || item.range.start.line > range.end.line))
    const value = await opened.client.request('textDocument/codeAction', { textDocument: { uri: opened.doc.uri }, range, context: { diagnostics: touching, triggerKind: 1 } }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) })
    const items = readCodeActions(value)
    this.actions = { file: this.key(file), items, at: Date.now(), server: opened.server.spec.label }
    return items.map((item, index) => ({
      id: index + 1,
      title: item.title,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.isPreferred ? { preferred: true } : {}),
      ...(item.disabled ? { disabled: item.disabled.reason } : {}),
      ...(!item.edit && item.command ? { command: true } : {}),
    }))
  }

  private listed(file: string, id: number): { action: CodeAction; server: string } {
    const listed = this.actions
    if (!listed || listed.file !== this.key(file) || Date.now() - listed.at > ACTIONS_TTL_MS) throw new Error('List the actions for this file again (codeActions); the list from before is gone.')
    const action = listed.items[id - 1]
    if (!action) throw new Error(`There is no action ${id}; the list has ${listed.items.length}.`)
    if (action.disabled) throw new Error(`That action is not available: ${action.disabled.reason}`)
    return { action, server: listed.server }
  }

  /**
   * What an action `codeActions` listed would change, without changing anything: its edit (resolved first when the
   * server sends it later), or the command it runs instead, whose edits are known only once it runs.
   */
  async actionEdit(file: string, id: number, signal?: AbortSignal): Promise<{ plan: EditPlan } | { command: string }> {
    const { action: chosen, server } = this.listed(file, id)
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    const { client } = opened
    let action: CodeAction = chosen
    const provider = client.capabilities.codeActionProvider
    // An action that comes without its edit gets it from resolve: one with data for the server, or one with nothing else.
    if (!action.edit && (action.data !== undefined || !action.command) && typeof provider === 'object' && provider?.resolveProvider) {
      const resolved = readCodeAction(await client.request('codeAction/resolve', chosen, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) }).catch((error: unknown) => {
        if (action.command) return null
        throw new Error(`${client.name} could not prepare that action: ${lowerFirst(error instanceof Error ? error.message : String(error))}`)
      }))
      if (resolved) action = resolved
      // What was resolved is what runs.
      if (this.actions?.items[id - 1] === chosen) this.actions.items[id - 1] = action
    }
    if (action.edit) return { plan: await this.plan(action.edit, client, server) }
    if (action.command) return { command: action.command.title || action.command.command }
    throw new Error('That action carries no change.')
  }

  /**
   * Runs the command of an action that has no edit of its own. The edits the server asks for while it runs go to
   * `apply`, each as a plan; nothing the server asks for after it ends is applied.
   */
  async runActionCommand(file: string, id: number, apply: (plan: EditPlan) => Promise<{ applied: boolean; failureReason?: string }>, signal?: AbortSignal): Promise<{ applied: number; refused: string[] }> {
    const { action, server } = this.listed(file, id)
    if (!action.command) throw new Error('That action has no command to run.')
    const opened = await this.open(file, signal)
    if ('reason' in opened) throw new Error(opened.reason)
    const { client } = opened
    let applied = 0
    const refused: string[] = []
    await client.executeCommand(
      action.command,
      async (edit) => {
        let plan: EditPlan
        try {
          plan = await this.plan(edit, client, server)
        } catch (error) {
          refused.push(error instanceof Error ? error.message : String(error))
          return { applied: false, failureReason: refused.at(-1) }
        }
        const result = await apply(plan)
        if (result.applied) applied++
        else if (result.failureReason) refused.push(result.failureReason)
        return result
      },
      { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    )
    return { applied, refused }
  }

  /**
   * The changes an edit makes, in order, each text edit with its file's text before and after: what the earlier
   * changes of the edit left, else the text the server saw when it has the document open, else the file on disk, which
   * is what a server reads for a document it does not have open.
   */
  private async plan(edit: WorkspaceEdit, client: LanguageClient, server: string): Promise<EditPlan> {
    const changes: PlannedChange[] = []
    const files: string[] = []
    /** What the edit has made of a path so far: its text, or null once it is gone. */
    const state = new Map<string, string | null>()
    let bytes = 0
    const fileOf = (uri: string): string => {
      const file = uriToPath(uri, this.platform)
      if (!file) throw new Error(`The edit names ${uri.slice(0, 200)}, which is not a file eNCode can change; nothing was changed.`)
      return file
    }
    const textOf = async (file: string): Promise<string | null> => {
      const key = this.key(file)
      if (state.has(key)) return state.get(key)!
      return client.document(file)?.text ?? (await this.read(file))
    }
    const textEdit = async (file: string, edits: TextEdit[]) => {
      const before = await textOf(file)
      if (before === null) throw new Error(`The edit changes ${path.basename(file)}, which is missing or not a text file eNCode can read; nothing was changed.`)
      const fitted = fitLineBreaks(edits, before)
      const after = applyTextEdits(before, fitted)
      bytes += before.length + after.length
      if (bytes > MAX_PLAN_BYTES) throw new Error('The edit is too large to check and apply safely; nothing was changed.')
      state.set(this.key(file), after)
      changes.push({ kind: 'edit', file, before, after, edits: edits.length, textEdits: fitted })
      files.push(file)
    }
    if (edit.documentChanges) {
      for (const item of edit.documentChanges) {
        if ('textDocument' in item) {
          const file = fileOf(item.textDocument.uri)
          const open = client.document(file)
          // An edit made for another version of the document than the one open would land in the wrong places.
          if (open && !state.has(this.key(file)) && item.textDocument.version !== null && item.textDocument.version !== open.version) throw new Error(`The edit was made for an older version of ${path.basename(file)}; nothing was changed. Ask again.`)
          await textEdit(file, item.edits)
        } else if (item.kind === 'create') {
          const file = fileOf(item.uri)
          const overwrite = Boolean(item.options?.overwrite)
          const ignoreIfExists = Boolean(item.options?.ignoreIfExists)
          const existing = await textOf(file).catch(() => null)
          if (existing === null || overwrite) state.set(this.key(file), '')
          changes.push({ kind: 'create', file, overwrite, ignoreIfExists })
          files.push(file)
        } else if (item.kind === 'rename') {
          const from = fileOf(item.oldUri)
          const to = fileOf(item.newUri)
          const moved = await textOf(from)
          if (moved !== null) state.set(this.key(to), moved)
          state.set(this.key(from), null)
          changes.push({ kind: 'rename', from, to, overwrite: Boolean(item.options?.overwrite), ignoreIfExists: Boolean(item.options?.ignoreIfExists) })
          files.push(from, to)
        } else {
          const file = fileOf(item.uri)
          state.set(this.key(file), null)
          changes.push({ kind: 'delete', file, recursive: Boolean(item.options?.recursive), ignoreIfNotExists: Boolean(item.options?.ignoreIfNotExists) })
          files.push(file)
        }
      }
    } else if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) await textEdit(fileOf(uri), edits)
    }
    return { server, changes, files: [...new Set(files)] }
  }

  /** Reads a range the way the protocol has it, or null. */
  static range(value: unknown): Range | null {
    return readRange(value)
  }

  // ------------------------------------------------------------ the editor's requests

  /**
   * Asks the server of a file the editor shows, for the editor's text as it is now. A server that cannot answer, or a
   * file no server may serve, gets null: the editor shows nothing rather than an error for each keystroke.
   */
  private async editorAsk<T>(file: string, feature: Parameters<LanguageClient['supports']>[0], method: string, params: (doc: OpenDocument, client: LanguageClient) => unknown, read: (value: unknown, client: LanguageClient, server: string) => T, signal?: AbortSignal, timeoutMs = REQUEST_MS): Promise<T | null> {
    if (!this.covers(file).ok) return null
    const opened = await this.open(file, signal).catch(() => ({ reason: 'gone' }))
    if ('reason' in opened || !opened.client.supports(feature)) return null
    try {
      const value = await opened.client.request(method, params(opened.doc, opened.client), { timeoutMs, ...(signal ? { signal } : {}) })
      return read(value, opened.client, opened.server.spec.label)
    } catch (error) {
      if (!(error instanceof RpcFailure && error.code === 'cancelled')) this.options.log?.(`[${opened.client.name}] ${method}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** What typing asks of the server of a file, or null while none runs for it. */
  editorTriggers(file: string): EditorTriggers | null {
    return this.runningFor(file)?.client.triggers() ?? null
  }

  async completion(file: string, line: number, character: number, context: { triggerKind: 1 | 2 | 3; triggerCharacter?: string }, signal?: AbortSignal): Promise<CompletionResult | null> {
    const list = ++this.completionLists
    return this.editorAsk(
      file,
      'completion',
      'textDocument/completion',
      (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character }, context }),
      (value, client) => {
        const read = readCompletion(value)
        const resolvable = client.supports('completionResolve')
        // Only the newest list can be resolved; an older answer that arrives late is still shown by its caller's choice.
        if (list === this.completionLists) this.completions = { list, file, client, items: read.items }
        return { list, incomplete: read.incomplete, items: read.items.map((item, index) => toEntry(item, index, !resolvable)) }
      },
      signal,
    )
  }

  /** Fills in an item of the newest list: its documentation, and the edits it brings (an import). */
  async resolveCompletion(file: string, list: number, id: number, signal?: AbortSignal): Promise<CompletionEntry | null> {
    const known = this.completions
    if (!known || known.list !== list || known.file !== file || !known.items[id]) return null
    const item = known.items[id]
    if (!known.client.supports('completionResolve') || known.client.exited) return toEntry(item, id, true)
    try {
      const value = await known.client.request('completionItem/resolve', item, { timeoutMs: 5_000, ...(signal ? { signal } : {}) })
      const read = readCompletion([value]).items[0]
      if (!read) return toEntry(item, id, true)
      // A resolve fills in; it does not move the item. What it left out stays as the list had it.
      const merged: CompletionItem = { ...item, ...read, textEdit: read.textEdit ?? item.textEdit, insertText: read.insertText ?? item.insertText }
      known.items[id] = merged
      return toEntry(merged, id, true)
    } catch (error) {
      if (!(error instanceof RpcFailure && error.code === 'cancelled')) this.options.log?.(`[${known.client.name}] completionItem/resolve: ${error instanceof Error ? error.message : String(error)}`)
      return toEntry(item, id, true)
    }
  }

  signatureHelp(file: string, line: number, character: number, context: { triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; activeSignatureHelp?: SignatureHelp }, signal?: AbortSignal): Promise<SignatureHelp | null> {
    return this.editorAsk(file, 'signatureHelp', 'textDocument/signatureHelp', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character }, context }), (value) => readSignatureHelp(value), signal)
  }

  async highlights(file: string, line: number, character: number, signal?: AbortSignal): Promise<EditorHighlight[]> {
    const kinds = { 1: 'text', 2: 'read', 3: 'write' } as const
    const read = await this.editorAsk(file, 'documentHighlight', 'textDocument/documentHighlight', (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }), (value) => readHighlights(value), signal, 3_000)
    return (read ?? []).map((item) => ({ range: item.range, kind: kinds[(item.kind ?? 1) as 1 | 2 | 3] }))
  }

  /** The hover of a position for the editor: markdown, and the range it is about. */
  editorHover(file: string, line: number, character: number, signal?: AbortSignal): Promise<{ markdown: string; range?: Range } | null> {
    return this.editorAsk(
      file,
      'hover',
      'textDocument/hover',
      (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }),
      (value) => {
        const markdown = readHover(value)
        if (!markdown) return null
        const range = value && typeof value === 'object' ? readRange((value as { range?: unknown }).range) : null
        return { markdown, ...(range ? { range } : {}) }
      },
      signal,
      5_000,
    )
  }

  /** Where a symbol is defined, for the editor: the same as the agent's lookup, without its errors. */
  async editorLocations(kind: 'definition' | 'typeDefinition' | 'implementation' | 'references', file: string, line: number, character: number, signal?: AbortSignal): Promise<CodeLocation[] | null> {
    const method = { definition: 'textDocument/definition', typeDefinition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation', references: 'textDocument/references' }[kind]
    return this.editorAsk(
      file,
      kind,
      method,
      (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character }, ...(kind === 'references' ? { context: { includeDeclaration: true } } : {}) }),
      (value) => this.locations(value),
      signal,
    )
  }

  /** The editor's text of a file it has open, as it last sent it, and whether that has unsaved changes. */
  editorText(file: string): { text: string; dirty: boolean } | null {
    const doc = this.editorDocs.get(this.key(file))
    return doc ? { text: doc.text, dirty: doc.dirty } : null
  }

  /**
   * Whether the symbol at a position can be renamed, and what: the range and the name to start from, or no range when
   * the server leaves it to the editor (the word there). The server's reason when it cannot; null when no server can
   * rename in the file.
   */
  async editorPrepareRename(file: string, line: number, character: number, signal?: AbortSignal): Promise<{ ok: true; range?: Range; placeholder?: string } | { ok: false; reason: string } | null> {
    if (!this.covers(file).ok) return null
    const opened = await this.open(file, signal).catch(() => ({ reason: 'gone' }))
    if ('reason' in opened || !opened.client.supports('rename')) return null
    if (!opened.client.supports('prepareRename')) return { ok: true }
    try {
      const value = await opened.client.request('textDocument/prepareRename', { textDocument: { uri: opened.doc.uri }, position: { line, character } }, { timeoutMs: 5_000, ...(signal ? { signal } : {}) })
      const read = readPrepareRename(value)
      if (read === null) return { ok: false, reason: 'This element cannot be renamed.' }
      return read === 'default' ? { ok: true } : { ok: true, ...read }
    } catch (error) {
      if (error instanceof RpcFailure && error.code === 'cancelled') throw error
      return { ok: false, reason: serverWords(error, 'This element cannot be renamed.') }
    }
  }

  /**
   * The actions the server offers the editor for a range (quick fixes, refactors, source actions such as organizing the
   * imports), with the problems published there, numbered by their place in the list. `only` keeps the kinds asked
   * for ('quickfix' keeps 'quickfix.add'); `automatic` is the question the editor asks by itself, not the person.
   */
  editorCodeActions(file: string, range: Range, options: { only?: readonly string[]; automatic: boolean }, signal?: AbortSignal): Promise<{ list: number; actions: ActionInfo[] } | null> {
    const list = ++this.editorActionLists
    const before = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line < b.line || (a.line === b.line && a.character < b.character)
    return this.editorAsk(
      file,
      'codeAction',
      'textDocument/codeAction',
      (doc, client) => {
        // The problems the range touches go with the question: most quick fixes are offered only for them.
        const published = client.diagnosticsOf(file)?.items ?? []
        const touching = published.filter((item) => !before(item.range.end, range.start) && !before(range.end, item.range.start))
        return { textDocument: { uri: doc.uri }, range, context: { diagnostics: touching, ...(options.only ? { only: [...options.only] } : {}), triggerKind: options.automatic ? 2 : 1 } }
      },
      (value, client, server) => {
        const only = options.only
        // A server may offer more than was asked for; an action without a kind is not of any kind asked for.
        const items = readCodeActions(value).filter((item) => !only || only.some((kind) => item.kind === kind || Boolean(item.kind?.startsWith(`${kind}.`))))
        if (list === this.editorActionLists) this.editorActions = { list, file: this.key(file), client, server, items }
        return {
          list,
          actions: items.map((item, index) => ({
            id: index,
            title: item.title,
            ...(item.kind ? { kind: item.kind } : {}),
            ...(item.isPreferred ? { preferred: true } : {}),
            ...(item.disabled ? { disabled: item.disabled.reason } : {}),
            ...(!item.edit && item.command ? { command: true } : {}),
          })),
        }
      },
      signal,
      options.automatic ? 3_000 : REQUEST_MS,
    )
  }

  /** An action of the editor's newest list, or why it cannot be taken. */
  private editorListed(file: string, list: number, id: number): { action: CodeAction; client: LanguageClient; server: string } | { reason: string } {
    const known = this.editorActions
    if (!known || known.list !== list || known.file !== this.key(file) || known.client.exited) return { reason: 'That list of actions is out of date. Open it again.' }
    const action = known.items[id]
    if (!action) return { reason: 'That action is not in the list any more. Open it again.' }
    if (action.disabled) return { reason: `${action.title}: ${action.disabled.reason}` }
    return { action, client: known.client, server: known.server }
  }

  /** Whether the server runs a command itself, by its own list; a command it does not list belongs to another editor. */
  private runsCommand(client: LanguageClient, command: string): boolean {
    const listed = client.capabilities.executeCommandProvider?.commands
    return !Array.isArray(listed) || listed.includes(command)
  }

  /**
   * What an action of the editor's list changes: its edit (resolved first when the server sends it later), and whether
   * a command of the server's runs after it (or instead, when it carries no edit). Nothing is changed yet.
   */
  async editorAction(file: string, list: number, id: number, signal?: AbortSignal): Promise<{ title: string; plan?: EditPlan; command: boolean } | { reason: string }> {
    const listed = this.editorListed(file, list, id)
    if ('reason' in listed) return listed
    const { client, server } = listed
    let action = listed.action
    // An action that comes without its edit gets it from resolve: one with data for the server, or one with nothing else.
    if (!action.edit && (action.data !== undefined || !action.command) && client.supports('codeActionResolve')) {
      try {
        const resolved = readCodeAction(await client.request('codeAction/resolve', action, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) }))
        if (resolved) {
          action = resolved
          // What was resolved is what runs.
          if (this.editorActions?.list === list) this.editorActions.items[id] = resolved
        }
      } catch (error) {
        if (error instanceof RpcFailure && error.code === 'cancelled') throw error
        if (!action.command) return { reason: `${client.name} could not prepare "${action.title}": ${lowerFirst(error instanceof Error ? error.message : String(error))}` }
      }
    }
    const command = action.command && this.runsCommand(client, action.command.command) ? action.command : undefined
    if (!action.edit) {
      if (command) return { title: action.title, command: true }
      if (action.command) return { reason: `"${action.title}" asks the editor it was made for to do the work (${action.command.command.slice(0, 100)}), which eNCode cannot do.` }
      return { reason: `"${action.title}" carries no change.` }
    }
    try {
      return { title: action.title, plan: await this.plan(action.edit, client, server), command: Boolean(command) }
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Runs the command of an action of the editor's list. The edits the server asks for while it runs go to `apply`, each
   * as a plan; nothing it asks for after it ends is applied.
   */
  async editorRunCommand(file: string, list: number, id: number, apply: (plan: EditPlan) => Promise<{ applied: boolean; failureReason?: string }>, signal?: AbortSignal): Promise<{ applied: number; refused: string[] } | { reason: string }> {
    const listed = this.editorListed(file, list, id)
    if ('reason' in listed) return listed
    const { action, client, server } = listed
    if (!action.command || !this.runsCommand(client, action.command.command)) return { reason: `"${action.title}" has no command eNCode can run.` }
    let applied = 0
    const refused: string[] = []
    try {
      await client.executeCommand(
        action.command,
        async (edit) => {
          let plan: EditPlan
          try {
            plan = await this.plan(edit, client, server)
          } catch (error) {
            refused.push(error instanceof Error ? error.message : String(error))
            return { applied: false, failureReason: refused.at(-1) }
          }
          const result = await apply(plan)
          if (result.applied) applied++
          else if (result.failureReason) refused.push(result.failureReason)
          return result
        },
        { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
      )
    } catch (error) {
      if (error instanceof RpcFailure && error.code === 'cancelled') throw error
      return { reason: `${client.name} could not run "${action.title}": ${lowerFirst(error instanceof Error ? error.message : String(error))}` }
    }
    return { applied, refused }
  }

  /** The edits that format a document of the editor's, or a range of it, for its text as the editor sent it. */
  format(file: string, options: { tabSize: number; insertSpaces: boolean }, range?: Range, signal?: AbortSignal): Promise<TextEdit[] | null> {
    return this.editorAsk(
      file,
      range ? 'rangeFormatting' : 'formatting',
      range ? 'textDocument/rangeFormatting' : 'textDocument/formatting',
      (doc) => ({ textDocument: { uri: doc.uri }, ...(range ? { range } : {}), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }),
      (value) => {
        const edits = readTextEditList(value)
        const doc = this.editorDocs.get(this.key(file))
        return edits && doc ? fitLineBreaks(edits, doc.text) : edits
      },
      signal,
      10_000,
    )
  }

  /** The edits that format what was just typed (`ch` at the position, after it), for the editor's text as it sent it. */
  formatOnType(file: string, line: number, character: number, ch: string, options: { tabSize: number; insertSpaces: boolean }, signal?: AbortSignal): Promise<TextEdit[] | null> {
    return this.editorAsk(
      file,
      'onTypeFormatting',
      'textDocument/onTypeFormatting',
      (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character }, ch, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }),
      (value) => {
        const edits = readTextEditList(value)
        const doc = this.editorDocs.get(this.key(file))
        return edits && doc ? fitLineBreaks(edits, doc.text) : edits
      },
      signal,
      2_000,
    )
  }

  /** The blocks of a document of the editor's that can fold, by whole lines, as its server sees them. */
  editorFoldingRanges(file: string, signal?: AbortSignal): Promise<EditorFoldRange[] | null> {
    return this.editorAsk(file, 'foldingRange', 'textDocument/foldingRange', (doc) => ({ textDocument: { uri: doc.uri } }), (value) => readFoldingRanges(value), signal)
  }

  /** The hints a server draws among the lines `startLine` to `endLine` (0-based, both included) of a document of the editor's. */
  editorInlayHints(file: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<EditorInlayHint[] | null> {
    return this.editorAsk(
      file,
      'inlayHint',
      'textDocument/inlayHint',
      (doc) => ({ textDocument: { uri: doc.uri }, range: { start: { line: startLine, character: 0 }, end: { line: endLine + 1, character: 0 } } }),
      (value) => readInlayHints(value)?.filter((hint) => hint.line >= startLine && hint.line <= endLine) ?? null,
      signal,
    )
  }

  /** The semantic tokens of a whole document of the editor's, in the editor's own kinds. */
  editorSemanticTokens(file: string, signal?: AbortSignal): Promise<EditorSemanticTokens | null> {
    return this.editorAsk(
      file,
      'semanticTokens',
      'textDocument/semanticTokens/full',
      (doc) => ({ textDocument: { uri: doc.uri } }),
      (value, client) => {
        const legend = readLegend(client.capabilities.semanticTokensProvider)
        return legend ? readSemanticTokens(value, legend) : null
      },
      signal,
    )
  }

  /** The outline of a document of the editor's as a tree; a server that answers with a flat list has it nested by range. */
  editorSymbols(file: string, signal?: AbortSignal): Promise<EditorSymbol[] | null> {
    return this.editorAsk(
      file,
      'documentSymbol',
      'textDocument/documentSymbol',
      (doc) => ({ textDocument: { uri: doc.uri } }),
      (value) => {
        const read = readDocumentSymbols(value)
        if ('tree' in read) return fromDocumentSymbols(read.tree)
        const key = this.key(file)
        const flat: EditorSymbol[] = []
        for (const item of read.flat) {
          // A flat list names a place for each symbol; one in another file, or with no range, is not this outline's.
          if (!('range' in item.location)) continue
          const at = uriToPath(item.location.uri, this.platform)
          if (!at || this.key(at) !== key) continue
          flat.push({ name: item.name, kind: SYMBOL_KINDS[item.kind] ?? 'symbol', range: item.location.range, selection: item.location.range })
        }
        return nestSymbols(flat)
      },
      signal,
    )
  }

  /**
   * Symbols by name across the folder for the editor: from every server running in it, and the one of `file` (started
   * if it is not). Null while no running server searches symbols.
   */
  async editorWorkspaceSymbols(query: string, file: string | undefined, signal?: AbortSignal): Promise<EditorSymbolHit[] | null> {
    if (file && this.covers(file).ok) await this.open(file, signal).catch(() => undefined)
    const clients: LanguageClient[] = []
    for (const server of this.servers.values()) if (server.client && !server.client.exited && server.client.supports('workspaceSymbol')) clients.push(server.client)
    if (!clients.length) return null
    const answers = await Promise.all(
      clients.map(async (client) => {
        try {
          return readSymbolInformation(await client.request('workspace/symbol', { query }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) }))
        } catch (error) {
          if (error instanceof RpcFailure && error.code === 'cancelled') throw error
          this.options.log?.(`[${client.name}] workspace/symbol: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      }),
    )
    const out: EditorSymbolHit[] = []
    for (const list of answers) {
      for (const item of list) {
        if (out.length >= MAX_SYMBOL_HITS) return out
        const at = uriToPath(item.location.uri, this.platform)
        if (!at) continue
        const range = 'range' in item.location ? item.location.range : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        out.push({ name: item.name, kind: SYMBOL_KINDS[item.kind] ?? 'symbol', ...(item.containerName ? { container: item.containerName } : {}), file: at, range })
      }
    }
    return out
  }

  /**
   * The functions at a position a call hierarchy starts from (usually one), numbered in a new hierarchy that replaces
   * the editor's last; null when no server offers call hierarchies in the file.
   */
  editorPrepareCalls(file: string, line: number, character: number, signal?: AbortSignal): Promise<{ list: number; items: EditorCallItem[] } | null> {
    const list = ++this.editorCallLists
    return this.editorAsk(
      file,
      'callHierarchy',
      'textDocument/prepareCallHierarchy',
      (doc) => ({ textDocument: { uri: doc.uri }, position: { line, character } }),
      (value, client) => {
        const items = readCallHierarchyItems(value).slice(0, MAX_CALL_ROOTS)
        if (list === this.editorCallLists) this.editorCallItems = { list, client, items: [...items] }
        const out: EditorCallItem[] = []
        items.forEach((item, id) => {
          const named = this.callItem(item, id)
          if (named) out.push(named)
        })
        return { list, items: out }
      },
      signal,
    )
  }

  /** Who calls a function of the editor's newest call hierarchy (`incoming`), or what it calls (`outgoing`), numbered in it in turn. */
  async editorCalls(list: number, id: number, direction: 'incoming' | 'outgoing', signal?: AbortSignal): Promise<{ calls: EditorCall[] } | { reason: string }> {
    const known = this.editorCallItems
    const asked = known && known.list === list ? known.items[id] : undefined
    if (!known || !asked) return { reason: 'That call hierarchy is out of date. Open it again.' }
    if (known.client.exited) return { reason: 'The language server stopped. Open the call hierarchy again.' }
    let value: unknown
    try {
      value = await known.client.request(direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item: asked }, { timeoutMs: REQUEST_MS, ...(signal ? { signal } : {}) })
    } catch (error) {
      if (error instanceof RpcFailure && error.code === 'cancelled') throw error
      return { reason: `${known.client.name} could not answer. ${serverWords(error, 'It gave no reason.')}` }
    }
    const askedFile = uriToPath(asked.uri, this.platform)
    const calls: EditorCall[] = []
    for (const { item, sites } of readCallSites(value, direction === 'incoming' ? 'from' : 'to')) {
      // A hierarchy is opened a level at a time; past this many functions it has grown beyond what anyone reads.
      if (known.items.length >= MAX_CALL_ITEMS) break
      const siteFile = direction === 'incoming' ? uriToPath(item.uri, this.platform) : askedFile
      if (!siteFile) continue
      const named = this.callItem(item, known.items.length)
      if (!named) continue
      known.items.push(item)
      calls.push({ item: named, file: siteFile, sites })
    }
    return { calls }
  }

  private callItem(item: CallHierarchyItem, id: number): EditorCallItem | null {
    const file = uriToPath(item.uri, this.platform)
    if (!file) return null
    return { id, name: item.name, kind: SYMBOL_KINDS[item.kind] ?? 'symbol', ...(item.detail ? { detail: item.detail } : {}), file, range: item.selectionRange }
  }

  // ------------------------------------------------------------ the servers

  status(): ServerView[] {
    const allowed = this.options.allowed()
    return [...this.servers.values()].map((server) => {
      const plan = this.discover(server.spec)
      const documents = server.client ? server.client.documents().length : 0
      if (!allowed.ok && !server.client) return { id: server.spec.id, label: server.spec.label, state: 'off' as const, detail: allowed.reason, documents }
      if (server.state === 'stopped' && 'missing' in plan) return { id: server.spec.id, label: server.spec.label, state: 'missing' as const, detail: plan.missing, documents }
      return {
        id: server.spec.id,
        label: server.spec.label,
        state: server.state,
        ...(server.detail ? { detail: server.detail } : {}),
        ...(server.command ? { command: server.command } : 'missing' in plan ? {} : { command: `${plan.command} (${plan.found})` }),
        ...(server.client?.working ? { working: true } : {}),
        documents,
      }
    })
  }

  /** The last lines a server logged, for a bug report. */
  logs(id: string): string[] {
    return this.servers.get(id)?.client?.logs() ?? []
  }

  /** Stops what may no longer run (the folder lost its trust, servers were turned off). */
  async sync(): Promise<void> {
    const allowed = this.options.allowed().ok
    const flipped = allowed !== this.wasAllowed
    this.wasAllowed = allowed
    // Where a server is found depends on the trust (the project's own node_modules/.bin counts only then): look again.
    if (flipped) this.discovered.clear()
    if (!allowed) {
      // Called before every tool call too: with nothing running and nothing new, there is nothing to say.
      if (flipped || [...this.servers.values()].some((server) => server.client || server.starting)) await this.stopAll('off')
      return
    }
    // Allowed again (the folder was trusted, servers were turned on): the files the editor shows get their servers.
    for (const server of this.servers.values()) if (server.state === 'off') server.state = 'stopped'
    for (const doc of this.editorDocs.values()) if (!this.runningFor(doc.file)) this.bringUp(doc.file)
    if (flipped) this.options.onChange?.()
  }

  /**
   * Looks for the servers again, one or all (one was installed or removed): the files the editor shows get the server
   * that is there now, and one that failed to start may try again at once. With `stop`, a running one is stopped
   * first, so that what it ran from can be removed.
   */
  async rediscover(id?: string, options: { stop?: boolean } = {}): Promise<void> {
    for (const server of this.servers.values()) {
      if (id && server.spec.id !== id) continue
      this.discovered.delete(server.spec.id)
      if (options.stop && (server.client || server.starting)) {
        const client = server.client ?? (await server.starting?.catch(() => undefined))
        server.client = undefined
        if (client) {
          for (const doc of client.documents()) this.forgetSync(doc.file)
          this.unmark(server)
          await client.stop()
        }
        server.state = 'stopped'
        server.detail = undefined
      }
      if (server.state === 'failed' && !server.client) {
        server.state = 'stopped'
        server.failedAt = undefined
        server.crashes = []
        server.detail = undefined
      }
    }
    if (!options.stop && !this.disposed && this.options.allowed().ok) for (const doc of this.editorDocs.values()) if (!this.runningFor(doc.file)) this.bringUp(doc.file)
    this.options.onChange?.()
  }

  private stopIdle(): void {
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS
    const now = Date.now()
    for (const server of this.servers.values()) {
      const client = server.client
      if (!client || now - server.lastUse < idleMs) continue
      const editorHas = [...this.editorDocs.values()].some((doc) => serverFor(doc.file, this.catalog)?.spec.id === server.spec.id)
      if (editorHas) continue
      server.client = undefined
      server.state = 'stopped'
      server.detail = undefined
      for (const doc of client.documents()) this.forgetSync(doc.file)
      this.unmark(server)
      void client.stop()
      this.options.onChange?.()
    }
  }

  private async stopAll(state: ServerState): Promise<void> {
    const stopping: Promise<void>[] = []
    for (const server of this.servers.values()) {
      const client = server.client
      server.client = undefined
      if (server.state === 'running' || server.state === 'starting') server.state = state
      if (client) {
        for (const doc of client.documents()) this.forgetSync(doc.file)
        stopping.push(client.stop())
      }
      this.unmark(server)
    }
    await Promise.all(stopping)
    this.options.onChange?.()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.idleTimer)
    await this.stopAll('stopped')
  }
}

function describeFeature(feature: string): string {
  const names: Record<string, string> = {
    hover: 'hover information',
    definition: 'go to definition',
    typeDefinition: 'go to type definition',
    implementation: 'go to implementation',
    references: 'find references',
    documentSymbol: 'a document outline',
    workspaceSymbol: 'symbol search',
    callHierarchy: 'call hierarchy',
    foldingRange: 'folding',
    rename: 'renaming',
    codeAction: 'code actions',
  }
  return names[feature] ?? feature
}

/** A signal that also aborts at `end`. */
function deadline(end: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, end - Date.now()))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
