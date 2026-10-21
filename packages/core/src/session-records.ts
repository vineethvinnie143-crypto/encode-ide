/**
 * A session is an append-only JSONL log. Each line is one record with a
 * stable id. Replaying the log in order rebuilds the session; nothing is ever
 * rewritten in place, so a crash costs at most the line being written.
 *
 * Records:
 *   session     the header, always first
 *   context     the system prompt and tool list as sent; replayed as stored
 *   message     a model-facing message; its id is the message id
 *   entry       a UI entry; a later record with the same entry id replaces it
 *   compaction  the model-facing messages from here on start over with these
 *   title, goal, todos, plan   the latest record wins
 *   truncate    drops every record after `after` (rewind)
 *
 * A user prompt's message id, its UI entry id and the turn id are the same
 * string, so a client can rewind from the entry it shows. The entry record
 * is written before the message record, so truncating after the message
 * keeps both.
 */
import type { AssistantMessage, SystemPart, ToolDefinition, Usage, UserMessage } from '@encode/providers'
import type { ConversationEntry, PlanRequest, SessionGoal, SessionSummary, TodoItem } from './ui'

export const SESSION_FORMAT = 1

export type Message = UserMessage | AssistantMessage

interface RecordBase {
  /** Unique within the session. */
  id: string
  /** ms since the epoch. */
  at: number
}

export interface SessionHeader extends RecordBase {
  type: 'session'
  v: typeof SESSION_FORMAT
  /** The workspace root the session works in. */
  root: string
  title: string
  /** The session and record this one was forked from. */
  forkedFrom?: { sessionId: string; recordId: string }
}

export interface ContextRecord extends RecordBase {
  type: 'context'
  system: SystemPart[]
  tools: ToolDefinition[]
}

export interface MessageRecord extends RecordBase {
  type: 'message'
  message: Message
  /** The user message that started the turn this message belongs to. */
  turnId: string
  /** 'main', or the subagent's id. */
  agentId?: string
  usage?: Usage
}

export interface EntryRecord extends RecordBase {
  type: 'entry'
  entry: ConversationEntry
}

export interface CompactionRecord extends RecordBase {
  type: 'compaction'
  trigger: 'auto' | 'manual'
  /** The summary's text, for display. */
  summary: string
  /** How many messages it replaced. */
  removed: number
  /** The model-facing conversation from here on. */
  messages: MessageRecord[]
}

export interface TitleRecord extends RecordBase {
  type: 'title'
  title: string
}

export interface GoalRecord extends RecordBase {
  type: 'goal'
  goal: SessionGoal | null
}

export interface TodosRecord extends RecordBase {
  type: 'todos'
  todos: TodoItem[]
}

export interface PlanRecord extends RecordBase {
  type: 'plan'
  plan: PlanRequest | null
}

export interface TruncateRecord extends RecordBase {
  type: 'truncate'
  /** The last record kept. */
  after: string
}

export type SessionRecord =
  | SessionHeader
  | ContextRecord
  | MessageRecord
  | EntryRecord
  | CompactionRecord
  | TitleRecord
  | GoalRecord
  | TodosRecord
  | PlanRecord
  | TruncateRecord

type WithoutBase<T> = T extends unknown ? Omit<T, 'id' | 'at'> & Partial<Pick<RecordBase, 'id' | 'at'>> : never

/** A record to append; `id` and `at` are filled in when missing. */
export type NewRecord = WithoutBase<Exclude<SessionRecord, SessionHeader | TruncateRecord>>

/** The session as its log rebuilds it. */
export interface SessionSnapshot {
  header: SessionHeader
  title: string
  context?: ContextRecord
  /** The model-facing conversation, after any compaction. */
  messages: MessageRecord[]
  /** The UI transcript, in the order entries first appeared. */
  entries: ConversationEntry[]
  goal: SessionGoal | null
  todos: TodoItem[]
  plan: PlanRequest | null
  /** The id of the last live record. */
  lastRecordId: string
  updatedAt: number
}

export interface SessionLog {
  readonly id: string
  snapshot(): SessionSnapshot
  /** Appends a record and returns it as stored. */
  append(record: NewRecord): Promise<SessionRecord>
  /** Drops every record after `recordId` (it stays). */
  truncateAfter(recordId: string): Promise<void>
  /** Drops `recordId` and every record after it. */
  truncateBefore(recordId: string): Promise<void>
  close(): Promise<void>
}

export interface CreateSessionOptions {
  root: string
  title?: string
  /** Starts from a copy of another session, up to and including `recordId` (default: all of it). */
  fork?: { sessionId: string; recordId?: string }
}

export interface SessionStore {
  list(options?: { root?: string }): Promise<(SessionSummary & { root: string })[]>
  create(options: CreateSessionOptions): Promise<SessionLog>
  open(id: string): Promise<SessionLog | undefined>
  remove(id: string): Promise<void>
}
