import { diffLines, type DiffOptions } from '@encode/diff'
import { ChangeSet, type Text } from '@encode/text'
import { replaceLines } from './review'
import type { EditorState, Transaction } from './state'

/** The change that turns `doc` into `text` (lines separated by "\n"), as small as the line diff finds it. */
export function reloadChanges(doc: Text, text: string, options: DiffOptions = {}): ChangeSet {
  const next = text.split('\n')
  const { blocks } = diffLines(doc.lineTexts(), next, options)
  return ChangeSet.of(
    blocks.map((block) => replaceLines(doc, block.fromA, block.toA, next.slice(block.fromB, block.toB))),
    doc.length,
  )
}

/**
 * A transaction that brings the document in line with `text`, which was
 * changed from outside (the agent, another program). Only what differs is
 * replaced, so the cursor stays where it was, the scroll position holds and
 * the highlighter re-reads just those lines; the reload is one undo step.
 * Null when nothing differs.
 */
export function reload(state: EditorState, text: string, options?: DiffOptions): Transaction | null {
  const changes = reloadChanges(state.doc, text, options)
  if (changes.empty) return null
  return state.update({ changes, origin: 'external', isolateHistory: true, scrollIntoView: false })
}
