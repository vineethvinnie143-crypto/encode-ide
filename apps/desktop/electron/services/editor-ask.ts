import type { EditorAsk, SignatureHelp } from '../../shared/types'

/** The kinds of question the editor asks the language servers. */
const KINDS = new Set<EditorAsk['kind']>(['complete', 'resolve', 'signature', 'hover', 'highlights', 'definition', 'typeDefinition', 'implementation', 'references', 'triggers'])

/** Lines and columns past these are not in any file the editor gives a server (8 MB at most). */
const MAX_LINE = 10_000_000
const MAX_CHARACTER = 10_000_000
/** The signature help the editor shows, sent back with a question while it is open, is small; more is refused. */
const MAX_ACTIVE_CHARS = 64 * 1024

const isCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const isTriggerKind = (value: unknown): value is 1 | 2 | 3 => value === 1 || value === 2 || value === 3
/** One character a person typed (two UTF-16 units for one outside the basic plane). */
const isTriggerCharacter = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 2

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
  return { kind, ...at }
}

/** What a question gets when nothing answers it. */
export function noAnswer(kind: unknown): [] | null {
  return kind === 'highlights' ? [] : null
}
