# 0076. The editor finds its way by the symbols the servers name, asked only while shown, and calls are followed a level at a time

- Status: Accepted, builds on 0072, 0074 and 0075
- Date: 2026-10-23

## Context

0074 and 0075 gave the editor what the language servers know about a place and what they can change. What was
missing is the shape of the code: which classes, functions and methods a file holds, where the cursor is among them,
where a symbol of the folder is when its file is not open, and who calls a function. Everything stays our own code
(0003, 0072). Four questions needed an answer.

- **What is shown, and where.** The editor pane is narrow beside the conversation, and the side panel shows one tab
  at a time, so an outline cannot be another tab.
- **What it costs.** Asking for a file's symbols on every pause in typing is a request a second for a large file. It
  should cost nothing when nothing shows the symbols.
- **What the renderer may ask for.** A call hierarchy is a chain of items the server made; letting the renderer send
  them back would let it hand the server anything.
- **How to get there and back** without losing where the person was.

## Decision

### A file's symbols

- **The editor asks the file's server for its outline** (`textDocument/documentSymbol`) when a file is shown, again
  400 ms after typing pauses, and once a server that started late marks the file. An answer for text that has changed
  since is dropped and asked again. A server that answers with a flat list has it nested by range, and its symbols in
  other files left out; a name range outside its symbol is moved to the symbol's start. At most 5,000 symbols are read.
- **Only while something shows them**: the breadcrumbs, the outline, or Go to symbol. A question skipped while none
  did is asked when one does.
- **The breadcrumbs** (on by default) show the file's folders, the file, and the symbols the cursor is in, following
  it. Each part opens a list of what is beside it: a folder or the file lists its folder's entries (at most 300, a
  folder opened inside the same list), a symbol lists the symbols beside it, the current one checked, and a last part
  lists what the innermost symbol holds. **Ctrl+Shift+.** gives them the keys, the last part's list open on the
  current entry; Left and Right move between parts.
- **The outline** (off by default; View > Show outline) is a column beside the text, over it when the editor pane is
  560 px wide or less. It follows the cursor (opening the symbols it is in), sorts by position, name or kind, filters
  by name keeping what a match is in, collapses all, and is moved through with the arrow keys, Home, End and Enter.
  Its width (180 to 480 px), sort and follow are kept, with whether the breadcrumbs and outline show, in this
  computer's settings for the app.

### Getting there

- **Go to symbol in file** (Ctrl+Shift+O, or `@` in Go to file) lists the file's symbols with what each is in, best
  match first. Moving through the list shows each symbol in the editor; Esc puts the cursor and scroll back; Enter
  goes, and Back returns to where the list was opened. At most 300 are listed.
- **Go to symbol in folder** (Ctrl+Alt+T, or `#`; Ctrl+T already opens a tab) asks every running server that searches
  symbols, and the server of the file shown, started if need be, 150 ms after typing rests; a newer search cancels the
  older. Places outside the folder are dropped, at most 1,000 come back and 200 are listed, names the query spells
  first. Enter opens the file at the symbol.
- **A line**: `:12` or `:12:5` in Go to file, previewed like a symbol, and `name.ts:12` opens a file at a line.

### Calls

- **Shift+Alt+H** (and the editor's menu) opens the function at the cursor's callers between the lines, under it, with
  the file of the selected call beside the tree; a switch shows what it calls instead. Each level is asked for when it
  is opened (Right, or the arrow), so a recursive function is no trap. A caller's calls are marked in its file;
  Enter goes to the first, and Back returns. Esc closes it and gives the keys back.
- **The host keeps the hierarchy.** The folder's servers keep the newest hierarchy's items and number them; the
  renderer asks about a function by its list and number only and never sends an item. A list replaced by a newer
  one, or whose server stopped, is refused with a sentence the tree shows. At most 20 functions start a hierarchy,
  5,000 are numbered in one, and 100 places are kept for each call.

### What the renderer may ask

- The main process rebuilds the four new questions field by field: `symbols` takes a file of the folder;
  `workspaceSymbols` a query of at most 200 characters without control characters, with a file of the folder or none;
  `callHierarchy` a file and a position; `calls` a list and a number up to 10,000 as counts, and `incoming` or
  `outgoing`. Anything else gets no answer. Expanding two levels at once asks twice; every other kind keeps one
  question at a time, a newer one cancelling the older (0074).

## Consequences

- With any server that follows the protocol, the person sees where they are in a file, moves by symbol in the file and
  the folder, and follows calls both ways, all from the keys.
- Nothing is asked for a file's symbols while neither the breadcrumbs, the outline nor Go to symbol is shown.
- A renderer cannot make a server act on a call hierarchy item it invented, and a server's places outside the folder
  never reach the list.
- The outline is per editor, not per file: it shows the file the editor shows.
- Still to come in the next editor steps: inlay hints and semantic tokens, folding and the rest of the engine work,
  the 100 MB test with highlighting off the main thread, Windows input and accessibility, one-click server install and
  the fixed editor interface.
