/**
 * Brings the sessions an earlier build kept in one JSON file into the
 * session store. The transcript is kept as it was shown. The model's side of
 * those conversations used another message format and other tool names, so
 * it is carried over as a summary of what was said, in the first message.
 */
import fs from 'node:fs/promises'
import { textBlock, type Message } from '@encode/providers'
import type { NewRecord, SessionStore } from './session-records'
import type { ConversationEntry, PlanRequest, SessionGoal, TodoItem } from './ui'

interface LegacySession {
  id?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  entries?: unknown
  goal?: unknown
  todos?: unknown
  plan?: unknown
  projectRoot?: unknown
  pinned?: unknown
  archived?: unknown
  unread?: unknown
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const MAX_SUMMARY_CHARS = 12_000

const asEntries = (value: unknown): ConversationEntry[] =>
  Array.isArray(value) ? value.filter((entry): entry is ConversationEntry => Boolean(entry) && typeof entry === 'object' && typeof (entry as ConversationEntry).id === 'string' && typeof (entry as ConversationEntry).kind === 'string') : []

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** What was said, one line per request, reply or tool call, newest kept when it is too long. */
export function summarizeEntries(entries: readonly ConversationEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const text = (entry.text ?? '').replace(/\s+/g, ' ').trim()
    if (entry.kind === 'user') lines.push(`User: ${text.slice(0, 600)}`)
    else if (entry.kind === 'assistant' && text) lines.push(`You: ${text.slice(0, 600)}`)
    else if (entry.kind === 'tool' && entry.tool) {
      const subject = String(entry.tool.input?.path ?? entry.tool.input?.command ?? entry.tool.input?.pattern ?? '').replace(/\s+/g, ' ').slice(0, 120)
      lines.push(`Tool ${entry.tool.name}${subject ? ` ${subject}` : ''}${entry.tool.ok === false ? ' (failed)' : ''}`)
    }
  }
  let out = lines.join('\n')
  if (out.length > MAX_SUMMARY_CHARS) out = `…\n${out.slice(out.length - MAX_SUMMARY_CHARS)}`
  return out
}

function openingMessages(entries: readonly ConversationEntry[]): Message[] {
  const summary = summarizeEntries(entries)
  if (!summary) return []
  return [
    {
      role: 'user',
      content: [
        textBlock(
          `<conversation_summary>\nThis conversation began in an earlier version of eNCode. Here is what was said, in order:\n\n${summary}\n</conversation_summary>\n\nContinue from here when the user writes next.`,
        ),
      ],
    },
    { role: 'assistant', content: [textBlock('Understood. I have the earlier conversation in mind and will continue from it.')] },
  ]
}

/**
 * Imports every session in `file` that the store does not have yet, then
 * renames the file so it is not read again. Sessions without a project go to
 * `defaultRoot`. Returns how many were imported.
 */
export async function migrateLegacySessions(options: { file: string; store: SessionStore; defaultRoot: string | null; existing?: ReadonlySet<string> }): Promise<number> {
  let raw: string
  try {
    raw = await fs.readFile(options.file, 'utf8')
  } catch {
    return 0
  }
  let sessions: LegacySession[]
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown }
    sessions = Array.isArray(parsed.sessions) ? (parsed.sessions as LegacySession[]) : []
  } catch {
    return 0
  }

  let imported = 0
  for (const legacy of sessions) {
    if (!legacy || typeof legacy.id !== 'string' || !SAFE_ID.test(legacy.id) || options.existing?.has(legacy.id)) continue
    const createdAt = finite(legacy.createdAt, Date.now())
    const updatedAt = finite(legacy.updatedAt, createdAt)
    const projectRoot = typeof legacy.projectRoot === 'string' && legacy.projectRoot.trim() ? legacy.projectRoot : legacy.projectRoot === null ? null : options.defaultRoot
    let log
    try {
      log = await options.store.create({ id: legacy.id, createdAt, root: projectRoot, title: typeof legacy.title === 'string' && legacy.title.trim() ? legacy.title.slice(0, 90) : undefined })
    } catch {
      continue // already there, or not writable
    }
    const entries = asEntries(legacy.entries)
    const records: NewRecord[] = []
    // The transcript counts up from the creation date; the last records carry the date of the last use, so the session keeps its place in the list.
    const at = (offset: number) => Math.min(updatedAt, createdAt + offset)
    for (const [index, entry] of entries.entries()) records.push({ type: 'entry', entry, at: at(index + 1) })
    const turnId = `imported-${legacy.id}`
    for (const message of openingMessages(entries)) records.push({ type: 'message', message, turnId, agentId: 'main', at: updatedAt })
    if (legacy.goal && typeof legacy.goal === 'object') records.push({ type: 'goal', goal: legacy.goal as SessionGoal, at: updatedAt })
    if (Array.isArray(legacy.todos) && legacy.todos.length) records.push({ type: 'todos', todos: legacy.todos as TodoItem[], at: updatedAt })
    if (legacy.plan && typeof legacy.plan === 'object') records.push({ type: 'plan', plan: legacy.plan as PlanRequest, at: updatedAt })
    const marks = { pinned: legacy.pinned === true, archived: legacy.archived === true, unread: legacy.unread === true }
    if (marks.pinned || marks.archived || marks.unread) records.push({ type: 'meta', ...marks, at: updatedAt })
    for (const record of records) await log.append(record)
    await log.close()
    imported++
  }
  await fs.rename(options.file, `${options.file}.migrated`).catch(() => undefined)
  return imported
}
