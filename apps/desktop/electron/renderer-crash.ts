/**
 * When the window's page stops (its renderer process crashed, ran out of memory or was killed), the window is left
 * blank. The agents and the terminal live in other processes and keep going, so the page can come back where it was:
 * eNCode says what happened and offers to load it again. A page that keeps stopping is said to, so that the person
 * saves a diagnostics report rather than reloading for ever.
 */

/** How long a run of stops counts as one. */
const WINDOW_MS = 60_000
/** Stops within the window after which the page is said to keep stopping. */
const REPEATED = 3

export type CrashChoice = 'reload' | 'quit'

export interface CrashPrompt {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  /** What each button means, by index. */
  choices: CrashChoice[]
}

/** Remembers when the page stopped, to tell one stop from a page that keeps stopping. */
export class CrashCounter {
  private readonly times: number[] = []

  /** Records a stop at `now`; returns how many stops there were in the last minute, this one included. */
  record(now: number): number {
    this.times.push(now)
    while (this.times.length && now - this.times[0] > WINDOW_MS) this.times.shift()
    return this.times.length
  }
}

/** A clean exit is the page closing with the window; nothing to tell. */
export function isCrash(reason: string): boolean {
  return reason !== 'clean-exit'
}

/** Why the page stopped, in a phrase. */
function because(reason: string): string {
  switch (reason) {
    case 'oom':
      return 'it ran out of memory'
    case 'killed':
      return 'another program ended it'
    case 'launch-failed':
      return 'it could not start'
    case 'integrity-failure':
      return 'its code failed a check'
    default:
      return 'it crashed'
  }
}

export function crashPrompt(reason: string, recent: number): CrashPrompt {
  const again = recent >= REPEATED
  return {
    message: again ? "eNCode's window keeps stopping" : "eNCode's window stopped",
    detail: again
      ? `It stopped ${recent} times in the last minute; this time ${because(reason)}. Your chats and running agents are kept. If it stops again after a reload, save a diagnostics report from Help and send it with what you were doing.`
      : `The window's page stopped because ${because(reason)}. Your chats and running agents are kept; edits not yet saved in the editor are lost. Reload to carry on where you were.`,
    buttons: ['Reload', 'Quit eNCode'],
    defaultId: 0,
    cancelId: 0,
    choices: ['reload', 'quit'],
  }
}
