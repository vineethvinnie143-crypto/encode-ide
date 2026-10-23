# 0080. Long lines wrap into rows the layout counts, and spaces and tabs are marked without changing the text

- Status: Accepted, builds on 0003, 0077 and 0079
- Date: 2026-10-23

## Context

The editor drew every line as one row. A long line ran off to the right, and since 0079 a line wider than the
browser allows scrolls through a scaled range, but reading prose, a long string or a minified file still meant
scrolling sideways. Word wrap and showing spaces and tabs are part of the committed editor scope, and no step had
them. Wrapping touches every part of the view that thought in lines: heights, the caret, clicks, selections, the
arrows and Home and End, the line marks, the minimap and sticky scroll. It has to hold for a 100 MB file too, where
breaking every line before the first screen is too slow.

## Decision

### Where a line breaks

- **A row ends after a space, a tab or a mark that ends a word** (`} ) ] ? | / & . , ; : ! % > -`), before an
  opening mark (`( [ { < +`), or on either side of a wide character. A word longer than a row is cut between
  characters, never inside a cluster. Spaces at a row's end stay on it (up to another row's width), so the next row
  starts with what came after them and no row starts with a space.
- **Rows after the first are indented as the line is**, unless the indentation is more than half a row; Settings can
  turn that off. Tabs reach the tab stops of their own row.
- **Four ways to wrap**: off, at the window's edge (the text area less its padding, the minimap and one column for
  the caret), at a column, or at whichever of the two comes first. At the window's edge or bounded nothing scrolls
  sideways; at a column wider than the window it still can.
- **Plain ASCII runs are measured in one step**, other text a cluster at a time; a line that cannot be wider than a
  row is not walked at all. The breaks of the lines drawn and asked about are cached by their text (4,096 lines or
  32 million characters at most).

### The layout counts rows

- **Each line's rows are kept in chunks of 1,024 lines** with a sum per chunk, and the offsets within a chunk
  counted when first needed. Lines before each chunk and rows before each chunk are two separate indexes: changing a
  line's rows only marks the second, so settling millions of lines is linear. The height map (0003) lays rows out
  where it laid lines out, and folded lines hide their rows.
- **An edit breaks again only what it can change**: the rows of the edited line from the one before the edit, until
  a row starts where one did before (moved by the edit); the rest are moved. A line of few rows, or an edit to the
  indentation, is broken from its start.
- **A document of up to 2 million characters is broken at once.** A larger one starts from rows guessed from each
  line's length; the lines about to be drawn get their real rows before they are drawn, and the rest are broken in
  idle time, 12 ms at a time.
- **The text at the top of the view stays put while rows change above it**: before rows change the view remembers
  the place at the start of the top row and how far into it the view starts, and scrolls back to it after. While the
  view stays where it was put, the next hold takes the same place again rather than reading it back from a scroll
  offset rounded to whole pixels (in a large file one scroll pixel is several layout pixels), so many holds in a row
  do not drift. The same holds the view still when the editor is resized or wrapping is turned on or off.

### Drawing and moving by rows

- **Each row is its own block** in its line's element; a line of more than 240 rows draws only the rows near the
  view (and 60 more each side), so a minified line wraps without drawing all of it.
- **The caret knows which side of a break it is on**: a selection's head carries `assoc`, -1 at the end of the row
  before a break (End was pressed there, or a click landed past the row's end), otherwise at the start of the row
  after. The position is the same either way; only where the caret is drawn and where the next move starts differ.
- **The arrows move by row** to the same visual column (the row's indent counted), stepping over folded lines; Page
  Up and Down move by rows; End goes to the row's end and then the line's; Home goes to the row's start and then, as
  before, to the first non-blank character and the line's start. Adding a cursor above or below goes by row.
- **Selections are drawn row by row**, rows that go on to the next reaching the edge rows wrap at; the active line,
  line marks and indent guides cover all of a line's rows; sticky scroll uses the line's full height; the minimap
  maps the slider over rows.

### Spaces and tabs

- **Five ways to show them**: none, at a line's edges and in runs of two or more (and every tab), in the selection,
  at a line's end, or all. Settings picks one (in the selection by default); the View menu's Show whitespace shows
  them all until it is turned off.
- **The text is not changed**: a run of spaces is wrapped in a span drawn with a dot per space as its background,
  and a tab with a line, so copying, clicks and measuring see the same characters.

### In the app

- The View menu has **Turn word wrap on** (Alt+Z) and **Show whitespace**. A new **Settings > Editor** page has
  word wrap, where it wraps, the column, the indent of wrapped rows, which spaces and tabs show, and the editor's
  parts the View menu turns on and off. They are kept on this computer with the editor's layout, each field checked
  when read back.

### The limits are measured

- Browser tests check rows that fit, the indent and tab stops of rows, the caret and clicks at a break, selections
  across rows, arrows and Home and End by row, a narrower editor and wrapping turned on and off keeping the top line,
  a line of a million characters drawn near the view only, and each way of showing spaces.
- **A browser test wraps 100 MB of code at 40 columns**: opening 3 s, a far jump 100 ms, a wheel step 50 ms, a
  keystroke 25 ms typical and 100 ms worst, every line's real rows 15 s, with the top line held while they settle and
  the last line reached by Ctrl+End. Measured here: 0.29 s, 8 ms, 6 ms, 2 and 3 ms, 0.9 s.
- The end-to-end run turns wrapping on with Alt+Z, checks End by row in the app's footer, shows and hides
  whitespace, marks a selection's spaces, and turns wrapping on from Settings > Editor.

## Consequences

- Long lines can be read without scrolling sideways, in a small file or a 100 MB one, and the top of the view does
  not move while a large file's rows settle.
- Every part of the view that placed things by line now asks the layout for rows; future features (E6's input and
  accessibility work, ghost text in E9) build on rows from the start.
- Not done: inlay hints are not counted in a row's width, so a row with hints can run past the edge; column (box)
  selection still goes by line; word wrap is one setting for every file (no per-language default yet).
