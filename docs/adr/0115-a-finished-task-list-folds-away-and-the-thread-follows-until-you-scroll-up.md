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

## Decision

- **Only a move up stops the thread following** (`components/Chat/follow.ts`). A scroll event stops it when the list
  moved up from where it last was, unless it is now at its very end; the browser moves the list up only to keep the end
  in view, when the thread or the list shrinks. Coming back within 90 px of the end starts it again, as before. Text
  that lands below leaves the list where it was, which is never a reason to stop.
- **The thread's own scrolls record where they put the list**, so a scroll it made is never read as a move.
- **A turn of the wheel up stops it at once** (`onWheel`), before the scroll it starts is reported, so a stream that
  grows the thread in the same frame cannot pull the list back down under the person's hand. Ctrl with the wheel
  zooms and does not count.
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

## Verification

- `follow.test.ts`: following goes on when text lands below, stops on any move up, goes on when the browser keeps the
  end in view, and starts again near the end.
- `chat.test.ts`: `finishedList`, and a session opened with a finished list shows none.
- Smoke part `follow` (ENCODE_SMOKE_ONLY=follow): a list of three items written and finished, then a long answer in
  small pieces. The card shows 3/3 and folds away while the answer streams; the thread is at the end of the answer;
  the 60 + 420 px growth before the next frame leaves it at the end; a turn of the wheel up shows Jump to the latest
  and leaves the list where it was as more text comes; Jump to the latest goes back and follows again; the last task
  step says 3 of 3 done; the session reloaded shows no card. Before the change the part failed on the card and on the
  growth.
