# 0079. Large files are coloured on another thread, counted from indexed points, and held to measured limits

- Status: Accepted, builds on 0003, 0072, 0074 and 0077
- Date: 2026-10-23

## Context

The editor engine (0003) already drew only the lines on screen, kept the text in leaves of whole lines, and scaled a
document taller than a browser element may be. It had never been held to numbers for a large file, and measuring one
of 100 MB (about 1.8 million lines of code) and one minified line of 10 to 50 MB showed where it fell short:

- **Colouring a file ran on the page's own thread.** Reading every line of 100 MB took about 6 s of script time, in
  slices between frames, so scrolling and typing shared the thread with it for that long.
- **A far jump read every line above it.** Jumping to the middle of a file whose states were not known yet tokenized
  hundreds of thousands of lines first: about 330 ms for one frame.
- **The app could not open such a file at all.** Every read was capped at 12 MB.
- **Re-reading after a save compared the whole text** as one new string, and the find box counted every match of a
  100 MB file in one go.
- **One very long line cost time in proportion to its length on every keystroke.** Visual columns were counted from
  the start of the line several times per key (the caret, the reveal, the line's width): about 30 ms per MB of line.
- **A line wider than 16 million pixels could not be scrolled to its end**: the scrollable area was capped there and
  nothing mapped scroll offsets past it.

## Decision

### Colours come from a worker

- **One highlighting worker per window**, shared by every editor in it (the code editor and peeks). The view sends it
  batches of lines from where the known states stop: 256 lines first, four times more each time up to 16,384 lines
  or 1,000,000 characters, one batch in flight per file. A line is cut at 10,000 characters, as before. The worker
  tokenizes them with the same tokenizer and sends back the state after each line and the bracket depths, as typed
  arrays moved rather than copied. The page's thread only stores them.
- **What comes back is checked before it is used**: the answer must be for the batch out, have one state per line
  and a table of strings, and stop where an edit since then reached. A batch the worker reads stops early once a
  state settles on the one known before, so an edit re-reads only what it changed.
- **A visible line far past what is known is drawn from a guess**: within 3,000 lines of the known states it is read
  at once; further away its state is guessed from the 80 lines above it (chained from a guess just above, when there
  is one), drawn marked as a guess, and drawn again with its true colours when the worker gets there. A line below
  the last one guessed goes on from where that one ended, over any lines between that were not asked for (the minimap
  skips blank ones), so lines drawn in order are read once each; restarting the guess at every gap had made a far
  jump read over ten times as many lines as it drew. Each place the known states stop is first read on 256 lines
  to see whether they settle on the old ones.
- **The worker is checked both ways.** It takes only a batch of the expected shape (at most 65,536 lines, all
  strings, a known language) and answers anything else with nothing. The page stops a worker that reports an error,
  sends something it cannot read, or takes more than 20 s over a batch; then every editor colours its file on its own
  thread in idle time, as before. A tokenizer that throws on a line shows that line plain, once warned.

### Large files open

- **The editor reads files up to 256 MB** through a read of its own (`workspace:read-for-editor`), with the same path
  checks as every read; every other read keeps its 12 MB cap. A file over the limit says how large it is and what the
  limit is.
- **Language servers are not given files over 8 MB**, as before; the footer says "file too large" for one, and a
  question that needs a server says why there is no answer.
- **Comparing the text with the disk or the saved copy is done in place**, leaf by leaf, so a save and a re-read of a
  large file do not build its whole text again.
- **The find box counts matches in windows of 20,000 lines**, yielding to the page between them.

### Columns are counted from indexed points

- **Runs of plain characters are counted at once**: characters below U+007F other than a tab take one column each
  and start a cluster of their own, so columns skip over a run of them in one step.
- **A line of 16,384 characters or more keeps an index** while it is in use: its column at points about every 1,024
  characters. A point is a place no cluster spans (a character below U+0080 followed by one below U+0300), so finding
  the offset of a column can start from one too; a line without such places has no points and is counted from its
  start. The indexes of the two lines used last are kept, and let go when an editor closes.
- **An edit carries the index along** rather than counting the line again: the points before it stay, the edited
  stretch is counted, and the points after it move by what the edit added. A tab after the edit can take up the
  shift (it reaches the same tab stop), so the shift is read at the first point past that tab. A line edited in more
  than one place in one change, or split or joined, is counted again when it is next asked about.
- Both are checked against counting one character at a time by property tests, through tabs, accents and wide
  characters, and through edits.

### A wider line scrolls through a scaled range

- **Past 16,000,000 pixels the scrollable width is scaled**, as the height already was: the scroll bar covers that
  range, the last scroll offset lands on the line's end, and a sideways wheel moves the text by the wheel's distance.
- **The layers are drawn from a left edge** on a grid of 1,000,000 pixels at least 100,000 pixels left of the view,
  so pixel offsets in the page stay small; a line's text is moved left of its box by what lies before that edge, a
  rectangle that would run millions of pixels past the view is drawn only near it, and the text area clips what lies
  past its ends.

### The limits are measured and enforced

- **A browser test opens 100 MB of code** with every display option on and the worker on, and fails when a step takes
  longer than its limit: opening and the first screen 3 s, a far jump 100 ms, a wheel step 50 ms, a keystroke 25 ms
  typical and 100 ms worst, undo 100 ms, a search that reads to the end 1.5 s, the find box's jump to the last match
  1.5 s, the whole text as one string 1.5 s, the worker reading every line 60 s, and script time on the page's thread
  while it does 1 s. On a development machine they measure about 0.7 s, 8 ms, 5 ms, 3 and 3 ms, 2 ms, 160 ms,
  150 ms, 0.4 s, 7.5 s and 14 ms; the limits leave room for a shared CI runner, which runs these steps about five
  times slower. It also checks colours line by line
  against a fresh read of the same lines.
- **A browser test types in a line of ten million characters** (minified JSON): a keystroke 30 ms typical and 150 ms
  worst (about 7 and 10 ms measured), a caret move 50 ms (about 7), a click 50 ms (under 1). It checks that both ends
  of the line can be scrolled to and are drawn, that the caret at its end is in sight, that a click lands where it was
  made, and that a selection of everything is drawn across the view in the middle of the line.
- **The end-to-end run opens a 100 MB file in the app**: the worker starts, the footer says it is too large for the
  servers, Ctrl+End reaches the last line, its lines are coloured as the comment that spans the file, typing, finding
  the last function, saving (checked on disk) and taking in a change made on disk all stay under their limits.

## Consequences

- A 100 MB file opens in under a second in the app and stays as quick to scroll and type in as a small one; its
  colours fill in within seconds without the page's thread doing the work.
- A minified file can be read, typed in and scrolled to its end; typing costs about 7 ms per key in a 10 MB line and
  about 30 ms in a 50 MB one, most of it the browser copying the line's new string.
- One more thread per window, and a 100 MB file takes about 550 MB of the page's memory.
- Not done: word wrap (the next editor step, which will also wrap a minified line rather than scroll it sideways),
  files over 256 MB, keeping one very long line as pieces rather than one string, and colouring past the first 10,000
  characters of a line.
