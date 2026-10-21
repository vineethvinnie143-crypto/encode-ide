/**
 * What the session sidebar shows, worked out from the sessions and their
 * live state. Pure, so the grouping, ordering and guard rules are unit tested.
 */
import type { AgentStatus, SessionSummary } from '@shared/types'
import { isToday } from '../ui/time'

export type RowStatus = 'running' | 'approval' | 'unread' | 'idle'
export type StatusById = Readonly<Record<string, AgentStatus | undefined>>

const WAITING: readonly AgentStatus[] = ['awaiting-approval', 'awaiting-user']
const WORKING: readonly AgentStatus[] = ['thinking', 'running-tool']

/** Running and waiting sessions both have an agent in them that acts on the open folder. */
export function isBusy(status: AgentStatus | undefined): boolean {
  return status !== undefined && (WAITING.includes(status) || WORKING.includes(status))
}

/** What a row's status slot shows: a spinner, an amber dot, an accent dot or nothing. */
export function rowStatus(session: SessionSummary, status: AgentStatus | undefined): RowStatus {
  if (status !== undefined && WAITING.includes(status)) return 'approval'
  if (status !== undefined && WORKING.includes(status)) return 'running'
  return session.unread ? 'unread' : 'idle'
}

/** A folder compared the way Windows compares it: slashes and case do not matter. */
export function rootKey(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && rootKey(a) === rootKey(b)
}

export function projectName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root
}

export interface ProjectGroup {
  root: string
  name: string
  sessions: SessionSummary[]
}

export interface SidebarModel {
  pinned: SessionSummary[]
  projects: ProjectGroup[]
  /** Sessions that belong to no project. */
  recents: SessionSummary[]
}

const newestFirst = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

export function buildSidebar(
  sessions: readonly SessionSummary[],
  options: { workspaceRoot: string | null; recentRoots: readonly string[]; filter?: string },
): SidebarModel {
  const needle = (options.filter ?? '').trim().toLowerCase()
  const live = sessions.filter((session) => !session.archived)
  const matches = (session: SessionSummary) =>
    !needle ||
    session.title.toLowerCase().includes(needle) ||
    (session.projectRoot !== null && projectName(session.projectRoot).toLowerCase().includes(needle))

  const shown = live.filter(matches).sort(newestFirst)
  const pinned = shown.filter((session) => session.pinned)
  const unpinned = shown.filter((session) => !session.pinned)

  // Projects: the open folder first, then by latest activity, then folders opened before without sessions.
  const roots = new Map<string, string>()
  const add = (root: string | null) => {
    if (root && !roots.has(rootKey(root))) roots.set(rootKey(root), root)
  }
  add(options.workspaceRoot)
  for (const session of unpinned) add(session.projectRoot)
  if (!needle) for (const root of options.recentRoots) add(root)

  const projects: ProjectGroup[] = []
  for (const [key, root] of roots) {
    const inProject = unpinned.filter((session) => session.projectRoot !== null && rootKey(session.projectRoot) === key)
    if (needle && !inProject.length) continue
    projects.push({ root, name: projectName(root), sessions: inProject })
  }

  return { pinned, projects, recents: unpinned.filter((session) => session.projectRoot === null) }
}

/** Every session the sidebar lists, top to bottom, leaving out those in collapsed projects. */
export function visibleOrder(model: SidebarModel, collapsed: ReadonlySet<string> = new Set()): string[] {
  return [
    ...model.pinned.map((session) => session.id),
    ...model.projects.flatMap((project) =>
      collapsed.has(rootKey(project.root)) ? [] : project.sessions.map((session) => session.id),
    ),
    ...model.recents.map((session) => session.id),
  ]
}

export interface ActivityGroup {
  id: 'approval' | 'running' | 'unread' | 'today' | 'earlier'
  title: string
  sessions: SessionSummary[]
}

/** Sessions by what they need from you, then by day. Each session is in the first group it fits. */
export function activityGroups(sessions: readonly SessionSummary[], statuses: StatusById, now = Date.now()): ActivityGroup[] {
  const groups: ActivityGroup[] = [
    { id: 'approval', title: 'Needs approval', sessions: [] },
    { id: 'running', title: 'Running', sessions: [] },
    { id: 'unread', title: 'Unread', sessions: [] },
    { id: 'today', title: 'Today', sessions: [] },
    { id: 'earlier', title: 'Earlier', sessions: [] },
  ]
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const session of [...sessions].filter((item) => !item.archived).sort(newestFirst)) {
    const status = rowStatus(session, statuses[session.id])
    const id =
      status === 'approval' ? 'approval' : status === 'running' ? 'running' : status === 'unread' ? 'unread' : isToday(session.updatedAt, now) ? 'today' : 'earlier'
    byId.get(id)?.sessions.push(session)
  }
  return groups.filter((group) => group.sessions.length)
}

/** The session to jump to for "next session that needs you": waiting for an answer first, then unread. */
export function nextAttention(sessions: readonly SessionSummary[], statuses: StatusById, activeId: string): string | undefined {
  const live = [...sessions].filter((session) => !session.archived && session.id !== activeId).sort(newestFirst)
  const waiting = live.filter((session) => rowStatus(session, statuses[session.id]) === 'approval')
  const unread = live.filter((session) => rowStatus(session, statuses[session.id]) === 'unread')
  return (waiting[0] ?? unread[0])?.id
}

/** How many sessions want you: the number on the Home button. */
export function attentionCount(sessions: readonly SessionSummary[], statuses: StatusById): number {
  return sessions.filter((session) => {
    if (session.archived) return false
    const status = rowStatus(session, statuses[session.id])
    return status === 'approval' || status === 'unread'
  }).length
}

/** The next (older) or previous (newer) session by recent activity, wrapping around. */
export function adjacentRecent(sessions: readonly SessionSummary[], activeId: string, direction: 1 | -1): string | undefined {
  const live = [...sessions].filter((session) => !session.archived).sort(newestFirst)
  if (!live.length) return undefined
  const index = live.findIndex((session) => session.id === activeId)
  if (index < 0) return live[0].id
  return live[(index + direction + live.length) % live.length].id
}

export interface SwitchCheck {
  ok: boolean
  reason?: string
}

export const SWITCH_BLOCKED =
  'A session is still working in the open folder. Stop it or wait for it to finish before opening another project.'

/**
 * Whether the open folder may change for a session in another project. The
 * agent works in the open folder, so while any session runs or waits, a
 * switch would point its edits at the wrong project.
 */
export function canSwitchProject(
  target: string | null,
  current: string | null,
  statuses: StatusById,
): SwitchCheck {
  if (target === null || sameRoot(target, current)) return { ok: true }
  if (Object.values(statuses).some(isBusy)) return { ok: false, reason: SWITCH_BLOCKED }
  return { ok: true }
}
