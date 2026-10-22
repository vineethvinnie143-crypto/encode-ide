# 0015. One tab model for the side and bottom panels

- Status: Accepted
- Date: 2026-10-22

## Context

Until UI-3 the right side of the window was a fixed rail: a Browse page and a Workspace page
with three more tabs inside it (Files, Editor, Shell), and the thread could be swapped for the
trajectory with a main-view switch. Nothing could be opened twice, closed and brought back, or
made wider than a narrow column, and a hidden rail unmounted its terminal, so showing it again
started a new shell.

The editor and the terminal are being rebuilt by another thread, so the panels must host them
without knowing their insides.

## Decision

- **Tabs are data.** `src/panels/model.ts` holds the side panel's tabs, which one is in front,
  its layout, and the bottom panel's tabs, as plain functions that return a new state. They are
  unit tested and free of React. `src/stores/panels.ts` keeps the state and saves it to
  `localStorage` (`eNCode.panels.v1`), repairing whatever it reads back (unknown kinds, repeated
  ids, a missing active tab).
- **What can be a tab.** The side panel takes New tab, Browser, Files, Editor, Terminal and
  Trajectory. The bottom panel takes Terminal and Jobs. Files, Editor, Trajectory and Jobs exist
  once, and asking for one again shows the one that is open. Browsers and terminals can be
  opened any number of times (up to 20 tabs).
- **New tab is a page, not a tab kind that stays.** Choosing something on it turns that page
  into the chosen tab, in the same place.
- **Layouts.** Split, full width and hidden. Full width covers the thread but keeps it mounted,
  so a draft in the composer survives. Hidden removes the panel from view but keeps it mounted,
  so a Browser keeps its page and a terminal its shell. Below 1100 px the split panel floats over
  the thread.
- **Pages stay mounted.** Every tab's page is rendered and only the one in front is shown.
- **A Browser tab keeps its page.** It stores its address (web addresses only), takes the site's
  name as its title, and comes back on that page after Reopen (`Ctrl+Shift+T`, ten tabs deep)
  and after a restart.
- **Black boxes.** `CodeEditor`, `EditorTabs` and `TerminalPanel` are hosted as they are; the
  editor's own file tabs and the terminal's own shell tabs stay inside their panes.
- **The trajectory is a side tab.** The thread is always the conversation, so the main-view
  switch is gone, and so are the activity bar, status bar and Welcome components that nothing
  rendered any more.

## Consequences

- Opening a file from Files, Search, source control or Quick Open shows the Editor tab, as it
  showed the Editor page before.
- Closing a Terminal tab does not yet end its shells; `TerminalPanel` owns that and will be
  asked to when the editor thread replaces it.
- Review (UI-4) and the side chat (UI-7) join as two more tab kinds without new layout code.
- Only the layout, tabs and widths are saved. The pages themselves (a browser's history, a
  terminal's scrollback) are not.
