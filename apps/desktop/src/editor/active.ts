import type { EditorView } from '@encode/editor-view'

/** The editor on screen, for commands run from the palette: they act on it as its own keys would. */
let active: EditorView | null = null

export function setActiveEditor(view: EditorView | null): void {
  active = view
}

/** True while the editor shows a file. */
export const hasActiveEditor = (): boolean => active !== null && active.root.isConnected && active.root.clientHeight > 0

/** Runs one of the editor's commands ("goToDefinition") with the focus in the editor; false when none is on screen. */
export function runEditorCommand(name: string): boolean {
  if (!active || !hasActiveEditor()) return false
  active.focus()
  return active.runCommand(name)
}
