# 0074. The editor asks the language servers through checked questions, and draws their answers with its own widgets

- Status: Accepted, builds on 0072 and 0073
- Date: 2026-10-23

## Context

Parity 3 gave the editor the marks the language servers report, and the agent the LSP tools. The owner wants the
editor itself at the level of the editors people compare eNCode with: suggestions as they type, the parameters of a
call, what a symbol is on hover, and the ways to its definition and its uses. Everything is our own code (0003, 0072):
no editor component, no widget library, no code taken from another editor.

Four questions needed an answer.

- **Which way a question goes.** The renderer has no server of its own; the servers run in the agent host, one hub per
  folder, shared with the agent (0073). The renderer is the least trusted part of the app, so what it asks has to be
  checked on the way, and an answer must be for the text the person sees, not for the text before their last key.
- **How an item goes in.** A suggestion can be a snippet with stops, carry edits elsewhere (an import), be filled in
  only when chosen (its documentation and its import come later), and be accepted by a character typed after it.
- **How a server's words are shown.** Hover, a suggestion's details and a signature's documentation are markdown the
  server wrote, which is text from a program that read the project: untrusted.
- **Where a place goes.** A definition can be in another file, in a file outside the folder (a library's types), or
  in many places at once.

## Decision

### Questions and answers

- **One path for every question.** The renderer asks (`code.ask`) with a kind and a file of the open folder; the main
  process rebuilds the question field by field (the kind from a fixed set, lines and columns as counts, a trigger
  character of one character, the open signature at most 64 KB) and makes the path the folder's own, else it gets no
  answer; the agent host answers it from the folder's hub.
- **An answer is for the text as it is.** A question first lets the editor's other listeners note the change being
  made (a `(` typed asks at once), then sends the change still waiting for a pause in typing, and the host answers it
  only after the changes the editor sent before it. A newer question of the same kind cancels an older one still
  waiting. The renderer drops an answer for a document or a file it no longer shows.
- **Limits.** At most 5,000 suggestions, 50 signatures, 2,000 highlights and 1,000 places an answer; a suggestion is
  filled in by the number of its list and its place in it, and only the newest list is kept; documentation is cut at
  20,000 characters (a signature's at 10,000, a parameter's at 4,000), and a block of code at 20,000.

### Suggestions

- **When.** After 40 ms of quiet once a letter of a word is typed, at once after a server's trigger character, and on
  Ctrl+Space. The list follows what is typed and closes when the cursor leaves the word.
- **Order** is ours: a fuzzy match where the letters typed must start the word or one of its parts (`gEBI` finds
  `getElementById`, `ring` does not find `toString`), then the server's sort text. Only the rows in sight are drawn.
- **Keys.** Up, Down, Page Up and Page Down move; Enter and Tab accept; Shift+Enter replaces the whole word; a server's
  commit character accepts and is then typed; Esc closes. Ctrl+Space with the list open shows the selected item's
  details beside it, for every list after it until asked again.
- **Snippets** are parsed by our own parser (tab stops, placeholders, choices, mirrors, variables, transforms). The
  variables are the file's and the date's; the clipboard is never read and nothing runs. Tab and Shift+Tab move between
  the stops, at every cursor at once; the last Tab, Esc, undo or leaving the snippet ends it.
- **Edits elsewhere** go in with the item in one step of the undo history; one that overlaps where the item goes is
  left out. An item filled in only once chosen brings its import when the answer comes, within three seconds and only
  while the document can still be followed to it.

### The parameters of a call

- Shown over the line after a server's trigger character (`(`), asked again after its retrigger character (`,`) and as
  the cursor moves in the call, and on Ctrl+Shift+Space. The parameter being typed is set apart, with its
  documentation; Up and Down go through the overloads; Esc closes.

### Hover and the places of a symbol

- **Hover.** Resting on a word asks the server what it is; the answer joins the messages of the marks there in one
  card, which stays while the pointer is on it.
- **The symbol's other places** in the file are marked a moment after the cursor rests on it, reads and writes apart.
- **Going to a place.** F12 and Ctrl+click (Cmd on macOS) go to the definition, Ctrl+F12 to the implementation;
  Shift+F12 lists the references and Alt+F12 the definitions in a **peek** between the lines: the list grouped by file
  with each place's line, beside the file itself with the place marked, unsaved text included. Arrows move through it,
  Enter goes, Esc closes. At the definition already, F12 lists the uses instead.
- **Back and Forward** (Alt+Left and Alt+Right; Ctrl+- and Ctrl+Shift+- on macOS) go through the last 50 places a jump
  started from or went to.
- **A file outside the folder is not opened**: the editor shows only the folder's files, so the person is told where
  the place is, and a peek shows its path. The peek reads a file through the same workspace calls as the file list.
- The same commands are in the Go menu and the palette, so they can be found and run without their keys.

### Showing what a server wrote

- **Markdown goes through the app's renderer**: everything escaped first, then only its own tags; links only to
  `http(s)` and `mailto`, opened outside the app. Code blocks are coloured by the editor's own tokenizers from escaped
  text. Plain text is escaped.

### The editor engine

- A view takes **bindings and commands of its own** that are tried before the built-in ones, and a key bound to
  several commands tries them in order until one acts (Esc closes the peek, then Find, then the snippet, then
  collapses the selection).
- A **zone between the lines** can be fixed: it spans the text in sight and stays put when the text scrolls sideways
  (the peek), instead of scrolling with the text (the removed lines of a review).
- Ctrl+click reports where it was (`navigate`), and the word under the pointer can be drawn as a link while Ctrl is
  held.

## Consequences

- The editor has suggestions with snippets and imports, parameter hints, hover documentation, the symbol's places,
  go to definition and implementation, peeks of definitions and references, and Back and Forward, with any server
  that follows the protocol.
- A question cannot reach a file outside the folder, and nothing a server writes runs in the app.
- Still to come in the next editor steps: rename and code actions in the editor, formatting, the outline and
  breadcrumbs, workspace symbols, inlay hints and semantic tokens, folding and the rest of the engine work, the
  100 MB test with highlighting off the main thread, Windows input and accessibility, and the fixed editor interface.
