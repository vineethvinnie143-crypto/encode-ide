import type { CodeRange, EditorAsk, EditorChangeRequest, SignatureHelp } from '../../shared/types'

/** The kinds of question the editor asks the language servers. */
const KINDS = new Set<EditorAsk['kind']>(['complete', 'resolve', 'signature', 'hover', 'highlights', 'definition', 'typeDefinition', 'implementation', 'references', 'triggers', 'prepareRename', 'codeActions', 'format', 'formatOnType'])

/** Lines and columns past these are not in any file the editor gives a server (8 MB at most). */
const MAX_LINE = 10_000_000
const MAX_CHARACTER = 10_000_000
/** The signature help the editor shows, sent back with a question while it is open, is small; more is refused. */
const MAX_ACTIVE_CHARS = 64 * 1024
/** A kind of code action is a short dotted name ("quickfix", "source.organizeImports"); a question names a few. */
const ACTION_KIND = /^[a-z][A-Za-z]*(\.[A-Za-z]+)*$/
const MAX_ACTION_KINDS = 8
/** A new name is one line of a sensible length. */
const MAX_NAME_CHARS = 500
/** The files the editor has open, as a change is told of them; more than this many tabs is not a person's editor. */
const MAX_OPEN = 2_000

const isCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const isTriggerKind = (value: unknown): value is 1 | 2 | 3 => value === 1 || value === 2 || value === 3
/** One character a person typed (two UTF-16 units for one outside the basic plane). */
const isTriggerCharacter = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 2

function readRange(value: unknown): CodeRange | null {
  if (typeof value !== 'object' || value === null) return null
  const { start, end } = value as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }
  if (!start || !end || !isCount(start.line, MAX_LINE) || !isCount(start.character, MAX_CHARACTER) || !isCount(end.line, MAX_LINE) || !isCount(end.character, MAX_CHARACTER)) return null
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) return null
  return { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }
}

/** How the editor indents: the size of a tab and whether it puts spaces in. */
function readIndent(ask: Record<string, unknown>): { tabSize: number; insertSpaces: boolean } | null {
  if (!isCount(ask.tabSize, 16) || ask.tabSize < 1 || typeof ask.insertSpaces !== 'boolean') return null
  return { tabSize: ask.tabSize, insertSpaces: ask.insertSpaces }
}

function isSignatureHelp(value: unknown): value is SignatureHelp {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as SignatureHelp).signatures)) return false
  try {
    return JSON.stringify(value).length <= MAX_ACTIVE_CHARS
  } catch {
    return false
  }
}

/**
 * A question from the renderer, checked field by field and rebuilt from what passed, with its path made the folder's
 * own by `relative` (null for a path outside the folder). Null for anything else: the renderer gets no answer then.
 */
export function readEditorAsk(value: unknown, relative: (path: string) => string | null): EditorAsk | null {
  if (typeof value !== 'object' || value === null) return null
  const ask = value as Record<string, unknown>
  const kind = ask.kind as EditorAsk['kind']
  if (!KINDS.has(kind) || typeof ask.path !== 'string') return null
  const path = relative(ask.path)
  if (!path) return null
  if (kind === 'triggers') return { kind, path }
  if (kind === 'codeActions') {
    const range = readRange(ask.range)
    if (!range || typeof ask.automatic !== 'boolean') return null
    if (ask.only !== undefined && !(Array.isArray(ask.only) && ask.only.length >= 1 && ask.only.length <= MAX_ACTION_KINDS && ask.only.every((item) => typeof item === 'string' && item.length <= 100 && ACTION_KIND.test(item)))) return null
    return { kind, path, range, automatic: ask.automatic, ...(ask.only ? { only: [...(ask.only as string[])] } : {}) }
  }
  if (kind === 'format') {
    const indent = readIndent(ask)
    if (!indent) return null
    if (ask.range === undefined) return { kind, path, ...indent }
    const range = readRange(ask.range)
    return range ? { kind, path, range, ...indent } : null
  }
  if (kind === 'resolve') {
    if (!isCount(ask.list, Number.MAX_SAFE_INTEGER) || !isCount(ask.id, 100_000)) return null
    return { kind, path, list: ask.list, id: ask.id }
  }
  if (!isCount(ask.line, MAX_LINE) || !isCount(ask.character, MAX_CHARACTER)) return null
  const at = { path, line: ask.line, character: ask.character }
  if (kind === 'complete' || kind === 'signature') {
    if (!isTriggerKind(ask.triggerKind)) return null
    if (ask.triggerCharacter !== undefined && !isTriggerCharacter(ask.triggerCharacter)) return null
    const trigger = ask.triggerCharacter === undefined ? {} : { triggerCharacter: ask.triggerCharacter }
    if (kind === 'complete') return { kind, ...at, triggerKind: ask.triggerKind, ...trigger }
    if (typeof ask.isRetrigger !== 'boolean') return null
    if (ask.active !== undefined && !isSignatureHelp(ask.active)) return null
    return { kind, ...at, triggerKind: ask.triggerKind, ...trigger, isRetrigger: ask.isRetrigger, ...(ask.active ? { active: ask.active } : {}) }
  }
  if (kind === 'formatOnType') {
    const indent = readIndent(ask)
    if (!indent || !isTriggerCharacter(ask.ch)) return null
    return { kind, ...at, ch: ask.ch, ...indent }
  }
  return { kind, ...at }
}

/**
 * A change the editor asks for through the language servers, checked and rebuilt like a question: its file made the
 * folder's own, a new name of one line, numbers as counts, and the editor's open files kept only where they are the
 * folder's. Null for anything else.
 */
export function readEditorChange(value: unknown, relative: (path: string) => string | null): EditorChangeRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const change = value as Record<string, unknown>
  const open = (): string[] | null => {
    if (!Array.isArray(change.open) || change.open.length > MAX_OPEN) return null
    const paths: string[] = []
    for (const item of change.open) {
      const path = typeof item === 'string' ? relative(item) : null
      if (path) paths.push(path)
    }
    return paths
  }
  if (change.kind === 'discard') return isCount(change.id, Number.MAX_SAFE_INTEGER) ? { kind: 'discard', id: change.id } : null
  if (change.kind === 'apply' || change.kind === 'undo') {
    const paths = open()
    return isCount(change.id, Number.MAX_SAFE_INTEGER) && paths ? { kind: change.kind, id: change.id, open: paths } : null
  }
  if (change.kind !== 'rename' && change.kind !== 'action') return null
  if (typeof change.path !== 'string' || typeof change.preview !== 'boolean') return null
  const path = relative(change.path)
  const paths = open()
  if (!path || !paths) return null
  if (change.kind === 'action') {
    if (!isCount(change.list, Number.MAX_SAFE_INTEGER) || !isCount(change.id, 1_000)) return null
    return { kind: 'action', path, list: change.list, id: change.id, preview: change.preview, open: paths }
  }
  if (!isCount(change.line, MAX_LINE) || !isCount(change.character, MAX_CHARACTER)) return null
  // A name is one line, without control characters, and not blank.
  if (typeof change.newName !== 'string' || !change.newName.trim() || change.newName.length > MAX_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(change.newName)) return null
  return { kind: 'rename', path, line: change.line, character: change.character, newName: change.newName, preview: change.preview, open: paths }
}

/** What a question gets when nothing answers it. */
export function noAnswer(kind: unknown): [] | null {
  return kind === 'highlights' ? [] : null
}
