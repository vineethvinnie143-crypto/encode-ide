# 0081. Input methods compose in place, screen readers read the lines around the cursor, and right-to-left text reads in its own order only where it cannot move code

- Status: Accepted, builds on 0003 and 0080, refines 0033
- Date: 2026-10-23

## Context

The editor is our own (0033), so the long tail of Windows input is ours too, and the committed editor scope names it:
input methods, right-to-left text, display scaling, accessibility and the clipboard. Where it stood:

- An input method composed in the hidden textarea, which was shown over the text while it composed: the composition
  covered the characters after the caret, Chromium painted it with its own yellow background, and with several cursors
  only the main one got it.
- A copy made with several cursors pasted the whole text at every cursor, unless it happened to have one line per
  cursor; a file with Windows line endings copied with `\n`.
- Lines were laid out at whatever fraction of a pixel the line height came to at 125% or 150%, so line spacing and
  selections could be a pixel uneven; nothing measured the text again when the window moved to a screen of another
  scale, and a change of font size in Settings was not noticed at all (the probe was an inline span, which a resize
  observer never reports).
- 0033 said screen reader support was limited: the textarea held nothing, so a screen reader heard nothing as the
  cursor moved. Tab indents, and `Escape` then `Tab` was the only way out of the editor.
- Every line is laid out in stored order (`unicode-bidi: bidi-override`). That is a deliberate defence against "Trojan
  Source" (text that reads differently from how it runs), but it leaves Hebrew or Arabic in a string, a comment or a
  Markdown file unreadable: its letters run left to right.

## Decision

### Input methods

- **The composition is drawn in place, at every cursor**: as an inline widget (the `compose` kind of the hints from
  0078), underlined, with the text after it moved along and the caret after it. The document does not change until the
  composition is committed, as one edit at every cursor. The textarea stays invisible over the composition, as wide as
  it, so the input method's window opens beside it.
- What is selected is taken out when composing starts, as typing over it would; a click elsewhere commits what was
  composed; a read-only editor draws nothing and refuses the commit.

### The clipboard

- **A copy made with several cursors remembers what each gave.** The clipboard holds only text, so the last copy (from
  any editor on the page) is kept beside it: pasting that same text with as many cursors gives each its own piece, even
  a piece with lines of its own; with another number of cursors the paste is as before.
- **A file with Windows line endings copies with them**, as the file has them; pasting normalises either.
- Ctrl+Insert, Shift+Insert and Shift+Delete copy, paste and cut, as in any Windows text field.

### Screen scale and fonts

- **A line is a whole number of device pixels high**: the measured line height is rounded to the device pixel, so at
  125%, 150% or 175% every line starts on a pixel and lines are evenly spaced.
- **The text is measured again when the device pixel ratio changes** (a screen of another scale, the scale changed,
  the page zoomed) and when the font's size or line height changes: the probe's two spans are boxes of their own, and
  its row is watched too.

### Screen readers

- **A screen reader mode** puts the lines around the main cursor in the textarea, in pages of ten lines (at most
  20,000 characters around the cursor, cut on whole characters), with the selection selected in it and its direction
  kept. The textarea is brought up to date in the same task as each change, so the screen reader reads the character,
  word or line the cursor moved over, and what is selected.
- What is typed is then what changed between that text and the textarea's: text in the selection's place is typed
  with the editor's conveniences; any other change (a screen reader's own editing) is made as it is. A selection made
  in the textarea (a braille display's routing keys) becomes the editor's. An input method composes there too.
- **The app turns it on** when Chromium reports assistive technology (Electron's `accessibility-support-changed`), or
  always or never, as Settings > Editor says (Auto by default).
- **What the text does not show is said** through a polite live region: a fold opened or closed, the number of cursors
  after adding one, typing refused in a read-only editor, Tab's new meaning, and the problem F8 went to. The find
  widget's count was already a live region.

### The keyboard, motion and contrast themes

- **Ctrl+M makes Tab move the focus** (and Shift+Tab back), and again makes it indent; a snippet's stops still take
  Tab. It is kept with the editor's layout and in the View menu. `Escape` then `Tab` still works.
- Reduce motion set to On in Settings > Appearance stops the caret blinking; with System, the view follows Windows.
- **In a Windows contrast theme** the system's colours replace the theme's and backgrounds are dropped, so what the
  editor marks with a background is drawn in system colours: the selection with `Highlight` (filled lightly and
  outlined, so the text over it stays readable), the caret in `CanvasText`, matches and the bracket pair outlined,
  changes as bars, squiggles, guides, whitespace marks, markers, hints and the minimap's slider in system colours.

### Right-to-left text

- **Off by default, every line stays in stored order**, as 0033 decided.
- **Turned on (Settings > Editor), right-to-left text reads in its own order only inside strings and comments** (a
  string's escapes with it), and in prose (plain text and Markdown, inline code aside). Each such stretch that has
  right-to-left letters is drawn isolated (`unicode-bidi: isolate`, left-to-right base), so nothing inside it can move
  anything outside it; the code between stays in stored order, which is the order it runs in. Bidi control characters
  never reach the DOM (they are markers, as before), so nothing inside a stretch can override its letters either.
- **The caret, clicks and selections follow what is drawn**: inside an isolated stretch a right-to-left character
  starts at its right edge; after right-to-left text the caret stays at its end (its left edge), so typing on reads
  leftwards; a click is the nearest boundary as drawn (past the line's right edge, its end); a selection is drawn as
  the boxes the browser lays its text out in, which may be several. The arrows move in stored order, a character at a
  time, as they do everywhere else.

### The limits are measured

- Browser tests: composition in place at one and many cursors, over a selection, in a wrapped line and a read-only
  one, committed by a click; a multi-cursor copy pasted back by piece and as a whole, CRLF on the clipboard,
  Ctrl+Insert, Shift+Delete and Shift+Insert; lines on device pixels at 125%, 150% and 175% and back, and a font
  change measured again; the screen reader mode's text, caret, backwards selection, typing, Backspace, pages, a
  braille selection, an input method, a paste and turning it off; a selection too large to copy whole; notices for
  folds, cursors and read-only typing; Ctrl+M and Tab; a contrast theme's colours; right-to-left text in stored order
  by default and in reading order inside a string and a comment only, a control character still a marker, the caret
  at both ends, a click, a selection inside the run, typing on, prose in Markdown and in a wrapped line.
- Unit tests: copying and pasting by piece, line-wise too; which stretches of a line are isolated; the saved layout.
- The end-to-end run copies and pastes with Ctrl+Insert and Shift+Insert, uses Ctrl+M and Tab, turns the screen
  reader mode on in Settings > Editor and reads the editor's field, and turns right-to-left reading order on.

## Consequences

- Chinese, Japanese and Korean input, and dictation, compose where the text goes, at every cursor.
- Screen reader users can read and edit in the editor; 0033's "screen reader support is limited" no longer holds for
  reading the text around the cursor, though widgets (hover cards, the suggestion list) still say little.
- Right-to-left strings and comments can be read without giving up 0033's guarantee for code.
- Not done: the arrows do not move visually through right-to-left text; an identifier in a right-to-left script stays
  in stored order; a prose line with markup inside right-to-left text reads in pieces, each in its own order but the
  pieces left to right; the screen reader mode reads text, not the hints or problem marks beside it.
