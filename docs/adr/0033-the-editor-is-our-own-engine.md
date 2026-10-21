# 0030. The editor is our own engine: text model, core and view

- Status: Accepted
- Date: 2026-10-21

## Context

eNCode may not embed Monaco, CodeMirror or any VS Code code
([0003](0003-own-code-above-the-platform.md)). The editor Forge shipped was a textarea laid
over a highlighted `<pre>`: quick to build, but it re-rendered the whole file on every
keystroke, could not virtualize, kept its undo history in the browser and gave an agent's
edit no more structure than a string.

What the editor has to be good at is not what a general-purpose one optimizes for:

- **Review.** The agent edits files, so the editor must show a change against a baseline
  and let the user keep or undo it hunk by hunk.
- **Size.** Generated files, logs and minified bundles open without freezing the window.
- **Honest display.** Text must not be able to read differently from how it is stored
  ([T18](../security/threat-model.md)).
- **Restyling.** The UI is designed in another thread and changes often. The editor must
  take its look from variables, not from selectors that reach into its markup.
- **Windows first.** Input methods, clipboard and display scaling are checked on Windows
  ([0012](0012-windows-first-ci.md)).

## Decision

Four packages, each depending only on the ones above it. The first three have no DOM and
run under plain Node, so the tests are fast and the logic could move to a worker.

- **`@encode/text`**: an immutable line tree (leaves of up to 256 lines with prefix sums,
  structural sharing). Offsets are UTF-16 code units, the text always uses `\n`, and the
  line ending a file had is configuration. A `ChangeSet` applies, inverts, composes and maps
  positions, so undo, review and the highlighter all speak one change format.
- **`@encode/diff`**: Myers O(ND) in linear space with a deadline fallback, hunks that apply
  and unapply with verification, and word diffs.
- **`@encode/editor`**: immutable state and transactions, multiple selections, grouped undo
  with a history point that identifies the document's place, about 50 editing commands,
  search and replace, bracket matching, hunk review against a baseline, `reload` (a change
  on disk as a small line diff) and an incremental highlighter over hand-written
  tokenizers (35 languages, including CfxLua). A tokenizer is a function from a line and a
  state string to tokens, and a state string equal to the old one is where re-tokenizing
  stops.
- **`@encode/editor-view`**: the DOM. One native scroller whose height comes from a height
  map, with the scroll range scaled down past 8 million pixels so a million-line file still
  scrolls with a native bar. Only the lines in view exist, pooled. Selections, marks and line
  backgrounds are rect layers. Keys, IME and the clipboard go through a hidden textarea
  placed at the caret, never `contenteditable`. Decorations come from sources keyed by
  owner and are mapped through edits; zones are blocks between lines, which is how a hunk's
  removed lines are shown.

How it is themed: the host sets `--enc-editor-*` and `--enc-tok-*` on any ancestor and the
package reads nothing else. The desktop app maps them from its tokens in
`theme/editor-terminal.css`.

How the display stays honest: control, bidi, zero-width and filler characters, and the
tag block that spells invisible ASCII, are drawn as labelled markers (`U+202E`) and the
character itself never reaches the DOM; every line is laid out in stored order
(`unicode-bidi: bidi-override`). Text is only ever written as text nodes, never as HTML.

How it is verified: unit and property tests for the three core packages and the view's pure
parts, and browser scenarios that drive the view in a real Chromium over the DevTools
protocol, with no test library: caret and mouse, 100 000 and 1.5 million lines, IME,
clipboard, long lines, find, review, fractional display scaling, document switching and a
hidden container. CI runs them on Windows with the installed Chrome.

## Consequences

- Review is part of the editor, not a layer on top: Keep moves a hunk into the baseline and
  Undo restores it as one undo step.
- A million-line file edits in microseconds and scrolls with a native bar.
- We own the long tail: IME quirks, bidi, accessibility. The view exposes the focused
  textarea and the lines in view only, so screen reader support is limited. Tab indents, so
  `Escape` then `Tab` is the way out of the editor.
- Right-to-left text is shown in stored order. That is deliberate (the display cannot be
  used to disguise code) and costs readability for right-to-left scripts. An opt-in view
  that reorders is possible later.
- Not built yet: word wrap, folding, a minimap, completion and hover popups. The diagnostics
  and zone mechanisms they need exist.
- A new language costs one tokenizer and a registry line.
