# 0056. Hooks run from the trusted snapshot, and every write is kept before it is made

- Status: Accepted
- Date: 2026-10-22

## Context

0042 and 0043 built the hook runner and the checkpoint store as libraries, and 0055 gave the app one picture of a
folder's settings. Putting the two to work in the agent's loop has its own ways to go wrong:

- **A guard that is silently missing.** A `PreToolUse` hook is the one kind of hook that can refuse a call. If the
  settings that define it cannot be read, or an entry under it is skipped as a typo, the call goes through as if the
  guard did not exist.
- **A recorder that takes the agent down with it.** The record of what the agent changes shares the loop's events
  with the person's hooks. A store that fails (full disk, a folder somebody locked) must not make a prompt hook that
  guards something be skipped, and must not stop the turn with an error nobody can act on.
- **A change that cannot be undone, made anyway.** If the earlier version of a file could not be kept, a later
  "Rewind" would say it restored everything and not have. The person would find out when it mattered.
- **Hooks are code from the repository.** They run with the person's rights, and an agent's environment holds what
  the person's own shell does (tokens, keys).
- **A rewind is destructive in both directions.** It overwrites files, and it cuts a conversation. It must not run
  while the agent is writing, must not overwrite what the person edited since without being told, and must not cut
  the conversation when the files did not all go back.

## Decision

- **Hooks come from the folder's snapshot (0055).** The person's own hooks always apply; a folder's hooks apply only
  when the folder is trusted and its settings, as they are now, were approved. Settings are read again before the
  events that start something (a session, a prompt); a tool call's events use the picture the loop has just
  refreshed. While the snapshot is `broken` nothing runs, because the scope refuses every tool anyway.
- **An unreadable guard breaks the folder.** A hooks value that is not an object, an event list that is not a list,
  or any entry under `PreToolUse` (or a misspelling of it) that is skipped, is `unsafe`: the folder is broken and
  refuses everything with the reason, instead of carrying on without the guard. A typo anywhere else only costs a
  convenience and is listed as a problem.
- **Hooks run the way the agent's commands do.** The agent's shell (bash, or PowerShell where there is no bash)
  without profiles, in the folder, in the agent's environment: anything that looks like a secret is left out
  unless the settings name it in `env`, and what `env` adds is added. A `PreToolUse` hook that cannot start, times
  out or fails denies the call; where there is no shell at all every hook fails to start, so a guard denies. A hook
  stops with the turn: pressing Stop ends its process tree, and a stopped turn starts none (and denies its
  guard).
- **The record never gets in the person's way, and the write is stopped when it cannot be kept.** The recording
  hooks come first in the combined hooks and cannot throw: a failure is told to the conversation once, as a notice,
  and the prompt and tool hooks that follow run as they would have. The write itself is a different matter: the file
  tools call `beforeWrite` with the earlier bytes before they change anything, and when that fails the write fails
  with a message that names the file. A change that cannot be taken back is not made.
- **Only what the file tools change is kept**, and the Rewind dialog says so every time: commands (installs,
  builds, git) are not recorded. Paths are shown relative to the folder.
- **A rewind is a plan, then an apply.** The plan lists each file with what would happen (put back, delete, already
  as it was, left alone with the reason) and flags the files that changed since the agent last wrote them. Applying
  sends the plan's fingerprint and the choice; the host works the plan out again from the record and the disk, and a
  plan the files have moved past is refused as stale, so the dialog shows how things stand now and the person
  decides again. A flagged file is left alone unless the person ticks overwrite.
- **Only while the session is idle.** Applying holds the session's controller, so a turn cannot start in the middle
  and the dialog cannot be opened for a working session.
- **The conversation follows the files, never the other way.** Code only, conversation only, or both. The
  conversation is cut only when no file failed, the log is cut before the request, and the request's text goes
  back into the composer to be edited. The latest rewind can be undone from the notice that reports it.
- **The page only asks.** The five calls (list, plan, plan an undo, apply, cut the conversation) are IPC handlers
  for the app's top frame; the shape of an apply request is checked in the main process before it reaches the host.

## Consequences

- A failing checkpoint store stops file writes in that session until it is fixed. That is an error the person can
  read and act on; the alternative is a rewind that quietly does less than it said.
- Each matching hook starts a shell, which takes tens of milliseconds on Linux and longer on Windows. Only groups whose
  matcher matches the tool run, hooks of one event run side by side, and identical commands run once.
- The rewind is only as complete as the file tools. A command that deletes a file, or a build that rewrites a
  folder, is not undone; a checkpoint of the whole folder (a git snapshot) would cover them and is left for later
  (RP4).
- The approval of a folder's settings covers its hooks, so a hook added by a pull turns every folder grant off until
  the person reads it (0055); the Permissions screen shows the text of what waits.
