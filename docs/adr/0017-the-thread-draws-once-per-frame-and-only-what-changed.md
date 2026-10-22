# 0017. The thread draws once per frame, and only what changed

- Status: Accepted
- Date: 2026-10-22

## Context

The interface did not feel smooth while an answer streamed, and it got worse the longer the thread
was. `pnpm perf` (apps/desktop/scripts/perf.mjs) streams a long markdown answer, about 2,000 pieces
at 300 a second, into a thread that already holds 0 to 5 earlier long answers, and records the
frames the page draws. On a machine without a GPU, before this decision:

| Thread before the answer | Script time per second | Layout per second | Frames per second | Slowest frame |
| --- | --- | --- | --- | --- |
| 0 long answers | 235 ms | 263 ms | 60 | 33 ms |
| 5 long answers | 456 ms | 100 ms | 55 | 83 ms |

Four things caused it. Each piece of text went into the store on its own, and the store renders
synchronously, so the thread rendered about 300 times a second. The answer's markdown was parsed again
and its whole HTML replaced on every piece, so the browser laid out the whole answer each time and a
text selection inside it was lost. Every turn of the thread rendered again on every piece, since
the turn objects were rebuilt. And dragging a panel's edge set React state on every pointer move, which
rendered the whole window and wrote the saved size to disk each time.

## Decision

- **Streamed text is applied once per frame** (`stores/deltas.ts`). Pieces wait in a buffer and are
  handed over on the next animation frame, or after 100 ms where there are no frames (a minimised
  window). Any other event flushes the buffer first, so events keep their order; opening another
  session discards it.
- **Markdown is a list of blocks, and the page redraws only the blocks that changed**
  (`renderMarkdownBlocks`, `dom-blocks.ts`). A block is one top-level HTML element. The element that
  holds them is not drawn by React: the blocks before the last stay as they are between pieces, so
  a selection, a scrolled code block and the hover under the pointer survive.
- **A turn that did not change is the same object** (`reuseTurns`), and the turn, its work log and its
  steps skip rendering when handed the object they drew last. While an answer streams only its own
  turn, and not even that turn's finished steps, render.
- **A panel drag sets the size on the element** and the state changes once, when the pointer is
  released (`useResizable`, `element`).
- **A burst of file events refreshes the tree and git at its start and once at its end** (`throttle`,
  300 ms), not once per file.
- **Turns far from the end of a long thread are not laid out or painted** (`content-visibility: auto`
  on all but the last four, with their last height remembered), so a long thread opens, resizes and
  streams at the cost of what the screen shows.

Folds (a work log, a step's output, an edited-files list) now grow and shrink (`ui/Collapse.tsx`) and
panels slide in; both honour Settings > Appearance > Motion, like every transition.

## Consequences

- After: script time is 35 to 45 ms per second and layout about 16 ms per second in every run, 60
  frames per second and a slowest frame of 16.8 ms, whatever the length of the thread.
- The text of an answer is owned by `dom-blocks.ts`, not by React. A change to the markdown
  renderer must keep every block one element (`markdown.test.ts` checks it, and that blocks before
  the last two do not change while an answer streams). `pnpm perf` also checks the finished answer
  against what was sent.
- An entry is replaced whenever it changes, never changed in place: the reuse of turns compares
  entries by identity. The stores already work that way.
- Turns that are far away use an estimated height (320 px) until they have been seen, so the scroll
  bar's length is approximate in a long thread. The browser keeps the reading position while heights
  settle.
- `pnpm perf` is a development tool, not a CI gate: frame numbers depend on the machine.
