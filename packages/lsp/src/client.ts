/**
 * One running language server: the handshake, the documents it has open and their versions, the diagnostics it
 * published, and the requests it may make of eNCode. A server is asked for no more than it said it can do, and what
 * it asks of eNCode is answered narrowly: settings by section, no message boxes, no documents shown, and no edit
 * applied unless eNCode asked for one (a code action's command).
 */
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { JSONRPC_ERRORS, JsonRpcConnection, RpcFailure, type RequestOptions } from './jsonrpc'
import { TextDocumentSyncKind, type Diagnostic, type Range, type ServerCapabilities, type WorkspaceEdit } from './protocol'
import { readDiagnostics, readWorkspaceEdit } from './results'
import { readLegend, SEMANTIC_TOKEN_MODIFIERS, SEMANTIC_TOKEN_TYPES } from './semantic'
import { documentKey, pathToUri, uriToPath } from './uri'

/** A started server process, as the client needs it. */
export interface ServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable | null
  /** Ends the process at once. */
  kill(): void
  /** Resolves once the process has exited. */
  exited: Promise<{ code: number | null; signal: string | null }>
}

/** A child process started with three pipes, as a server process. */
export function fromChildProcess(child: ChildProcess): ServerProcess {
  if (!child.stdin || !child.stdout) throw new Error('The language server was started without pipes for its input and output.')
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode })
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A program that could not be started never exits; it fails.
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  // A write after the server is gone fails on the pipe, not on eNCode.
  child.stdin.on('error', () => undefined)
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
    exited,
  }
}

export interface ClientOptions {
  /** For people: "typescript-language-server". */
  name: string
  /** The workspace folder, absolute. */
  root: string
  platform?: NodeJS.Platform
  process: ServerProcess
  initializationOptions?: unknown
  /** Answers `workspace/configuration`, by section ("python.analysis"). */
  settings?: Record<string, unknown>
  onDiagnostics?(file: string, diagnostics: Diagnostic[], version: number | undefined): void
  /** A line the server logged (stderr, window/logMessage); kept for when it fails. */
  onLog?(line: string): void
  /** The server ended or broke the protocol without being asked to stop. */
  onExit?(reason: string): void
  /** How long the handshake may take: a server can index the project first. Default 60 s. */
  initializeTimeoutMs?: number
}

/** What typing a character asks of a server, by its own say. */
export interface EditorTriggers {
  completion: string[]
  /** Characters that accept the selected completion and are then typed (`.` after a name). */
  commit: string[]
  signature: string[]
  signatureRetrigger: string[]
  /** Characters after which the server formats the line as it is typed (`}`, `;`, a new line). */
  format: string[]
}

export interface OpenDocument {
  file: string
  uri: string
  languageId: string
  version: number
  text: string
}

/** What a document's diagnostics were last, and when. */
interface Published {
  items: Diagnostic[]
  /** The version the server said they are for, when it says. */
  version?: number
  /** Counts publishes for the document, so a wait can tell a new one from an old one. */
  seq: number
}

interface Waiter {
  key: string
  check(published: Published): boolean
  resolve(): void
  /** The server is gone: the wait ends without what it waited for. */
  cancel(): void
}

const LOG_LINES = 50
const SETTLE_MS = 200

/** The capabilities eNCode says it has, so a server sends what eNCode reads. */
function clientCapabilities(): object {
  return {
    general: { positionEncodings: ['utf-16'] },
    workspace: {
      applyEdit: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'], failureHandling: 'abort' },
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
      symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) } },
      executeCommand: {},
      diagnostics: { refreshSupport: false },
    },
    textDocument: {
      synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
      publishDiagnostics: { relatedInformation: false, versionSupport: true, codeDescriptionSupport: false, dataSupport: false },
      diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      completion: {
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: { valueSet: [1] },
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, index) => index + 1) },
        contextSupport: true,
        completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] },
      },
      signatureHelp: {
        signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
        contextSupport: true,
      },
      documentHighlight: {},
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) } },
      callHierarchy: {},
      // Whole lines: the editor folds lines, so a server leaves a closing bracket's line out of the block itself.
      foldingRange: { lineFoldingOnly: true, rangeLimit: 5000, foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] } },
      // Hints are drawn from their label alone (parts joined); nothing is resolved later.
      inlayHint: {},
      // Whole-file tokens in the standard relative format; they colour names the lexer cannot tell apart (a type, a
      // parameter, a deprecated function) and leave the rest to it.
      semanticTokens: {
        requests: { full: true },
        tokenTypes: SEMANTIC_TOKEN_TYPES,
        tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
        serverCancelSupport: true,
        augmentsSyntaxTokens: true,
      },
      rename: { prepareSupport: true },
      formatting: {},
      rangeFormatting: {},
      onTypeFormatting: {},
      codeAction: {
        codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.move', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ['edit'] },
      },
    },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
  }
}

function has(capability: unknown): boolean {
  return capability === true || (Boolean(capability) && typeof capability === 'object')
}

export class LanguageClient {
  readonly name: string
  readonly root: string
  private readonly platform: NodeJS.Platform
  private readonly connection: JsonRpcConnection
  private capabilitiesValue: ServerCapabilities = {}
  private readonly docs = new Map<string, OpenDocument>()
  private readonly published = new Map<string, Published>()
  private readonly waiters = new Set<Waiter>()
  private readonly logLines: string[] = []
  /** Work the server announced with $/progress and has not ended: indexing, a build check. */
  private readonly busy = new Set<string>()
  /** Edits a command eNCode runs may ask for; anything else asking is refused. */
  private applying: ((edit: WorkspaceEdit) => Promise<{ applied: boolean; failureReason?: string }>) | null = null
  private stopping = false
  private exitReason: string | null = null

  private constructor(private readonly options: ClientOptions) {
    this.name = options.name
    this.root = options.root
    this.platform = options.platform ?? process.platform
    const proc = options.process
    this.connection = new JsonRpcConnection(proc.stdout, proc.stdin, {
      onRequest: (method, params) => this.serverRequest(method, params),
      onNotification: (method, params) => this.serverNotification(method, params),
      onClose: (reason) => this.ended(reason),
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.log(line)
    })
    void proc.exited.then((exit) => this.ended(this.describeExit(exit), true))
  }

  /** Starts the conversation with a server: initialize, then initialized. Kills the process when the handshake fails. */
  static async start(options: ClientOptions): Promise<LanguageClient> {
    const client = new LanguageClient(options)
    try {
      const rootUri = pathToUri(options.root, client.platform)
      const result = await client.connection.request<{ capabilities?: unknown; serverInfo?: unknown }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'eNCode' },
          locale: 'en',
          rootPath: options.root,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: options.root.split(/[\\/]/).filter(Boolean).pop() ?? options.root }],
          capabilities: clientCapabilities(),
          ...(options.initializationOptions !== undefined ? { initializationOptions: options.initializationOptions } : {}),
          trace: 'off',
        },
        { timeoutMs: options.initializeTimeoutMs ?? 60_000 },
      )
      client.capabilitiesValue = result && typeof result.capabilities === 'object' && result.capabilities ? (result.capabilities as ServerCapabilities) : {}
      client.connection.notify('initialized', {})
      if (options.settings) client.connection.notify('workspace/didChangeConfiguration', { settings: options.settings })
      return client
    } catch (error) {
      client.stopping = true
      client.connection.close('The handshake failed.')
      options.process.kill()
      const said = client.lastLog()
      throw new Error(`${options.name} did not start: ${error instanceof Error ? error.message : String(error)}${said ? ` It said: ${said}` : ''}`)
    }
  }

  get capabilities(): ServerCapabilities {
    return this.capabilitiesValue
  }

  /** Why the server is gone, or null while it runs. */
  get exited(): string | null {
    return this.exitReason
  }

  /** The server is still working through something it announced (indexing, a check). */
  get working(): boolean {
    return this.busy.size > 0
  }

  /** The last lines the server logged. */
  logs(): string[] {
    return [...this.logLines]
  }

  /** The characters after which the server offers completions or signature help without being asked. */
  triggers(): EditorTriggers {
    const chars = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length >= 1 && item.length <= 2).slice(0, 40) : [])
    const c = this.capabilitiesValue
    const completion = has(c.completionProvider) ? c.completionProvider : undefined
    const signature = has(c.signatureHelpProvider) ? c.signatureHelpProvider : undefined
    const onType = c.documentOnTypeFormattingProvider
    return {
      completion: chars(completion?.triggerCharacters),
      commit: chars(completion?.allCommitCharacters),
      signature: chars(signature?.triggerCharacters),
      signatureRetrigger: chars(signature?.retriggerCharacters),
      format: onType && typeof onType === 'object' ? [...new Set(chars([onType.firstTriggerCharacter, ...(Array.isArray(onType.moreTriggerCharacter) ? onType.moreTriggerCharacter : [])]))] : [],
    }
  }

  supports(feature: 'hover' | 'definition' | 'typeDefinition' | 'implementation' | 'references' | 'documentSymbol' | 'workspaceSymbol' | 'callHierarchy' | 'foldingRange' | 'inlayHint' | 'semanticTokens' | 'rename' | 'prepareRename' | 'codeAction' | 'codeActionResolve' | 'pullDiagnostics' | 'completion' | 'completionResolve' | 'signatureHelp' | 'documentHighlight' | 'formatting' | 'rangeFormatting' | 'onTypeFormatting'): boolean {
    const c = this.capabilitiesValue
    switch (feature) {
      case 'completion':
        return has(c.completionProvider)
      case 'completionResolve':
        return has(c.completionProvider) && c.completionProvider?.resolveProvider === true
      case 'signatureHelp':
        return has(c.signatureHelpProvider)
      case 'documentHighlight':
        return has(c.documentHighlightProvider)
      case 'hover':
        return has(c.hoverProvider)
      case 'definition':
        return has(c.definitionProvider)
      case 'typeDefinition':
        return has(c.typeDefinitionProvider)
      case 'implementation':
        return has(c.implementationProvider)
      case 'references':
        return has(c.referencesProvider)
      case 'documentSymbol':
        return has(c.documentSymbolProvider)
      case 'workspaceSymbol':
        return has(c.workspaceSymbolProvider)
      case 'callHierarchy':
        return has(c.callHierarchyProvider)
      case 'foldingRange':
        return has(c.foldingRangeProvider)
      case 'inlayHint':
        return has(c.inlayHintProvider)
      case 'semanticTokens':
        // Whole-file answers, read by a legend that can be read.
        return has(c.semanticTokensProvider?.full) && readLegend(c.semanticTokensProvider) !== null
      case 'rename':
        return has(c.renameProvider)
      case 'prepareRename':
        return typeof c.renameProvider === 'object' && c.renameProvider?.prepareProvider === true
      case 'codeAction':
        return has(c.codeActionProvider)
      case 'codeActionResolve':
        return typeof c.codeActionProvider === 'object' && c.codeActionProvider?.resolveProvider === true
      case 'formatting':
        return has(c.documentFormattingProvider)
      case 'rangeFormatting':
        return has(c.documentRangeFormattingProvider)
      case 'onTypeFormatting':
        return typeof c.documentOnTypeFormattingProvider === 'object' && c.documentOnTypeFormattingProvider !== null && typeof c.documentOnTypeFormattingProvider.firstTriggerCharacter === 'string'
      case 'pullDiagnostics':
        return has(c.diagnosticProvider)
    }
  }

  // ------------------------------------------------------------ documents

  document(file: string): OpenDocument | undefined {
    return this.docs.get(documentKey(file, this.platform))
  }

  documents(): OpenDocument[] {
    return [...this.docs.values()]
  }

  /** Opens a document, or brings an open one to `text`. Returns its version. */
  sync(file: string, languageId: string, text: string, options: { saved?: boolean } = {}): number {
    const key = documentKey(file, this.platform)
    const open = this.docs.get(key)
    if (!open) {
      const doc: OpenDocument = { file, uri: pathToUri(file, this.platform), languageId, version: 1, text }
      this.docs.set(key, doc)
      this.connection.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId, version: doc.version, text } })
      return doc.version
    }
    if (open.text !== text) {
      open.version++
      open.text = text
      // Sent whole: eNCode knows the text, not the keystrokes, and a whole text cannot drift from the server's copy.
      this.connection.notify('textDocument/didChange', { textDocument: { uri: open.uri, version: open.version }, contentChanges: [{ text }] })
    }
    if (options.saved && this.wantsSave()) {
      this.connection.notify('textDocument/didSave', { textDocument: { uri: open.uri }, ...(this.saveIncludesText() ? { text } : {}) })
    }
    return open.version
  }

  /** A change the editor made, as ranges of the document before it; sent as ranges when the server takes them. */
  edit(file: string, text: string, changes: readonly { range: Range; text: string }[]): number | undefined {
    const open = this.docs.get(documentKey(file, this.platform))
    if (!open) return undefined
    if (this.syncKind() !== TextDocumentSyncKind.Incremental || !changes.length) return this.sync(file, open.languageId, text)
    open.version++
    open.text = text
    this.connection.notify('textDocument/didChange', { textDocument: { uri: open.uri, version: open.version }, contentChanges: changes.map((change) => ({ range: change.range, text: change.text })) })
    return open.version
  }

  close(file: string): void {
    const key = documentKey(file, this.platform)
    const open = this.docs.get(key)
    if (!open) return
    this.docs.delete(key)
    this.published.delete(key)
    this.connection.notify('textDocument/didClose', { textDocument: { uri: open.uri } })
  }

  /** Files eNCode created, changed or deleted on disk, for a server that watches the project. */
  filesChanged(changes: readonly { file: string; kind: 'created' | 'changed' | 'deleted' }[]): void {
    if (!changes.length) return
    const type = { created: 1, changed: 2, deleted: 3 } as const
    this.connection.notify('workspace/didChangeWatchedFiles', { changes: changes.map((change) => ({ uri: pathToUri(change.file, this.platform), type: type[change.kind] })) })
  }

  private syncKind(): number {
    const sync = this.capabilitiesValue.textDocumentSync
    if (typeof sync === 'number') return sync
    return typeof sync?.change === 'number' ? sync.change : TextDocumentSyncKind.Full
  }

  private wantsSave(): boolean {
    const sync = this.capabilitiesValue.textDocumentSync
    return typeof sync === 'object' && sync !== null && Boolean(sync.save)
  }

  private saveIncludesText(): boolean {
    const sync = this.capabilitiesValue.textDocumentSync
    return typeof sync === 'object' && sync !== null && typeof sync.save === 'object' && sync.save !== null && sync.save.includeText === true
  }

  // ------------------------------------------------------------ diagnostics

  /** What the server last published for a document, or undefined when it has published nothing for it. */
  diagnosticsOf(file: string): { items: Diagnostic[]; version?: number } | undefined {
    const published = this.published.get(documentKey(file, this.platform))
    return published ? { items: published.items, ...(published.version !== undefined ? { version: published.version } : {}) } : undefined
  }

  /**
   * The diagnostics of an open document at its current version. A server that answers pull requests is asked;
   * otherwise this waits for the push that follows the last change, and a moment more for a second one (some servers
   * send their quick checks before their slow ones). `fresh` is false when the time ran out before the server spoke.
   */
  async diagnostics(file: string, options: { waitMs: number; signal?: AbortSignal; since?: number }): Promise<{ items: Diagnostic[]; fresh: boolean }> {
    const key = documentKey(file, this.platform)
    const doc = this.docs.get(key)
    if (!doc) return { items: [], fresh: false }
    if (this.supports('pullDiagnostics')) {
      try {
        const report = await this.connection.request<{ kind?: unknown; items?: unknown }>('textDocument/diagnostic', { textDocument: { uri: doc.uri } }, { timeoutMs: Math.max(options.waitMs, 1), ...(options.signal ? { signal: options.signal } : {}) })
        if (report && report.kind === 'full') {
          const items = readDiagnostics(report.items)
          this.publish(key, doc.file, items, doc.version)
          return { items, fresh: true }
        }
        const known = this.published.get(key)
        if (report && report.kind === 'unchanged' && known) return { items: known.items, fresh: true }
      } catch (error) {
        if (error instanceof RpcFailure && error.code === 'cancelled') throw error
        // A server that cannot answer a pull here may still push.
      }
    }
    const version = doc.version
    const since = options.since ?? -1
    const ready = (published: Published) => (published.version !== undefined ? published.version >= version : published.seq > since)
    const known = this.published.get(key)
    if (!(known && ready(known))) {
      const arrived = await this.waitFor(key, ready, options.waitMs, options.signal)
      if (!arrived) return { items: this.published.get(key)?.items ?? [], fresh: false }
    }
    // A second publish for the same text can follow the first closely.
    const seq = this.published.get(key)!.seq
    await this.waitFor(key, (published) => published.seq > seq, SETTLE_MS, options.signal)
    return { items: this.published.get(key)?.items ?? [], fresh: true }
  }

  /** How many times the server has published for the document; a wait started after a change counts from here. */
  publishCount(file: string): number {
    return this.published.get(documentKey(file, this.platform))?.seq ?? 0
  }

  private waitFor(key: string, check: (published: Published) => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (value: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const waiter: Waiter = { key, check, resolve: () => finish(true), cancel: () => finish(false) }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), Math.max(0, ms))
      if (signal?.aborted || this.exitReason) return finish(false)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(waiter)
    })
  }

  private publish(key: string, file: string, items: Diagnostic[], version: number | undefined): void {
    const before = this.published.get(key)
    const published: Published = { items, seq: (before?.seq ?? 0) + 1, ...(version !== undefined ? { version } : {}) }
    this.published.set(key, published)
    for (const waiter of [...this.waiters]) if (waiter.key === key && waiter.check(published)) waiter.resolve()
    this.options.onDiagnostics?.(file, items, version)
  }

  // ------------------------------------------------------------ requests

  request<T = unknown>(method: string, params: unknown, options?: RequestOptions): Promise<T> {
    if (this.exitReason) return Promise.reject(new RpcFailure(this.exitReason, 'closed'))
    return this.connection.request<T>(method, params, options)
  }

  /**
   * Runs a server command (a code action's), letting the server apply the edits it asks for through `apply` while it
   * runs, and only then.
   */
  async executeCommand(command: { command: string; arguments?: unknown[] }, apply: (edit: WorkspaceEdit) => Promise<{ applied: boolean; failureReason?: string }>, options?: RequestOptions): Promise<unknown> {
    if (this.applying) throw new Error(`${this.name} is already running a command.`)
    this.applying = apply
    try {
      return await this.request('workspace/executeCommand', { command: command.command, ...(command.arguments ? { arguments: command.arguments } : {}) }, options)
    } finally {
      this.applying = null
    }
  }

  /** Asks the server to stop, then makes sure it has. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    const proc = this.options.process
    if (!this.exitReason) {
      try {
        await this.connection.request('shutdown', null, { timeoutMs: 2_000 })
        this.connection.notify('exit')
      } catch {
        // A server that does not answer is ended below.
      }
    }
    const gone = await Promise.race([proc.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500))])
    if (!gone) proc.kill()
    this.connection.close('The language server was stopped.')
    this.failWaiters()
  }

  // ------------------------------------------------------------ what the server asks

  private async serverRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'workspace/configuration': {
        const items = params && typeof params === 'object' && Array.isArray((params as { items?: unknown }).items) ? ((params as { items: unknown[] }).items) : []
        return items.map((item) => {
          const section = item && typeof item === 'object' && typeof (item as { section?: unknown }).section === 'string' ? (item as { section: string }).section : ''
          return section ? (this.settingAt(section) ?? null) : (this.options.settings ?? null)
        })
      }
      case 'workspace/workspaceFolders': {
        const uri = pathToUri(this.root, this.platform)
        return [{ uri, name: this.root.split(/[\\/]/).filter(Boolean).pop() ?? this.root }]
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'workspace/diagnostic/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/codeLens/refresh':
        return null
      case 'window/showMessageRequest':
        // No one is there to choose: the server gets no choice.
        return null
      case 'window/showDocument':
        return { success: false }
      case 'workspace/applyEdit': {
        const edit = params && typeof params === 'object' ? readWorkspaceEdit((params as { edit?: unknown }).edit) : null
        if (!edit) return { applied: false, failureReason: 'The edit could not be read.' }
        if (!this.applying) return { applied: false, failureReason: 'eNCode applies an edit only for a command it asked to run.' }
        return this.applying(edit)
      }
      default:
        throw new RpcFailure(`eNCode does not handle ${method}.`, JSONRPC_ERRORS.methodNotFound)
    }
  }

  private settingAt(section: string): unknown {
    const settings = this.options.settings
    if (!settings) return undefined
    if (section in settings) return settings[section]
    let value: unknown = settings
    for (const part of section.split('.')) {
      if (!value || typeof value !== 'object' || !(part in (value as object))) return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }

  private serverNotification(method: string, params: unknown): void {
    const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        if (typeof record.uri !== 'string') return
        const file = uriToPath(record.uri, this.platform)
        if (!file) return
        const version = typeof record.version === 'number' && Number.isInteger(record.version) ? record.version : undefined
        this.publish(documentKey(file, this.platform), file, readDiagnostics(record.diagnostics), version)
        return
      }
      case 'window/logMessage':
      case 'window/showMessage':
        if (typeof record.message === 'string') this.log(record.message)
        return
      case '$/progress': {
        const token = typeof record.token === 'string' || typeof record.token === 'number' ? String(record.token) : null
        const value = record.value && typeof record.value === 'object' ? (record.value as { kind?: unknown }) : null
        if (!token || !value) return
        if (value.kind === 'begin') this.busy.add(token)
        else if (value.kind === 'end') this.busy.delete(token)
        return
      }
      default:
        return
    }
  }

  private log(line: string): void {
    this.logLines.push(line.slice(0, 500))
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES)
    this.options.onLog?.(line)
  }

  private lastLog(): string {
    return this.logLines.slice(-3).join(' ').slice(0, 600)
  }

  private describeExit({ code, signal }: { code: number | null; signal: string | null }): string {
    return `${this.name} exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ''}.`
  }

  private ended(reason: string, fromExit = false): void {
    if (this.exitReason) return
    this.exitReason = this.stopping ? 'The language server was stopped.' : reason
    this.connection.close(this.exitReason)
    this.failWaiters()
    if (this.stopping) return
    const report = (why: string) => {
      const said = this.lastLog()
      this.options.onExit?.(`${why}${said ? ` It said: ${said}` : ''}`)
    }
    if (fromExit) return report(reason)
    // The output closes a moment before the process is gone, and its exit code and last words say more.
    void Promise.race([this.options.process.exited.then((exit) => this.describeExit(exit)), new Promise<null>((resolve) => setTimeout(() => resolve(null), 500).unref?.())]).then((exit) => {
      if (exit) this.exitReason = exit
      report(exit ?? reason)
    })
  }

  private failWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.cancel()
  }
}
