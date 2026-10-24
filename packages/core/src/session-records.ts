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
 *   meta        the session's project, pin, archive and unread marks; the latest value of each field wins
 *   agent       a subagent: its type, task and how it stands; the latest record of an id wins
 *   wakeup      the wake-up the agent asked for, or null; the latest wins
 *   worktree    the git worktree the agent works in (EnterWorktree), or null; the latest wins
 *   truncate    drops every record after `after` (rewind)
 *
 * A subagent's messages are message records with its id as `agentId`, and its compactions carry the id too, so that
 * it can go on from where it stopped (SendMessage), also after a restart. They never enter the main conversation.
 *
 * A user prompt's message id, its UI entry id and the turn id are the same
 * string, so a client can rewind from the entry it shows. The entry record
 * is written before the message record, so truncating after the message
 * keeps both.
 */
import type { AssistantMessage, SystemPart, ToolDefinition, Usage, UserMessage } from '@encode/providers'
import type { AgentMode, WorktreeInfo } from '@encode/tools'
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
  /** The project the session was created in; null for a standalone session. */
  root: string | null
  title: string
  /** The session and record this one was forked from. */
  forkedFrom?: { sessionId: string; recordId: string }
  /** A side chat of that session (ADR 0104): a copy to ask questions in, not listed, removed with it. */
  sideOf?: string
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
  /** A subagent's: its conversation starts over with these, and the main one is untouched. */
  agentId?: string
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

export interface MetaRecord extends RecordBase {
  type: 'meta'
  projectRoot?: string | null
  pinned?: boolean
  archived?: boolean
  unread?: boolean
}

/** A subagent of the session, as its latest record has it. */
export interface SubagentInfo {
  id: string
  type: string
  description: string
  /** `interrupted`: it was running when eNCode closed; SendMessage takes it on from where it stopped. */
  status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'
  /** It ran in the background, so the main agent hears how it ended through a notice. */
  background: boolean
  mode: AgentMode
  startedAt: number
  endedAt?: number
  /** How it ended, kept until the main agent has been told. */
  report?: string
  ok?: boolean
  /** The main agent has read how it ended. */
  told?: boolean
}

export interface AgentRecord extends RecordBase {
  type: 'agent'
  agent: SubagentInfo
}

/** What ScheduleWakeup asked for. */
export interface Wakeup {
  /** Epoch ms. */
  at: number
  reason: string
  prompt: string
}

export interface WakeupRecord extends RecordBase {
  type: 'wakeup'
  wakeup: Wakeup | null
}

export interface WorktreeRecord extends RecordBase {
  type: 'worktree'
  worktree: WorktreeInfo | null
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
  | MetaRecord
  | AgentRecord
  | WakeupRecord
  | WorktreeRecord
  | TruncateRecord

type WithoutBase<T> = T extends unknown ? Omit<T, 'id' | 'at'> & Partial<Pick<RecordBase, 'id' | 'at'>> : never

/** A record to append; `id` and `at` are filled in when missing. */
export type NewRecord = WithoutBase<Exclude<SessionRecord, SessionHeader | TruncateRecord>>

/** What a session carries besides its conversation. */
export interface SessionMarks {
  /** The project the session belongs to now; null for a standalone session. */
  projectRoot: string | null
  pinned: boolean
  archived: boolean
  unread: boolean
}

/** The session as its log rebuilds it. */
export interface SessionSnapshot {
  header: SessionHeader
  title: string
  marks: SessionMarks
  context?: ContextRecord
  /** The model-facing conversation, after any compaction. */
  messages: MessageRecord[]
  /** The UI transcript, in the order entries first appeared. */
  entries: ConversationEntry[]
  goal: SessionGoal | null
  todos: TodoItem[]
  plan: PlanRequest | null
  /** The subagents, as their latest records have them, oldest first. */
  agents: SubagentInfo[]
  wakeup: Wakeup | null
  worktree: WorktreeInfo | null
  /** The id of the last live record. */
  lastRecordId: string
  updatedAt: number
}

export interface SessionLog {
  readonly id: string
  snapshot(): SessionSnapshot
  /** A subagent's conversation, after its own compactions; empty for an id the log does not know. */
  agentMessages(agentId: string): Message[]
  /** Appends a record and returns it as stored. */
  append(record: NewRecord): Promise<SessionRecord>
  /** Drops every record after `recordId` (it stays). */
  truncateAfter(recordId: string): Promise<void>
  /** Drops `recordId` and every record after it. */
  truncateBefore(recordId: string): Promise<void>
  close(): Promise<void>
}

export interface CreateSessionOptions {
  /** The project the session belongs to; null for a standalone session. */
  root: string | null
  title?: string
  /** For importing a session that already has an id and a date. */
  id?: string
  createdAt?: number
  /** Starts from a copy of another session, up to and including `recordId` (default: all of it). */
  fork?: { sessionId: string; recordId?: string }
  /** Makes it a side chat of that session, which lists leave out. */
  sideOf?: string
}

export interface SessionStore {
  /** Newest first. `root` keeps only the sessions of that project; side chats are left out unless `sides`. */
  list(options?: { root?: string | null; sides?: boolean }): Promise<SessionSummary[]>
  create(options: CreateSessionOptions): Promise<SessionLog>
  open(id: string): Promise<SessionLog | undefined>
  remove(id: string): Promise<void>
}
