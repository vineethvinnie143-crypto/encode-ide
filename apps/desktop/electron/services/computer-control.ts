/**
 * What the person is given while the agent uses their computer: a banner that says so, with a Stop button, and a key
 * combination that stops it from whatever window they are in. This decides when each exists and what Stop does; the
 * window and the shortcut themselves are Electron's and come in as `overlay` and `shortcuts` (see computer-overlay.ts).
 *
 * Stop cancels every session that is using the computer. It does not close the conversation or undo anything: the turn
 * ends the way it does when the person presses Stop in the window, and whatever the agent had done stays done.
 */
import type { ComputerActivity } from './computer-watch'

/** The combination that stops the agent from anywhere. The Computer tool refuses to press it (keys.ts), so the agent cannot stop itself. */
export const STOP_SHORTCUT = 'Control+Alt+Escape'
/** How it is written for people. */
export const STOP_SHORTCUT_LABEL = 'Ctrl+Alt+Esc'

export interface OverlayState {
  /** What the banner says. */
  mode: 'using' | 'waiting' | 'stopping'
  /** The shortcut that works now, or null when another program holds it and only the button is left. */
  shortcut: string | null
}

export interface Overlay {
  show(state: OverlayState): void
  update(state: OverlayState): void
  hide(): void
}

export interface Shortcuts {
  /** False when the combination could not be taken: another program has it. */
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
}

export interface ComputerControlOptions {
  overlay: Overlay
  shortcuts: Shortcuts
  /** Ends the turn of a session, as the Stop button of its window does. */
  cancel(sessionId: string): Promise<void>
  log?(message: string): void
}

export class ComputerControl {
  private activity: ComputerActivity = { active: false, sessions: [], waiting: false }
  private shown = false
  private registered = false
  private stopping = false
  private disposed = false

  constructor(private readonly o: ComputerControlOptions) {}

  /** The sessions using the computer changed. */
  setActivity(activity: ComputerActivity): void {
    if (this.disposed) return
    this.activity = activity
    if (!activity.active) {
      this.release()
      return
    }
    const state = this.state()
    if (this.shown) {
      this.o.overlay.update(state)
      return
    }
    this.hold()
    this.o.overlay.show(this.state())
    this.shown = true
  }

  /** The button, or the key combination. Pressed again, it asks again: a turn that has not ended yet is not left running. */
  stop(): void {
    const sessions = this.activity.sessions
    if (!sessions.length) return
    this.stopping = true
    if (this.shown) this.o.overlay.update(this.state())
    for (const id of sessions) {
      this.o.cancel(id).catch((error) => this.o.log?.(`could not stop ${id}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  /** Called when eNCode quits: gives everything back, and takes nothing again. */
  dispose(): void {
    this.disposed = true
    this.release()
  }

  private state(): OverlayState {
    return { mode: this.stopping ? 'stopping' : this.activity.waiting ? 'waiting' : 'using', shortcut: this.registered ? STOP_SHORTCUT_LABEL : null }
  }

  /** The key combination is taken only while the agent is at work, so no other program loses it the rest of the time. */
  private hold(): void {
    if (this.registered) return
    try {
      this.registered = this.o.shortcuts.register(STOP_SHORTCUT, () => this.stop())
    } catch (error) {
      this.o.log?.(`could not take ${STOP_SHORTCUT}: ${error instanceof Error ? error.message : String(error)}`)
      this.registered = false
    }
    if (!this.registered) this.o.log?.(`${STOP_SHORTCUT_LABEL} is taken by another program; the Stop button still works`)
  }

  private release(): void {
    this.stopping = false
    if (this.registered) {
      try {
        this.o.shortcuts.unregister(STOP_SHORTCUT)
      } catch (error) {
        this.o.log?.(`could not give back ${STOP_SHORTCUT}: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.registered = false
    }
    if (this.shown) {
      this.o.overlay.hide()
      this.shown = false
    }
  }
}
