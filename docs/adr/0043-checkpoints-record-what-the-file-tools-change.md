# 0043. Checkpoints record what the file tools change, and rewinding never overwrites silently

- Status: Accepted
- Date: 2026-10-21

## Context

"Rewind to this turn" must put files back without a copy of the workspace per turn, and
without destroying work the agent did not do.

## Decision

- The file tools call `ToolContext.beforeWrite` with a file's previous bytes. The first time
  a turn touches a file those bytes are saved (gzip, named by SHA-256, shared by all
  sessions of a workspace), and the session's manifest gets a line. The `postToolUse` hook
  then records what the call left on disk.
- Rewinding to turn T restores every file touched since T began to the earliest version saved
  after T started, deletes what the turn created along with the folders its writes made, and
  can be undone in one step while the conversation has not moved on.
- A file the agent did not leave as it is (the user, a build or a shell command changed it, or
  the agent's last write was never confirmed) is a conflict, and is overwritten only when the
  caller forces it.
- Applying a plan re-derives everything from the manifest and the disk. The plan handed to a
  UI carries a fingerprint, so a plan that went through a renderer cannot name other files.
- Each target is checked on its real path right before it is written: inside the workspace or
  an allowed folder, never in `.git` or `.encode`. Restored bytes are checked against their
  hash, and a rewind journals what it is about to replace first, so a crash half way leaves a
  way back.

## Consequences

- Only changes made through the file tools are recorded. A shell command's side effects are
  not, and the agent must be idle while a rewind runs. File modes and owners are not saved.
  Threat model RP4.
- Redo restores files, not the conversation. The core truncates its session log when it
  applies a rewind (`SessionLog.truncateAfter`).
- The checkpoint hooks go first in `combineHooks`, so a later hook that blocks a result cannot
  stop the record of what is on disk.
