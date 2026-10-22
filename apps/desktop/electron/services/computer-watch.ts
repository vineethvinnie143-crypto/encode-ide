/**
 * Tells when the agent is using the computer: the event stream of the sessions, read for the one tool that reaches out
 * of eNCode. The person sees a banner and can stop it from anywhere (see computer-control.ts); this decides when. Pure,
 * so the rules are unit tested.
 *
 * A session counts from the first Computer call of its turn until the turn is over, not only while a call is running:
 * between two calls the model is thinking, and that is when someone who wants it to stop reaches for the control.
 */
import type { AgentEvent, AgentStatus } from '@encode/core'

export const COMPUTER_TOOL = 'Computer'

export interface ComputerActivity {
  /** At least one session is using the computer. */
  active: boolean
  /** The sessions that are, oldest first. */
  sessions: string[]
  /** Everything those sessions are waiting for is the person: an approval or an answer. */
  waiting: boolean
}

const IDLE: ComputerActivity = { active: false, sessions: [], waiting: false }

/** A turn is still going in these. */
const TURN_GOING: ReadonlySet<AgentStatus> = new Set(['thinking', 'running-tool', 'awaiting-approval', 'awaiting-user'])
const WAITING_FOR_PERSON: ReadonlySet<AgentStatus> = new Set(['awaiting-approval', 'awaiting-user'])

interface SessionState {
  /** The turn has made a Computer call that was not turned down. */
  used: boolean
  status: AgentStatus
}

export class ComputerWatch {
  private readonly sessions = new Map<string, SessionState>()
  private last: ComputerActivity = IDLE

  constructor(private readonly onChange: (activity: ComputerActivity) => void) {}

  activity(): ComputerActivity {
    return this.last
  }

  /** Reads one event. Calls `onChange` when what the person should be told is different. */
  see(event: AgentEvent): void {
    const state = this.sessions.get(event.sessionId) ?? { used: false, status: 'idle' as AgentStatus }
    switch (event.type) {
      case 'entry': {
        const tool = event.entry.kind === 'tool' ? event.entry.tool : undefined
        // A call the person declined, or one that has not been let through yet, has not touched anything.
        if (tool?.name === COMPUTER_TOOL && (tool.state === 'running' || tool.state === 'done' || tool.state === 'error')) state.used = true
        break
      }
      case 'status':
        state.status = event.status
        if (!TURN_GOING.has(event.status)) state.used = false
        break
      case 'done':
      case 'error':
      case 'session-reset':
        state.used = false
        state.status = 'idle'
        break
      default:
        return
    }
    this.sessions.set(event.sessionId, state)
    if (!state.used && !TURN_GOING.has(state.status)) this.sessions.delete(event.sessionId)
    this.publish()
  }

  /** Forget a session that was removed, so it cannot keep the banner up. */
  forget(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.publish()
  }

  /** Forget every session: the person turned the feature off, so nothing is using the computer any more. */
  reset(): void {
    this.sessions.clear()
    this.publish()
  }

  private publish(): void {
    const using = [...this.sessions.entries()].filter(([, state]) => state.used && TURN_GOING.has(state.status))
    const next: ComputerActivity = using.length
      ? { active: true, sessions: using.map(([id]) => id), waiting: using.every(([, state]) => WAITING_FOR_PERSON.has(state.status)) }
      : IDLE
    const same = next.active === this.last.active && next.waiting === this.last.waiting && next.sessions.length === this.last.sessions.length && next.sessions.every((id, index) => id === this.last.sessions[index])
    if (same) return
    this.last = next
    this.onChange(next)
  }
}
