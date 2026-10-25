/**
 * What eNCode does for the person while they look elsewhere: a Windows notice when a request finishes or the agent
 * needs them, the taskbar button flashing while it waits for them, and the computer kept awake while an agent works.
 * Only the decisions live here; Electron's Notification, flashFrame and powerSaveBlocker are behind `AttentionEffects`,
 * so the rules are unit tested.
 */
import type { AgentEvent, AgentStatus, NotifyWhen } from '../../shared/types'

export interface AttentionSettings {
  notifyDone: NotifyWhen
  notifyNeeds: NotifyWhen
  flashTaskbar: boolean
  keepAwake: boolean
}

export interface Notice {
  /** The session the notice is about; empty for a test notice. */
  sessionId: string
  kind: 'done' | 'error' | 'needs' | 'test'
  title: string
  body: string
}

export interface AttentionEffects {
  /** Whether eNCode's window is the one in front (focused and not minimized). */
  focused(): boolean
  /** A session's name, for the notice; undefined when it cannot be read. */
  titleOf(sessionId: string): Promise<string | undefined>
  notify(notice: Notice): void
  flash(on: boolean): void
  keepAwake(on: boolean): void
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

const WORKING: ReadonlySet<AgentStatus> = new Set(['thinking', 'running-tool'])
const WAITING: ReadonlySet<AgentStatus> = new Set(['awaiting-approval', 'awaiting-user'])

/** A request that ends and starts again within this long (a goal's next round, a queued message going out) is not done. */
export const DONE_SETTLE_MS = 2_000
/** The computer may sleep this long after the last agent stopped working, so the gap between two requests keeps it awake. */
export const AWAKE_GRACE_MS = 15_000

/** A session's name as a notice's title: one line, short enough for the notice. */
export function noticeTitle(title: string | undefined): string {
  const line = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return 'eNCode'
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/**
 * What a notice says. Never an error's text: a provider's error can quote what was sent to it, and Windows keeps
 * notices in its notification centre after eNCode closes.
 */
export function noticeBody(kind: Notice['kind'], detail?: { status?: AgentStatus; summary?: string }): string {
  if (kind === 'needs') return detail?.status === 'awaiting-approval' ? 'Wants your approval to go on.' : 'Is waiting for your answer.'
  if (kind === 'error') return 'Stopped with an error. Open eNCode to see it.'
  if (kind === 'test') return 'This is how eNCode tells you a request finished.'
  const summary = (detail?.summary ?? '').replace(/\s+/g, ' ').trim()
  // A summary is eNCode's own line (stopped after N steps); a model's reply is never put in a notice.
  return /^Stopped after \d+ steps\./.test(summary) ? summary : 'Finished.'
}

export class Attention {
  private readonly statuses = new Map<string, AgentStatus>()
  /** Requests that ended a moment ago, held back in case another starts at once. */
  private readonly settling = new Map<string, unknown>()
  private awake = false
  private sleepTimer: unknown = null
  private flashing = false
  private disposed = false

  constructor(
    private readonly settings: () => AttentionSettings,
    private readonly effects: AttentionEffects,
  ) {}

  see(event: AgentEvent): void {
    if (this.disposed) return
    const id = event.sessionId
    if (event.type === 'status') {
      const before = this.statuses.get(id)
      this.statuses.set(id, event.status)
      if (WORKING.has(event.status) || WAITING.has(event.status)) this.unsettle(id)
      if (WAITING.has(event.status) && !(before !== undefined && WAITING.has(before))) this.needs(id, event.status)
      if (!this.anyWaiting()) this.stopFlashing()
      this.updateAwake()
    } else if (event.type === 'done') {
      this.settle(id, 'done', event.summary)
    } else if (event.type === 'error') {
      this.settle(id, 'error')
    } else if (event.type === 'session-reset') {
      this.forget(id)
    }
  }

  /** eNCode's window came to the front or went to the back. */
  focusChanged(focused: boolean): void {
    if (focused) this.stopFlashing()
  }

  /** The settings changed: keeping awake may have been turned on or off. */
  settingsChanged(): void {
    if (!this.settings().flashTaskbar) this.stopFlashing()
    this.updateAwake()
  }

  /** A session went away: nothing about it is told any more. */
  forget(sessionId: string): void {
    this.unsettle(sessionId)
    this.statuses.delete(sessionId)
    if (!this.anyWaiting()) this.stopFlashing()
    this.updateAwake()
  }

  /**
   * An agent is working or waiting for the person, or a request ended a moment ago and may go on (a goal's next round,
   * a queued message): what a restart to update waits for (ADR 0127).
   */
  busy(): boolean {
    if (this.settling.size > 0) return true
    for (const status of this.statuses.values()) if (WORKING.has(status) || WAITING.has(status)) return true
    return false
  }

  /** A notice like a finished request's, whatever the settings say, so the person sees what Windows does with it. */
  test(): void {
    this.effects.notify({ sessionId: '', kind: 'test', title: 'eNCode', body: noticeBody('test') })
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.settling.values()) this.effects.clearTimer(timer)
    this.settling.clear()
    if (this.sleepTimer !== null) this.effects.clearTimer(this.sleepTimer)
    this.sleepTimer = null
    if (this.awake) this.effects.keepAwake(false)
    this.awake = false
    this.stopFlashing()
  }

  private shows(when: NotifyWhen): boolean {
    return when === 'always' || (when === 'background' && !this.effects.focused())
  }

  private needs(sessionId: string, status: AgentStatus): void {
    const settings = this.settings()
    if (settings.flashTaskbar && !this.effects.focused() && !this.flashing) {
      this.flashing = true
      this.effects.flash(true)
    }
    if (this.shows(settings.notifyNeeds)) void this.tell(sessionId, 'needs', noticeBody('needs', { status }))
  }

  private settle(sessionId: string, kind: 'done' | 'error', summary?: string): void {
    this.unsettle(sessionId)
    const timer = this.effects.setTimer(() => {
      this.settling.delete(sessionId)
      if (this.disposed) return
      const status = this.statuses.get(sessionId)
      // Working again or waiting for the person: that is not the end, and waiting has its own notice.
      if (status !== undefined && (WORKING.has(status) || WAITING.has(status))) return
      if (this.shows(this.settings().notifyDone)) void this.tell(sessionId, kind, noticeBody(kind, { summary }))
    }, DONE_SETTLE_MS)
    this.settling.set(sessionId, timer)
  }

  private unsettle(sessionId: string): void {
    const timer = this.settling.get(sessionId)
    if (timer === undefined) return
    this.effects.clearTimer(timer)
    this.settling.delete(sessionId)
  }

  private async tell(sessionId: string, kind: Notice['kind'], body: string): Promise<void> {
    let title: string | undefined
    try {
      title = await this.effects.titleOf(sessionId)
    } catch {
      title = undefined
    }
    if (this.disposed) return
    this.effects.notify({ sessionId, kind, title: noticeTitle(title), body })
  }

  private anyWaiting(): boolean {
    for (const status of this.statuses.values()) if (WAITING.has(status)) return true
    return false
  }

  private stopFlashing(): void {
    if (!this.flashing) return
    this.flashing = false
    this.effects.flash(false)
  }

  private updateAwake(): void {
    let working = false
    for (const status of this.statuses.values()) if (WORKING.has(status)) working = true
    const want = working && this.settings().keepAwake
    if (want) {
      if (this.sleepTimer !== null) {
        this.effects.clearTimer(this.sleepTimer)
        this.sleepTimer = null
      }
      if (!this.awake) {
        this.awake = true
        this.effects.keepAwake(true)
      }
      return
    }
    if (!this.awake) return
    // Turned off in Settings: at once. Done working: after a grace, in case the next request is about to start.
    if (!this.settings().keepAwake) {
      if (this.sleepTimer !== null) this.effects.clearTimer(this.sleepTimer)
      this.sleepTimer = null
      this.awake = false
      this.effects.keepAwake(false)
      return
    }
    if (this.sleepTimer !== null) return
    this.sleepTimer = this.effects.setTimer(() => {
      this.sleepTimer = null
      if (this.disposed || !this.awake) return
      this.awake = false
      this.effects.keepAwake(false)
    }, AWAKE_GRACE_MS)
  }
}
