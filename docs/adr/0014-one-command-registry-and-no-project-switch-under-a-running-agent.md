# 0014. One command registry, and no project switch under a running agent

- Status: Accepted
- Date: 2026-10-22

## Context

The window shell (UI-1) adds a menu bar, an icon rail, a project sidebar and about 40 shortcuts.
Until now each menu item and each shortcut carried its own copy of what it does, in a menu
component and in a key handler, so a command could have two titles, two implementations and a
shortcut that the menu did not show.

Two things about how sessions work made the sidebar unsafe as it was first drawn:

- The agent acts on the one folder that is open (`WorkspaceService.current`). Opening another
  project while a session runs or waits for an answer would point that session's next edit or
  command at the wrong project.
- A session that waited for an approval or a question lost its card when you left it, and the
  agent stayed stuck until you stopped it: the history sent to the renderer did not carry the
  pending card.

## Decision

- **One registry.** `src/commands` holds every command (`commands.ts`), the menus' structure
  (`menus.ts`) and the registry (`registry.ts`). Menus, the keymap, tooltips and the `Ctrl+/`
  list all read it, and the command palette (UI-5) and rebinding (UI-6) will too. Unit tests
  keep it honest: no shortcut is bound twice, every menu item is a command and every command is
  in its menu, every shortcut parses.
- **One keyboard handler.** `useKeymap` is the only global key listener. Letters follow the
  keyboard layout (Ctrl+Z is the key labelled Z, with a position fallback for layouts without
  Latin letters), digits and punctuation go by position so Shift does not change them, and a
  character typed with AltGr never matches a shortcut. In a text field only chords with Ctrl, Alt
  or a function key act. While a dialog is open only quit, zoom and full screen do.
- **Sessions record their project.** A session stores its folder (`projectRoot`, or none), and
  whether it is pinned, archived or unread (`electron/agent/sessions.ts`). Files from earlier
  builds load unchanged. An unused session with no project joins the folder that is open.
- **No project switch under a running agent.** Opening a folder, or a session from another
  project, is refused while any session is thinking, running a tool or waiting for you. The
  check sits in the workspace store (`canSwitchProject`), so the menus, the sidebar, the project
  switcher and the welcome screen all obey it. Opening the folder that is already open is always
  allowed.
- **Pending cards survive.** `Agent.getHistory` returns the approval or question still waiting,
  so a session you come back to, or a reloaded window, shows its card again.

## Consequences

- A command is added in one place and appears in the menu, the shortcut list and the keymap.
- While one session runs you cannot open a session from another project. That limit goes away
  when worktrees (UI-7) give each session its own folder.
- The sidebar can show live state for every session (spinner, amber dot, accent dot) and the rail
  badge can count the ones that need you, because the status of each session is tracked from the
  agent's events.
