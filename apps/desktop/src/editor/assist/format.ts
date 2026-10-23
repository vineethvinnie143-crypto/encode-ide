import type { EditorState } from '@encode/editor'
import type { CodeRange } from '@shared/types'
import { applyServerEdits, currentDoc, docState } from '../docs'
import { askServers } from './ask'

/** How long a save waits for the server to format the file; a slow one is not waited for, and the file is saved as it is. */
export const FORMAT_ON_SAVE_MS = 1_500

/** How the document indents, as the servers are told: the size of one level, and whether it is spaces. */
export function indentOf(state: EditorState): { tabSize: number; insertSpaces: boolean } {
  const { indentUnit, tabSize } = state.config
  return indentUnit === '\t' ? { tabSize, insertSpaces: false } : { tabSize: indentUnit.length || tabSize, insertSpaces: true }
}

export type FormatOutcome = 'formatted' | 'unchanged' | 'no-server' | 'moved-on'

/**
 * Formats an open document, or a range of it, through its server: the edits go in as one undo step, while the document
 * is still the text they were made for. `no-server` when none formats it, `moved-on` when it changed meanwhile.
 */
export async function formatDoc(path: string, range?: CodeRange, options: { waitMs?: number } = {}): Promise<FormatOutcome> {
  const state = docState(path)
  if (!state) return 'no-server'
  const doc = currentDoc(path)
  const asked = askServers({ kind: 'format', path, ...(range ? { range } : {}), ...indentOf(state) })
  const edits = options.waitMs === undefined ? await asked : await Promise.race([asked, new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), options.waitMs))])
  if (edits === 'late') return 'moved-on'
  if (edits === null) return 'no-server'
  if (currentDoc(path) !== doc) return 'moved-on'
  if (!edits.length) return 'unchanged'
  return applyServerEdits(path, edits) ? 'formatted' : 'unchanged'
}
