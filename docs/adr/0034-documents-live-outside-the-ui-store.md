# 0034. Open documents live outside the UI store, and "unsaved" is derived from the text

- Status: Accepted
- Date: 2026-10-21

## Context

The first editor kept every tab's text in the UI store. That meant a store update and a
full-string comparison (`content !== savedContent`) on every keystroke, a flag that could go
stale, no undo history across tab switches, a save that marked the document saved even if
the user had typed while the file was being written, and a change on disk that replaced the
whole text and threw away the cursor.

Two data-loss paths also sat around the editor. Tabs held paths relative to the workspace,
so after switching project a leftover tab saved into the new project's file of the same
name. And "close others" dropped unsaved tabs without asking.

## Decision

`apps/desktop/src/editor/docs.ts` is a registry from workspace-relative path to an entry:
the `EditorState` (document, selection, history), the text last read from or written to
disk, its history point, the scroll position and the view that shows it, if any. It is plain
TypeScript with no React and no Electron, so it is unit tested. The UI store keeps only what
the UI shows: tab path, name, language id and the unsaved flag, plus the cursor position and
indentation for the status bar.

- **Unsaved** means: the history point differs from the saved one and the text differs.
  Equal points cost nothing; the text is compared only when the points differ but the
  lengths agree (typed, then deleted again). The view reports the answer after every
  transaction.
- **Saves** take a snapshot (text as written, document, point) when they start, and mark
  exactly that snapshot saved once the write succeeds. Typing during the write stays
  unsaved. The text is written with the line ending the file had. Before writing, a save
  reads the file and compares it with the text last read or written there; if someone else
  changed it, the save asks (Overwrite or Cancel) and Cancel leaves the changes unsaved.
  A file that is gone or unreadable is written as before.
- **Changes on disk** are applied only to a document with no unsaved changes, through the
  view that shows it, as a line diff with its own history group. The cursor and scroll stay,
  the new text becomes the saved text before the view hears about it (so it is never
  reported as edited), and undoing the reload is possible and then counts as unsaved. A
  document with unsaved changes keeps the user's version.
- **Paths.** Renaming a file or folder moves its documents and re-derives their language.
  Deleting closes them. Opening, switching or closing the project first asks about unsaved
  changes, then drops every document; they are paths in the old project and cannot be
  saved into the new one. Closing a tab, closing the others and closing all ask before
  discarding.
- **One view.** A single `EditorView` shows the active tab through `setState`, so switching
  tabs keeps each document's selection, undo history and scroll position, and unmounting
  the view (the side panel closing) loses nothing.

## Consequences

- Typing does not touch the UI store except when the unsaved flag changes.
- Undo history survives tab switches and the panel being hidden, for as long as the tab is
  open. Memory is bounded by the open tabs.
- A change on disk while a document has unsaved changes is neither shown nor merged. The save
  asks before it overwrites, but the prompt carries no comparison, and the check and the write
  are two steps ([threat model](../security/threat-model.md), ER3). A compare view is the
  follow-up.
- The agent's edits (M1) reach the editor the same way, as `applyExternal` for a clean
  document, and will feed the review baseline.
