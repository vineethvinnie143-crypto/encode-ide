import { stat } from 'node:fs/promises'
import path from 'node:path'
import { checkpointDir, CheckpointService, nodeCheckpointFs, pruneStore, type CheckpointFs } from '@encode/checkpoints'
import { workspaceKey } from '@encode/config'
import { combineHooks, type SessionScope } from '@encode/core'
import type { HookRunner } from '@encode/hooks'
import { resolveSandboxSettings, type Sandbox } from '@encode/sandbox'
import { detectLanguages, EditRefused, installedNatives, type CodeLocation, type EditorCallItem, type EditPlan, type FolderLanguages, type InstallPlan, type LanguageServers } from '@encode/lsp'
import { CodeIndex, detectShell, realPathOf, type ShellProgram } from '@encode/tools'
import {
  folderLanguageServers,
  languageServersReport,
  type EditorAnswer,
  type EditorAsk,
  type EditorAsks,
  type EditorCallEntry,
  type EditorCallFunction,
  type EditorChangeRequest,
  type EditorChangeResult,
  type EditorDocumentChange,
  type EditorLocation,
  type EditorSymbolMatch,
  type LanguageServerOptions,
  type LanguageServersReport,
  withPreviews,
} from './code'
import { actOn, type PermissionsAction, type PermissionsOutcome } from './actions'
import { FolderDebugger, type DebugOptions } from './debug'
import { applyEditorPlan, ChangeRefused, previewPlan, undoEditorChange, type AppliedChange, type AppliedRecord, type ChangeContext } from './editor-changes'
import { WorkspaceConfig, type ConfigSnapshot } from './config'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { workspaceHooks } from './hooks'
import { ServerInstalls, type InstallResult } from './installs'
import { McpHub, type McpHubOptions, type McpReport } from './mcp'
import { actOnMcp, type McpAction, type McpOutcome } from './mcp-actions'
import { rememberRules } from './remember'
import { reportOn, type WorkspaceReport } from './report'
import { recordingHooks, sessionCheckpoints } from './rewind'
import { actOnSandbox, type SandboxAction, type SandboxOutcome } from './sandbox-actions'
import { sandboxReport, withMarks, type SandboxReport } from './sandbox-report'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long a change of the editor's can be taken back, and a preview of one applied. */
const UNDO_MS = 10 * 60_000
const PREVIEW_MS = 10 * 60_000
/** How long opening a session waits for the sandbox to find out whether this machine has one (the first run on Windows builds its helper). */
const SANDBOX_WAIT_MS = 15_000

/** A file's path in a folder, '/'-separated, or null when it is the folder itself or outside it. */
function inFolder(root: string, file: string): string | null {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/** A function of a call hierarchy for the editor, with its place as a list shows it. */
function callFunction(item: EditorCallItem, at: EditorLocation): EditorCallFunction {
  return { id: item.id, name: item.name, kind: item.kind, ...(item.detail ? { detail: item.detail } : {}), at }
}

/** A change of the editor's, planned and not applied yet: the server's edit, and the command that runs after it, if any. */
interface PendingChange {
  id: number
  title: string
  plan?: EditPlan
  command?: { file: string; list: number; id: number }
  at: number
}

export interface CheckpointStoreOptions {
  /** The store's base folder; a folder for each workspace is made under it. */
  dir: string
  fs?: CheckpointFs
  /** Sessions nobody has touched for this long are forgotten when the store is tidied. Default 30 days. */
  maxAgeMs?: number
  /** The largest file a rewind can bring back. Default 20 MB. */
  maxFileBytes?: number
}

export interface WorkspacesOptions {
  home: string
  platform?: NodeJS.Platform
  fs?: WorkspaceFs
  /** Default `<home>/.encode/trust.json`. */
  trustFile?: string
  /** Trouble a session should not have to hear about, such as a settings file that cannot be read. */
  warn?(message: string): void
  /** Keeps what the agent's file tools change, so that it can be put back. Without it nothing is kept and rewinding is not offered. */
  checkpoints?: CheckpointStoreOptions
  /** Runs hook command lines. Default: the shell the agent's own commands use. */
  hookRunner?: HookRunner
  /** What hooks start from, before secrets are taken out. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** The conversation's file for a session, for the `transcript_path` that hooks are given. */
  transcriptPath?(sessionId: string): string | undefined
  /** What a folder's MCP servers do that a screen shows (their state, their tools, their setup), as the folder's real path. Called after a short pause, never in a burst. */
  onMcpChange?(root: string): void
  /** For tests: how MCP servers are reached, and how long things are waited for. */
  mcp?: Pick<McpHubOptions, 'manager' | 'startWaitMs' | 'idleMs'>
  /** The operating-system sandbox for the agent's commands; one for the whole program. Without it commands run as the user does. */
  sandbox?: Sandbox
  /** The folders' language servers, for the agent and the editor. Without it no server is started. */
  languageServers?: LanguageServerOptions
  /** The folders' debuggers (ADR 0143). Without it nothing is debugged. */
  debug?: DebugOptions
}

/**
 * The folders sessions work in, each with its settings picture, and the scope the agent core asks for when it opens
 * a session. One object for a whole program: the desktop's agent host and the command line each make one.
 */
export class Workspaces {
  readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly fs: WorkspaceFs
  private readonly trustFile: string | undefined
  private readonly warn: ((message: string) => void) | undefined
  private readonly configs = new Map<string, WorkspaceConfig>()
  /** A folder's MCP servers, shared by every session in it. Made on first use, let go of when nobody works in the folder. */
  private readonly hubs = new Map<string, McpHub>()
  /** A folder's language servers, shared by its sessions and the editor; each server in it stops when unused. */
  private readonly code = new Map<string, LanguageServers>()
  /** A folder's debugger: its breakpoints and its runs. */
  private readonly debuggers = new Map<string, FolderDebugger>()
  private readonly indexes = new Map<string, CodeIndex>()
  /** Servers eNCode installs when asked, for every folder; none without a tools folder. */
  readonly installs: ServerInstalls | undefined
  /** The languages each folder uses, read again after a minute. */
  private readonly languages = new Map<string, { at: number; stamp: number; found: Promise<FolderLanguages> }>()
  /** The editor's changes and questions, by the folder path it gives. */
  private readonly lanes = new Map<string, { pending: Promise<void>; asking: Map<string, AbortController> }>()
  private readonly realRoots = new Map<string, string>()
  /** The editor's changes by folder: one shown for review, and the last one applied while it can be taken back. */
  private readonly changes = new Map<string, { preview: PendingChange | null; applied: { id: number; record: AppliedRecord; at: number } | null }>()
  private changeIds = 0
  private readonly stores: CheckpointStoreOptions | undefined
  /** The stores already tidied by this program, so that opening a second session in a folder does not do it again. */
  private readonly tidied = new Set<string>()

  private readonly options: WorkspacesOptions

  constructor(options: WorkspacesOptions) {
    this.home = options.home
    this.platform = options.platform ?? process.platform
    this.fs = options.fs ?? nodeWorkspaceFs
    this.trustFile = options.trustFile
    this.warn = options.warn
    this.stores = options.checkpoints
    this.options = options
    const servers = options.languageServers
    this.installs = servers?.tools
      ? new ServerInstalls({
          tools: servers.tools,
          platform: this.platform,
          ...(servers.catalog ? { catalog: servers.catalog } : {}),
          ...(servers.libraries ? { libraries: servers.libraries } : {}),
          ...(servers.env ? { env: servers.env } : {}),
          rediscover: async (id, how) => {
            await Promise.all([...this.code.values()].map((hub) => hub.rediscover(id, how).catch(() => undefined)))
          },
          onChange: () => {
            for (const [, hub] of this.code) servers.onChange?.(hub.root)
          },
        })
      : undefined
  }

  /** The picture of a folder, given as a real path; the same object for every session in it. */
  config(root: string): WorkspaceConfig {
    const key = workspaceKey(root, this.platform === 'win32')
    let config = this.configs.get(key)
    if (!config) {
      config = new WorkspaceConfig({
        root: (this.platform === 'win32' ? path.win32 : path.posix).normalize(root),
        home: this.home,
        platform: this.platform,
        fs: this.fs,
        ...(this.trustFile ? { trustFile: this.trustFile } : {}),
      })
      this.configs.set(key, config)
    }
    return config
  }

  private hub(config: WorkspaceConfig): McpHub {
    const key = workspaceKey(config.root, this.platform === 'win32')
    let hub = this.hubs.get(key)
    if (!hub) {
      const made: McpHub = new McpHub({
        config,
        platform: this.platform,
        env: this.options.env ?? process.env,
        ...(this.warn ? { warn: this.warn } : {}),
        ...(this.options.onMcpChange ? { onChange: () => this.options.onMcpChange?.(config.root) } : {}),
        onIdle: () => {
          if (this.hubs.get(key) === made) this.hubs.delete(key)
          void made.close()
        },
        ...this.options.mcp,
      })
      this.hubs.set(key, made)
      hub = made
    }
    return hub
  }

  /** The language servers of a folder, given as a real path, or undefined when the program starts none. */
  languageServers(root: string): LanguageServers | undefined {
    const options = this.options.languageServers
    if (!options) return undefined
    const config = this.config(root)
    const key = workspaceKey(config.root, this.platform === 'win32')
    let servers = this.code.get(key)
    if (!servers) {
      servers = folderLanguageServers(config, this.platform, options)
      this.code.set(key, servers)
    }
    return servers
  }

  /** The debugger of a folder, given as any path to it, or undefined when the program debugs nothing. */
  async folderDebugger(root: string): Promise<FolderDebugger | undefined> {
    const options = this.options.debug
    if (!options) return undefined
    let real = this.realRoots.get(root)
    if (!real) {
      real = await realPathOf(root)
      this.realRoots.set(root, real)
    }
    return this.debuggerFor(this.config(real))
  }

  /** The debugger of a folder whose settings are open; one per folder, shared by the window and its sessions' agents. */
  private debuggerFor(config: WorkspaceConfig): FolderDebugger | undefined {
    const options = this.options.debug
    if (!options) return undefined
    const key = workspaceKey(config.root, this.platform === 'win32')
    let found = this.debuggers.get(key)
    if (!found) {
      found = new FolderDebugger(config, this.fs, options, this.platform)
      this.debuggers.set(key, found)
    }
    return found
  }

  /** The code index of a folder, given as a real path (ADR 0090): one per folder, shared by its sessions. */
  codeIndex(root: string): CodeIndex {
    const config = this.config(root)
    const key = workspaceKey(config.root, this.platform === 'win32')
    let index = this.indexes.get(key)
    if (!index) {
      index = new CodeIndex({ root: config.root, caseInsensitive: this.platform === 'win32' || this.platform === 'darwin' })
      this.indexes.set(key, index)
    }
    return index
  }

  /**
   * Stops the servers that may no longer run, in every folder (the setting went off, a folder lost its trust), and
   * starts the ones the editor needs where they may run again.
   */
  async syncLanguageServers(): Promise<void> {
    await Promise.all([...this.code.values()].map((servers) => servers.sync().catch(() => undefined)))
  }

  /**
   * How a folder's language servers stand, for the Settings screen. The folder may be given as any path to it. With
   * `logs`, the last lines of each server that stopped or failed, for a bug report.
   */
  async languageServersReport(root: string, options: { logs?: number } = {}): Promise<LanguageServersReport & { logs?: Record<string, string[]> }> {
    const settings = this.options.languageServers
    if (!settings) return { state: 'off', reason: 'This program starts no language servers.', servers: [] }
    const config = this.config(await realPathOf(root))
    const snapshot = await config.refresh()
    const languages = await this.folderLanguages(config.root)
    const installs = this.installs
    return languageServersReport(this.languageServers(config.root)!, settings, snapshot.folder.trusted, options.logs ?? 0, { languages, ...(installs ? { installs: (id: string) => installs.state(id) } : {}) })
  }

  /**
   * The languages a folder uses, by its files: read once a minute at most, or again at once when a file was added to
   * or removed from the folder's top (a new package.json or fxmanifest.lua), which changes its time.
   */
  private async folderLanguages(root: string): Promise<FolderLanguages> {
    const key = workspaceKey(root, this.platform === 'win32')
    const stamp = await stat(root).then((stats) => stats.mtimeMs).catch(() => 0)
    const known = this.languages.get(key)
    if (known && known.stamp === stamp && Date.now() - known.at < 60_000) return known.found
    const found = detectLanguages(root, this.options.languageServers?.catalog ? { catalog: this.options.languageServers.catalog } : {}).catch(() => ({ used: [], partial: true }))
    this.languages.set(key, { at: Date.now(), stamp, found })
    return found
  }

  /** What installing a server would do, for the person to read before saying yes. */
  async planServerInstall(root: string, id: string): Promise<InstallPlan | { unavailable: string }> {
    if (!this.installs) return { unavailable: 'This program does not install language servers.' }
    return this.installs.plan(id, await realPathOf(root))
  }

  /** Installs a server the person said yes to; the folders' editors get it at once. */
  async installServer(root: string, id: string): Promise<InstallResult> {
    if (!this.installs) return { ok: false, reason: 'This program does not install language servers.' }
    return this.installs.install(id, await realPathOf(root))
  }

  /** Removes a server eNCode installed. */
  async removeServer(id: string): Promise<InstallResult> {
    if (!this.installs) return { ok: false, reason: 'This program does not install language servers.' }
    return this.installs.remove(id)
  }

  /**
   * The editor opened, changed or closed a file of a folder (given as any path to it). A path that leaves the folder
   * is ignored: the editor shows only the folder's own files. Changes are applied in the order they came, and a
   * question the editor asks after one waits for it (`editorAsk`).
   */
  editorDocument(root: string, change: EditorDocumentChange): Promise<void> {
    if (!this.options.languageServers) return Promise.resolve()
    const lane = this.editorLane(root)
    lane.pending = lane.pending.then(async () => {
      const at = await this.editorFile(root, change.path)
      if (!at) return
      if (change.kind === 'close') at.servers.editorClose(at.file)
      else if (change.kind === 'open') at.servers.editorOpen(at.file, change.text, change.dirty)
      else at.servers.editorChange(at.file, change.text, change.dirty)
    }).catch((error: unknown) => this.warn?.(`The language servers could not follow the editor: ${error instanceof Error ? error.message : String(error)}`))
    return lane.pending
  }

  /**
   * A question of the editor's to the servers of a file it shows, for its text as it is now: it waits for the changes
   * the editor sent before it. A newer question of the same kind cancels an older one still waiting for its answer.
   */
  async editorAsk<K extends keyof EditorAsks>(root: string, ask: { kind: K } & EditorAsks[K]['params']): Promise<EditorAnswer<K>> {
    const empty = (ask.kind === 'highlights' ? [] : null) as EditorAnswer<K>
    if (!this.options.languageServers) return empty
    const lane = this.editorLane(root)
    await lane.pending
    // A search across the folder may come with no file shown.
    const at = await this.editorFile(root, ask.kind === 'workspaceSymbols' && !ask.path ? '' : ask.path, ask.kind === 'workspaceSymbols')
    if (!at) return empty
    const { servers, file, root: real } = at
    // The lightbulb's own question does not cancel the person's, nor theirs the lightbulb's; each level of a call
    // hierarchy opened is a question of its own.
    const slot = ask.kind === 'resolve' || ask.kind === 'triggers' || ask.kind === 'calls' ? null : ask.kind === 'codeActions' && (ask as EditorAsks['codeActions']['params']).automatic ? 'codeActions:automatic' : ask.kind
    const controller = new AbortController()
    if (slot) {
      lane.asking.get(slot)?.abort()
      lane.asking.set(slot, controller)
    }
    const signal = controller.signal
    const a = ask as EditorAsk
    const where = async (items: CodeLocation[] | null): Promise<EditorLocation[] | null> => items && withPreviews(items.map((item) => ({ path: inFolder(real, item.file), ...item })))
    try {
      switch (a.kind) {
        case 'complete':
          return (await servers.completion(file, a.line, a.character, { triggerKind: a.triggerKind, ...(a.triggerCharacter ? { triggerCharacter: a.triggerCharacter } : {}) }, signal)) as EditorAnswer<K>
        case 'resolve':
          return (await servers.resolveCompletion(file, a.list, a.id)) as EditorAnswer<K>
        case 'signature':
          return (await servers.signatureHelp(file, a.line, a.character, { triggerKind: a.triggerKind, isRetrigger: a.isRetrigger, ...(a.triggerCharacter ? { triggerCharacter: a.triggerCharacter } : {}), ...(a.active ? { activeSignatureHelp: a.active } : {}) }, signal)) as EditorAnswer<K>
        case 'hover':
          return (await servers.editorHover(file, a.line, a.character, signal)) as EditorAnswer<K>
        case 'highlights':
          return (await servers.highlights(file, a.line, a.character, signal)) as EditorAnswer<K>
        case 'definition':
        case 'typeDefinition':
        case 'implementation':
        case 'references':
          return (await where(await servers.editorLocations(a.kind, file, a.line, a.character, signal))) as EditorAnswer<K>
        case 'triggers':
          return servers.editorTriggers(file) as EditorAnswer<K>
        case 'prepareRename':
          return (await servers.editorPrepareRename(file, a.line, a.character, signal)) as EditorAnswer<K>
        case 'codeActions':
          return (await servers.editorCodeActions(file, a.range, { ...(a.only ? { only: a.only } : {}), automatic: a.automatic }, signal)) as EditorAnswer<K>
        case 'format':
          return (await servers.format(file, { tabSize: a.tabSize, insertSpaces: a.insertSpaces }, a.range, signal)) as EditorAnswer<K>
        case 'formatOnType':
          return (await servers.formatOnType(file, a.line, a.character, a.ch, { tabSize: a.tabSize, insertSpaces: a.insertSpaces }, signal)) as EditorAnswer<K>
        case 'symbols':
          return (await servers.editorSymbols(file, signal)) as EditorAnswer<K>
        case 'folding':
          return (await servers.editorFoldingRanges(file, signal)) as EditorAnswer<K>
        case 'inlayHints':
          return (await servers.editorInlayHints(file, a.startLine, a.endLine, signal)) as EditorAnswer<K>
        case 'semanticTokens':
          return (await servers.editorSemanticTokens(file, signal)) as EditorAnswer<K>
        case 'workspaceSymbols': {
          const hits = await servers.editorWorkspaceSymbols(a.query, a.path ? file : undefined, signal)
          if (!hits) return null as EditorAnswer<K>
          // Only the folder's own files: the editor shows nothing else.
          const matches: EditorSymbolMatch[] = []
          for (const hit of hits) {
            const inside = inFolder(real, hit.file)
            if (inside !== null) matches.push({ name: hit.name, kind: hit.kind, ...(hit.container ? { container: hit.container } : {}), path: inside, range: hit.range })
          }
          return matches as EditorAnswer<K>
        }
        case 'callHierarchy': {
          const prepared = await servers.editorPrepareCalls(file, a.line, a.character, signal)
          if (!prepared) return null as EditorAnswer<K>
          const places = await where(prepared.items.map((item) => ({ file: item.file, line: item.range.start.line, character: item.range.start.character, endLine: item.range.end.line, endCharacter: item.range.end.character })))
          return { list: prepared.list, items: prepared.items.map((item, index) => callFunction(item, places![index])) } as EditorAnswer<K>
        }
        case 'calls': {
          const answer = await servers.editorCalls(a.list, a.id, a.direction, signal)
          if ('reason' in answer) return answer as EditorAnswer<K>
          const own = await where(answer.calls.map(({ item }) => ({ file: item.file, line: item.range.start.line, character: item.range.start.character, endLine: item.range.end.line, endCharacter: item.range.end.character })))
          const sites = await where(answer.calls.flatMap((call) => call.sites.map((site) => ({ file: call.file, line: site.start.line, character: site.start.character, endLine: site.end.line, endCharacter: site.end.character }))))
          let next = 0
          const calls: EditorCallEntry[] = answer.calls.map((call, index) => ({ item: callFunction(call.item, own![index]), sites: sites!.slice(next, (next += call.sites.length)) }))
          return { calls } as EditorAnswer<K>
        }
        default:
          return empty
      }
    } catch {
      return empty
    } finally {
      if (slot && lane.asking.get(slot) === controller) lane.asking.delete(slot)
    }
  }

  /**
   * A change of the editor's through a folder's servers: a rename or a code action, applied at once or shown first; a
   * preview applied or let go; an applied change taken back. It waits for the editor's earlier changes, and the editor's
   * later ones wait for it, so the servers' plan is for the text the person sees.
   */
  editorChange(root: string, request: EditorChangeRequest): Promise<EditorChangeResult> {
    if (!this.options.languageServers) return Promise.resolve({ ok: false, reason: 'This program starts no language servers.' })
    const lane = this.editorLane(root)
    const run = lane.pending.then(() => this.runEditorChange(root, request))
    lane.pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run.catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
  }

  private async runEditorChange(root: string, request: EditorChangeRequest): Promise<EditorChangeResult> {
    let real = this.realRoots.get(root)
    if (!real) {
      real = await realPathOf(root)
      this.realRoots.set(root, real)
    }
    const config = this.config(real)
    const servers = this.languageServers(config.root)!
    const key = workspaceKey(config.root, this.platform === 'win32')
    let state = this.changes.get(key)
    if (!state) {
      state = { preview: null, applied: null }
      this.changes.set(key, state)
    }
    const folder = config.root
    const relative = (file: string) => inFolder(folder, file) ?? file
    const resolve = (rel: string) => {
      const file = path.resolve(folder, rel)
      return inFolder(folder, file) === null ? null : file
    }
    const context = (open: readonly string[]): ChangeContext => ({ root: folder, servers, open: open.map(resolve).filter((file): file is string => file !== null), platform: this.platform })

    if (request.kind === 'discard') {
      if (state.preview?.id === request.id) state.preview = null
      return { ok: true, done: 'discarded' }
    }
    if (request.kind === 'undo') {
      const applied = state.applied
      if (!applied || applied.id !== request.id || Date.now() - applied.at > UNDO_MS) return { ok: false, reason: 'That change can no longer be taken back as a whole. Use Undo in each file instead.' }
      try {
        const undone = await undoEditorChange(applied.record, context(request.open))
        state.applied = null
        return { ok: true, done: 'undone', id: applied.id, editor: undone.editor.map((item) => ({ path: relative(item.file), written: item.written })), written: undone.written.map(relative), created: undone.created.map(relative), deleted: undone.deleted.map(relative) }
      } catch (error) {
        if (error instanceof ChangeRefused) return { ok: false, reason: error.message }
        throw error
      }
    }
    if (request.kind === 'apply') {
      const pending = state.preview
      if (!pending || pending.id !== request.id || Date.now() - pending.at > PREVIEW_MS) return { ok: false, reason: 'That preview is out of date. Make the change again.' }
      state.preview = null
      return this.applyEditorChange(pending, servers, context(request.open), state, relative)
    }

    const file = resolve(request.path)
    if (!file) return { ok: false, reason: 'That file is not in the open folder.' }
    let pending: PendingChange
    if (request.kind === 'rename') {
      try {
        const plan = await servers.rename(file, request.line, request.character, request.newName)
        if (!plan.changes.length) return { ok: false, reason: 'The language server found nothing to rename.' }
        pending = { id: ++this.changeIds, title: `Rename to ${request.newName}`, plan, at: Date.now() }
      } catch (error) {
        // The server's own words: the error's message is written for the agent.
        if (error instanceof EditRefused) return { ok: false, reason: error.reason }
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    } else {
      const decided = await servers.editorAction(file, request.list, request.id)
      if ('reason' in decided) return { ok: false, reason: decided.reason }
      pending = { id: ++this.changeIds, title: decided.title, ...(decided.plan ? { plan: decided.plan } : {}), ...(decided.command ? { command: { file, list: request.list, id: request.id } } : {}), at: Date.now() }
    }
    if (request.preview && pending.plan) {
      state.preview = pending
      const files = previewPlan(pending.plan, { root: folder, servers })
      return { ok: true, done: 'preview', id: pending.id, title: pending.title, files }
    }
    return this.applyEditorChange(pending, servers, context(request.open), state, relative)
  }

  /** Applies a planned change: its edit, then the command that goes with it, whose edits are applied as the server sends them. */
  private async applyEditorChange(
    pending: PendingChange,
    servers: LanguageServers,
    ctx: ChangeContext,
    state: { applied: { id: number; record: AppliedRecord; at: number } | null },
    relative: (file: string) => string,
  ): Promise<EditorChangeResult> {
    const done: AppliedChange = { editor: [], written: [], created: [], moved: [], deleted: [], places: 0, record: { disk: [], editor: [] } }
    const add = (applied: AppliedChange) => {
      done.editor.push(...applied.editor)
      done.written.push(...applied.written)
      done.created.push(...applied.created)
      done.moved.push(...applied.moved)
      done.deleted.push(...applied.deleted)
      done.places += applied.places
      done.record.disk.push(...applied.record.disk)
      done.record.editor.push(...applied.record.editor)
    }
    const notes: string[] = []
    if (pending.plan) {
      try {
        add(await applyEditorPlan(pending.plan, ctx))
      } catch (error) {
        if (error instanceof ChangeRefused) return { ok: false, reason: error.message }
        throw error
      }
    }
    if (pending.command) {
      const { file, list, id } = pending.command
      const ran = await servers.editorRunCommand(file, list, id, async (plan) => {
        try {
          add(await applyEditorPlan(plan, ctx))
          return { applied: true }
        } catch (error) {
          return { applied: false, failureReason: error instanceof Error ? error.message : String(error) }
        }
      })
      if ('reason' in ran) {
        if (!pending.plan) return { ok: false, reason: ran.reason }
        notes.push(ran.reason)
      } else {
        notes.push(...ran.refused)
        if (!pending.plan && !ran.applied && ran.refused.length) return { ok: false, reason: `Nothing was changed: ${ran.refused.join(' ')}` }
      }
    }
    const touched = new Set([...done.editor.map((item) => item.file), ...done.written, ...done.created, ...done.deleted, ...done.moved.flatMap((item) => [item.from, item.to])])
    const undo = done.record.disk.length > 0 || done.record.editor.length > 0
    if (undo) state.applied = { id: pending.id, record: done.record, at: Date.now() }
    return {
      ok: true,
      done: 'applied',
      id: pending.id,
      title: pending.title,
      editor: done.editor.map((item) => ({ path: relative(item.file), edits: item.edits, written: item.written })),
      written: [...new Set(done.written)].map(relative),
      created: done.created.map(relative),
      moved: done.moved.map((item) => ({ from: relative(item.from), to: relative(item.to) })),
      deleted: done.deleted.map(relative),
      places: done.places,
      files: touched.size,
      undo,
      notes,
    }
  }

  /** The order the editor's changes of a folder are applied in, and the questions it waits on, by the path it gave. */
  private editorLane(root: string): { pending: Promise<void>; asking: Map<string, AbortController> } {
    let lane = this.lanes.get(root)
    if (!lane) {
      lane = { pending: Promise.resolve(), asking: new Map() }
      this.lanes.set(root, lane)
    }
    return lane
  }

  /** The file a path of the editor's names in the real folder, with the folder's servers, or null outside the folder. */
  /** A file of a folder the editor named, with the folder's servers; `orRoot` takes '' as the folder itself. */
  private async editorFile(root: string, relativePath: string, orRoot = false): Promise<{ servers: LanguageServers; file: string; root: string } | null> {
    let real = this.realRoots.get(root)
    if (!real) {
      real = await realPathOf(root)
      this.realRoots.set(root, real)
    }
    const config = this.config(real)
    const file = path.resolve(config.root, relativePath)
    if (inFolder(config.root, file) === null && !(orRoot && relativePath === '')) return null
    return { servers: this.languageServers(config.root)!, file, root: config.root }
  }

  /**
   * The folder's MCP servers as the Settings screen shows them. The folder may be given as any path to it. With
   * `start: false` no server is started for the sake of looking (the banner above the composer does that).
   */
  async mcpReport(root: string, options: { start?: boolean } = {}): Promise<McpReport> {
    const config = this.config(await realPathOf(root))
    return this.hub(config).report(await config.refresh(), options)
  }

  /** Does what the MCP screen asked in a folder, and returns how its servers stand afterwards. */
  async mcpAct(root: string, action: McpAction): Promise<McpOutcome> {
    const config = this.config(await realPathOf(root))
    return actOnMcp(config, this.hub(config), action, { fs: this.fs, platform: this.platform })
  }

  /** The sandbox around the agent's commands as it stands in a folder, for the Sandbox screen. The folder may be given as any path to it. */
  async sandboxReport(root: string): Promise<SandboxReport> {
    const config = this.config(await realPathOf(root))
    const snapshot = await config.refresh()
    return withMarks(sandboxReport(this.options.sandbox, snapshot, this.home, this.platform, this.shellFor(snapshot)), this.options.sandbox)
  }

  /** The shell the agent's commands run in for a folder's settings (PowerShell when they ask for it on Windows). */
  private shellFor(snapshot: ConfigSnapshot): ShellProgram | undefined {
    return detectShell(this.options.env ?? process.env, this.platform, this.prefersPowerShell(snapshot.effective.sandbox) ? 'pwsh' : undefined)
  }

  /**
   * PowerShell, so that the sandbox can confine the commands: the default wherever there is a sandbox and it is on,
   * unless the person turned it off. Only Windows has a choice to make; elsewhere shell detection ignores it.
   */
  private prefersPowerShell(sources: ConfigSnapshot['effective']['sandbox']): boolean {
    if (!this.options.sandbox) return false
    const settings = resolveSandboxSettings(sources)
    return settings.enabled && settings.powershell
  }

  /** Does what the Sandbox screen asked, and returns how the sandbox stands afterwards. */
  async sandboxAct(root: string, action: SandboxAction): Promise<SandboxOutcome> {
    const config = this.config(await realPathOf(root))
    return actOnSandbox(config, this.options.sandbox, action, { fs: this.fs, platform: this.platform, shell: (snapshot) => this.shellFor(snapshot) })
  }

  /** Calls back when the sandbox's state changes (it was checked, or a folder is being prepared). Returns the way to stop. */
  onSandboxChange(listener: () => void): () => void {
    return this.options.sandbox?.onChange(listener) ?? (() => undefined)
  }

  /** Stops every folder's MCP servers. Quick enough for a program that is closing. */
  async close(): Promise<void> {
    const hubs = [...this.hubs.values()]
    const code = [...this.code.values()]
    const debuggers = [...this.debuggers.values()]
    this.hubs.clear()
    this.code.clear()
    this.debuggers.clear()
    this.indexes.clear()
    await Promise.all([...hubs.map((hub) => hub.close().catch(() => undefined)), ...code.map((servers) => servers.dispose().catch(() => undefined)), ...debuggers.map((folder) => folder.close().catch(() => undefined))])
  }

  /** The folder's permissions as the Permissions screen shows them. The folder may be given as any path to it. */
  async report(root: string): Promise<WorkspaceReport> {
    return reportOn(this.config(await realPathOf(root)), this.platform)
  }

  /** Does what the Permissions screen asked in a folder, and returns how the folder stands afterwards. */
  async act(root: string, action: PermissionsAction): Promise<PermissionsOutcome> {
    const config = this.config(await realPathOf(root))
    const outcome = await actOn(config, action, { fs: this.fs, platform: this.platform })
    // Trusting a folder, or approving its settings, decides which of its MCP servers may run, and whether its language servers may.
    await this.hubs.get(workspaceKey(config.root, this.platform === 'win32'))?.follow(config)
    await this.code.get(workspaceKey(config.root, this.platform === 'win32'))?.sync()
    return outcome
  }

  /** The record of what a session's file tools change: the hooks that keep it, the seam the tools call, and the means to put it back. */
  private recorder(request: { sessionId: string; root: string; notice(text: string): void }, config: WorkspaceConfig) {
    const stores = this.stores
    if (!stores) return undefined
    const fs = stores.fs ?? nodeCheckpointFs()
    const dir = checkpointDir(stores.dir, request.root, this.platform)
    if (!this.tidied.has(dir)) {
      this.tidied.add(dir)
      pruneStore(fs, dir, { maxAgeMs: stores.maxAgeMs ?? 30 * DAY_MS, platform: this.platform }).catch((error: unknown) => {
        this.warn?.(`Could not tidy the record of file changes of ${request.root}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const service = new CheckpointService({
      fs,
      dir,
      // The folder, and the extra folders the settings name as it stands when a file is written.
      roots: () => [request.root, ...config.current().extraRoots],
      sessionId: request.sessionId,
      platform: this.platform,
      ...(stores.maxFileBytes ? { maxFileBytes: stores.maxFileBytes } : {}),
      notice: request.notice,
    })
    return {
      hooks: recordingHooks(service, request.notice),
      checkpoints: sessionCheckpoints(service, { root: request.root, platform: this.platform }),
      // A write is stopped when its earlier version cannot be kept: a change that cannot be taken back is not made.
      beforeWrite: async (file: string, previous: Buffer | null, info: { turnId: string; toolUseId: string }) => {
        try {
          await service.beforeWrite(file, previous, info)
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          throw new Error(`eNCode could not keep the earlier version of ${path.basename(file)} so that it can be put back (${why}), so the file was not changed.`)
        }
      },
    }
  }

  /** What the host's `scope` option is given. The folder's settings are read before the session opens. */
  readonly scope = async (request: { sessionId: string; root: string; scratch?: string; notice(text: string): void }): Promise<SessionScope> => {
    const config = this.config(request.root)
    const hub = this.hub(config)
    // Taken before anything is awaited, so that the hub cannot be let go of between getting it and holding it.
    const release = hub.acquire()
    try {
      hub.sync(await config.refresh())
      await this.sandboxChecked()
      return this.scopeOf(request, config, hub, release)
    } catch (error) {
      release()
      throw error
    }
  }

  /** A session's tools are built once the sandbox has said whether it works here, so that Bash is told what its commands run in. Never fails a session. */
  private async sandboxChecked(): Promise<void> {
    const sandbox = this.options.sandbox
    if (!sandbox) return
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        sandbox.start().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SANDBOX_WAIT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private scopeOf(request: { sessionId: string; root: string; scratch?: string; notice(text: string): void }, config: WorkspaceConfig, hub: McpHub, release: () => void): SessionScope {
    const recording = this.recorder(request, config)
    const { env, hookRunner, transcriptPath } = this.options
    // The folder and the extra folders its settings name are where commands may write; its settings may tighten the rest.
    const sandbox = this.options.sandbox?.session({
      roots: () => [request.root, ...config.current().extraRoots],
      settings: () => resolveSandboxSettings(config.current().effective.sandbox),
    })
    sandbox?.warm()
    const code = this.languageServers(config.root)
    // The agent's Debug tool (ADR 0145): its runs end with the session, and its probes run from its scratch folder (ADR 0149).
    const debug = this.debuggerFor(config)?.forAgent(request.sessionId, request.scratch)
    return {
      // What keeps the record comes first: a hook that stops a result must not leave the record out of date.
      hooks: combineHooks(
        recording?.hooks,
        workspaceHooks(config, {
          platform: this.platform,
          notice: request.notice,
          ...(hookRunner ? { runner: hookRunner } : {}),
          ...(env ? { baseEnv: env } : {}),
          ...(transcriptPath ? { transcriptPath } : {}),
        }),
      ),
      assessor: config.assessor,
      rules: config.rules,
      extraRoots: () => config.current().extraRoots,
      // A picture that cannot be rebuilt refuses everything until it can (see WorkspaceConfig.refresh); this only reports why.
      // The folder's MCP servers follow the same picture.
      refresh: async () => {
        try {
          hub.sync(await config.refresh())
          await code?.sync()
        } catch (error) {
          this.warn?.(`Could not reload the settings of ${request.root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      remember: rememberRules(config, this.fs, this.platform),
      shell: () => ({
        extraEnv: config.current().effective.env,
        ...(this.prefersPowerShell(config.current().effective.sandbox) ? { prefer: 'pwsh' as const } : {}),
        ...(sandbox
          ? {
              wrapSpawn: sandbox.wrapSpawn,
              scratchRoot: sandbox.scratchRoot,
              sandbox: (program: string) => {
                const { active, allowUnsandboxed } = sandbox.state(program)
                return { active, allowUnsandboxed }
              },
            }
          : {}),
      }),
      external: hub,
      ...(code ? { code: () => (code.available().ok ? code : undefined) } : {}),
      codeIndex: () => this.codeIndex(config.root),
      checks: () => config.current().effective.checks,
      natives: () => {
        const dir = this.options.languageServers?.tools?.dir
        return dir ? installedNatives(dir) : undefined
      },
      ...(debug ? { debug } : {}),
      release: async () => {
        await debug?.close().catch(() => undefined)
        release()
      },
      ...(recording ? { beforeWrite: recording.beforeWrite, checkpoints: recording.checkpoints } : {}),
    }
  }
}
