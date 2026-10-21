/**
 * What eNCode keeps about each session besides its conversation: its
 * project, pin, archive and unread marks. Pure, so the rules are unit tested
 * without Electron; AgentManager stores and persists the results.
 */
import type { ConversationEntry, SessionSummary } from '../../shared/types'

/** A session's stored fields; the preview and the entry count are derived from its conversation. */
export type SessionMeta = Omit<SessionSummary, 'preview' | 'entryCount'>

export const MAX_TITLE = 90

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function root(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function newSessionMeta(id: string, title: string, projectRoot: string | null, now = Date.now()): SessionMeta {
  return {
    id,
    title: title.trim().slice(0, MAX_TITLE) || 'New session',
    createdAt: now,
    updatedAt: now,
    projectRoot,
    pinned: false,
    archived: false,
    unread: false,
  }
}

/** One session from sessions.json, or null when it has no id. Files from earlier builds lack the marks. */
export function readSessionMeta(raw: unknown, now = Date.now()): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  if (typeof input.id !== 'string' || !input.id) return null
  return {
    id: input.id,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, MAX_TITLE) : 'New session',
    createdAt: finite(input.createdAt, now),
    updatedAt: finite(input.updatedAt, now),
    projectRoot: root(input.projectRoot),
    pinned: input.pinned === true,
    archived: input.archived === true,
    unread: input.unread === true,
  }
}

/**
 * Applies a change from the renderer field by field; anything unknown or of
 * the wrong type is ignored. Archiving a session also unpins it. Returns
 * whether anything changed.
 */
export function applySessionPatch(meta: SessionMeta, patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false
  const input = patch as Record<string, unknown>
  const before = JSON.stringify(meta)
  if (typeof input.title === 'string' && input.title.trim()) meta.title = input.title.trim().slice(0, MAX_TITLE)
  if (input.projectRoot === null || typeof input.projectRoot === 'string') meta.projectRoot = root(input.projectRoot)
  if (typeof input.pinned === 'boolean') meta.pinned = input.pinned
  if (typeof input.unread === 'boolean') meta.unread = input.unread
  if (typeof input.archived === 'boolean') {
    meta.archived = input.archived
    if (input.archived) meta.pinned = false
  }
  return JSON.stringify(meta) !== before
}

/** The start of the last reply on one line, for the Activity view. */
export function previewOf(entries: readonly ConversationEntry[], max = 140): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind !== 'assistant' || !entry.text?.trim()) continue
    const flat = entry.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
  }
  return ''
}

/** The sessions sessions.json keeps: every pinned one, then the most recent, `cap` in all. Newest first. */
export function sessionsToKeep<T extends { pinned: boolean; updatedAt: number }>(list: readonly T[], cap = 50): T[] {
  const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  const pinned = newest.filter((session) => session.pinned)
  const room = Math.max(0, cap - pinned.length)
  const kept = new Set([...pinned, ...newest.filter((session) => !session.pinned).slice(0, room)])
  return newest.filter((session) => kept.has(session))
}
