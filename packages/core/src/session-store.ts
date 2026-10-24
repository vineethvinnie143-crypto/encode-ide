/**
 * Sessions on disk: one append-only JSONL file per session (see
 * session-records.ts for the records) and a small index for listing.
 *
 * A crash costs at most the line being written: replay skips a line that does
 * not parse, and the next append starts on a fresh line. The index is only a
 * cache: it is rebuilt from the logs when it is missing, damaged or older
 * than a log.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { WorktreeInfo } from '@encode/tools'
import { previewOf, type ConversationEntry, type PlanRequest, type SessionGoal, type SessionSummary, type TodoItem } from './ui'
import {
  SESSION_FORMAT,
  type ContextRecord,
  type CreateSessionOptions,
  type Message,
  type MessageRecord,
  type NewRecord,
  type SessionHeader,
  type SessionLog,
  type SessionMarks,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStore,
  type SubagentInfo,
  type Wakeup,
} from './session-records'

export const DEFAULT_TITLE = 'New session'

export function newRecordId(): string {
  return `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`
}

// ---------------------------------------------------------------- replay

interface Derived {
  header: SessionHeader
  title: string
  marks: SessionMarks
  context?: ContextRecord
  messages: MessageRecord[]
  entries: Map<string, ConversationEntry>
  goal: SessionGoal | null
  todos: TodoItem[]
  plan: PlanRequest | null
  agents: Map<string, SubagentInfo>
  wakeup: Wakeup | null
  worktree: WorktreeInfo | null
  updatedAt: number
}

function start(header: SessionHeader): Derived {
  return {
    header,
    title: header.title,
    marks: { projectRoot: header.root || null, pinned: false, archived: false, unread: false },
    messages: [],
    entries: new Map(),
    goal: null,
    todos: [],
    plan: null,
    agents: new Map(),
    wakeup: null,
    worktree: null,
    updatedAt: header.at,
  }
}

function apply(state: Derived, record: SessionRecord): void {
  switch (record.type) {
    case 'session':
    case 'truncate':
      return
    case 'context':
      state.context = record
      return
    case 'message':
      // A subagent's messages belong to its own run, not to the conversation the model continues.
      if (!record.agentId || record.agentId === 'main') state.messages.push(record)
      break
    case 'entry':
      state.entries.set(record.entry.id, record.entry)
      break
    case 'compaction':
      if (record.agentId && record.agentId !== 'main') return
      state.messages = [...record.messages]
      break
    case 'title':
      state.title = record.title
      break
    case 'goal':
      state.goal = record.goal
      return
    case 'todos':
      state.todos = record.todos
      return
    case 'plan':
      state.plan = record.plan
      return
    case 'agent':
      state.agents.set(record.agent.id, record.agent)
      return
    case 'wakeup':
      state.wakeup = record.wakeup
      return
    case 'worktree':
      state.worktree = record.worktree
      return
    case 'meta':
      // Marking a session changes where it sits, not when it was last worked on.
      if (record.projectRoot !== undefined) state.marks.projectRoot = record.projectRoot || null
      if (record.pinned !== undefined) state.marks.pinned = record.pinned
      if (record.archived !== undefined) state.marks.archived = record.archived
      if (record.unread !== undefined) state.marks.unread = record.unread
      return
  }
  state.updatedAt = record.at
}

/** The records still in force: a truncate record cancels everything between its `after` and itself. */
function liveRecords(all: readonly SessionRecord[]): SessionRecord[] {
  const live: SessionRecord[] = []
  for (const record of all) {
    if (record.type !== 'truncate') {
      live.push(record)
      continue
    }
    const index = live.findIndex((kept) => kept.id === record.after)
    if (index >= 0) live.length = index + 1
  }
  return live
}

function derive(live: readonly SessionRecord[]): Derived {
  const header = live[0]
  if (header?.type !== 'session') throw new Error('The session log does not start with its header.')
  const state = start(header)
  for (const record of live.slice(1)) apply(state, record)
  return state
}

/** Parses a log's text, skipping lines that are not complete records. */
export function parseLog(text: string): SessionRecord[] {
  const records: SessionRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as SessionRecord
      if (value && typeof value === 'object' && typeof value.type === 'string' && typeof value.id === 'string') records.push(value)
    } catch {
      /* a torn line from a crash */
    }
  }
  return records
}

// ---------------------------------------------------------------- the log

type IndexEntry = SessionSummary

class FileSessionLog implements SessionLog {
  private state: Derived
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(
    readonly id: string,
    private live: SessionRecord[],
    private handle: fs.FileHandle,
    private needsNewline: boolean,
    private readonly changed: (summary: IndexEntry) => void,
    private readonly released: () => void,
  ) {
    this.state = derive(live)
  }

  snapshot(): SessionSnapshot {
    const { state } = this
    return {
      header: state.header,
      title: state.title,
      marks: { ...state.marks },
      context: state.context,
      messages: [...state.messages],
      entries: [...state.entries.values()],
      goal: state.goal,
      todos: state.todos,
      plan: state.plan,
      agents: [...state.agents.values()].map((agent) => ({ ...agent })),
      wakeup: state.wakeup ? { ...state.wakeup } : null,
      worktree: state.worktree ? { ...state.worktree } : null,
      lastRecordId: this.live[this.live.length - 1].id,
      updatedAt: state.updatedAt,
    }
  }

  agentMessages(agentId: string): Message[] {
    let messages: Message[] = []
    for (const record of this.live) {
      if (record.type === 'message' && record.agentId === agentId) messages.push(record.message)
      else if (record.type === 'compaction' && record.agentId === agentId) messages = record.messages.map((kept) => kept.message)
    }
    return messages
  }

  private write(record: SessionRecord): Promise<void> {
    if (this.closing) return Promise.reject(new Error('The session log is closed.'))
    const line = JSON.stringify(record)
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error('The session log is closed.')
      await this.handle.write(`${this.needsNewline ? '\n' : ''}${line}\n`)
      this.needsNewline = false
    })
    // A failed write must not poison the writes after it.
    this.queue = task.catch(() => undefined)
    return task
  }

  private notify(): void {
    this.changed(indexOf(this.state))
  }

  async append(record: NewRecord): Promise<SessionRecord> {
    const stored = { ...record, id: record.id ?? newRecordId(), at: record.at ?? Date.now() } as SessionRecord
    await this.write(stored)
    this.live.push(stored)
    apply(this.state, stored)
    this.notify()
    return stored
  }

  private async truncate(after: string): Promise<void> {
    const record: SessionRecord = { type: 'truncate', id: newRecordId(), at: Date.now(), after }
    await this.write(record)
    this.live.length = this.live.findIndex((kept) => kept.id === after) + 1
    this.state = derive(this.live)
    this.state.updatedAt = record.at
    this.notify()
  }

  async truncateAfter(recordId: string): Promise<void> {
    if (!this.live.some((record) => record.id === recordId)) throw new Error(`The session has no record ${recordId}.`)
    if (this.live[this.live.length - 1].id === recordId) return
    await this.truncate(recordId)
  }

  async truncateBefore(recordId: string): Promise<void> {
    const index = this.live.findIndex((record) => record.id === recordId)
    if (index < 1) throw new Error(`The session has no record ${recordId} to rewind to.`)
    // The entry that introduced a prompt is written just before its message; it goes too.
    let first = index
    for (let i = index - 1; i >= 1; i--) {
      const earlier = this.live[i]
      if (earlier.type === 'entry' && earlier.entry.id === recordId) first = i
    }
    await this.truncate(this.live[first - 1].id)
  }

  /** True from the moment the log is asked to close: it takes no new writes, and the store no longer hands it out. */
  get isClosing(): boolean {
    return this.closing !== undefined
  }

  /** Finishes the writes already queued, then closes the file. Every caller waits for the same close. */
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    try {
      await this.queue
      this.closed = true
      try {
        await this.handle.sync()
      } catch {
        /* not every file system can */
      }
      await this.handle.close()
    } finally {
      this.released()
    }
  }
}

// ---------------------------------------------------------------- the store

export interface SessionStoreOptions {
  /** Where the logs live. Created private. */
  dir: string
  /** Debounce for index writes, ms. */
  indexDelayMs?: number
}

const INDEX_FILE = 'index.json'

/**
 * Errors that renaming over a file gives on Windows while another program holds it open for a moment (the session list
 * reading it, an antivirus scanning it): they pass on their own, so the index is not left behind the sessions.
 */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_DELAYS_MS = [20, 40, 80, 160, 320, 640]

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_DELAYS_MS.length || !TRANSIENT_RENAME_ERRORS.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_DELAYS_MS[attempt]))
    }
  }
}
const LOG_EXTENSION = '.jsonl'

function indexOf(derived: Derived): IndexEntry {
  return {
    id: derived.header.id,
    title: derived.title,
    createdAt: derived.header.at,
    updatedAt: derived.updatedAt,
    ...derived.marks,
    preview: previewOf([...derived.entries.values()]),
    entryCount: derived.entries.size,
    ...(derived.wakeup ? { wakeAt: derived.wakeup.at } : {}),
    ...(derived.worktree ? { worktree: derived.worktree.name } : {}),
  }
}

export interface FileSessionStore extends SessionStore {
  /** Writes the index now, and closes every open log. */
  dispose(): Promise<void>
}

export function createSessionStore(options: SessionStoreOptions): FileSessionStore {
  const { dir } = options
  const delay = options.indexDelayMs ?? 300
  const open = new Map<string, FileSessionLog>()
  const opening = new Map<string, Promise<FileSessionLog | undefined>>()
  let index: Map<string, IndexEntry> | undefined
  let loading: Promise<Map<string, IndexEntry>> | undefined
  let timer: NodeJS.Timeout | undefined
  let writing: Promise<void> = Promise.resolve()

  const fileOf = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('That is not a session id.')
    return path.join(dir, `${id}${LOG_EXTENSION}`)
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  }

  async function readLog(file: string): Promise<{ live: SessionRecord[]; endsWithNewline: boolean } | undefined> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return undefined
    }
    const live = liveRecords(parseLog(text))
    if (live[0]?.type !== 'session') return undefined
    return { live, endsWithNewline: text.length === 0 || text.endsWith('\n') }
  }

  function loadIndex(): Promise<Map<string, IndexEntry>> {
    loading ??= buildIndex()
    return loading
  }

  async function buildIndex(): Promise<Map<string, IndexEntry>> {
    const entries = new Map<string, IndexEntry>()
    let written = 0
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, INDEX_FILE), 'utf8')) as { v?: number; sessions?: IndexEntry[] }
      for (const entry of raw.sessions ?? []) if (entry && typeof entry.id === 'string') entries.set(entry.id, entry)
      written = (await fs.stat(path.join(dir, INDEX_FILE))).mtimeMs
    } catch {
      /* first run, or damaged: rebuilt below */
    }

    let files: string[] = []
    try {
      files = (await fs.readdir(dir)).filter((name) => name.endsWith(LOG_EXTENSION))
    } catch {
      /* no sessions yet */
    }
    const present = new Set<string>()
    for (const name of files) {
      const id = name.slice(0, -LOG_EXTENSION.length)
      present.add(id)
      const known = entries.get(id)
      // An entry from before the index carried marks and previews is rebuilt.
      let stale = !known || typeof known.entryCount !== 'number'
      if (known && !stale) {
        try {
          stale = (await fs.stat(path.join(dir, name))).mtimeMs > written
        } catch {
          stale = true
        }
      }
      if (!stale) continue
      const log = await readLog(path.join(dir, name))
      if (log) entries.set(id, indexOf(derive(log.live)))
    }
    for (const id of [...entries.keys()]) if (!present.has(id)) entries.delete(id)
    index = entries
    return entries
  }

  async function writeIndex(): Promise<void> {
    if (!index) return
    const sessions = [...index.values()]
    const target = path.join(dir, INDEX_FILE)
    const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await ensureDir()
    await fs.writeFile(temp, JSON.stringify({ v: SESSION_FORMAT, sessions }), { mode: 0o600 })
    try {
      await renameOver(temp, target)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }

  function scheduleIndex(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      writing = writing.then(writeIndex).catch(() => undefined)
    }, delay)
    timer.unref()
  }

  function note(summary: IndexEntry): void {
    if (!index) return
    index.set(summary.id, summary)
    scheduleIndex()
  }

  async function openLog(id: string, file: string, log: { live: SessionRecord[]; endsWithNewline: boolean }): Promise<FileSessionLog> {
    const header = log.live[0] as SessionHeader
    if (header.v > SESSION_FORMAT) throw new Error('This session was saved by a newer version of eNCode.')
    const handle = await fs.open(file, 'a', 0o600)
    // A log that closes late must not take its successor out of the map.
    const created: FileSessionLog = new FileSessionLog(id, log.live, handle, !log.endsWithNewline, note, () => {
      if (open.get(id) === created) open.delete(id)
    })
    open.set(id, created)
    return created
  }

  async function copyOf(source: string, upTo: string | undefined): Promise<SessionRecord[]> {
    const log = await readLog(fileOf(source))
    if (!log) throw new Error('The session to fork no longer exists.')
    const records = log.live.slice(1)
    if (!upTo) return records
    const at = records.findIndex((record) => record.id === upTo)
    if (at < 0) throw new Error('The session to fork has no such record.')
    return records.slice(0, at + 1)
  }

  return {
    async list(filter) {
      const entries = await loadIndex()
      return [...entries.values()]
        .filter((entry) => filter?.root === undefined || entry.projectRoot === filter.root)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((entry) => ({ ...entry }))
    },

    async create(create: CreateSessionOptions) {
      await ensureDir()
      const entries = await loadIndex()
      const id = create.id ?? newRecordId()
      const header: SessionHeader = { type: 'session', v: SESSION_FORMAT, id, at: create.createdAt ?? Date.now(), root: create.root || null, title: create.title || DEFAULT_TITLE }
      const records: SessionRecord[] = [header]
      if (create.fork) {
        header.forkedFrom = { sessionId: create.fork.sessionId, recordId: create.fork.recordId ?? '' }
        const copied = await copyOf(create.fork.sessionId, create.fork.recordId)
        if (!header.forkedFrom.recordId) header.forkedFrom.recordId = copied.length ? copied[copied.length - 1].id : header.id
        records.push(...copied)
      }
      const file = fileOf(id)
      await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { flag: 'wx', mode: 0o600 })
      const log = await openLog(id, file, { live: records, endsWithNewline: true })
      entries.set(id, indexOf(derive(records)))
      scheduleIndex()
      return log
    },

    async open(id) {
      const file = fileOf(id)
      // A log that is closing still has writes to finish: the file is read once it is done, and not before.
      for (let closing = open.get(id); closing?.isClosing; closing = open.get(id)) await closing.close().catch(() => undefined)
      const existing = open.get(id)
      if (existing) return existing
      const pending = opening.get(id)
      if (pending) return pending
      const task = (async () => {
        const log = await readLog(file)
        if (!log) return undefined
        const opened = await openLog(id, file, log)
        const entries = await loadIndex()
        if (!entries.has(id)) note(indexOf(derive(log.live)))
        return opened
      })()
      opening.set(id, task)
      try {
        return await task
      } finally {
        opening.delete(id)
      }
    },

    async remove(id) {
      await open.get(id)?.close()
      const entries = await loadIndex()
      entries.delete(id)
      await fs.rm(fileOf(id), { force: true })
      scheduleIndex()
    },

    async dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await Promise.all([...open.values()].map((log) => log.close()))
      await writing
      await writeIndex()
    },
  }
}
