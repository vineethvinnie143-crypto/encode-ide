# 0065. The Turn view reads the agent's record, and writes back only over what the person saw

- Status: Accepted, builds on 0056 and 0064
- Date: 2026-10-22

## Context

The Review tab (0064) shows what git sees. That misses two things the person asks after every request: "what did
the agent just change?" (git mixes it with everything else in the working tree) and the same question in a folder
that has no git at all. The agent already keeps a record of every write its file tools make, with the earlier bytes
(0056), and the Rewind dialog puts a whole request back from it. What was missing is reading that record as a diff and
taking it back one change at a time. The forces:

- **The record and the disk can disagree.** A later request can change the same file again, the person can edit it,
  a formatter can rewrite it. A revert computed from the record alone would undo their work.
- **The record does not keep everything.** Files over its size limit are recorded by hash only, and files outside the
  workspace are not kept at all. Something that cannot be put back must not offer to be.
- **A revert made from the review is the person's own change.** If the record does not know about it, the next
  rewind sees a file that "changed since the agent wrote it" and flags the person's own revert as a conflict.
- **The agent may be writing.** A revert while a turn runs races the agent's tools.
- **The renderer must not hold write power.** It can ask for a revert of a hunk it was shown; the main process and
  the agent host decide what is written, and where.
- **Large requests.** A request that rewrote a thousand files must not freeze the window or fill memory.

## Decision

- **A fifth scope, the Turn view.** "Last turn" in the Review tab's scope menu shows what the latest request of the
  open conversation changed with its file tools; a chip beside it picks any earlier request that changed files. The
  change card under a request opens the view on that request ("Review changes"), and the latest card also offers
  Undo, which opens the Rewind dialog on putting that request's files back with the conversation kept. The view works
  with or without git; a folder without git offers it from the Review tab's empty state. What a card (or a step) shows
  lasts while the Review tab is open: the scope the person picks from the menu is the one the tab opens on next time
  and the one kept between runs, so a card never changes where `Ctrl+Shift+G` lands.
- **The record says what changed; the disk says where it stands.** For each file the request wrote, the "before" is
  the copy kept at its first write in that request. The "after" is the disk as it is now, or, when a later request
  wrote the file again, the copy that later request kept before its own first write (the file as this request left
  it). A file whose disk version is what it was before the request is not listed. A note says when a later request
  changed the file again, and when something other than the agent changed it since.
- **Written back only when it can be put back exactly.** A file is read only, with the reason on it, when a later
  request changed it again, when the version before the request was not kept, when its current bytes cannot be read,
  when it is outside the workspace, or while the agent is working on the conversation. Everything else can be
  reverted by hunk (the hunk is taken out by the code that drew it), by file, or all at once.
- **The host writes, and only over what was shown.** A write names the file, the hash the person saw, and the bytes
  to write or the hash of a kept copy. The agent host refuses unless the path is absolute, inside the workspace, in
  this record, outside `.git` and `.encode`, and still holds the expected hash; it keeps the bytes it replaces before
  writing, and records the write as a `wrote` line of its own, so a later rewind or review starts from the person's
  revert as the expected state rather than flagging it as a conflict. A write is refused while the agent works on the
  conversation, and holds the session while it runs, so a turn cannot start in the middle.
- **The main process checks the picture.** It reads the record again for every action, compares the file's
  fingerprint with the one the person acted on, and refuses with "changed since you looked at it" and a fresh view
  when they differ. It keeps the last 20 reverts; Undo takes back the open conversation's latest, putting each file
  back from the copy the host kept, and only over the bytes the revert wrote.
- **Bounded reads.** The view shows up to 2 MB per file and 48 MB per request. A file past those limits is listed
  without its lines, with its size; up to the 20 MB the record keeps a copy of, it is still hashed, so it can be
  reverted whole.
- **Shapes are checked at every hop.** The renderer's scope is checked in the main process (session and request ids of
  a fixed shape); the host's request schema checks hashes, limits and the file name, and only an `ArrayBuffer` passes
  as the bytes of a write.

## Consequences

- The person sees each request's own changes, in any folder, and can keep part of them without git or the Rewind
  dialog. Rewind and review agree on what is expected on disk, so neither flags the other's work.
- Changes made by commands (installs, builds, git) are still not recorded, so the Turn view does not show them; the
  Unstaged view does, in a repository.
- Reverts from the Turn view can be undone until the app closes; the kept copies stay in the record, but the undo
  list is not saved.
- Still open: a "changes since the request" view against the latest disk state for files a later request rewrote.
