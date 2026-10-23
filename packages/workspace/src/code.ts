/**
 * A folder's language servers, as eNCode starts them: one hub for the folder (@encode/lsp), shared by every session
 * in it and by the editor, so a server runs once and not once per chat.
 *
 * A language server reads the project and can run code it names (TypeScript plugins in tsconfig.json, Rust build
 * scripts and macros, the project's own copy of a server in node_modules/.bin), so servers run only in a folder the
 * person trusts, and only while language servers are on in Settings. They start with the agent's environment, without
 * anything that looks like a secret, in the folder itself. Like MCP servers they run outside the sandbox of the
 * agent's commands: they write their caches and logs where they please, and nothing the agent types reaches them.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { discover, fromChildProcess, LANGUAGE_SERVERS, LanguageServers, type ActionInfo, type CodeDiagnostic, type CompletionEntry, type CompletionResult, type EditorFoldRange, type EditorHighlight, type EditorInlayHint, type EditorSemanticTokens, type EditorSymbol, type EditorTriggers, type LaunchPlan, type Range, type ServerProcess, type ServerSpec, type ServerState, type SignatureHelp, type TextEdit } from '@encode/lsp'
import { agentEnvironment, decodeText, searchPath } from '@encode/tools'
import type { WorkspaceConfig } from './config'

/** The largest document a server is given. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export interface LanguageServerOptions {
  /** Language servers are on (the setting). Read at each start. */
  enabled(): boolean
  /** What servers start from, before secrets are taken out. Default: this process's environment. */
  env?: Record<string, string | undefined>
  /** Every publish, for the editor's marks: the folder, the file and what the server said. */
  onDiagnostics?(root: string, file: string, diagnostics: CodeDiagnostic[]): void
  /** A server of the folder started, stopped or failed. */
  onChange?(root: string): void
  /** For tests: how servers are found and started, and how soon an unused one stops. */
  discover?(spec: ServerSpec, root: string): LaunchPlan | { missing: string }
  spawn?(plan: LaunchPlan, cwd: string, env: Record<string, string>): Promise<ServerProcess>
  idleMs?: number
  catalog?: readonly ServerSpec[]
}

/** A language server as the Settings screen lists it. */
export interface LanguageServerInfo {
  id: string
  label: string
  state: ServerState
  /** Where it was found, or why it is missing, off or failed. */
  detail?: string
  command?: string
  /** It is busy (indexing, checking the project). */
  working?: boolean
  documents: number
  /** How to install it. */
  install: string
  /** What it covers: ".ts", ".tsx", "CMakeLists.txt". */
  files: string[]
}

export interface LanguageServersReport {
  /** `on`: a server starts when a file needs it. `off`: turned off in Settings. `untrusted`: the folder is not trusted. */
  state: 'on' | 'off' | 'untrusted'
  /** Why they do not run, in words. */
  reason?: string
  servers: LanguageServerInfo[]
}

interface At {
  /** The file's path in the folder ("src/a.ts"). */
  path: string
  /** Zero-based, as the servers count. */
  line: number
  /** Zero-based, in UTF-16 code units: a JavaScript string index. */
  character: number
}

/** A place a server pointed to: in the folder by its path, or outside it (a library) by its whole path. */
export interface EditorLocation {
  /** The path in the folder, or null for a file outside it. */
  path: string | null
  file: string
  line: number
  character: number
  endLine: number
  endCharacter: number
  /** The text of its first line (its end trimmed, at most 300 characters), for a list of places; only for a file in the folder. */
  preview?: string
}

/** A symbol found by name across the folder: only the folder's own files are listed. */
export interface EditorSymbolMatch {
  name: string
  kind: string
  container?: string
  path: string
  /** The range of its name, or the start of the file when the server gave only the file. */
  range: Range
}

/** A function of a call hierarchy as the editor shows it, numbered in the newest one so that its calls can be asked for. */
export interface EditorCallFunction {
  id: number
  name: string
  kind: string
  detail?: string
  /** Its name. */
  at: EditorLocation
}

/** The other end of a function's calls (who calls it, or what it calls) and where those calls are. */
export interface EditorCallEntry {
  item: EditorCallFunction
  sites: EditorLocation[]
}

/** What the editor asks the servers, by kind, with what each answers. */
export interface EditorAsks {
  complete: { params: At & { triggerKind: 1 | 2 | 3; triggerCharacter?: string }; result: CompletionResult | null }
  resolve: { params: { path: string; list: number; id: number }; result: CompletionEntry | null }
  signature: { params: At & { triggerKind: 1 | 2 | 3; triggerCharacter?: string; isRetrigger: boolean; active?: SignatureHelp }; result: SignatureHelp | null }
  hover: { params: At; result: { markdown: string; range?: Range } | null }
  highlights: { params: At; result: EditorHighlight[] }
  definition: { params: At; result: EditorLocation[] | null }
  typeDefinition: { params: At; result: EditorLocation[] | null }
  implementation: { params: At; result: EditorLocation[] | null }
  references: { params: At; result: EditorLocation[] | null }
  triggers: { params: { path: string }; result: EditorTriggers | null }
  /**
   * Whether the symbol at a position can be renamed: the range and the name to start from (none: the word there), the
   * server's reason when it cannot, null when no server renames in the file.
   */
  prepareRename: { params: At; result: { ok: true; range?: Range; placeholder?: string } | { ok: false; reason: string } | null }
  /** The actions for a range, numbered for `EditorChangeRequest`; `automatic` when the editor asks by itself (the lightbulb). */
  codeActions: { params: { path: string; range: Range; only?: string[]; automatic: boolean }; result: { list: number; actions: ActionInfo[] } | null }
  /** The edits that format the file, or a range of it, for the text the editor sent. */
  format: { params: { path: string; range?: Range; tabSize: number; insertSpaces: boolean }; result: TextEdit[] | null }
  /** The edits that format what was just typed: `ch`, which ends at the position. */
  formatOnType: { params: At & { ch: string; tabSize: number; insertSpaces: boolean }; result: TextEdit[] | null }
  /** The file's outline, as a tree. */
  symbols: { params: { path: string }; result: EditorSymbol[] | null }
  /** The blocks the file folds by, as its server sees them (0-based lines); null when no server folds it. */
  folding: { params: { path: string }; result: EditorFoldRange[] | null }
  /** The hints the server draws among lines `startLine` to `endLine` (0-based, both included); null when none draws any. */
  inlayHints: { params: { path: string; startLine: number; endLine: number }; result: EditorInlayHint[] | null }
  /** The file's semantic tokens in the editor's kinds; null when no server gives them. */
  semanticTokens: { params: { path: string }; result: EditorSemanticTokens | null }
  /**
   * Symbols by name across the folder, from every server running in it; `path`, the file shown ('' for none), starts its
   * server when it is not running yet. Null while no running server searches symbols.
   */
  workspaceSymbols: { params: { path: string; query: string }; result: EditorSymbolMatch[] | null }
  /** The functions at a position a call hierarchy starts from, numbered in a new hierarchy. */
  callHierarchy: { params: At; result: { list: number; items: EditorCallFunction[] } | null }
  /** Who calls a function of the newest hierarchy (`incoming`), or what it calls (`outgoing`). */
  calls: { params: { path: string; list: number; id: number; direction: 'incoming' | 'outgoing' }; result: { calls: EditorCallEntry[] } | { reason: string } | null }
}

export type EditorAsk = { [K in keyof EditorAsks]: { kind: K } & EditorAsks[K]['params'] }[keyof EditorAsks]
export type EditorAnswer<K extends keyof EditorAsks = keyof EditorAsks> = EditorAsks[K]['result']

/**
 * What the editor asks to change through a folder's servers. `open` names every file the editor has open, so that none
 * of them is written behind its back. A change is applied at once, or shown first (`preview`) and applied by its id;
 * `undo` takes an applied one back while nothing it touched has changed since; `discard` lets a preview go.
 */
export type EditorChangeRequest =
  | { kind: 'rename'; path: string; line: number; character: number; newName: string; preview: boolean; open: string[] }
  | { kind: 'action'; path: string; list: number; id: number; preview: boolean; open: string[] }
  | { kind: 'apply'; id: number; open: string[] }
  | { kind: 'undo'; id: number; open: string[] }
  | { kind: 'discard'; id: number }

/** The edits a change makes to a file the editor has open; `written`: the file on disk was written too, so the editor's text is saved once they are in. */
export interface EditorFileEdit {
  path: string
  edits: TextEdit[]
  written: boolean
}

/** A file a change would make, edit, move or delete, for its preview. */
export interface EditorChangeFile {
  path: string
  kind: 'edit' | 'create' | 'move' | 'delete'
  /** Where a moved file goes. */
  to?: string
  /** How many places in it change. */
  places: number
  /** The lines that change, as they read before and after, for an edit; at most so many. */
  lines?: { line: number; before: string; after: string }[]
  /** Changed in the editor, where it has unsaved changes, rather than on disk. */
  inEditor?: boolean
  /** Some of its lines are left out: a preview shows at most so many. */
  cut?: boolean
}

export type EditorChangeResult =
  | { ok: true; done: 'preview'; id: number; title: string; files: EditorChangeFile[] }
  | {
      ok: true
      done: 'applied'
      id: number
      title: string
      /** In order: a file may get more than one set of edits when a command makes several changes. */
      editor: EditorFileEdit[]
      written: string[]
      created: string[]
      moved: { from: string; to: string }[]
      deleted: string[]
      places: number
      files: number
      /** It can be taken back with `undo`. */
      undo: boolean
      /** What the server refused or could not do while the change ran. */
      notes: string[]
    }
  | { ok: true; done: 'undone'; id: number; editor: { path: string; written: boolean }[]; written: string[]; created: string[]; deleted: string[] }
  | { ok: true; done: 'discarded' }
  | { ok: false; reason: string }

/** The most files a list of places reads for its previews, and the most characters a preview keeps. */
const PREVIEW_FILES = 100
const PREVIEW_CHARS = 300

/**
 * The places with the text of their first line, read from disk (the editor puts in its own text for the files it
 * has open). Only files in the folder are read, and only so many of them; a file that cannot be read has none.
 */
export async function withPreviews(locations: EditorLocation[]): Promise<EditorLocation[]> {
  const files = [...new Set(locations.filter((item) => item.path !== null).map((item) => item.file))].slice(0, PREVIEW_FILES)
  const lines = new Map<string, string[]>()
  await Promise.all(
    files.map(async (file) => {
      const text = await readText(file)
      if (text !== null) lines.set(file, text.split(/\r\n?|\n/))
    }),
  )
  return locations.map((item) => {
    const text = item.path === null ? undefined : lines.get(item.file)?.[item.line]
    if (text === undefined) return item
    const line = text.trimEnd()
    return { ...item, preview: line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) : line }
  })
}

/** What the editor tells the servers of a file it shows, by its path in the folder ("src/a.ts"). */
export type EditorDocumentChange = { kind: 'open' | 'change'; path: string; text: string; dirty: boolean } | { kind: 'close'; path: string }

/** The most a server is shown of one line of its log in a report. */
const LOG_LINE_CHARS = 300

export const SERVERS_OFF = 'Language servers are turned off in Settings.'
export const FOLDER_NOT_TRUSTED = 'Language servers run only in folders you trust, since a server can run code the project names (its plugins, its build scripts). Trust the folder to use them.'

/** A file's text as the tools read it (UTF-8, its byte order mark, UTF-16, older Windows text), or null. */
async function readText(file: string): Promise<string | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) return null
    return decodeText(await fs.readFile(file))?.text ?? null
  } catch {
    return null
  }
}

async function start(plan: LaunchPlan, cwd: string, env: Record<string, string>): Promise<ServerProcess> {
  const child = spawn(plan.file, plan.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  // A program that cannot be started says so through `error`; wait for it to start or fail.
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => reject(new Error(`${plan.command} could not be started: ${error.message}`)))
  })
  return fromChildProcess(child)
}

export function folderLanguageServers(config: WorkspaceConfig, platform: NodeJS.Platform, options: LanguageServerOptions): LanguageServers {
  const base = options.env ?? process.env
  const environment = () => agentEnvironment(base, { platform }).env
  return new LanguageServers({
    root: config.root,
    platform,
    ...(options.catalog ? { catalog: options.catalog } : {}),
    allowed: () => {
      if (!options.enabled()) return { ok: false, reason: SERVERS_OFF }
      if (!config.current().folder.trusted) return { ok: false, reason: FOLDER_NOT_TRUSTED }
      return { ok: true }
    },
    // Only reached once the folder is trusted: its own node_modules/.bin is looked in first.
    discover: (spec) => options.discover?.(spec, config.root) ?? discover(spec, config.root, { platform, projectBins: true, which: (name) => searchPath(name, environment(), platform) }),
    spawn: (plan, cwd) => (options.spawn ?? start)(plan, cwd, environment()),
    readText,
    exists: (file) => existsSync(file),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    ...(options.onDiagnostics ? { onDiagnostics: (file: string, items: CodeDiagnostic[]) => options.onDiagnostics?.(config.root, file, items) } : {}),
    ...(options.onChange ? { onChange: () => options.onChange?.(config.root) } : {}),
  })
}

/** How a folder's servers stand, for the Settings screen; with `logs`, the last lines of the ones that stopped or failed. */
export function languageServersReport(servers: LanguageServers, options: Pick<LanguageServerOptions, 'enabled' | 'catalog'>, trusted: boolean, logs = 0): LanguageServersReport & { logs?: Record<string, string[]> } {
  const catalog = options.catalog ?? LANGUAGE_SERVERS
  const specs = new Map(catalog.map((spec) => [spec.id, spec]))
  const state = !options.enabled() ? 'off' : !trusted ? 'untrusted' : 'on'
  const views = servers.status().map((view): LanguageServerInfo => {
    const spec = specs.get(view.id)
    return { ...view, install: spec?.install ?? '', files: spec ? [...Object.keys(spec.extensions), ...Object.keys(spec.fileNames ?? {})] : [] }
  })
  const report: LanguageServersReport & { logs?: Record<string, string[]> } = { state, ...(state === 'off' ? { reason: SERVERS_OFF } : state === 'untrusted' ? { reason: FOLDER_NOT_TRUSTED } : {}), servers: views }
  if (logs > 0) {
    const kept: Record<string, string[]> = {}
    for (const view of views) {
      if (view.state !== 'failed' && !(view.state === 'stopped' && view.detail)) continue
      const lines = servers.logs(view.id).slice(-logs)
      if (lines.length) kept[view.id] = lines.map((line) => (line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}...` : line))
    }
    if (Object.keys(kept).length) report.logs = kept
  }
  return report
}
