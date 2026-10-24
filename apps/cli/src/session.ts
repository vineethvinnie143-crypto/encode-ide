/**
 * What print mode and the prompt share: the settings a run starts with, which session it works in, and how a
 * folder's trust is settled.
 */
import { DEFAULT_SETTINGS, type AgentHost, type AgentSettings, type SessionSummary } from '@encode/core'
import type { Workspaces } from '@encode/workspace'
import { UsageError, type CliOptions } from './args'
import { firstLine, plain } from './text'

export function settingsFor(options: Pick<CliOptions, 'policy' | 'maxSteps'>): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    policy: options.policy ?? DEFAULT_SETTINGS.policy,
    maxSteps: options.maxSteps ?? DEFAULT_SETTINGS.maxSteps,
    // The Computer tool drives a desktop the app watches over; the command line has no banner to stop it from.
    computer: false,
  }
}

/** This folder's sessions, newest first; side chats and archived ones left out. */
export async function folderSessions(host: AgentHost, root: string): Promise<SessionSummary[]> {
  const all = await host.sessions()
  return all.filter((session) => session.projectRoot === root && !session.archived).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The session a run works in: the one asked for, this folder's latest, or a new one. */
export async function chooseSession(host: AgentHost, root: string, options: Pick<CliOptions, 'continue' | 'resume'>): Promise<{ session: SessionSummary; resumed: boolean }> {
  if (options.resume !== undefined) {
    const wanted = options.resume.trim().toLowerCase()
    if (!wanted) throw new UsageError('--resume needs a session id')
    const matches = (await host.sessions()).filter((session) => session.id.toLowerCase().startsWith(wanted))
    if (matches.length === 0) throw new UsageError(`no session starts with ${plain(options.resume)}; \`encode sessions\` lists this folder's`)
    if (matches.length > 1) throw new UsageError(`${matches.length} sessions start with ${plain(options.resume)}; give more of the id`)
    return { session: matches[0]!, resumed: true }
  }
  if (options.continue) {
    const latest = (await folderSessions(host, root))[0]
    if (latest) return { session: latest, resumed: true }
  }
  return { session: await host.create({ projectRoot: root }), resumed: false }
}

/** "3 min ago", "yesterday", or a date. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return new Date(at).toISOString().slice(0, 10)
}

export function sessionLine(session: SessionSummary, now = Date.now()): string {
  return `${session.id.slice(0, 8)}  ${firstLine(session.title || 'New session', 60).padEnd(60)}  ${ago(session.updatedAt, now)}`
}

/** Trusts the folder, saying the warning for a folder that holds far more than a project was seen. */
export async function trustFolder(workspaces: Workspaces, root: string): Promise<{ ok: boolean; text: string }> {
  const outcome = await workspaces.act(root, { type: 'trust', acknowledged: true })
  return outcome.ok ? { ok: true, text: `Trusted ${plain(root)}.` } : { ok: false, text: plain(outcome.reason) }
}
