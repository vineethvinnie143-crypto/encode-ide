# 0064. The Review tab reads git itself, and stages a hunk the way `git add -p` does

- Status: Accepted, builds on 0033, 0060 and 0063
- Date: 2026-10-22

## Context

The agent changes files, and the person needs one place to read those changes, keep or drop them piece by piece,
send notes back to the agent and commit what they keep. Codex and Claude Code both give that place; eNCode had a
list of changed files and the editor. The forces:

- **A hunk must be exactly what is shown.** Staging or reverting part of a file acts on what the person read. If the
  screen and the action come from two different diffs (git's for the action, ours for the screen), they can disagree
  on where a hunk starts, and the wrong lines move.
- **Files change under the screen.** The agent, a formatter or the person's editor can write a file between the moment
  it is shown and the click. Acting on the old picture would undo their work without anyone seeing it.
- **Line endings and filters are git's business.** On Windows git usually converts endings (`core.autocrlf`), and a
  repository may have clean filters. What goes into the index must be what `git add` would have put there.
- **Reverting is destructive.** It writes over the working file, and for a new file deletes it.
- **A repository's settings can start programs.** Git runs `core.fsmonitor` on a read, hooks on a commit and filters
  when staging. The repository belongs to the person, but the agent writes inside it.
- **Reviews can be large.** A lockfile, a generated bundle or thousands of files must not freeze the window.
- **The folder opened may be a folder inside the repository**, and the editor and the agent name files from that
  folder while git names them from the repository's top.

## Decision

- **`@encode/git` reads the scope itself and compares with eNCode's own diff.** Four scopes: Unstaged (the working tree
  against the index, new files included), Staged (the index against HEAD), Branch (the working tree against where the
  branch left its base; the base defaults to the remote's default branch, else main or master) and Commit (one commit
  against its first parent). What changed comes from `git status --porcelain=v2 -z` and `git diff --raw -z -M
  --no-abbrev`; both sides of every file are read once, objects through one `git cat-file --batch` and working files
  from the disk, and diffed by our diff with word marks. Lines are compared without their endings, so a file whose
  endings git converts shows only its real changes; a change no line shows (the endings, a byte order mark, the mode)
  is said in a note. A file over 2 MB, or past 48 MB read in one review, is listed without its lines; binary files,
  submodules, links and folders are named, not drawn.
- **A hunk is staged the way `git add -p` stages it.** The index entry's content is read, the hunk is put in (or taken
  out, to unstage) by the same code that drew it, and the result is written with `git hash-object -w --stdin
  --no-filters` and set with `git update-index --cacheinfo`. Unchanged lines keep their own endings and new lines take
  the file's usual one, so the index holds what git would have put there. Reverting a hunk writes the working file the
  same way. Whole files go through `git add`, `git reset` and `git checkout`, so filters apply as usual, and a file
  whose attributes give it a filter or another encoding is only staged or reverted whole: a hunk written without the
  filter would not be what `git add` writes.
- **Every action checks the file first.** A file carries a fingerprint of both sides as shown; an action reads them
  again and refuses, with "changed since you looked" and a fresh review, when they differ. Actions run one at a time.
- **Reverts can be taken back.** Before a revert writes, the files' bytes are kept (up to 8 MB each, the last 20
  reverts); Undo, or Ctrl+Z in the tab, puts them back if nothing touched them since. A new file that is reverted goes
  to the Recycle Bin, not to nothing. Revert all asks first.
- **The commit message is drafted, never committed unread.** Opening Commit asks the Small tasks role for a message
  from the staged changes (cut to 24,000 characters) and the last subjects, with the changes framed as data. The person
  edits it; nothing is committed until they press Commit. Typing while the draft runs keeps their words. Commit and
  push sends the branch to its upstream, or sets one on `origin` (or the only remote, when there is one).
- **Comments go to the agent as one message.** A comment sits on a line of the diff; Send hands all of a view's
  comments to the agent at once, each with its file, its line and the line quoted, or queues them while a turn runs.
  Files are named from the open folder, or by full path when outside it.
- **The app's git is the person's git, with the program-starting reads closed.** eNCode's own git runs by absolute
  path (a `git.exe` in the folder is never picked), with `core.fsmonitor=false` and `safe.bareRepository=explicit` on
  every command, `GIT_OPTIONAL_LOCKS=0`, no terminal prompts, paths taken literally and the variables that point git
  at another repository dropped. Commit and push run the repository's hooks, and staging its filters, as git would for
  the person: the sandbox keeps `.git/hooks` and `.git/config` out of the agent's reach (0063), which is what lets the
  person's own tools trust them.
- **The renderer asks, the main process decides.** Every request is checked in the main process before git sees it:
  known scopes and actions, branch names that cannot read as options, hunk ids and fingerprints of fixed shapes, paths
  that must be inside the repository and be in the review, a message under 64 KB.
- **Drawn for size.** The list draws only the rows on screen; row heights are known in advance (wrapping is counted
  in monospace columns), comments are measured, and the place being read stays put when rows above it change. Large
  generated files (lockfiles, minified code, source maps, snapshots, over 1,500 changed lines) start folded.
- **Paths are named from the repository's top**, and the snapshot says where the open folder sits in it, so the editor,
  the agent and Source control can each be given the name they use.

## Consequences

- What the person stages is what they saw, on Windows endings included, and nothing is staged or reverted from a stale
  picture. A hunk is taken only with its whole file when whitespace is hidden, the file is binary, too large, not
  UTF-8, a link, filtered or in conflict, or the diff ran out of time; the tab says why.
- The tab works without the agent and without a model: drafting a message is the only part that needs one, and it
  can be skipped by typing.
- Hooks still run on commit, as the person expects. On Windows the sandbox holds them best effort (0063), so a command
  run outside the sandbox could plant one; that is the sandbox's residual risk, not a new one.
- Still open: review of a pull request from the forge; staging single lines. The "Last turn" scope built from the
  agent's checkpoints, and Undo on the change card, are 0065.
