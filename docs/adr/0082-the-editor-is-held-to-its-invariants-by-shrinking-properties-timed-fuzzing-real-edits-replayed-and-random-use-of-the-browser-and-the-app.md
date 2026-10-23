# 0082. The editor is held to its invariants by shrinking properties, timed fuzzing, real edits replayed, and random use of the browser and the app

- Status: Accepted, builds on 0033, 0079 and 0081
- Date: 2026-10-23

## Context

The editor is our own (0033), so nobody else's users find its bugs first. The committed editor scope (Editor 7) asks
for property tests and fuzzing, and a regression suite of real edits. Where it stood:

- `@encode/testkit` ran a property over seeded random cases and reported the first input that failed, as it was
  found: often a long list of edits in which one mattered.
- The editor's tests were examples, written to show each feature works; the properties there were per function.
  Nothing checked that a long, mixed run of commands keeps the document, the selection and the history consistent.
- Nothing replayed how files are really edited, and nothing used the view in a browser at random: every browser test
  knows what it is about to do.
- Nothing ran for longer than a test run, so a bug one case in a million finds was left for a user.

## Decision

### Properties shrink, and fuzzing is the same properties run for longer

- **Every generator draws from one recorded stream of numbers**, so a failing case is made again from that stream
  with draws taken out and made smaller (towards 0, which every generator reads as its first or smallest choice),
  keeping each change that still fails, for at most 3,000 tries or 20 seconds. No generator needs a shrinker. The
  message gives the seed and the environment that replay the case, the input made smaller, and the input as found.
- **Examples** (cases that once failed) run first, before the generated ones.
- **`ENCODE_FUZZ_MS`** keeps each `check` making cases, sweep after sweep of sizes, until that much time has passed;
  `scripts/fuzz.mjs` (`pnpm fuzz`) runs every property in the repository this way (or those of the paths named) and
  lists each one's case count and the failures with their seeds. Test runs keep their fixed number of cases on a fresh
  seed each run, so CI explores a little more every time.

### The invariants are code

- **`Text.checkStructure()`**: leaves are not empty, a leaf holds at most its share of lines and characters, the
  counts and the prefix sums are right.
- **`editorProblems(state, tr)`**: the text's structure; the selection sorted, apart, in range, with a main range;
  auto-closed brackets still where they were typed; the history in step with the text (its changes apply to the
  document they were made from); a transaction's changes apply and invert back.

### Commands at random

- **A command machine** runs random sequences of about fifty commands (moving, selecting, deleting by word and line,
  indenting, commenting, moving and copying lines, multiple cursors, brackets), typing and inserting, copying, cutting
  and pasting, changes from elsewhere, reloads and replace-all, over samples in nine languages with a random tab size,
  indent unit, line separator and read-only flag. After every step it checks `editorProblems`, that each history point
  always comes back with the same text, that a read-only document changes only by a reload, and that the state
  survives being saved and restored. At the end, replaying the same steps gives the same result, and undoing and
  redoing everything reaches both ends.
- **Commands that undo each other** are checked as pairs: comment twice, indent and outdent, move down and up, right
  then left through emoji, joiners, flags and accents, typing against inserting, select all and delete then undo.
- **Search** is checked against a plain model (`indexOf` for literal and whole-word search, the whole text for regular
  expressions), next and previous from every position, and replace-all.

### Real edits, replayed

- **An edit trace** (`EditorTrace`, version 1) is a starting document and its settings, and steps: commands, typing,
  selections, copy, cut and paste, changes from elsewhere, replace-all, reloads, and `expect` (the length, line count
  and a hash of the text where it must be). Steps carry their time, and the history reads the replay's clock
  (`withHistoryClock`), so typing groups into the same undo steps as it was recorded.
- **`scripts/edit-traces.mjs`** (`pnpm traces`) makes the regression traces from eNCode's own git history: eight files
  (the ADR index, TESTING.md, the desktop package with Windows line endings, the editor's styles, the CI workflow,
  the editor's commands, the language client, the editor layout store), each version reached from the one before by
  the edits a person would make (select, cut or delete, type in pieces or paste, a change from elsewhere now and then,
  pauses, undo and redo), with every version an `expect`. 2,837 steps, about 340 KB, kept in git so CI needs no
  history. Each is replayed with every invariant checked after every step, then undone and redone to both ends.
- **A trace is scrambled** before it is shared: each word is replaced by another of the same length, the same word by
  the same word, keywords and punctuation kept, so a bug report carries the shape of the edits and not the code.
  Every trace is replayed scrambled too, to the same length and line count.
- **Every bug the fuzzing finds is kept** as a trace (or an example) in the suite.

### Random use of the view, and of the app

- **The browser's random use** (`random use` scenarios) presses keys, types in several scripts, composes with an input
  method, clicks (with Shift, Alt, twice), drags, scrolls with the wheel, resizes and copies and pastes, in a document
  with tabs, wide characters, emoji, accents, a long line and right-to-left text, once plain and once with word wrap,
  right-to-left reading order, every space shown and the screen reader mode on. After every step: every line in the
  DOM holds its line's text in order below the one before (a marker read as the character it marks), the gutter
  numbers it, the state keeps `editorProblems`, the caret has a place, the screen reader's field holds the document
  around the cursor, the focus is still in the editor (unless Escape and then Tab took it out), nothing threw. The
  history's clock moves with the steps and the clipboard is seeded, so a seed is the same run every time and a failure
  names the seed, the step and the steps before it. `ENCODE_MONKEY_STEPS` and `ENCODE_MONKEY_SEED` run more.
- **The app's random editing** (the end-to-end run) edits a Lua file with Windows line endings at random with saves
  along the way, then checks the file on disk is what the editor shows with Windows line endings throughout, undoes
  everything across the saves, saves, and checks the file is byte for byte what it was. `ENCODE_SMOKE_SEED` runs
  another.

### What it found, and what changed

- **The text store** kept a trail of tiny leaves where lines were typed one at a time at the same place: the leaf
  after an edit is now split evenly with the one before it when it would be small.
- **Undo and redo changed a read-only document** (taking back a reload): they now do nothing in a read-only editor.
- **Find next and previous missed a match the cursor was inside**, when the search wrapped around; and **whole-word
  search skipped a match overlapping one it had turned down** (`b b` in `ab b b`): both fixed.
- **Shift+Tab with nothing to outdent moved the focus out of the editor**, and **a click on a scrollbar** did the same:
  an editable editor now keeps Tab and Shift+Tab whatever they change (Escape then Tab, or Ctrl+M, is still the way
  out, and a read-only editor lets Tab go), and a scrollbar click scrolls without taking the focus. **Escape, then a
  click, then Tab** also left: a click or a drag in the editor now disarms Escape, as any other key does.
- **An emoji sequence drew as separate pictures with markers between them**: the zero-width joiner between two
  pictures is now drawn as itself, so a family or a flag with a sign shows as the one picture it is. Anywhere else (two
  letters, the start or end of a line, beside one picture only, two joiners in a row) it is still a marker, as every
  other invisible character is (0033). A joiner between pictures can neither reorder text nor hide letters.
- **Composed text with no `compositionstart` before it** (the focus came back while an input method was open) was
  left in the textarea: the composition is now taken up from the first such input.

## Consequences

- A failure found at random comes with a small input and a seed that replays it, whichever test found it.
- Long fuzzing is run by hand (`pnpm fuzz`), before a release and after a change to the text, the editor's core or a
  parser of untrusted input; CI runs every property at its usual count, on fresh seeds.
- The traces are the start of "Report editor issue" (Editor 9): the recorder, the replayer and the scrambler are in
  `@encode/editor`, so a report can carry what was done, made anonymous, and become a regression test.
- Not done: fuzzing is not guided by coverage; the browser's random use does not reach the suggestion list, hover
  cards, the find widget, the minimap or language servers (each has its own tests); the app's random editing runs one
  seed per run.
