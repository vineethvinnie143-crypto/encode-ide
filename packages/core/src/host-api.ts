/**
 * The host over a message port: the requests the desktop app's main process
 * makes of the agent host (a utility process) and the events it gets back.
 *
 * `serveHost` is the host's side; `createHostClient` is the caller's, with the
 * same positional methods as `AgentHost`. Every request is checked against a
 * schema before it reaches the host, however trusted the caller is: the port
 * is a boundary, and what crosses it is data.
 */
import type { HandlerOptions, JsonSchema, RequestContext, RequestOptions } from '@encode/protocol'
import type { AgentHost } from './host'
import type {
  AgentMode,
  AgentEvent,
  AgentHistory,
  AgentStartInput,
  AgentStatus,
  ApprovalAnswer,
  BackgroundJob,
  CheckpointInfo,
  PlanRequest,
  RewindOutcome,
  RewindPlan,
  RewindRequest,
  SessionGoal,
  SessionPatch,
  SessionSummary,
  TodoItem,
  TurnChangeSet,
  TurnFileWrite,
  TurnWriteOutcome,
} from './ui'

export type HostRequests = {
  sessions: { params: undefined; result: SessionSummary[] }
  create: { params: { projectRoot?: string | null; title?: string } | undefined; result: SessionSummary }
  update: { params: { sessionId: string; patch: SessionPatch }; result: SessionSummary | null }
  statuses: { params: undefined; result: Record<string, AgentStatus> }
  history: { params: { sessionId?: string } | undefined; result: AgentHistory }
  /** Resolves when the turn ends. */
  start: { params: { sessionId: string; input: AgentStartInput }; result: void }
  /** Runs the last request again from where a problem stopped it. Resolves when it ends. */
  retry: { params: { sessionId: string; mode?: AgentMode }; result: void }
  cancel: { params: { sessionId: string }; result: void }
  /** A message for the running turn; null when no turn takes one now (send it as the next request). */
  steer: { params: { sessionId: string; text: string; id?: string }; result: { id: string } | null }
  reset: { params: { sessionId?: string } | undefined; result: void }
  remove: { params: { sessionId: string }; result: void }
  fork: { params: { sessionId: string }; result: SessionSummary }
  rename: { params: { sessionId: string; title: string }; result: void }
  goal: { params: { sessionId: string }; result: SessionGoal | null }
  setGoal: { params: { sessionId: string; goal: SessionGoal | null }; result: void }
  todos: { params: { sessionId: string }; result: TodoItem[] }
  setTodos: { params: { sessionId: string; todos: TodoItem[] }; result: void }
  plan: { params: { sessionId: string }; result: PlanRequest | null }
  setPlan: { params: { sessionId: string; plan: PlanRequest | null }; result: void }
  compact: { params: { sessionId: string; instructions?: string }; result: { removed: number } }
  rewind: { params: { sessionId: string; entryId: string }; result: { text: string } }
  checkpoints: { params: { sessionId: string }; result: CheckpointInfo }
  rewindPlan: { params: { sessionId: string; turn: string }; result: RewindPlan }
  redoPlan: { params: { sessionId: string }; result: RewindPlan | null }
  rewindApply: { params: { sessionId: string; request: RewindRequest }; result: RewindOutcome }
  turnChanges: { params: { sessionId: string; turn?: string; limits?: { maxFileBytes?: number; maxTotalBytes?: number } }; result: TurnChangeSet }
  turnWrite: { params: { sessionId: string; write: TurnFileWrite }; result: TurnWriteOutcome }
  exportData: { params: { sessionId: string }; result: { title: string; transcript: string; json: string } }
  approve: { params: { requestId: string; answer: Exclude<ApprovalAnswer, boolean> }; result: boolean }
  answer: { params: { requestId: string; text: string }; result: boolean }
  jobs: { params: undefined; result: BackgroundJob[] }
  jobOutput: { params: { jobId: string }; result: string }
  killJob: { params: { jobId: string }; result: void }
  setWorkspace: { params: { root: string | null }; result: void }
  importLegacy: { params: { file: string }; result: number }
}

export type HostEvents = {
  /** An event of any session. */
  event: AgentEvent
  /** The background jobs of all sessions, whenever one changed. */
  jobs: BackgroundJob[]
  /** Something the user should be told about that is not a session's: a skill that could not be read. */
  warn: string
}

export type HostApi = { requests: HostRequests; events: HostEvents }

/** What `serveHost` needs of a peer: a `Peer<Local>` whose API includes the host's. */
export interface HostServer {
  handle<M extends keyof HostRequests & string>(
    method: M,
    handler: (params: HostRequests[M]['params'], context: RequestContext) => HostRequests[M]['result'] | Promise<HostRequests[M]['result']>,
    options?: HandlerOptions,
  ): () => void
}

/** What `createHostClient` needs of a peer: a `Peer<_, Remote>` whose API includes the host's. */
export interface HostCaller {
  request<M extends keyof HostRequests & string>(
    method: M,
    ...args: undefined extends HostRequests[M]['params'] ? [params?: HostRequests[M]['params'], options?: RequestOptions] : [params: HostRequests[M]['params'], options?: RequestOptions]
  ): Promise<HostRequests[M]['result']>
}

// ------------------------------------------------------------ schemas

const text = (max: number, min = 0): JsonSchema => ({ type: 'string', minLength: min, maxLength: max })
const id: JsonSchema = text(200, 1)
const sessionId = { sessionId: id }
const optionalSessionId = { sessionId: text(200) }
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required })
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] })

const GOAL: JsonSchema = {
  type: 'object',
  required: ['text', 'status', 'rounds', 'createdAt', 'updatedAt'],
  properties: {
    text: text(4_000),
    status: { enum: ['active', 'paused', 'complete', 'blocked'] },
    rounds: { type: 'integer', minimum: 0, maximum: 10_000 },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
}

const TODO: JsonSchema = {
  type: 'object',
  required: ['id', 'text', 'status'],
  properties: { id: text(200), text: text(2_000), status: { enum: ['pending', 'in_progress', 'completed'] } },
}

const PLAN: JsonSchema = { type: 'object', required: ['id', 'plan'], properties: { id: text(200), plan: text(200_000) } }

const START_INPUT: JsonSchema = {
  type: 'object',
  required: ['text', 'mode'],
  properties: {
    text: text(400_000),
    mode: { enum: ['code', 'ask', 'plan'] },
    attachments: {
      type: 'array',
      maxItems: 100,
      items: { type: 'object', required: ['path', 'content'], properties: { path: text(4_096), content: text(4_000_000) } },
    },
  },
}

const PATCH: JsonSchema = {
  type: 'object',
  properties: {
    title: text(400),
    projectRoot: nullable(text(4_096)),
    pinned: { type: 'boolean' },
    archived: { type: 'boolean' },
    unread: { type: 'boolean' },
  },
}

const ANSWER: JsonSchema = {
  type: 'object',
  required: ['approved'],
  properties: { approved: { type: 'boolean' }, note: text(4_000), remember: { enum: ['session', 'always'] }, scope: { enum: ['user', 'project', 'local'] } },
}

const REWIND_REQUEST: JsonSchema = {
  type: 'object',
  required: ['kind', 'turn', 'fingerprint'],
  properties: {
    kind: { enum: ['rewind', 'redo'] },
    turn: id,
    fingerprint: text(200, 1),
    force: { type: 'boolean' },
    conversation: { type: 'boolean' },
  },
}

const HASH: JsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' }

/** An id the caller chose for a message, as `crypto.randomUUID()` makes them. */
const UUID: JsonSchema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }

const LIMITS: JsonSchema = {
  type: 'object',
  properties: { maxFileBytes: { type: 'integer', minimum: 0, maximum: 64 * 1024 * 1024 }, maxTotalBytes: { type: 'integer', minimum: 0, maximum: 512 * 1024 * 1024 } },
}

/** The bytes travel as an ArrayBuffer, which the checker passes over without looking at each byte. */
const FILE_WRITE: JsonSchema = {
  type: 'object',
  required: ['file', 'expected', 'next'],
  properties: {
    file: text(4_096, 1),
    expected: nullable(HASH),
    next: {
      anyOf: [
        { type: 'object', required: ['bytes'], properties: { bytes: { type: 'object' } } },
        { type: 'object', required: ['kept'], properties: { kept: HASH } },
        { type: 'null' },
      ],
    },
  },
}

/** Request parameters per method; methods without an entry take none. */
export const HOST_SCHEMAS: { [M in keyof HostRequests]?: JsonSchema } = {
  create: { type: ['object', 'null'], properties: { projectRoot: nullable(text(4_096)), title: text(400) } },
  update: object({ ...sessionId, patch: PATCH }, ['sessionId', 'patch']),
  history: { type: ['object', 'null'], properties: optionalSessionId },
  start: object({ ...sessionId, input: START_INPUT }, ['sessionId', 'input']),
  retry: object({ ...sessionId, mode: { enum: ['code', 'ask', 'plan'] } }, ['sessionId']),
  cancel: object(sessionId, ['sessionId']),
  steer: object({ ...sessionId, text: text(400_000, 1), id: UUID }, ['sessionId', 'text']),
  reset: { type: ['object', 'null'], properties: optionalSessionId },
  remove: object(sessionId, ['sessionId']),
  fork: object(sessionId, ['sessionId']),
  rename: object({ ...sessionId, title: text(400) }, ['sessionId', 'title']),
  goal: object(sessionId, ['sessionId']),
  setGoal: object({ ...sessionId, goal: nullable(GOAL) }, ['sessionId', 'goal']),
  todos: object(sessionId, ['sessionId']),
  setTodos: object({ ...sessionId, todos: { type: 'array', maxItems: 200, items: TODO } }, ['sessionId', 'todos']),
  plan: object(sessionId, ['sessionId']),
  setPlan: object({ ...sessionId, plan: nullable(PLAN) }, ['sessionId', 'plan']),
  compact: object({ ...sessionId, instructions: text(8_000) }, ['sessionId']),
  rewind: object({ ...sessionId, entryId: id }, ['sessionId', 'entryId']),
  checkpoints: object(sessionId, ['sessionId']),
  rewindPlan: object({ ...sessionId, turn: id }, ['sessionId', 'turn']),
  redoPlan: object(sessionId, ['sessionId']),
  rewindApply: object({ ...sessionId, request: REWIND_REQUEST }, ['sessionId', 'request']),
  turnChanges: object({ ...sessionId, turn: id, limits: LIMITS }, ['sessionId']),
  turnWrite: object({ ...sessionId, write: FILE_WRITE }, ['sessionId', 'write']),
  exportData: object(sessionId, ['sessionId']),
  approve: object({ requestId: id, answer: ANSWER }, ['requestId', 'answer']),
  answer: object({ requestId: id, text: text(100_000) }, ['requestId', 'text']),
  jobOutput: object({ jobId: id }, ['jobId']),
  killJob: object({ jobId: id }, ['jobId']),
  setWorkspace: object({ root: nullable(text(4_096, 1)) }, ['root']),
  importLegacy: object({ file: text(4_096, 1) }, ['file']),
}

// ------------------------------------------------------------ the host's side

/** Answers the requests of `HostRequests` from `host`. Returns a function that stops answering. */
export function serveHost(server: HostServer, host: AgentHost): () => void {
  const stops: (() => void)[] = []
  const on = <M extends keyof HostRequests & string>(method: M, handler: (params: HostRequests[M]['params']) => HostRequests[M]['result'] | Promise<HostRequests[M]['result']>) => {
    const schema = HOST_SCHEMAS[method]
    stops.push(server.handle(method, (params) => handler(params), schema ? { schema } : {}))
  }

  on('sessions', () => host.sessions())
  on('create', (params) => host.create(params ?? {}))
  on('update', ({ sessionId, patch }) => host.update(sessionId, patch))
  on('statuses', () => host.statuses())
  on('history', (params) => host.history(params?.sessionId || undefined))
  on('start', ({ sessionId, input }) => host.start(sessionId, input))
  on('retry', ({ sessionId, mode }) => host.retry(sessionId, mode))
  on('cancel', ({ sessionId }) => host.cancel(sessionId))
  on('steer', ({ sessionId, text: message, id: chosen }) => host.steer(sessionId, message, chosen))
  on('reset', (params) => host.reset(params?.sessionId || undefined))
  on('remove', ({ sessionId }) => host.remove(sessionId))
  on('fork', ({ sessionId }) => host.fork(sessionId))
  on('rename', ({ sessionId, title }) => host.rename(sessionId, title))
  on('goal', ({ sessionId }) => host.goal(sessionId))
  on('setGoal', ({ sessionId, goal }) => host.setGoal(sessionId, goal))
  on('todos', ({ sessionId }) => host.todos(sessionId))
  on('setTodos', ({ sessionId, todos }) => host.setTodos(sessionId, todos))
  on('plan', ({ sessionId }) => host.plan(sessionId))
  on('setPlan', ({ sessionId, plan }) => host.setPlan(sessionId, plan))
  on('compact', ({ sessionId, instructions }) => host.compact(sessionId, instructions))
  on('rewind', ({ sessionId, entryId }) => host.rewind(sessionId, entryId))
  on('checkpoints', ({ sessionId }) => host.checkpointInfo(sessionId))
  on('rewindPlan', ({ sessionId, turn }) => host.rewindPlan(sessionId, turn))
  on('redoPlan', ({ sessionId }) => host.redoPlan(sessionId))
  on('rewindApply', ({ sessionId, request }) => host.rewindApply(sessionId, request))
  on('turnChanges', ({ sessionId, turn, limits }) => host.turnChanges(sessionId, turn, limits))
  on('turnWrite', ({ sessionId, write }) => {
    const { next } = write
    // The checker saw an object; only an ArrayBuffer is bytes.
    if (next && 'bytes' in next && !(next.bytes instanceof ArrayBuffer)) throw new TypeError('write.next.bytes must be an ArrayBuffer')
    return host.turnWrite(sessionId, write)
  })
  on('exportData', ({ sessionId }) => host.exportData(sessionId))
  on('approve', ({ requestId, answer }) => host.approve(requestId, answer))
  on('answer', ({ requestId, text: answer }) => host.answer(requestId, answer))
  on('jobs', () => host.jobs())
  on('jobOutput', ({ jobId }) => host.jobOutput(jobId))
  on('killJob', ({ jobId }) => host.killJob(jobId))
  on('setWorkspace', ({ root }) => host.setWorkspace(root))
  on('importLegacy', ({ file }) => host.importLegacySessions(file))

  return () => {
    for (const stop of stops.splice(0)) stop()
  }
}

// ------------------------------------------------------------ the caller's side

/** `AgentHost`'s methods over a port. */
export interface HostClient {
  sessions(): Promise<SessionSummary[]>
  create(options?: { projectRoot?: string | null; title?: string }): Promise<SessionSummary>
  update(sessionId: string, patch: SessionPatch): Promise<SessionSummary | null>
  statuses(): Promise<Record<string, AgentStatus>>
  history(sessionId?: string): Promise<AgentHistory>
  start(sessionId: string, input: AgentStartInput): Promise<void>
  retry(sessionId: string, mode?: AgentMode): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** `id`, when given, names the message's entry: a caller can then match the entry even when it comes before the answer. */
  steer(sessionId: string, text: string, id?: string): Promise<{ id: string } | null>
  reset(sessionId?: string): Promise<void>
  remove(sessionId: string): Promise<void>
  fork(sessionId: string): Promise<SessionSummary>
  rename(sessionId: string, title: string): Promise<void>
  goal(sessionId: string): Promise<SessionGoal | null>
  setGoal(sessionId: string, goal: SessionGoal | null): Promise<void>
  todos(sessionId: string): Promise<TodoItem[]>
  setTodos(sessionId: string, todos: TodoItem[]): Promise<void>
  plan(sessionId: string): Promise<PlanRequest | null>
  setPlan(sessionId: string, plan: PlanRequest | null): Promise<void>
  compact(sessionId: string, instructions?: string): Promise<{ removed: number }>
  rewind(sessionId: string, entryId: string): Promise<{ text: string }>
  checkpoints(sessionId: string): Promise<CheckpointInfo>
  rewindPlan(sessionId: string, turn: string): Promise<RewindPlan>
  redoPlan(sessionId: string): Promise<RewindPlan | null>
  rewindApply(sessionId: string, request: RewindRequest): Promise<RewindOutcome>
  turnChanges(sessionId: string, turn?: string, limits?: { maxFileBytes?: number; maxTotalBytes?: number }): Promise<TurnChangeSet>
  turnWrite(sessionId: string, write: TurnFileWrite): Promise<TurnWriteOutcome>
  exportData(sessionId: string): Promise<{ title: string; transcript: string; json: string }>
  approve(requestId: string, answer: ApprovalAnswer): Promise<boolean>
  answer(requestId: string, text: string): Promise<boolean>
  jobs(): Promise<BackgroundJob[]>
  jobOutput(jobId: string): Promise<string>
  killJob(jobId: string): Promise<void>
  setWorkspace(root: string | null): Promise<void>
  importLegacy(file: string): Promise<number>
}

/** Calls the host over `caller`. A turn started with `start` is not cancelled by the caller's signal; use `cancel`. */
export function createHostClient(caller: HostCaller): HostClient {
  return {
    sessions: () => caller.request('sessions'),
    create: (options) => caller.request('create', options),
    update: (sessionId, patch) => caller.request('update', { sessionId, patch }),
    statuses: () => caller.request('statuses'),
    history: (sessionId) => caller.request('history', sessionId ? { sessionId } : undefined),
    start: (sessionId, input) => caller.request('start', { sessionId, input }),
    retry: (sessionId, mode) => caller.request('retry', mode ? { sessionId, mode } : { sessionId }),
    cancel: (sessionId) => caller.request('cancel', { sessionId }),
    steer: (sessionId, text, id) => caller.request('steer', id === undefined ? { sessionId, text } : { sessionId, text, id }),
    reset: (sessionId) => caller.request('reset', sessionId ? { sessionId } : undefined),
    remove: (sessionId) => caller.request('remove', { sessionId }),
    fork: (sessionId) => caller.request('fork', { sessionId }),
    rename: (sessionId, title) => caller.request('rename', { sessionId, title }),
    goal: (sessionId) => caller.request('goal', { sessionId }),
    setGoal: (sessionId, goal) => caller.request('setGoal', { sessionId, goal }),
    todos: (sessionId) => caller.request('todos', { sessionId }),
    setTodos: (sessionId, todos) => caller.request('setTodos', { sessionId, todos }),
    plan: (sessionId) => caller.request('plan', { sessionId }),
    setPlan: (sessionId, plan) => caller.request('setPlan', { sessionId, plan }),
    compact: (sessionId, instructions) => caller.request('compact', { sessionId, ...(instructions ? { instructions } : {}) }),
    rewind: (sessionId, entryId) => caller.request('rewind', { sessionId, entryId }),
    checkpoints: (sessionId) => caller.request('checkpoints', { sessionId }),
    rewindPlan: (sessionId, turn) => caller.request('rewindPlan', { sessionId, turn }),
    redoPlan: (sessionId) => caller.request('redoPlan', { sessionId }),
    rewindApply: (sessionId, request) => caller.request('rewindApply', { sessionId, request }),
    turnChanges: (sessionId, turn, limits) => caller.request('turnChanges', { sessionId, ...(turn ? { turn } : {}), ...(limits ? { limits } : {}) }),
    turnWrite: (sessionId, write) => caller.request('turnWrite', { sessionId, write }),
    exportData: (sessionId) => caller.request('exportData', { sessionId }),
    approve: (requestId, answer) => caller.request('approve', { requestId, answer: typeof answer === 'boolean' ? { approved: answer } : answer }),
    answer: (requestId, answer) => caller.request('answer', { requestId, text: answer }),
    jobs: () => caller.request('jobs'),
    jobOutput: (jobId) => caller.request('jobOutput', { jobId }),
    killJob: (jobId) => caller.request('killJob', { jobId }),
    setWorkspace: (root) => caller.request('setWorkspace', { root }),
    importLegacy: (file) => caller.request('importLegacy', { file }),
  }
}
