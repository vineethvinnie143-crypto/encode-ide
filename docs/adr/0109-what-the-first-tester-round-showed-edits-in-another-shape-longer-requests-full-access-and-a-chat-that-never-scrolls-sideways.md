# 0109. What the first tester round showed: edits in another shape, longer requests, Full access, and a chat that never scrolls sideways

- Status: Accepted, builds on 0009, 0063, 0089, 0097 and 0107
- Date: 2026-10-24

## Context

The first tester worked with free models on a project that lives on a virtual machine. Their reports, with
screenshots:

- **Edits failed.** Rows read "Edit" with no file, and the agent tried again and again. The free models mixed the
  shapes of Edit and MultiEdit (a list of edits sent to Edit, one replacement sent to MultiEdit), wrote the
  SEARCH/REPLACE blocks other coding agents use, or added a parameter of their own (`explanation`). A call that failed
  its schema reached the loop as `invalid` with an empty input, so its row showed neither the file nor what was wrong.
- **The agent stopped by itself**, which looked like it happened after an automatic compaction. The cause was the
  limit of 30 steps per request: a request on a real project takes more, and every settings file held 30. A weaker
  model also tends to end its turn with a progress report right after a compaction, as if the summary were the answer.
- **Full access still showed cards.** The card was for `ssh` to the machine, which asked to leave the sandbox. 0063
  made leaving the sandbox ask under every approval policy, Full access included.
- **The approval card's amber border** did not belong in the black and silver theme of 0107.
- **The chat scrolled sideways**, and a maximized window showed a wide empty band on the left: one long line in a diff
  or a command's output widened the whole thread.

## Decision

### Edits sent in another shape are read as meant (extends 0089)

- A tool may say how a call sent in another tool's shape reads in its own (`Tool.reshape`). The registry tries it only
  when the call fails its schema, keeps the result only when it then passes, and may run it as another tool when the
  agent is offered that tool. A call that passes is never changed.
- Edit and MultiEdit read: a list of one edit sent to Edit as `old_string` and `new_string`; a list of several sent to
  Edit as MultiEdit, all or none; one replacement sent to MultiEdit as a list of one; the `str_replace` command of a text
  editor tool; a list written as JSON text; and SEARCH/REPLACE blocks in either marker style. A call with both a
  replacement and a list, or with line numbers in place of text, has no single reading and is refused as before.
- A parameter that only explains the call (`explanation`, `reason`, `thought`, `summary` and the like) is left out when
  the tool takes no such parameter and accepts no others.
- The row of a call is named after the tool that ran it, says how the call was read, and, when the call is refused,
  shows the input that was sent, so the file it named and the reason are on screen.

### A request takes up to 200 steps, and goes on after a compaction

- The default is 200 steps per request; the setting takes 1 to 1000 (it took 1 to 100). The command line's `--max-steps`
  takes the same range. A settings file that holds 30 (what every file before this held) reads as the new default; any
  other number, or any limit saved from this build on, is the person's choice and is kept.
- When the conversation was compacted on its own after the model's last reply in this request, and the model then
  replies without a tool call, it is told once that the conversation was compacted and to carry on, or to give its
  final answer if the request is done. A compaction before the first reply, or one the person asked for, does not do
  this, and it never happens twice in one request.

### Full access runs commands outside the sandbox without asking (changes 0063)

- The owner chose this on 2026-10-24: Full access is the person's answer for the session, so a command that asks to
  leave the sandbox runs outside it without a card under Full access. Under the other approval policies it asks as
  before; Read Only refuses it; no rule, "Always allow" or Reviewer answers for the person.
- **Let a command ask to leave the sandbox** turned off still keeps every command inside, under every policy.
- A command that is hard to undo still gets a second look from the model before it runs unseen (0097).

### Attention is silver, risk stays amber

- A token `--attention` (the accent: silver in the default theme) marks what waits for the person: the approval card's
  border and glow, its icon, and "Needs approval" and "Waiting for you" in the session list and header. Amber stays for
  risk, such as the Full access chip.

### Nothing in the chat widens it

- A fold (`Collapse`) is one column no wider than itself (`minmax(0, 1fr)`, `min-width: 0`): a long line inside a
  diff, a file read back or a command's output scrolls in its own box. A long word in a reply wraps, and a table wider
  than the reply scrolls in its own box. The thread keeps its 784 px column, centered.
- The end-to-end smoke writes, reads, edits and prints a 900-character line and answers with a sixteen-column table,
  opens every fold, and fails if the chat scrolls sideways or the thread grows past its column.

## Consequences

- Weaker models finish more edits on the first try, and a refused call says what was wrong where the person can see
  it. Reshaping is narrow on purpose: a shape with two readings is refused rather than guessed.
- A long request runs much longer before it stops; the cost of a runaway request is bounded by 200 steps, not 30. The
  person can lower it.
- Under Full access nothing asks; the person who picks it accepts that commands may run outside the sandbox. The threat
  model's P33 says so.
- Work on files that live on another machine still goes through `ssh` and `scp` commands, which Edit, Review and rewind
  cannot see. Remote workspaces over SSH are next.
