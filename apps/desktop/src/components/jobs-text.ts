import type { BackgroundJob } from '@shared/types'

const STATUS: Record<BackgroundJob['status'], string> = { running: 'Running', done: 'Done', error: 'Failed', killed: 'Stopped' }

/** "14:05", or "Fri 14:05" when it is not on the day of `now`. */
export function wakeTime(at: number, now = Date.now()): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** How a job card names what runs in the background. */
export interface JobText {
  kind: NonNullable<BackgroundJob['kind']>
  /** A subagent's task, a wake-up's reason, or what the agent said a command is for (the command itself when it said nothing). */
  name: string
  /** The name is a command line. */
  mono: boolean
  /** A subagent's type; "Monitor"; "Wake-up". */
  badge?: string
  /** The command line under a named command or monitor. */
  command?: string
  status: string
}

export function jobText(job: BackgroundJob, now = Date.now()): JobText {
  const kind = job.kind ?? 'command'
  const shell = kind === 'command' || kind === 'monitor'
  const named = shell && Boolean(job.title)
  return {
    kind,
    name: named ? job.title! : job.command,
    mono: shell && !named,
    ...(kind === 'agent' && job.title ? { badge: job.title } : kind === 'monitor' ? { badge: 'Monitor' } : kind === 'wakeup' ? { badge: 'Wake-up' } : {}),
    ...(named ? { command: job.command } : {}),
    status: kind === 'wakeup' && job.status === 'running' ? `Wakes at ${wakeTime(job.startedAt, now)}` : STATUS[job.status],
  }
}

/** "2 agents, 1 job running", counting a running subagent as an agent and a command or monitor as a job; null when none runs. */
export function runningLabel(jobs: BackgroundJob[]): string | null {
  const running = jobs.filter((job) => job.status === 'running' && job.kind !== 'wakeup')
  const agents = running.filter((job) => job.kind === 'agent').length
  const others = running.length - agents
  const parts = [agents ? `${agents} agent${agents === 1 ? '' : 's'}` : '', others ? `${others} job${others === 1 ? '' : 's'}` : ''].filter(Boolean)
  return parts.length ? `${parts.join(', ')} running` : null
}
