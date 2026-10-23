/**
 * The parts of the Language Server Protocol (3.17) eNCode speaks, as the wire has them. Positions are zero-based and
 * count UTF-16 code units, the one encoding every server supports and the one JavaScript strings index by.
 * What a server sends is checked where it is read (results.ts); these types say what a well-behaved one sends.
 */

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  uri: string
  range: Range
}

export interface LocationLink {
  originSelectionRange?: Range
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const

export interface Diagnostic {
  range: Range
  severity?: number
  code?: number | string
  source?: string
  message: string
  tags?: number[]
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null }
  edits: TextEdit[]
}

export interface CreateFile {
  kind: 'create'
  uri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

export interface RenameFile {
  kind: 'rename'
  oldUri: string
  newUri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

export interface DeleteFile {
  kind: 'delete'
  uri: string
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean }
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[]
}

export interface Command {
  title: string
  command: string
  arguments?: unknown[]
}

export interface CodeAction {
  title: string
  kind?: string
  diagnostics?: Diagnostic[]
  isPreferred?: boolean
  disabled?: { reason: string }
  edit?: WorkspaceEdit
  command?: Command
  data?: unknown
}

export interface DocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

export interface SymbolInformation {
  name: string
  kind: number
  location: Location | { uri: string }
  containerName?: string
}

export interface MarkupContent {
  kind: 'plaintext' | 'markdown'
  value: string
}

export type MarkedString = string | { language: string; value: string }

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[]
  range?: Range
}

export interface CallHierarchyItem {
  name: string
  kind: number
  detail?: string
  uri: string
  range: Range
  selectionRange: Range
  data?: unknown
}

export interface InsertReplaceEdit {
  newText: string
  insert: Range
  replace: Range
}

export const InsertTextFormat = { PlainText: 1, Snippet: 2 } as const

export interface CompletionItem {
  label: string
  labelDetails?: { detail?: string; description?: string }
  kind?: number
  tags?: number[]
  detail?: string
  documentation?: string | MarkupContent
  deprecated?: boolean
  preselect?: boolean
  sortText?: string
  filterText?: string
  insertText?: string
  insertTextFormat?: number
  textEdit?: TextEdit | InsertReplaceEdit
  textEditText?: string
  additionalTextEdits?: TextEdit[]
  commitCharacters?: string[]
  command?: Command
  data?: unknown
}

export interface CompletionList {
  isIncomplete: boolean
  itemDefaults?: { commitCharacters?: string[]; editRange?: Range | { insert: Range; replace: Range }; insertTextFormat?: number; data?: unknown }
  items: CompletionItem[]
}

export interface ParameterInformation {
  /** The label's text, or where it is in the signature's label (UTF-16 offsets, end exclusive). */
  label: string | [number, number]
  documentation?: string | MarkupContent
}

export interface SignatureInformation {
  label: string
  documentation?: string | MarkupContent
  parameters?: ParameterInformation[]
  activeParameter?: number
}

export interface SignatureHelp {
  signatures: SignatureInformation[]
  activeSignature?: number
  activeParameter?: number
}

export const DocumentHighlightKind = { Text: 1, Read: 2, Write: 3 } as const

export interface DocumentHighlight {
  range: Range
  kind?: number
}

/** The server's capabilities eNCode reads. A capability is there when it is `true` or an options object. */
export interface ServerCapabilities {
  positionEncoding?: string
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } }
  hoverProvider?: unknown
  definitionProvider?: unknown
  typeDefinitionProvider?: unknown
  implementationProvider?: unknown
  referencesProvider?: unknown
  documentSymbolProvider?: unknown
  workspaceSymbolProvider?: unknown
  callHierarchyProvider?: unknown
  renameProvider?: boolean | { prepareProvider?: boolean }
  codeActionProvider?: boolean | { resolveProvider?: boolean; codeActionKinds?: string[] }
  diagnosticProvider?: { interFileDependencies?: boolean; workspaceDiagnostics?: boolean }
  executeCommandProvider?: { commands?: string[] }
  completionProvider?: { triggerCharacters?: string[]; allCommitCharacters?: string[]; resolveProvider?: boolean }
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] }
  documentHighlightProvider?: unknown
}

export const TextDocumentSyncKind = { None: 0, Full: 1, Incremental: 2 } as const

/** Names for completion item kinds, as people read them. */
export const COMPLETION_KINDS: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'constructor',
  5: 'field',
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'module',
  10: 'property',
  11: 'unit',
  12: 'value',
  13: 'enum',
  14: 'keyword',
  15: 'snippet',
  16: 'color',
  17: 'file',
  18: 'reference',
  19: 'folder',
  20: 'enum member',
  21: 'constant',
  22: 'struct',
  23: 'event',
  24: 'operator',
  25: 'type parameter',
}

/** Names for symbol kinds, as people read them. */
export const SYMBOL_KINDS: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type parameter',
}
