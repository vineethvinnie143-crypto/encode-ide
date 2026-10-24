# 0106. eNCode's profile is off limits to the agent, and the files a folder brings are read with care

- Status: Accepted, builds on 0061, 0063 and 0093
- Date: 2026-10-24

## Context

eNCode's profile folder (Electron's `userData`: `%APPDATA%\eNCode`, `~/.config/eNCode`,
`~/Library/Application Support/eNCode`) holds the keys (encrypted with the system's store), the browser's sign-ins
(`persist:encode-browser`), every chat and its checkpoints, the logs and the trust records. Nothing stopped the agent
from reading it: under Full access a Read, a Grep from the home folder or a `cat` went through, and under the other
policies it was one approval away, worded like any other file outside the workspace. A prompt injected into a page or a
repository could ask for exactly that. One folder inside the profile is the agent's own: the long results kept for its
session (0093), which it is told to read back.

Three smaller gaps were left open by earlier steps: settings and server files a repository brings were read with a
plain read (RP11); the git folders of submodules and a hooks folder named by `core.hooksPath` were not held by the
sandbox (RP14); and a window whose page crashed stayed blank.

## Decision

### The profile is off limits under every policy

The host takes `offLimits: { folders, except }`; the desktop passes its profile, with the sandbox's own folders inside it
(its temp folder, on Windows its package caches) as exceptions. Each session adds its own results folder,
`sessions/outputs/<session>`, to the exceptions. Paths are compared as real paths.

- **Approvals.** Before anything else, `decideApproval` refuses a call that names an off-limits path, under every
  policy and whatever a rule allows, with a reason the model can relay: a read or an edit by its paths, a command by
  the words that could be paths (as the rules' check reads them) and by its text, where the folder can also be spelled
  from `~` or through a variable of the shell's that holds one of its parents (`$HOME/.config/eNCode`,
  `$env:APPDATA\eNCode`, `%APPDATA%\eNCode`, `${XDG_CONFIG_HOME}/eNCode`). A name that only starts the same
  (`eNCode-dev`) is not the folder.
- **Searches.** Glob and Grep do not enter an off-limits folder, nor read a file linked into one, wherever they start.
  A search that starts in the session's own results folder searches it.
- **Reading back.** The files re-read after a summary are never taken from the profile.
- **The sandbox.** On Linux and macOS the profile is one of the paths commands cannot read (bubblewrap mounts an
  empty folder over it, Seatbelt denies reads), whatever the sandbox settings say. A writable folder inside it, the
  sandbox's temp folder, stays usable: bubblewrap mounts it again after hiding the profile, and Seatbelt allows reading
  it again after the denial. On Windows the sandbox holds writes only (RP12), so the approval check is what holds
  reads there.

The command check is a floor: a command that builds the folder's name while it runs (`$a + 'Code'`) gets past it.
Where commands are not otherwise asked about (Full access, or a command Auto review passes), that is the gap, and the
threat model says so.

### Files a folder brings are read as regular files of bounded size

`@encode/config`'s reader opens a file so that a named pipe cannot block it, reads only a regular file of at most
4 MB, and, for a file the folder brings (`.encode/settings*.json`, `.mcp.json`, `.encode/mcp.json`), refuses a link
instead of following it. The person's own files (`~/.encode/...`) may still be links. A refused file is a settings
source that could not be read, which the trust rules already treat as unsafe.

### The sandbox holds submodules and a configured hooks folder

Besides `.git/hooks` and `.git/config`, the sandbox keeps read-only, for every git folder of the session: the
`hooks`, `config` and `config.worktree` of each submodule's git folder under `modules/` (nested ones and names in
several parts included, up to 64 found and 8 levels deep), and the folder `core.hooksPath` names, with the folder
above husky's `.husky/_`. A submodule without a hooks folder gets an empty one first, as the repository does.

### A window whose page stopped offers to reload

When the window's renderer process crashes, runs out of memory or is killed, eNCode says so in a message box: what
happened, that chats and running agents are kept (they live in other processes) and that edits not yet saved in the
editor are lost, with Reload (the default, also on closing the box) and Quit. After three stops in a minute the box
says the window keeps stopping and points to a diagnostics report.

## Consequences

- A prompt injection cannot read the keys, the browser's sign-ins or other chats through a file tool or a search,
  under any policy, nor through a command on Linux and macOS.
- The agent's own long results and its commands' temp files stay as usable as before.
- A repository cannot make eNCode follow a link out of it, block on a pipe or read a huge file through its settings.
- On Windows a command that spells the profile's name at run time can still read it under Full access or when Auto
  review passes it; holding reads there needs more than a program without administrator rights can set up (RP12).
