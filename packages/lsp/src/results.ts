/**
 * What a language server answers, read defensively: a server is a program the project chose, so anything it sends is
 * checked for shape, and lists are cut to a size eNCode can show. An item that does not read is left out; a whole
 * answer that does not read is an empty one.
 */
import type { CallHierarchyItem, CodeAction, Command, Diagnostic, DocumentSymbol, Location, Position, Range, SymbolInformation, TextEdit, WorkspaceEdit } from './protocol'

export const MAX_LOCATIONS = 1_000
export const MAX_SYMBOLS = 5_000
export const MAX_DIAGNOSTICS = 1_000
export const MAX_EDITS = 20_000
export const MAX_ACTIONS = 100

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 31

export function readPosition(value: unknown): Position | null {
  if (!isObject(value) || !isCount(value.line) || !isCount(value.character)) return null
  return { line: value.line, character: value.character }
}

export function readRange(value: unknown): Range | null {
  if (!isObject(value)) return null
  const start = readPosition(value.start)
  const end = readPosition(value.end)
  if (!start || !end) return null
  // A range given backwards is read the right way round.
  return start.line < end.line || (start.line === end.line && start.character <= end.character) ? { start, end } : { start: end, end: start }
}

function text(value: unknown, max = 10_000): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/** Location, Location[], LocationLink[] or null, as definition, references and their kin answer. */
export function readLocations(value: unknown): Location[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  const out: Location[] = []
  for (const item of items) {
    if (out.length >= MAX_LOCATIONS) break
    if (!isObject(item)) continue
    if (typeof item.uri === 'string') {
      const range = readRange(item.range)
      if (range) out.push({ uri: item.uri, range })
    } else if (typeof item.targetUri === 'string') {
      const range = readRange(item.targetSelectionRange) ?? readRange(item.targetRange)
      if (range) out.push({ uri: item.targetUri, range })
    }
  }
  return out
}

export function readDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return []
  const out: Diagnostic[] = []
  for (const item of value) {
    if (out.length >= MAX_DIAGNOSTICS) break
    if (!isObject(item)) continue
    const range = readRange(item.range)
    const message = text(item.message, 2_000)
    if (!range || message === undefined) continue
    const severity = typeof item.severity === 'number' && item.severity >= 1 && item.severity <= 4 ? item.severity : undefined
    const code = typeof item.code === 'string' ? item.code.slice(0, 100) : typeof item.code === 'number' && Number.isFinite(item.code) ? item.code : undefined
    const source = text(item.source, 100)
    out.push({ range, message, ...(severity ? { severity } : {}), ...(code !== undefined ? { code } : {}), ...(source ? { source } : {}) })
  }
  return out
}

function readTextEdits(value: unknown, budget: { left: number }): TextEdit[] | null {
  if (!Array.isArray(value)) return null
  const out: TextEdit[] = []
  for (const item of value) {
    if (!isObject(item)) return null
    const range = readRange(item.range)
    if (!range || typeof item.newText !== 'string') return null
    if (--budget.left < 0) return null
    out.push({ range, newText: item.newText })
  }
  return out
}

/**
 * A workspace edit, or null when any part of it does not read: an edit applied in part is worse than none, so one bad
 * entry refuses the whole of it.
 */
export function readWorkspaceEdit(value: unknown): WorkspaceEdit | null {
  if (!isObject(value)) return null
  const budget = { left: MAX_EDITS }
  const edit: WorkspaceEdit = {}
  if (value.documentChanges !== undefined) {
    if (!Array.isArray(value.documentChanges)) return null
    const changes: NonNullable<WorkspaceEdit['documentChanges']> = []
    for (const item of value.documentChanges) {
      if (!isObject(item)) return null
      if (item.kind === 'create' && typeof item.uri === 'string') changes.push({ kind: 'create', uri: item.uri, ...(isObject(item.options) ? { options: { overwrite: item.options.overwrite === true, ignoreIfExists: item.options.ignoreIfExists === true } } : {}) })
      else if (item.kind === 'rename' && typeof item.oldUri === 'string' && typeof item.newUri === 'string') changes.push({ kind: 'rename', oldUri: item.oldUri, newUri: item.newUri, ...(isObject(item.options) ? { options: { overwrite: item.options.overwrite === true, ignoreIfExists: item.options.ignoreIfExists === true } } : {}) })
      else if (item.kind === 'delete' && typeof item.uri === 'string') changes.push({ kind: 'delete', uri: item.uri, ...(isObject(item.options) ? { options: { recursive: item.options.recursive === true, ignoreIfNotExists: item.options.ignoreIfNotExists === true } } : {}) })
      else if (item.kind === undefined && isObject(item.textDocument) && typeof item.textDocument.uri === 'string') {
        const edits = readTextEdits(item.edits, budget)
        if (!edits) return null
        const version = isCount(item.textDocument.version) ? item.textDocument.version : null
        changes.push({ textDocument: { uri: item.textDocument.uri, version }, edits })
      } else return null
    }
    edit.documentChanges = changes
  } else if (value.changes !== undefined) {
    if (!isObject(value.changes)) return null
    const changes: Record<string, TextEdit[]> = {}
    for (const [uri, list] of Object.entries(value.changes)) {
      const edits = readTextEdits(list, budget)
      if (!edits) return null
      changes[uri] = edits
    }
    edit.changes = changes
  }
  return edit
}

function readDocumentSymbol(value: unknown, depth: number, count: { left: number }): DocumentSymbol | null {
  if (!isObject(value) || depth > 32) return null
  const name = text(value.name, 300)
  const range = readRange(value.range)
  const selectionRange = readRange(value.selectionRange) ?? range
  if (!name || !range || !selectionRange || typeof value.kind !== 'number') return null
  if (--count.left < 0) return null
  const children: DocumentSymbol[] = []
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      const read = readDocumentSymbol(child, depth + 1, count)
      if (read) children.push(read)
    }
  }
  const detail = text(value.detail, 300)
  return { name, kind: value.kind, range, selectionRange, ...(detail ? { detail } : {}), ...(children.length ? { children } : {}) }
}

/** DocumentSymbol[] (a tree) or SymbolInformation[] (a flat list), as documentSymbol answers. */
export function readDocumentSymbols(value: unknown): { tree: DocumentSymbol[] } | { flat: SymbolInformation[] } {
  if (!Array.isArray(value) || !value.length) return { tree: [] }
  const first = value[0]
  if (isObject(first) && isObject(first.location)) return { flat: readSymbolInformation(value) }
  const count = { left: MAX_SYMBOLS }
  const tree: DocumentSymbol[] = []
  for (const item of value) {
    const read = readDocumentSymbol(item, 0, count)
    if (read) tree.push(read)
  }
  return { tree }
}

export function readSymbolInformation(value: unknown): SymbolInformation[] {
  if (!Array.isArray(value)) return []
  const out: SymbolInformation[] = []
  for (const item of value) {
    if (out.length >= MAX_SYMBOLS) break
    if (!isObject(item) || typeof item.kind !== 'number' || !isObject(item.location)) continue
    const name = text(item.name, 300)
    if (!name || typeof item.location.uri !== 'string') continue
    const range = readRange(item.location.range)
    const containerName = text(item.containerName, 300)
    out.push({ name, kind: item.kind, location: range ? { uri: item.location.uri, range } : { uri: item.location.uri }, ...(containerName ? { containerName } : {}) })
  }
  return out
}

/** A hover's contents as plain text (markdown stays markdown), or null for nothing. */
export function readHover(value: unknown): string | null {
  if (!isObject(value)) return null
  const part = (item: unknown): string => {
    if (typeof item === 'string') return item
    if (isObject(item) && typeof item.value === 'string') {
      if (typeof item.language === 'string' && item.language) return `\`\`\`${item.language}\n${item.value}\n\`\`\``
      return item.value
    }
    return ''
  }
  const contents = value.contents
  const joined = (Array.isArray(contents) ? contents.map(part) : [part(contents)]).filter((item) => item.trim()).join('\n\n')
  return joined.trim() ? joined.slice(0, 20_000) : null
}

export function readCallHierarchyItems(value: unknown): CallHierarchyItem[] {
  if (!Array.isArray(value)) return []
  const out: CallHierarchyItem[] = []
  for (const item of value) {
    if (out.length >= MAX_LOCATIONS) break
    const read = readCallHierarchyItem(item)
    if (read) out.push(read)
  }
  return out
}

export function readCallHierarchyItem(value: unknown): CallHierarchyItem | null {
  if (!isObject(value) || typeof value.kind !== 'number' || typeof value.uri !== 'string') return null
  const name = text(value.name, 300)
  const range = readRange(value.range)
  const selectionRange = readRange(value.selectionRange) ?? range
  if (!name || !range || !selectionRange) return null
  const detail = text(value.detail, 300)
  return { name, kind: value.kind, uri: value.uri, range, selectionRange, ...(detail ? { detail } : {}), ...(value.data !== undefined ? { data: value.data } : {}) }
}

/** incomingCalls (`from`) or outgoingCalls (`to`): the other end of each call. */
export function readCalls(value: unknown, end: 'from' | 'to'): CallHierarchyItem[] {
  if (!Array.isArray(value)) return []
  const out: CallHierarchyItem[] = []
  for (const item of value) {
    if (out.length >= MAX_LOCATIONS) break
    if (!isObject(item)) continue
    const read = readCallHierarchyItem(item[end])
    if (read) out.push(read)
  }
  return out
}

function readCommand(value: unknown): Command | null {
  if (!isObject(value) || typeof value.command !== 'string') return null
  const title = text(value.title, 300) ?? value.command
  return { title, command: value.command, ...(Array.isArray(value.arguments) ? { arguments: value.arguments } : {}) }
}

/** (Command | CodeAction)[]: a bare command is an action that only runs it. */
export function readCodeActions(value: unknown): CodeAction[] {
  if (!Array.isArray(value)) return []
  const out: CodeAction[] = []
  for (const item of value) {
    if (out.length >= MAX_ACTIONS) break
    const action = readCodeAction(item)
    if (action) out.push(action)
  }
  return out
}

export function readCodeAction(item: unknown): CodeAction | null {
  if (!isObject(item)) return null
  if (typeof item.command === 'string') {
    const command = readCommand(item)
    return command ? { title: command.title, command } : null
  }
  const title = text(item.title, 300)
  if (!title) return null
  const edit = item.edit === undefined ? undefined : readWorkspaceEdit(item.edit)
  if (item.edit !== undefined && !edit) return null
  const command = item.command === undefined ? undefined : readCommand(item.command)
  const kind = text(item.kind, 100)
  const disabled = isObject(item.disabled) && typeof item.disabled.reason === 'string' ? { reason: item.disabled.reason.slice(0, 300) } : undefined
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(item.isPreferred === true ? { isPreferred: true } : {}),
    ...(disabled ? { disabled } : {}),
    ...(edit ? { edit } : {}),
    ...(command ? { command } : {}),
    ...(item.data !== undefined ? { data: item.data } : {}),
  }
}
