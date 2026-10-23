import type { EditorChangeRequest, EditorChangeResult } from '@shared/types'
import { api } from '../../api'
import { useEditor } from '../../stores/editor'
import { useGit } from '../../stores/git'
import { useWorkspace } from '../../stores/workspace'
import { applyServerEdits, currentDoc, hasDoc, isDirty, openDocPaths, revertServerEdits, type ServerEdit } from '../docs'
import { flushLanguageSync } from '../language'

type Applied = Extract<EditorChangeResult, { done: 'applied' }>

/** A change as the editor asks for it; the files it has open are added on the way. */
export type ChangeAsk =
  | { kind: 'rename'; path: string; line: number; character: number; newName: string; preview: boolean }
  | { kind: 'action'; path: string; list: number; id: number; preview: boolean }
  | { kind: 'apply'; id: number }
type Preview = Extract<EditorChangeResult, { done: 'preview' }>

export type ChangeOutcome =
  | { ok: true; applied: Applied; /** Open files whose part of the change could not go in: they changed meanwhile. */ skipped: string[] }
  | { ok: true; preview: Preview }
  | { ok: false; reason: string }

/** The last change applied, while the editor can take it back as a whole: its edits to the editor's documents. */
let last: { id: number; edits: ServerEdit[]; written: Set<string> } | null = null

/** Sends every change still waiting for a pause in typing, so that the servers plan for the text as it is. */
async function settled(): Promise<string[]> {
  // A change asked for while the editor hands out a transaction waits for its listeners, as a question does.
  await Promise.resolve()
  const open = openDocPaths()
  for (const path of open) flushLanguageSync(path)
  return open
}

/** The tree and git read the folder again: a change can write files nobody has open. */
function refreshFolder(): void {
  void useWorkspace.getState().refreshAll()
  void useGit.getState().refresh()
}

/**
 * A rename or a code action across the folder (or a preview applied): the servers plan it, the agent host changes the
 * files on disk, and what it changes in the files the editor has open goes in here, each as one undo step of its own.
 */
export async function makeChange(request: ChangeAsk): Promise<ChangeOutcome> {
  const open = await settled()
  const before = new Map(open.map((path) => [path, currentDoc(path)]))
  const result = await api.code.edit({ ...request, open } as EditorChangeRequest).catch(() => ({ ok: false as const, reason: 'The change could not be made.' }))
  if (!result.ok) return { ok: false, reason: result.reason }
  if (result.done === 'preview') return { ok: true, preview: result }
  if (result.done !== 'applied') return { ok: false, reason: 'The change could not be made.' }
  const edits: ServerEdit[] = []
  const written = new Set<string>()
  const skipped: string[] = []
  for (const item of result.editor) {
    // The document must still be the one the servers planned for: one typed in meanwhile keeps what was typed.
    const doc = currentDoc(item.path)
    if (!doc || doc !== before.get(item.path)) {
      if (!skipped.includes(item.path)) skipped.push(item.path)
      continue
    }
    const edit = applyServerEdits(item.path, item.edits, { saved: item.written })
    if (!edit) {
      skipped.push(item.path)
      continue
    }
    before.set(item.path, edit.after)
    edits.push(edit)
    if (item.written) written.add(item.path)
    useEditor.getState().setDirty(item.path, isDirty(item.path))
  }
  // A file the change moved takes its tab along, and one it deleted closes.
  for (const move of result.moved) if (hasDoc(move.from)) useEditor.getState().renamePath(move.from, move.to)
  for (const path of result.deleted) if (hasDoc(path)) useEditor.getState().closeTabsUnder(path)
  last = result.undo && !skipped.length ? { id: result.id, edits, written } : null
  refreshFolder()
  return { ok: true, applied: result, skipped }
}

/** Lets a preview go. */
export function discardPreview(id: number): void {
  void api.code.edit({ kind: 'discard', id }).catch(() => undefined)
}

/** Whether the change with this id can still be taken back as a whole. */
export function canUndoChange(id: number): boolean {
  return last?.id === id
}

/**
 * Takes the last change back as a whole: the agent host puts the files on disk back while they still hold what it
 * wrote, and the editor's documents go back here while they still hold what it put in.
 */
export async function undoChange(id: number): Promise<{ ok: true; skipped: string[] } | { ok: false; reason: string }> {
  const change = last
  if (!change || change.id !== id) return { ok: false, reason: 'That change can no longer be taken back as a whole. Use Undo in each file instead.' }
  const open = await settled()
  const result = await api.code.edit({ kind: 'undo', id, open }).catch(() => ({ ok: false as const, reason: 'The change could not be taken back.' }))
  if (!result.ok) return { ok: false, reason: result.reason }
  if (result.done !== 'undone') return { ok: false, reason: 'The change could not be taken back.' }
  last = null
  const restored = new Map(result.editor.map((item) => [item.path, item.written]))
  const skipped: string[] = []
  // Last first: a document changed twice goes back through both.
  for (const edit of [...change.edits].reverse()) {
    if (!revertServerEdits(edit, { saved: restored.get(edit.path) ?? false })) {
      if (!skipped.includes(edit.path)) skipped.push(edit.path)
      continue
    }
    useEditor.getState().setDirty(edit.path, isDirty(edit.path))
  }
  for (const path of result.deleted) if (hasDoc(path)) useEditor.getState().closeTabsUnder(path)
  refreshFolder()
  return { ok: true, skipped }
}

/** "1 place" or "3 places": a count with its noun. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
