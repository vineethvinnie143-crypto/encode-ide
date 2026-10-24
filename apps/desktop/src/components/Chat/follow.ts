/** Scrolled back to within this many pixels of the end, the thread follows new text again. */
export const FOLLOW_WITHIN = 90

/**
 * Whether the thread follows new text after the chat list scrolled from `lastTop` to `top`, where `end` is the
 * furthest it can scroll and `follow` is whether it followed before (ADR 0115).
 *
 * Only a move up stops it: the thread grows below what you read, so text, a step or a diff that lands between the
 * thread's own scroll to the end and the browser reporting that scroll leaves the list where it was, short of the new
 * end, and is no reason to stop. The browser moves the list up too when the thread or the list shrinks (a log
 * folding, a card opening under the thread), but that leaves the list at its very end.
 */
export function followsAfterScroll(follow: boolean, lastTop: number, top: number, end: number): boolean {
  if (top < lastTop - 1 && top < end - 1) return false
  if (end - top < FOLLOW_WITHIN) return true
  return follow
}
