# 0068. Settings is a page that keeps each change as it is made, and a chat is a session in a folder of its own

- Status: Accepted, builds on 0052, 0054, 0066 and 0067
- Date: 2026-10-23

## Context

Settings were a dialog with tabs and a Save and Cancel footer. People look for a setting by what it does, not by the
tab it is on; a change that waits for Save is lost when the dialog closes another way; and the dialog covered the
thread, so it could not stay open while the agent worked. Four more things people expect from a coding agent's window
came with the page, each with a trap:

- **Sessions without a project.** A quick question needs no repository. A session with no folder runs its tools in
  whatever folder happens to be open (how sessions from before projects behave), so a chat could write into the last
  project.
- **Being told when the agent is done or needs you.** Windows keeps a notice in its notification centre after eNCode
  closes, where anyone at the computer can read it. A model's reply or a provider's error can quote code, paths or
  keys.
- **Keeping the computer awake** while an agent works, without keeping it awake forever.
- **The keys on the page.** The thread stays under the page with an approval that may be waiting. Enter and Esc
  answer an approval from anywhere in the window (0067), and a key the page used could reach it too.

## Decision

- **Settings is a page over the sessions and the work area.** They stay mounted under it, hidden and inert, so a draft,
  a terminal or a browser page is as it was when the page closes, and the agent keeps working. The sections are
  General, Notifications, Appearance, Keyboard shortcuts, Models, Roles, Agent, Permissions, MCP servers, Sandbox and
  Archived sessions. One list in the renderer (`components/settings/sections.ts`) gives the navigation, the page's search
  and the command palette every section and the settings in each, by label and other words; the palette lists single
  settings only once something is typed. Ctrl+, opens the page where it was left, with the focus in its search; a
  setting found from the search or the palette is scrolled to, marked and given the focus. Esc leaves the page once
  whatever on it used the key (a menu, a field's edit, the search) has had it, and the focus goes back where it was.
- **A change is kept as it is made.** A switch, a choice or a list saves at once; a text field saves when it loses the
  focus or on Enter, and Esc puts back what is saved. A key is stored only with its own Save key button, so half a key
  is never kept. The window's copy changes at once and only the answer to the latest save is applied, so fast changes
  do not flicker back. The main process checks every field as before; nothing the page sends is trusted further.
- **Keys on the page.** App shortcuts work on it. A command that acts on the app (anything but settings, the palette,
  quit, save, zoom, full screen, the theme, editing and help) leaves the page first. Keys meant for the thread do nothing
  while the page is open: Enter and Esc on an approval, and the double Esc that stops the agent. The Esc that leaves the
  page goes no further, and an approval card ignores an Esc something else used, so an approval that came up while the
  page was open is not answered by leaving it.
- **A chat is a session in the chats folder.** File > New chat, the Chats section's +, and Ctrl+Alt+O open the chats
  folder as the work folder, then make the session in it; when the folder cannot be opened (an agent works, an unsaved
  file is kept), nothing is made. A chat's tools run in that folder under the same rules as any project: permissions,
  the protected `.encode` and `.git`, trust, the sandbox. The folder is Documents\eNCode unless the person picks another,
  and only the system's folder dialog in the main process picks one: a path the window sends is never taken. A whole
  drive, the home folder, and a folder that holds eNCode's own files or lies in them are refused, from the dialog and
  from a hand-edited file. The chats folder is never listed as a project (recent folders, the switcher, Projects).
  Sessions with no folder from before projects are listed under Chats.
- **Notices name the session and say what happened in eNCode's words.** When a request finishes and when the agent
  needs the person: Never, In the background (the default: another window in front or eNCode minimized) or Always.
  A notice's title is the session's name and its text is eNCode's own sentence (Finished, Stopped with an error, Wants
  your approval): never the model's reply or an error's text. Clicking one opens that session. A request that ends and
  starts again within 2 s (a goal's next round, a queued message) has no notice, and one the person stops has none.
  The taskbar button flashes while the agent waits for the person in the background and stops when they come back.
  Test shows one whatever the settings say. A test run writes notices to `ENCODE_NOTICES_FILE`; a packaged build never
  does.
- **Keeping awake holds off sleep only while an agent works.** While any agent thinks or runs a command, eNCode asks
  Windows not to suspend (the screen may still turn off); 15 s after the last one stops it lets go, and it never holds
  off sleep while the agent waits for the person. On by default, a switch in General.
- **The send key is the person's choice.** Enter sends and Shift+Enter starts a line, or Ctrl+Enter sends and Enter
  starts a line. The other follow-up (steer or queue, 0067) moves to Ctrl+Enter or Ctrl+Shift+Enter with it, and every
  hint, button and setting names the keys in use. A picker keeps Enter to choose.
- **Archived sessions** lists every archived session with its project, or Chat, newest first: Restore (with Open in its
  notice) and Delete, which asks first. Past 8 it has a field to find one by name.

## Consequences

- Every setting is a search away, from the page or the palette, and a change cannot be lost to a missed Save; it is
  undone by changing it back.
- Chats have a place on disk, so the files they make are kept, and their tools have a folder's rules instead of the
  last project's.
- A notice can be left on the screen or in Windows' history without showing what the agent wrote.
- The page shares the window with a running agent: nothing on it can answer an approval, and the thread is exactly as
  it was when the page closes.
- Still open: the theme engine, adding and removing MCP servers, agents and skills, personalization, usage and the
  computer use section (UI-6b); the browser, side chat and worktrees (UI-7); keeping the agent out of eNCode's own
  folder whatever folder is open (hardening).
