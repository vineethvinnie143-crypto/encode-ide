# 0088. Report editor issue replays what was recorded, and the app reaches the editor through a fixed interface

- Status: Accepted, builds on 0051, 0075, 0082 and 0087
- Date: 2026-10-23

## Context

eNCode's editor is its own engine (Route 1: no Monaco, no code from VS Code). Three of the six points that make that
route safe were still open after Editor 9a:

- **Bugs testers hit must become tests.** "The cursor jumped after I pasted" cannot be fixed from a sentence. 0082
  gave the editor a trace format, a replayer that checks every invariant after every step, and a scrambler. Nothing
  recorded a real session into a trace, and testers had no way to send one.
- **Dogfood.** The editor should be used on eNCode's own files, which are large, mixed and real, every time the app is
  tested.
- **A small fixed interface.** The stores, panels, palette and Review tab reached into the editor's modules and
  packages directly, about thirty imports in all. Another engine could not take its place without changing them.

## Decision

### Recording

- **What is recorded.** `EditRecorder` (`packages/editor/src/trace-live.ts`) records every transaction an open file
  takes as trace steps. That covers what the view does and what the store does without a view: a reload from disk, a
  server's edit, a rename into another language.
  - A change is kept as the change it is, with its origin (`input.type`, `undo`, `server`, `external`), and not as the
    key that made it. A replay then reaches the very texts and selections the person saw, whatever the undo history
    did.
  - A `select` step is written only when the selection differs from where the change alone would put it.
  - A read-only file's change is a `reload` step.
  - The trace ends with an `expect` step: length, lines and a hash of the text.
- **When it starts again.** A transaction that does not start where the last one ended (a change the recorder did not
  see), or that changes the configuration (a new language, another indentation), starts the trace again from that
  state.
- **Limits.** Past 20,000 steps or 4 million characters of steps, the trace starts again from the current state, and
  the report says it holds only the newest steps. A file over 2 million characters is not recorded.
- **Where it lives.** `src/editor/recording.ts` keeps one recorder per open file, in memory only. It follows a rename
  and goes with a closed file. Nothing of it reaches the log, Diagnostics, the agent or the network.

### Report editor issue

- **Where.** Help → Report editor issue…, the palette, and the editor's context menu, for the file on screen.
- **The dialog.** It shows the file's name, how much was recorded and over how long, and what a replay found.
  - The replay runs the trace in a `TraceReplayer` and checks `editorProblems` at every step while that is cheap (about
    60 million characters of checking in all), at an even sample otherwise, and always at the last step.
  - It also checks that the replay ends on the text the editor shows.
  - Problems an `expect` step found come first, at most 20.
- **The words of the file.** *Replace the words of the file* is on by default. `scrambleTrace` (0082) swaps every word
  for another of the same shape, the same each time, with a random seed per report. Keywords, spaces, punctuation and
  every position stay. A file that holds secrets by its name is always scrambled, and the dialog does not let the
  person turn that off. With words replaced, the characters a problem quotes are left out too.
- **What the person writes.** *What went wrong?* holds up to 4,000 characters.
- **The draft.** The page sends the main process a draft: the description, the path, the language, whether the words
  were replaced, the editor's options (word wrap, screen reader, DPI…), what was recorded, the problems, and the trace.

### The file

- **The main process does not trust the draft.** `app:save-editor-issue` rebuilds it from known fields and limits
  (`readEditorIssueDraft`).
  - The trace must be one the recorder writes: `readTrace` takes only `changes`, `select`, `reload` and `expect` steps,
    with every range inside the text and every size within its limit.
  - Editor options are flat values with plain names, at most 40.
- **Words kept, refused when shaped like a secret.** With the words kept, the main process refuses a file that holds
  secrets by its name. It also refuses any text the trace carries (the start, every insertion, every reload) that the
  suggestion redaction (0087) would change. The person is told to turn word replacement on.
- **Cleaned.** The description and the problems go through the log's redaction (0051) and the credential patterns of
  0087.
- **No path.** The file's path is never written, only its extension.
- **What it holds.** Kind `encode-editor-issue`, version 1, the time, the build and system as Diagnostics names them,
  the facts, and the trace last.
- **Where it goes.** A save dialog the person answers, as `encode-editor-issue-YYYY-MM-DD-HHMM.json`. The toast says
  to send it. Nothing is sent by eNCode.

### Replaying a report

- **The command.** `pnpm editor-issue report.json` reads a report as data.
  - It checks the kind and the version, and takes the trace through the same `readTrace`.
  - It prints the build, the system, the file, the steps, and what the tester said and found. Control and direction
    characters are shown as `?`.
  - It replays the trace with every invariant and the undo history checked, and exits 1 on a problem.
- **Keeping it.** `--keep <name>` writes the trace to `packages/editor/test/traces/issue-<name>.json`, which the
  regression suite (0082) replays from then on. The name is lower-case letters, digits and dashes, and an existing file
  is never overwritten.

### Dogfood

- **The repository.** The Linux end-to-end run copies eNCode's own repository into its sandbox (the files git tracks or
  would track, up to 2 MB each) and opens it as the folder.
- **Six files of different kinds.** `smoke.mjs`, the view's `view.ts`, `CodeEditor.tsx`, the threat model, a
  stylesheet and `pnpm-lock.yaml`. For each one:
  - it opens within 6 seconds;
  - its tokens are coloured (except Markdown);
  - Ctrl+End and Ctrl+Home move;
  - Find counts a word as often as a plain count of the file does;
  - typing and undoing leaves the tab clean.
- **Then.** It opens Report editor issue from the palette, expects "No problem found", and searches the folder for
  `EditRecorder`.

### The fixed interface

- **Two modules.** `src/editor/surface.ts` (logic, loads in plain Node) and `src/editor/surface-view.ts` (the
  components and the editor's stylesheet) are the only way into the editor from the rest of the app.
- **What `surface.ts` does.**
  - Files: open, close, rename, unsaved, saved text, a change from outside, a save's snapshot, format before save, the
    file's language and its text line by line.
  - The editor on screen: whether it shows a file, run a command, keep and put back the cursor and scroll, select a
    range, go to a place.
  - Edits and problems: the language-server sync that reports every edit, the servers' marks and counts, questions
    to the servers, the outline, suggestions' state.
  - Colours for lines the editor does not show (the Review tab).
  - Whether a file can be reported.
- **What `surface-view.ts` gives.** `CodeEditor`, `Breadcrumbs`, `OutlinePane`, `ProblemsPane`,
  `LanguageServersSection`, the two dialogs and `SymbolIcon`.
- **Fixed by a test.** `surface.test.ts` holds the list of what `surface.ts` exports and fails on any change to it. It
  also reads every source of the desktop app outside the editor's own modules (`src/editor`,
  `src/components/CodeEditor.tsx`, `src/components/code`) and fails on an import that goes around the two doors, or of
  `@encode/editor`, `@encode/editor-view` or `@encode/text`.
  - Tests may build fixtures with the engine.
  - The main process and `shared/` may import the trace's type, because the report file is data they read.
- **The agent.** It never reached the renderer's editor. It reaches documents through the language servers, which the
  sync feeds, so it does not change.

## Consequences

- A tester's bug comes as a file that replays exactly, words replaced, and becomes a regression test with one command.
- Every end-to-end run edits eNCode's own files.
- The editor can be replaced by implementing two modules. Changing the interface is a deliberate act: the test's list,
  this ADR and the code change together.
- Recording costs a few objects per transaction and nothing when the dialog is closed.
- Open:
  - A trace records the text and selections, not the view: scrolling, folding, the IME and the screen are not in it.
    A bug of drawing alone replays as "No problem found", and the description and a screenshot carry it.
  - Word replacement keeps the shape of the code. Someone who knows the code well may still recognise it by its
    structure.
