/** Scrolled back to within this many pixels of the end, the thread follows new text again. */
export const FOLLOW_WITHIN = 90

/**
 * How long after the wheel, a key, a touch, a find or letting go of the list a scroll still counts as yours: the
 * browser's smooth scroll after one turn of the wheel runs on for a few frames.
 */
export const YOURS_MS = 600

/**
 * Whether the thread follows new text after the chat list scrolled from `lastTop` to `top`, where `end` is the
 * furthest it can scroll, `follow` is whether it followed before and `yours` is whether you were scrolling it
 * (ADR 0115).
 *
 * Only a move up of yours stops it. The page moves the list on its own all the time: text, a step or a diff lands
 * between the thread's own scroll to the end and the browser reporting it; the browser keeps what is in view in place
 * when something above it changes height (scroll anchoring), or brings the list up when the thread or the list
 * shrinks; the window changes size. None of that is you reading back, so none of it stops the thread, and none of it
 * starts it again short of the very end.
 */
export function followsAfterScroll(follow: boolean, lastTop: number, top: number, end: number, yours: boolean): boolean {
  if (top >= end - 1) return true
  if (!yours) return follow
  if (top < lastTop - 1) return false
  if (top > lastTop + 1 && end - top < FOLLOW_WITHIN) return true
  return follow
}
