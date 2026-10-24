# 0105. A chat moves into a worktree and back from the chat, and brings the worktree's changes into the project

- Status: Accepted, builds on 0073 and 0098
- Date: 2026-10-24

## Context

Since 0073 the agent can work in a worktree of the project (EnterWorktree, ExitWorktree) on a branch of its own,
apart from the person's checkout. Only the model could move a chat there or back, and once the work was done there was
no way to get it into the project folder short of git by hand. Codex lets the person pick where a thread works and
hand its work to the local checkout.

## Decision

`host.worktree(sessionId, request)` runs what the person asks, with the same git work as the agent's tools:

- `enter` (`/worktree [name]`, the header's menu): a new worktree `.encode-worktrees/<name>` on `encode/<name>` from
  HEAD; the shell moves into it.
- `leave` (`/local`, the worktree chip's menu): the shell goes back to the project folder; the worktree stays.
- `remove` (the chip's menu): leave and remove it with its branch. One with uncommitted files or commits no other
  branch has is removed only after the person confirms, with what it holds named.
- `bring` (the chip's menu): copy what the worktree changed since it was made into the project folder.

None of it runs while a request runs, since the shell would move under it. The model is told with its next request:
where it works now (the worktree reminder, as when the agent moves itself), or which files the person brought in.

Bringing in shares the copy that keeps a best-of attempt (`copyChanges`, 0098): the files git reports changed in the
worktree since its base, committed or not, are written into the project. A file the project changed after the worktree
was made is a conflict, and nothing is written unless the person says to write over theirs. A file that differs from
the base only in its line ends counts as unchanged, since git may check text out with CRLF on Windows. Paths with
`..` or `.git`, anything but a plain file, a link in the project, and a path whose real folder leaves the project are
refused. The worktree keeps its own copy.

## Consequences

- A chat can work apart from the person's checkout for as long as it likes, and its work lands in one step.
- Bringing in is not a checkpoint of any request: Undo and Rewind do not take it back. The worktree still holds the
  work, and the person's own git shows the change.
- A merge of two edits to one file is not attempted; the person chooses theirs or the worktree's.
