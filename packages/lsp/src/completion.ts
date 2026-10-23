/**
 * Completions as the editor takes them: one shape whatever the server sent (a plain label, insert text, a text edit
 * with one range or two, a snippet), with the parts the editor shows already named for people.
 */
import { COMPLETION_KINDS, type CompletionItem, type MarkupContent, type Range, type TextEdit } from './protocol'

export interface CompletionEntry {
  /** Its place in the list it came in; with the list's number it names the item to resolve. */
  id: number
  label: string
  /** "function", "property", "keyword"... */
  kind?: string
  detail?: string
  /** Shown right after the label, such as a signature: `(a: number)`. */
  labelDetail?: string
  /** Shown at the end of the row, such as the module an import comes from. */
  description?: string
  documentation?: MarkupContent
  deprecated?: boolean
  preselect?: boolean
  sortText: string
  filterText: string
  /** The text to put in, or a snippet in the protocol's syntax when `snippet` is true. */
  insertText: string
  snippet: boolean
  /** Where the text goes: `replace` covers the whole word under the cursor, `insert` only up to the cursor. */
  replace?: Range
  insert?: Range
  /** Edits elsewhere in the file, such as the import an item needs. */
  additionalEdits?: TextEdit[]
  commitCharacters?: string[]
  /** A command of the editor's own to run once the item is in: showing suggestions or parameter hints again. */
  then?: 'suggest' | 'parameterHints'
  /** False while the server can still fill in documentation or edits. */
  resolved: boolean
}

export interface CompletionResult {
  /** The list's number: a resolve names it, and an answer for an older list is refused. */
  list: number
  /** The server did not send everything: typing more asks again. */
  incomplete: boolean
  items: CompletionEntry[]
}

const EDITOR_COMMANDS: Record<string, CompletionEntry['then']> = {
  'editor.action.triggerSuggest': 'suggest',
  'editor.action.triggerParameterHints': 'parameterHints',
}

export function toEntry(item: CompletionItem, id: number, resolved: boolean): CompletionEntry {
  const edit = item.textEdit
  const insertText = edit?.newText ?? item.insertText ?? item.label
  const entry: CompletionEntry = {
    id,
    label: item.label,
    sortText: item.sortText ?? item.label,
    filterText: item.filterText ?? item.label,
    insertText,
    snippet: item.insertTextFormat === 2,
    resolved,
  }
  if (item.kind) entry.kind = COMPLETION_KINDS[item.kind]
  if (item.detail) entry.detail = item.detail
  if (item.labelDetails?.detail) entry.labelDetail = item.labelDetails.detail
  if (item.labelDetails?.description) entry.description = item.labelDetails.description
  if (item.documentation) entry.documentation = typeof item.documentation === 'string' ? { kind: 'plaintext', value: item.documentation } : item.documentation
  if (item.deprecated || item.tags?.includes(1)) entry.deprecated = true
  if (item.preselect) entry.preselect = true
  if (edit && 'range' in edit) {
    entry.replace = edit.range
    entry.insert = edit.range
  } else if (edit) {
    entry.replace = edit.replace
    entry.insert = edit.insert
  }
  if (item.additionalTextEdits?.length) entry.additionalEdits = item.additionalTextEdits
  if (item.commitCharacters?.length) entry.commitCharacters = item.commitCharacters
  const then = item.command ? EDITOR_COMMANDS[item.command.command] : undefined
  if (then) entry.then = then
  return entry
}

/** A document highlight's kind, named. */
export type HighlightKind = 'text' | 'read' | 'write'

export interface EditorHighlight {
  range: Range
  kind: HighlightKind
}
