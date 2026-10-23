# 0077. The editor folds by the servers' ranges or the indentation, and pins, colours and maps the text from what it already reads

- Status: Accepted, builds on 0003, 0072, 0074 and 0076
- Date: 2026-10-23

## Context

The editor showed every line of a file at once, brackets in one colour, and nothing of where the cursor is once a
class's first line scrolled away. Four features close that: folding, sticky scroll, brackets coloured by depth, and a
minimap. They are drawn on every frame and on every scroll, so they must cost next to nothing on a large file, and
they are the editor's own code (0003): no part comes from another editor. Four questions needed an answer.

- **Where the blocks come from.** A language server knows a file's blocks, comments, imports and regions, but not
  every file has a server, a server answers late, and the text changes between its answers.
- **What folding does to everything else.** Heights, the arrow and page keys, cursors, search, edits and the
  scrollbar all assumed that every line is on screen.
- **What the three pictures of the text read.** Sticky scroll needs the blocks the top line is in, bracket colours a
  depth for every bracket, and the minimap the colours of every line; each could be a pass over the file of its own.
- **What the renderer may ask the servers.** Folding adds a question; its answer comes from another program.

## Decision

### Where the blocks come from

- **The file's language server, when one folds it** (`textDocument/foldingRange`, asked as whole lines). The editor
  asks when a file is shown, again 400 ms after typing pauses, and once a server that started late marks the file;
  an answer for text that has changed since is dropped and asked again. Between answers the server's ranges move
  with the text. A range that ends just past a closing bracket at the start of its last line leaves that line out, so
  the bracket stays in sight; one range is kept per first line, the widest. At most 5,000 are read.
- **Otherwise the text itself**: a block is the lines more indented than its first line (blank lines inside it
  count, trailing ones do not), and a region runs from a `#region` marker to its `#endregion`. A marker needs a
  comment or directive in front, so `region = 5` is no marker. A line's own block is read only from the lines after
  it, so the chevrons of the lines on screen cost a few lines each; the whole file is read in one pass only to fold
  everything, a level or a kind, and at most 10,000 ranges are kept.

### What folding does

- **A folded block keeps its first line and hides the rest.** The chevron in the gutter's last column (16 px, after
  the line numbers) shows while the pointer is over the gutter for a line that starts a block, and always for a
  folded one; a click on it folds or opens, and a `⋯` after a folded first line opens it.
- **Hidden lines take no height.** The height map lays them out at zero, a line lookup never lands on one, and a zone
  after a hidden line is not drawn.
- **The cursor never rests inside a fold.** Folding moves cursors there to the end of the first line; Up, Down, Page
  Up, Page Down and adding a cursor above or below step over folded blocks; a cursor, a search result, Go to line or
  an edit that reaches inside a fold opens it, while typing at the very end of the first line keeps it folded.
- **Folds follow the text** as positions (the ends of the first and last lines), so lines added above move them and
  an edit inside opens them. Folding never edits.
- **Commands**: Fold (Ctrl+Shift+[), Unfold (Ctrl+Shift+]), Fold all (Ctrl+Alt+[), Unfold all (Ctrl+Alt+]), Toggle
  fold, Fold and Unfold recursively, Fold all block comments, Fold all regions, Unfold all regions, Fold imports, and
  Fold level 1 to 7. The first four are in the View menu; all are in the palette. In the editor the bracket keys
  fold, as people expect there; elsewhere Ctrl+Shift+[ and ] still move between the side panel's tabs.
- **What is folded is kept per file** while it is open: shown again, the file folds the same blocks before its
  scroll position is put back. A change made while the file was not shown (the agent wrote it, a rename across files
  changed it) moves the kept folds with the text, and opens those it reached into.

### What the three pictures read

- **Sticky scroll** pins the first lines of the blocks the top of the view is in, from the same ranges as folding,
  outermost first: at most five lines and at most a third of the view. As a block's last line scrolls up, its line is
  pushed up with it. A click on a pinned line goes to it and scrolls it to where it was pinned; the wheel over the
  pinned lines scrolls the text. Pinned lines are drawn from the tokens the text already has.
- **Brackets are coloured by depth** from the highlighter, which already reads every line in order: for each line it
  keeps how deep the line goes and where it ends up, so a bracket's depth is a sum over the lines above, kept as the
  file changes and filled in as the highlighter reaches each line. Brackets in strings, comments and regular
  expressions do not count. Three colours cycle by depth, and a closing bracket with no partner takes the error
  colour. A line not yet highlighted guesses its depth and is drawn again once it is known.
- **The minimap** is a canvas beside the text, 92 px wide, each line two pixels high and each character a pixel
  wide (84 columns), coloured by the same tokens and the theme's own colours; it marks the selection, search
  matches, errors and warnings, and changed lines, and leaves folded lines out. A slider shows the part in view;
  dragging it or clicking the map scrolls there. It hides while the text area would be narrower than 420 px, and it
  draws only the lines it shows, again only when what it shows has changed.
- All four are options of the view; the app turns them on by default and the View menu turns each off and on, kept
  with the editor's layout in this computer's settings for the app. Turning folding off opens every fold. The peek
  preview colours brackets as the editor does and does not fold.

### What the renderer may ask

- **One new question, `folding`**, rebuilt by the main process from a file of the folder and nothing else. The host
  reads the server's answer field by field: a range is two whole line numbers, the second below the first, with an
  optional column and a kind of `comment`, `imports` or `region`; anything else is skipped.

## Consequences

- With or without a server, any file folds; with one, it folds as the language does (imports, comments, regions).
- The editor's cost on scroll does not grow with the file: chevrons read ahead from the lines on screen, bracket
  depths come from the pass the highlighter makes anyway, sticky lines from the fold ranges, and the minimap redraws
  only what changed.
- Every line count the editor uses (heights, the scrollbar, the arrow keys, the minimap) counts folded lines out.
- Fold state lives while the file is open; closing the file or the app forgets it.
- Still to come in the next editor steps: inlay hints and semantic tokens (0078), the 100 MB test with highlighting
  off the main thread, Windows input and accessibility, one-click server install and the fixed editor interface.
