# 0060. Text that reads differently from how it runs is shown to the person and told to the model

- Status: Accepted, builds on 0004, 0012 and 0032
- Date: 2026-10-22

## Context

Threat T18 covers source that reads differently from how it runs: bidirectional controls that reorder a line on screen
("Trojan Source", CVE-2021-42574), zero-width and tag characters that carry hidden text, a Cyrillic "а" in `admin`.
`scripts/check-sources.mjs` keeps them out of this repository, and the command policy asks about a shell line that
holds them (0004). Two paths were still open:

- **The agent writes files.** A model that has read a poisoned page or file can write the characters into a file it
  creates, and the approval card, the diff in the thread and the editor all draw them as nothing. The person approves
  what they cannot read, or sees a clean diff of a file that behaves differently.
- **The card is the control, so the card must be honest.** A warning that quotes the characters can itself reorder or
  hide the text around it.

## Decision

- **One scanner, in the core, over what a call adds.** `scanText` and `scanHunks` (`packages/core/src/scan.ts`) look
  at the lines of a diff that are added, and at a shell line as a whole; context and removed lines are never scanned, so
  what was already in a file is not blamed on the call. They find:
  - text-direction controls (embeddings, overrides and isolates), in any file;
  - invisible characters: zero-width, word joiners, soft hyphens, fillers, the byte order mark except at the start of a
    file, and the left-to-right and right-to-left marks in code (in prose they are ordinary);
  - tag characters, with the text they spell decoded, except the flags of England, Scotland and Wales;
  - variation selectors that vary nothing, and any run of two or more;
  - control characters (escape, backspace, null, a carriage return inside a line) and unusual line breaks;
  - letters that pass for others: Cyrillic, Greek, Armenian, Cherokee, Coptic and Lisu letters inside a Latin word,
    ligatures and fullwidth or mathematical letters that read as plain ASCII, and, in code, punctuation that stands in
    for a slash, a backslash, a semicolon or a dot beside ASCII.
  A path counts as code by its extension or name (`isCodePath`: source, configuration, scripts, a Dockerfile, `.env`);
  prose gets the gentler rules, so a document in Arabic or Hebrew, an emoji sequence or a Braille picture is not a
  finding.
- **Findings never carry the characters.** A finding names each one by code point and name, and quotes the text around
  it with every hidden or non-drawn character replaced by a marker such as `‹U+202E›`. It is at most eight lines plus
  a count of the rest. What the card says cannot be tricked by what it reports.
- **Before the write: the approval card.** A write that asks lists its findings above the buttons under "Invisible or
  look-alike characters in this action". A command that asks lists its own the same way.
- **After the write: the step and the model.** A write that succeeds is scanned again on the diff it made. The row in
  the work log gets a warning mark and the list when opened, and the model reads a note after the tool result: "Heads-up:
  src/a.ts now contains characters that are invisible or look like others: - Line 3: … Rewrite those lines without
  them unless they are meant to be there." The model usually did not choose them and removes them.
- **No new gate.** The scanner warns; it does not refuse. A file may hold these characters for good reasons (a test of a
  parser, a right-to-left string), and refusing would only teach the person to skip the card. A shell line that holds
  them is still stopped from the Reviewer by the fixed checks (0059), which is a gate on the model, not on the person.
- **Fast on the common case.** A line of printable ASCII is passed over with one loop and allocates nothing.

## Consequences

- A person sees at the moment of approval, and in the thread afterwards, that a file contains something its drawing
  hides, and the model is told to undo it. It does not make an editor or a terminal show such characters; that is the
  editor's job.
- False positives exist: a file in a language that mixes scripts on purpose, an identifier that is really Greek. They
  cost a line on a card, never a refusal.
- The scan reads what the file tools report as written. A file the agent builds by a shell command, or a generator it
  runs, is outside it, as it is outside every file-tool control (threat model R1).
- Tests: `scan.test.ts` covers each family, the cases that must not be flagged (emoji sequences, flags, Braille, a
  byte order mark at the start, prose marks), markers instead of characters, the cap and the count, a corpus check that
  a finding fed back to the scanner finds nothing, and the speed on 200,000 plain lines; the loop tests cover the card,
  the step and the note.
