# 0131. Long tasks measure what shortening and summaries keep

- Status: Accepted, builds on 0092, 0129 and 0130
- Date: 2026-10-25

## Context

The benchmark's fourteen tasks are small. The longest peaks at about 15,000 tokens, below the point where old results
are shortened (16,000 tokens for most models since 0130, 32,000 for Claude's) and far below a summary. So the bench
could not tell whether a cost change to compaction loses anything: every task passed whatever compaction did, because
compaction never ran. `--window 16000` (0129) forces it, but on tasks that are over after five calls it barely gets the
chance.

The cost plan's rule is that compaction never cuts what the work depends on: the person's request, the plan and task
list, the file being edited, the latest failure. A test of that needs tasks where something read early is needed late,
after the old results have been shortened or summarized away.

## Decision

Four tasks tagged `long`, each with a reference that passes clean in a 16k window and in a full one:

- **`recall-early-rule`**: the request says to read `docs/PROTOCOL.md` first, then fix eight handlers of about 9,600
  characters each, then write the frame encoder "exactly as the protocol describes". The framing rules (magic `ENC7`,
  version 3, a big-endian length, an XOR checksum) are read in the first step and used in the last, and the protocol
  also describes an older version 2 with a different magic and a little-endian length. By the time the encoder is
  written, the protocol's text has been shortened (full window) or summarized (16k).
- **`rename-many-files`**: rename `formatCents` to `formatMoney` across seventeen files, 68,000 characters in all. One
  file imports it under another name, one calls it through the module (`money.formatCents`), one re-exports it, and a
  look-alike `formatCentsWidth` must be left alone, including where it is imported next to the formatter. The hidden
  check compares every report's output with what it showed before.
- **`log-middle-line`**: the nightly import prints a line for each of 5,000 records and says at the end that one was
  skipped. The line that says which is in the middle of 324,000 characters of output, where the tool's excerpt leaves
  it out: the model has to search the whole output kept in the session's folder (0093) or run the command again
  through `grep`, and then remember what it found once the output is shortened. The fix is to read a thousands
  separator; the export and the import script must stay as they are.
- **`six-part-request`**: six numbered changes to six modules in one message (a refusal with a RangeError, two bulk
  price tiers, a sort order, a new setting read from the environment that the report must use, an audit entry, and a
  CSV format with quoting). The hidden test checks each part separately, so a part forgotten after a summary shows as
  that part.

In a full window, three of the four pass the point where shortening starts (up to 38,000 tokens). In a 16k window all
four are summarized or shortened during the run (two to four summaries for the first, second and fourth). The
references pass clean in both.

## Consequences

- `pnpm bench run --tag long --repeat 5`, before and after a change and with `--window 16000`, is the accuracy check of
  each cost change that touches compaction (R1, R2, R3, Q5). A live run spends money on the owner's key, so it is run
  when the owner says.
- A model that loses a rule, a file or a part of the request to compaction fails a named check, not a vague one.
- These four add a few seconds to the tests in CI, and need no network.
- `log-middle-line` allows `grep` as well as its two commands. A line that pipes an allowed command into a read-only one
  still needs a rule for each part (the permission rules of 0040); whether a read-only part should pass on its own is a
  question for R3, since a declined pipe costs a step.
