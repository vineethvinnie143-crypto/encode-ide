# 0031. Sessions are append-only logs

- Status: Accepted
- Date: 2026-10-21

## Context

M0 kept every session in one JSON file that was rewritten whenever anything changed. A crash
during a write could take every conversation with it, the file grew with the whole history, and
it held only what the user saw. What the model saw (system prompt, tool list, message blocks,
thinking signatures) was rebuilt on load, so a reopened session could not continue exactly where
it stopped, and prompt caches went cold.

## Decision

- **One file per session**, `<sessions folder>/<id>.jsonl`, in a folder only the user can read
  (mode 0700, files 0600 where the platform has modes). Each line is one record with an id and a
  time. Records are only appended:
  - `session` (the header, first), `context` (the system prompt and tool list as sent),
    `message` (what the model saw), `entry` (what the user saw; a later record with the same id
    replaces it), `compaction`, `truncate` (a rewind), and the latest-wins records `title`,
    `goal`, `todos`, `plan` and `meta` (project, pinned, archived, unread).
  - A user prompt's message id, entry id and turn id are one string, so a client rewinds from
    the entry it shows.
- **Replay rebuilds the session.** A line that does not parse is skipped, and the next append
  starts on a fresh line, so a crash costs at most the line being written. A log written by a
  newer version is refused rather than misread.
- **An index** (`index.json`) lists sessions without reading every log. It is a cache: it is
  rebuilt when missing, damaged or older than a log. Records that only change a mark or a
  side-record do not change a session's last-activity time.
- **The system prompt and tool list are stored once and replayed as stored.** Nothing earlier in
  a conversation is edited, which keeps prompt caches warm and keeps providers that bind
  thinking blocks to the conversation before them from rejecting it. Compaction is the one
  rewrite of the model's view, and it is a record too; the transcript the user sees stays whole.
- **A fork** is a new log whose header names the session and record it was cut from, with the
  records up to that point copied.
- **No automatic pruning.** Conversations are the user's. Nothing deletes or truncates a log
  except the user removing the session (or rewinding it).
- **M0's single file is imported once**, on the first start, and renamed afterwards. Its
  transcript is kept as it was shown; the model-facing side used another message format and
  other tool names, so it is carried over as a summary of what was said in the first message.

## Consequences

- Sessions survive crashes and kills, and reopening one continues the same model-facing
  conversation.
- A log is plain text a person can read, tail or copy, and an export is a copy.
- Logs only grow. Compaction shortens what the model sees, not the file. A disk-usage view with
  an explicit "delete older than…" is possible later; automatic deletion is not planned.
- Logs hold what the user and the tools put in them, which may include secrets from a file the
  agent read. They are protected as the user's files are and are never uploaded. Anything that
  sends a log elsewhere (a bug report) must ask first.
- The format is versioned (`SESSION_FORMAT`). A change that old readers cannot replay raises it.
