# 0098. Several attempts at one request run side by side in worktrees, and the person keeps the one the Reviewer picks

- Status: Accepted, builds on 0052, 0063, 0073, 0094, 0095, 0096 and 0097
- Date: 2026-10-24

## Context

A cheap or free model gets a hard request right some of the time, not every time. 0095 to 0097 catch a wrong answer
after the fact (the checks, the scan, the Reviewer, the second look), but each catch only sends the same model back to
try again on the same path. For a change that is hard to get right, a risky refactor or a bug with several possible
causes, several independent attempts and a pick among them do better than one attempt fixed in rounds, as long as:

- the attempts cannot step on each other or on the project while they run;
- the person sees what each did before anything changes, and keeps one with a click, or none;
- what is kept is the request's work like any other, so Undo, Rewind and the Review tab see it;
- it costs nothing unless the person asks for it.

## Decision

### Asking for it

`/best [2-4] <request>` in the chat (the command list: "Make several attempts side by side and keep the best") sends
the request with `best: N` (3 when no number is given). It runs in Code mode only, from the project folder (not while
the agent works in a worktree of its own, 0073), and needs a git repository where worktrees can be made; otherwise the
send is refused with the reason ("Best of N makes a git worktree for each attempt. This folder is not a git
repository."). There is no setting: it is never used unless the person types it.

### The attempts' copies

For each attempt eNCode makes a git worktree (0073) under `.encode-worktrees/best-<tag>-<n>`, on its own branch, one
after the other (git locks the repository for each), and seeds it with the project as it is, not as HEAD has it
(`seed` in `@encode/git`):

- the files changed, added or deleted since HEAD (git's status, untracked included, ignored left out) are copied in
  and committed in the worktree as `base`, with eNCode's name, no hooks, no signature and no editor. At most 2,000
  files and 200 MB; a project with more uncommitted work is told to commit or stash some first;
- installed dependency folders git ignores (`node_modules`, `.venv`, `venv`, `.yarn`, `bower_components`) are linked
  from the project after that commit (a junction on Windows, which needs no rights), so the project's commands run;
- ignored `.env` files of at most 64 KB are copied, since the project's commands read them.

What an attempt changed is measured from `base` (`changes`): the work tree and any commit it made against the
instructions, links left out. `original` reads a file as the seed held it. Before a worktree is removed, `unlink`
takes the links out of it, so removing it can never reach what they point to.

### An attempt

Each attempt is an agent loop of its own (`best-of.ts`, `Session.attemptAgent`), run side by side with the others:

- the main agent's model (the Main role), instructions and tools, on a copy of the conversation so far, told after
  eNCode's instructions that it is attempt n of N, where its copy is, that it changes only its copy, that it does not
  commit or install dependencies (the linked folders are shared), that nobody is asked anything until the attempts end,
  and to run the checks and end with a short reply;
- its own shell, started in its worktree, its own background jobs, its own record of reads, and its own checks
  (0095), found in its worktree;
- the file tools write only inside its worktree (`onlyInside`): any other write is refused with "This attempt changes
  only its own copy of the project, in ... Write the file there instead." It reads the project as the main agent does;
- left out: what only the main agent has (subagents, plans, goals, worktrees, the desktop), `AskUserQuestion`, and the
  tools that read the project rather than the attempt's copy (`LSP`, `LSPEdit`, `CodeMap`);
- the finish gates hold it as they hold the main agent (`LoopOptions.gates`: the checks, the claim check, tests first,
  0095 and 0097), and the second look before a hard-to-undo command (0097) too. The Reviewer does not read each
  attempt before it ends (that would be paid twice); it reads them together;
- the person's approval policy holds every call. An approval goes to the person under the best-of card, its title
  starting "Attempt n: ", and an approval granted for the session counts for the attempts. A question gets a fixed
  answer: decide yourself and say so in the reply.

An attempt shows nothing of its own in the conversation: its steps become a line on its row of the card, updated four
times a second at most. Its tokens count in the request's cost.

### The pick

Once every attempt has ended, each that changed a file is put to the model of the Review role (0096) in one call with
no tools and 4 minutes at most (`judgeAttempts`): the person's last three requests, and for each attempt how it ended,
its reply (3,000 characters), what the project's checks said after its last change, eNCode's scan of its added lines
(0096) and its change as numbered hunks (about 160,000 characters for all of them, shared evenly), each fenced in a
block named with a random nonce and marked as data. It answers `{"best": n, "reason": "...", "notes": {"n": "..."}}`,
judging by whether the attempt does all of what was asked and nothing else, whether it is correct, what the checks
said, and then the smaller, clearer change.

When the Reviewer gives no verdict it can read, or cannot be asked, eNCode picks by the attempt that finished, then the
checks (passed, none, failed), then the fewest scan notes, then the smallest change, and says so: "Picked by what the
checks said and the size of the change: the Reviewer gave no verdict." An attempt that changed nothing is not judged;
when no attempt changed a file, or none finished, the run ends on that and its worktrees are removed.

### The card, and keeping one

The request's answer is a card (`EntryBest` on a notice entry): "Making 3 attempts side by side", then "The Reviewer is
comparing the attempts", then "Attempt 2 looks best" with the reason. Each attempt has a row: how it ended, "Checks
passed", "Checks failed" or "No checks run", the lines added and removed, the Reviewer's note, and its reply and files
behind a toggle. Each attempt that changed files has **Keep** (the pick's is the primary button); the card has
**Discard all**. Nothing in the project changes before Keep.

Keep (`answerBest`, `keepAttempt`) writes the attempt's changed files into the project:

- through the checkpoints (0052's `beforeWrite`), under the request's turn and as one call of eNCode's own, then
  confirmed with `wrote`, so Undo, Rewind and the Review tab see the request's work as they would the agent's;
- a file the project changed since the attempts started (it is neither what the seed held nor what the attempt wrote)
  is a conflict: nothing is written and the card names the files, with **Cancel** and **Keep anyway**;
- a path with `..` or `.git` in it, a file in the attempt that is not a plain file, a file in the project that is not a
  plain file (a link would be written through), and a folder whose real path leaves the project are refused;
- then every attempt's worktree and branch are removed, and the next request is told which attempt was kept, its
  files, and to read a file again before changing it (or that every attempt was discarded).

The main agent's conversation holds the attempts in short (each one's files, checks and reply, and the pick), so the
next request knows what was tried. A card is answered once; a second answer is refused.

### Stopping, resetting and closing

Stop during the attempts or the pick stops every attempt and removes the worktrees. A reset or a rewind that takes a
best-of card out of the conversation removes its worktrees. A run eNCode closed in the middle of is shown after the
restart as failed ("eNCode closed before the attempts ended."), and **Remove the attempts** removes what is left.

## Consequences

- A hard request can be tried N ways at once by the model the person already uses, and the person keeps the attempt
  the Reviewer (a second model when the person set one) found best, with each attempt's checks and scan in view.
- It costs about N times the request's tokens, plus one review call, and only when asked for. The attempts share the
  machine: N test runs at once are slower than one.
- `worktrees.test.ts` holds the seed (changed, new and deleted files, links and `.env` copied, limits), the changes, the
  original and the links taken out before a remove, on a real repository. `best-of.test.ts` holds the run side by side,
  the verdict and the fallback, the prompt, a write outside the attempt refused, the conflict and Keep anyway, the keep
  through the checkpoints, a link in the project not written through, the approval label, Stop, the plain refusals, a
  reset and a restart. `slash.test.ts` holds `/best`. The desktop's end-to-end run makes two attempts with the fake
  model, checks each worktree was seeded with the project's uncommitted change and the approvals' labels, has the
  Reviewer pick, keeps the pick and finds the project changed only then, the worktrees and branches gone and the keep in
  the checkpoints.
- Open:
  - An attempt's commands run in the project's sandbox (0063), which allows writes in the whole project: a command that
    writes outside the attempt's copy is not refused by eNCode, only by the person's approval policy and the
    instructions. Its file tools are refused.
  - The linked dependency folders are shared: an attempt that installs a package changes the project's.
  - The language servers and the code index read the project, not an attempt's copy, so attempts do without them.
  - Every attempt uses the Main role's model. Attempts on different models, and attempts started by the agent on a
    risky change of its own, are for the model families step.
