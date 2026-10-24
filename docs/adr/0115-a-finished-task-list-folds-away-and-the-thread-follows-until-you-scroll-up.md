# 0115. A finished task list folds away, and the thread follows until you scroll up

- Status: Accepted, builds on 0017
- Date: 2026-10-24

## Context

A tester sent two things from one session:

- The Tasks card above the message box still showed "6/6" with every item struck through, long after the work was
  done. The card hid only when the list was empty, and the agent never empties a list it has finished; a session
  opened later showed the finished card again.
- The thread stopped following an answer as it streamed, and stayed where it was until they scrolled down by hand.

The thread followed new text from a `ResizeObserver` on the thread, as long as a flag said to. The flag was set by
every scroll event to "within 90 px of the end". A scroll the thread makes itself is reported at the next frame, so
text that lands in between (a diff opening under an edit, a step, a burst of text applied outside a frame, the 100 ms
fallback of the delta buffer on a busy frame) put the list more than 90 px from the new end when the event came. The
flag read that as the person having scrolled up, and the thread stopped. A smoke check that grows the thread by 60 px
and then, before the next frame, by 420 px reproduced it every time: the list stopped 442 px short of the end, with
Jump to the latest showing.

A first fix read only a move up as a reason to stop. It passed here and failed on the Windows machine of the CI, where
the thread stopped following 337 px short of the end before the answer began. The page moves the list up on its own
too: the browser keeps what is in view in place when something above it gets shorter (scroll anchoring), a control
above takes the focus, a window changes size. Which of these it was there is not known; where the list is cannot say
who moved it. Moving the list up by script, with nobody at the wheel, reproduces the failure here: 337 px short, Jump to
the latest showing.

Sending a message did not start the thread following again either: after reading back, the answer to the next message
streamed in out of sight.

## Decision

- **Only a move up of yours stops the thread following** (`components/Chat/follow.ts`). A scroll is yours while you
  hold the list or its scroll bar, and for 600 ms after the wheel, a key in the thread or the find bar, a touch, a move
  of Find to a match, or letting go of the list; the browser's smooth scroll after one turn of the wheel runs on for a
  few frames. A move up of yours stops it; coming back within 90 px of the end, yours, starts it again; at the very end
  it follows, whoever moved the list there.
- **A move the page made on its own never stops it.** Text that lands below leaves the list short of the new end, the
  browser keeps the view in place when something above shrinks, a window changes size: while the thread follows, a
  move up that was not yours goes straight back to the end, rather than at the next text. While you read back, the page
  moving the list near the end does not start it again.
- **The thread's own scrolls record where they put the list**, so a scroll it made is never read as a move.
- **A turn of the wheel up stops it at once** (`onWheel`), before the scroll it starts is reported, so a stream that
  grows the thread in the same frame cannot pull the list back down under the person's hand. Ctrl with the wheel
  zooms and does not count.
- **Sending a message goes to the end and follows the answer**, wherever you had scrolled to, a message sent while
  the agent works included.
- **The list is watched as well as the thread.** When a card opens under the thread or the window gets smaller, the end
  stays in view.
- **Jump to the latest shows whenever the thread is not following**, not when the list is some distance from the end.
- **A finished task list folds away** (`components/Chat/TodoCard.tsx`). Once every item is done, the card stays for
  1.2 seconds so the last tick is seen, then folds away with the same motion as the other folds (`ui/Collapse`). A new
  list from the agent grows in. A session opened with a finished list shows no card (`finishedList` in
  `stores/chat.ts`); the list itself is kept as the agent left it.
- **The task step says how far the list got**: "Updated tasks · 3 of 6 done".

## Consequences

- The thread follows a long answer through diffs, steps and bursts of text, and stops as soon as the person scrolls
  up, even by one turn of the wheel.
- A list the agent left unfinished stays on screen, since that work is not done.
- A scrollbar drag or a key that scrolls up is seen at the next scroll event, a frame later than the wheel.
- A press the page never hears end (a scroll bar dragged and let go outside the window) ends at the next move of the
  mouse with no button down.
- Scrolling up with the middle button's autoscroll is not seen as yours after the press, and the thread may pull the
  list back to the end.

## Verification

- `follow.test.ts`: following goes on when text lands below, stops on a move up of yours, goes on when the page moves
  the list up on its own and when the browser keeps the end in view, starts again near the end when you scroll there,
  and not when the page moves the list there.
- `chat.test.ts`: `finishedList`, and a session opened with a finished list shows none.
- Smoke part `follow` (ENCODE_SMOKE_ONLY=follow): a list of three items written and finished, then a long answer in
  small pieces. The card shows 3/3 and folds away while the answer streams; the thread is at the end of the answer;
  the 60 + 420 px growth before the next frame leaves it at the end; the list moved up 337 px by script goes back to the
  end, with no Jump to the latest; a turn of the wheel up, over a part of the list nothing covers, shows Jump to the
  latest and leaves the list where it was as more text comes; Jump to the latest goes back and follows again; dragging
  the scroll bar up does the same, where the scroll bar is in view; a message sent after a turn of the wheel up ends
  with the thread at its answer; the last task step says 3 of 3 done; the session reloaded shows no card. If the thread
  stops following while the answer streams, the part prints every scroll of the list before it. Before the change the
  part failed on the card and on the growth; with the first fix it failed on the script's move (337 px short, as on the
  Windows CI) and on the message sent while reading back (650 px short).
