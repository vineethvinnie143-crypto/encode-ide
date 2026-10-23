/**
 * Calls that keep failing the same way (ADR 0089). A weaker model that gets an error often sends the very same call
 * again, and again, until the turn runs out of steps. From the third time a call fails with the same error, its
 * result says so, and says what to do instead.
 */

/** The failure, of the same call with the same error, from which the result says to change course. */
export const REPEAT_LIMIT = 3

/** Calls remembered in one turn; a turn that makes more is not stuck on one. */
const MAX_KEPT = 200

/** What the model is told when it sends a call that failed the same way before. */
export function repeatNote(count: number): string {
  return `This exact call has now failed ${count} times with the same error, so sending it again will fail again. Change what you send (read the file or the error again first), try another way, or ask the user.`
}

/** What eNCode changed in a call before it ran it, for the model. */
export function mendedNote(fixes: readonly string[]): string {
  return `eNCode read this call as: ${fixes.join('; ')}. Use the parameter names and types the tool gives next time.`
}

export class FailedCalls {
  private readonly seen = new Map<string, { error: string; count: number }>()

  /** A new turn: what failed before is not held against the model. */
  clear(): void {
    this.seen.clear()
  }

  /** Notes how a call ended. Returns the note to add to its result when it failed the same way REPEAT_LIMIT times or more. */
  record(name: string, input: Record<string, unknown>, failure: string | undefined): string | undefined {
    const key = `${name}\u0000${JSON.stringify(input)}`
    if (failure === undefined) {
      this.seen.delete(key)
      return undefined
    }
    const error = failure.slice(0, 500)
    const last = this.seen.get(key)
    const count = last && last.error === error ? last.count + 1 : 1
    this.seen.delete(key)
    this.seen.set(key, { error, count })
    if (this.seen.size > MAX_KEPT) this.seen.delete(this.seen.keys().next().value as string)
    return count >= REPEAT_LIMIT ? repeatNote(count) : undefined
  }
}
