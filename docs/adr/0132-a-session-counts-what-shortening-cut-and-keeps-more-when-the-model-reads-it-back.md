# 0132. A session counts what shortening cut, and keeps more when the model reads it back

- Status: Accepted, builds on 0093, 0095, 0130 and 0131
- Date: 2026-10-25

## Context

0130 shortens old outputs sooner and harder where the model's cache makes that cheap, and 0131 gave the benchmark long
tasks to measure what that costs in accuracy. But the bench runs a few tasks on a few models. Real sessions are where a
cut that is too deep would show, and nothing counted it: a model that needs a shortened output reads its file again or
runs the command again, an edit made from a shortened Read misses its text, a gate sends the agent back. None of that
reached the diagnostics report or a request's report, so a tester's session could not say whether shortening held.

## Decision

- **Six counts per request** (`packages/core/src/context-signals.ts`), kept with the request's usage on the person's
  message, summed per day with the rest of the usage, and carried in a request's report (0092):
  - `rewrites`: the conversation was rewritten, its old outputs shortened or its old steps summarized; `summaries` of
    them summarized.
  - `readBacks`: the model read a shortened output again. That is a Read, Grep or command naming the file that keeps
    the output whole (0093), or a Read of a file whose earlier Read was shortened and which has not changed since.
    Reading a file after editing it is no sign of anything, and each shortened output counts once, however many
    pages of it the model reads.
  - `editMisses`: an Edit or MultiEdit whose old text was not in the file, after a rewrite in the same request.
  - `checkBounces` and `claimBounces`: the project's checks or the check of what the reply claims sent the agent back
    (0095).
  - Only the main agent counts. Subagents shorten their own conversations and are not watched.
- **The diagnostics report** has a section "Context, last 7 days": requests, rewrites and summaries, read-backs and
  edit misses, and the bounces. It says HIGH when read-backs and edit misses together are at least three and a fifth of
  the rewrites or more.
- **An automatic back-off.** The session keeps a watch across its turns. Once the model has read back three shortened
  outputs in the session, every later rewrite keeps one more step whole (of command output and of what the model finds
  code by alike) and twice the characters of each old output: 3,000 rather than 1,500 for most models, 1,600 rather
  than 800 for Claude's. The rest of the profile (when shortening starts, when a rewrite pays) stays as 0130 has it.

## Consequences

- A tester's diagnostics now show whether shortening holds on their model. A HIGH there, or a request's report with
  read-backs, is what tunes the profiles next, with the long tasks of 0131 to check a change.
- The back-off costs tokens only in a session that showed it needed them: a session that never reads back pays
  nothing more. It does not last past the session object: after a restart a session starts at the normal profile and
  backs off again if it has to.
- Counting a read-back by the paths a call names misses one done another way (the model running the same command
  again). Running a command again is ordinary (tests after an edit), so it is not counted.
- The counts are numbers only. What the files and outputs said never goes into the usage records, the diagnostics or
  the report's new field.
