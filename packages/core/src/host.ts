/**
 * The host: every session of one user behind one API, the way the desktop
 * app's agent process and the CLI use them.
 *
 * It owns the session store and the sessions opened from it, builds each
 * session's environment (workspace, shell, skills, memory, subagent types),
 * keeps goals moving between turns, and routes the user's answers to the
 * session that asked. A session works in its own project folder, so
 * switching the open folder never changes where a running session writes.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelClient, SystemPart } from '@encode/providers'
import {
  createAgentShell,
  createDesktopBroker,
  createWebAccess,
  type AgentShellOptions,
  type CodeIndex,
  type NativeDoc,
  type CodeIntelligence,
  type DesktopBackend,
  type DesktopBroker,
  type DesktopOptions,
  type ManagedShell,
  type PlanVerdict,
  type ShellCommandAssessor,
  type Tool,
  type ToolContext,
  type WebAccess,
} from '@encode/tools'
import { createDefaultAssessor, refuseEverything, type RuleJudge } from './approval'
import type { ExternalToolSource } from './external'
import { combineHooks, type AgentHooks } from './hooks'
import { migrateLegacySessions } from './migrate'
import { createOutputStore, type OutputStore } from './outputs'
import { GOAL_CONTINUE_PROMPT } from './prompt'
import { AgentSession, type RememberResult, type SessionCheckpoints, type SessionEnding, type SessionEnv } from './session'
import type { SessionLog } from './session-records'
import { createSessionStore, type FileSessionStore } from './session-store'
import { createSkills, type SkillSource } from './skills'
import type { AgentSource } from './subagents'
import type { AgentSettings, TurnEnd } from './types'
import type { WorktreeGit } from './worktrees'
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
  RuleScope,
  SessionGoal,
  SessionSummary,
  TodoItem,
  TurnChangeSet,
  TurnFileWrite,
  TurnWriteOutcome,
} from './ui'
import type { TurnRecordOutcome } from './turn-report'

/**
 * The parts of a session's environment that depend on the folder it works in and on the settings found there:
 * which rules apply, whether the folder is trusted, which hooks run. Made once for each session when it opens
 * (see `HostOptions.scope`); what changes later, a rule the user adds or a settings file that is edited, is read
 * again by `refresh` before each tool call is judged.
 */
export interface SessionScope {
  /** Run before the host's own hooks. */
  hooks?: AgentHooks
  /** Replaces the host's assessor of shell lines. */
  assessor?: ShellCommandAssessor
  rules?: RuleJudge
  extraRoots?: () => readonly string[]
  refresh?: () => Promise<void>
  remember?(rules: string[], scope: RuleScope): Promise<RememberResult>
  beforeWrite?: ToolContext['beforeWrite']
  /** What the session's file tools changed, and the means to put it back. */
  checkpoints?: SessionCheckpoints
  /** The tools of the folder's MCP servers, which come and go while the session is open. */
  external?: ExternalToolSource
  /** Options for this session's shells, asked for each time one is made, merged over the host's. */
  shell?: () => Omit<AgentShellOptions, 'root'>
  /** The folder's language servers while they may run (trusted, turned on); read when a turn starts. */
  code?: () => CodeIntelligence | undefined
  /** The folder's code index, shared by its sessions (ADR 0090). */
  codeIndex?: () => CodeIndex | undefined
  /** FiveM's natives, when eNCode installed them (ADR 0091). */
  natives?: () => readonly NativeDoc[] | undefined
  /** The commands the folder's settings name as its checks (ADR 0095); undefined to have eNCode find them. */
  checks?: () => readonly string[] | undefined
  /** The session closed: let go of what was held for it. */
  release?: () => Promise<void>
}

export interface HostOptions {
  /** Where the session logs live. */
  dir: string
  client: ModelClient
  /** The live settings; read at each use, so a change applies to the next call. */
  settings: () => AgentSettings
  /** Every event of every session. */
  emit(event: AgentEvent): void
  /** The background jobs of all sessions changed. */
  onJobs?(jobs: BackgroundJob[]): void
  /** The folder open now, for sessions that belong to no project. */
  workspace?: string | null
  home?: string
  platform?: NodeJS.Platform
  hooks?: AgentHooks
  assessor?: ShellCommandAssessor
  /**
   * Settings, trust, rules, hooks and checkpoints of the folder a session works in. Asked once for each session that has a
   * folder. `notice` puts a line in the session's conversation (a hook that failed, a store that could not be read).
   */
  scope?(request: { sessionId: string; root: string; notice(text: string): void }): SessionScope | Promise<SessionScope>
  /** The git work behind the agent's worktrees, for every folder; without it the agent has no EnterWorktree. */
  worktrees?: WorktreeGit
  web?: WebAccess
  /** Options for the agent's shells: sandboxing, variables to keep. */
  shell?: Omit<AgentShellOptions, 'root'>
  /** Replaces how a shell is made (tests, a sandbox that needs more than a spawn wrapper). */
  createShell?(root: string): ManagedShell
  /** The user's own folder: ENCODE.md, skills and agents. Default `<home>/.encode`. */
  userDir?: string
  beforeWrite?: ToolContext['beforeWrite']
  extraTools?: readonly Tool[]
  /**
   * The desktop the Computer tool drives, shared by every session: one chat at a time sends input to it. The
   * host stops it when it closes. Sessions get the tool only while the `computer` setting is on.
   */
  desktop?: DesktopBackend
  desktopOptions?: Partial<DesktopOptions>
  reviewPlan?(plan: string, signal: AbortSignal): Promise<PlanVerdict>
  system?: SystemPart[]
  warn?(message: string): void
  /** The pause before an active goal restarts the agent, ms. Default 400. */
  goalDelayMs?: number
  /** Name each session with one small call to the utility model after its first turn. Default true. */
  nameSessions?: boolean
  /** How background news is timed in every session (see SessionEnv); tests shorten it. */
  timing?: SessionEnv['timing']
  /** Where results too long for the model are kept whole, a folder for each session (ADR 0093). Default `<dir>/outputs`; false keeps none. */
  outputs?: string | false
}

const NO_SESSION = 'That session does not exist.'

/** The scope of a session whose settings could not be loaded: nothing runs until they can. */
function refusing(error: unknown): SessionScope {
  return refuseEverything(`The settings of this folder could not be loaded (${error instanceof Error ? error.message : String(error)}), so nothing runs here until they can.`)
}

async function realPath(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir)
  } catch {
    return dir
  }
}

export class AgentHost {
  private readonly store: FileSessionStore
  private readonly loaded = new Map<string, AgentSession>()
  private readonly opening = new Map<string, Promise<AgentSession>>()
  /** Sessions being closed, by id: a session is opened again only after the one before it has let go of its log. */
  private readonly retiring = new Map<string, Promise<void>>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private workspaceRoot: string | null
  /** Counts the changes of the open folder; a session made before the latest one may be pointing at the wrong folder. */
  private epoch = 0
  private readonly bornAt = new WeakMap<AgentSession, number>()
  private disposed = false
  private readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly userDir: string
  private readonly web: WebAccess
  private readonly assessor: ShellCommandAssessor
  private readonly desktop: DesktopBroker | undefined
  private readonly outputs: OutputStore | undefined

  constructor(private readonly o: HostOptions) {
    this.store = createSessionStore({ dir: o.dir })
    this.outputs = o.outputs === false ? undefined : createOutputStore({ dir: o.outputs ?? path.join(o.dir, 'outputs') })
    this.workspaceRoot = o.workspace ?? null
    this.home = o.home ?? os.homedir()
    this.platform = o.platform ?? process.platform
    this.userDir = o.userDir ?? path.join(this.home, '.encode')
    this.web = o.web ?? createWebAccess()
    this.assessor = o.assessor ?? createDefaultAssessor(this.platform)
    this.desktop = o.desktop ? createDesktopBroker(o.desktop, o.desktopOptions ? { options: o.desktopOptions } : {}) : undefined
  }

  // ------------------------------------------------------------ the environment of a session

  private skillSources(root: string): SkillSource[] {
    return [
      { dir: path.join(this.userDir, 'skills'), source: 'user' },
      ...(root ? [{ dir: path.join(root, '.encode', 'skills'), source: 'workspace' as const }] : []),
    ]
  }

  private agentSources(root: string): AgentSource[] {
    return [
      { dir: path.join(this.userDir, 'agents'), source: 'user' },
      ...(root ? [{ dir: path.join(root, '.encode', 'agents'), source: 'workspace' as const }] : []),
    ]
  }

  private shellOptions(scope: SessionScope | undefined): Omit<AgentShellOptions, 'root'> {
    const own = scope?.shell?.()
    if (!own) return { ...this.o.shell }
    const base = this.o.shell ?? {}
    const keepEnv = [...(base.keepEnv ?? []), ...(own.keepEnv ?? [])]
    const extraEnv = { ...base.extraEnv, ...own.extraEnv }
    return { ...base, ...own, ...(keepEnv.length ? { keepEnv } : {}), ...(Object.keys(extraEnv).length ? { extraEnv } : {}) }
  }

  private envFor(sessionId: string, root: string, scope?: SessionScope): SessionEnv {
    const { o } = this
    const beforeWrite = scope?.beforeWrite ?? o.beforeWrite
    return {
      root,
      home: this.home,
      platform: this.platform,
      client: o.client,
      settings: o.settings,
      hooks: scope?.hooks ? combineHooks(scope.hooks, o.hooks) : (o.hooks ?? {}),
      assessor: scope?.assessor ?? this.assessor,
      ...(scope?.rules ? { rules: scope.rules } : {}),
      ...(scope?.extraRoots ? { extraRoots: scope.extraRoots } : {}),
      ...(scope?.refresh ? { refresh: scope.refresh } : {}),
      ...(scope?.remember ? { remember: scope.remember } : {}),
      ...(scope?.release ? { release: scope.release } : {}),
      ...(scope?.checkpoints ? { checkpoints: scope.checkpoints } : {}),
      ...(scope?.external ? { external: scope.external } : {}),
      ...(scope?.code ? { code: scope.code } : {}),
      ...(scope?.codeIndex ? { codeIndex: scope.codeIndex } : {}),
      ...(scope?.natives ? { natives: scope.natives } : {}),
      ...(scope?.checks ? { checks: scope.checks } : {}),
      ...(o.worktrees && root ? { worktrees: o.worktrees } : {}),
      web: this.web,
      createShell: () => (o.createShell ? o.createShell(root) : createAgentShell({ ...this.shellOptions(scope), root, platform: this.platform })),
      skills: createSkills(() => this.skillSources(root)),
      agentSources: () => this.agentSources(root),
      userDir: this.userDir,
      // What the agent may read without asking besides the workspace: skills, the user's own folder, and the long results kept for this session.
      readRoots: () => [this.userDir, ...this.skillSources(root).map((source) => source.dir), ...(this.outputs ? [this.outputs.folder(sessionId)] : [])],
      ...(this.outputs ? { outputs: this.outputs } : {}),
      ...(beforeWrite ? { beforeWrite } : {}),
      ...(o.extraTools ? { extraTools: o.extraTools } : {}),
      ...(this.desktop ? { desktop: (sessionId: string) => this.desktop!.open(sessionId) } : {}),
      ...(o.reviewPlan ? { reviewPlan: o.reviewPlan } : {}),
      ...(o.system ? { system: o.system } : {}),
      ...(o.warn ? { warn: o.warn } : {}),
      ...(o.nameSessions === false ? { nameSessions: false } : {}),
      ...(o.timing ? { timing: o.timing } : {}),
      emit: (event) => o.emit(event),
      jobsChanged: () => this.reportJobs(),
    }
  }

  // ------------------------------------------------------------ opening sessions

  private async make(log: SessionLog): Promise<AgentSession> {
    const project = log.snapshot().marks.projectRoot ?? this.workspaceRoot
    const root = project ? await realPath(project) : ''
    let scope: SessionScope | undefined
    if (root && this.o.scope) {
      try {
        scope = await this.o.scope({ sessionId: log.id, root, notice: (text) => this.loaded.get(log.id)?.tell(text) })
      } catch (error) {
        // Without its rules a session must not run with the permissive defaults: it opens, and every tool call fails.
        this.o.warn?.(`Could not load the settings of ${root}: ${error instanceof Error ? error.message : String(error)}`)
        scope = refusing(error)
      }
    }
    const session = new AgentSession(log, this.envFor(log.id, root, scope))
    this.bornAt.set(session, this.epoch)
    this.loaded.set(log.id, session)
    return session
  }

  private idle(session: AgentSession): boolean {
    return !session.isRunning() && !session.jobs().some((job) => job.status === 'running')
  }

  /** A session that belongs to no project, made before the open folder changed, and doing nothing now. */
  private stale(session: AgentSession): boolean {
    return session.marks().projectRoot === null && this.bornAt.get(session) !== this.epoch && this.idle(session)
  }

  /** Closes a session that is no longer wanted. It is out of the map at once; `open` waits for the close before it makes another. */
  private retire(id: string, session: AgentSession, ending: SessionEnding = 'closed'): Promise<void> {
    if (this.loaded.get(id) === session) this.loaded.delete(id)
    const closing: Promise<void> = session
      .dispose(ending)
      .catch(() => undefined)
      .finally(() => {
        if (this.retiring.get(id) === closing) this.retiring.delete(id)
      })
    this.retiring.set(id, closing)
    return closing
  }

  private async open(id: string): Promise<AgentSession> {
    if (this.disposed) throw new Error('The agent host is closed.')
    const retiring = this.retiring.get(id)
    if (retiring) {
      await retiring
      if (this.disposed) throw new Error('The agent host is closed.')
    }
    const cached = this.loaded.get(id)
    if (cached && !this.stale(cached)) return cached
    const pending = this.opening.get(id)
    if (pending) return pending
    const task = (async () => {
      if (cached) await this.retire(id, cached)
      const log = await this.store.open(id)
      if (!log) throw new Error(NO_SESSION)
      return this.make(log)
    })()
    this.opening.set(id, task)
    try {
      return await task
    } finally {
      this.opening.delete(id)
    }
  }

  /** The folder open now. Sessions that belong to no project follow it once they are idle. */
  async setWorkspace(root: string | null): Promise<void> {
    this.workspaceRoot = root
    this.epoch++
    await Promise.all([...this.loaded].filter(([, session]) => this.stale(session)).map(([id, session]) => this.retire(id, session)))
  }

  // ------------------------------------------------------------ the renderer's API

  /**
   * Brings in the sessions an earlier build kept in one JSON file, once: the
   * file is renamed afterwards. Sessions that name no project follow the open
   * folder, as they did before. Resolves to how many were imported.
   */
  async importLegacySessions(file: string): Promise<number> {
    const existing = new Set((await this.store.list()).map((summary) => summary.id))
    return migrateLegacySessions({ file, store: this.store, defaultRoot: null, existing })
  }

  async sessions(): Promise<SessionSummary[]> {
    let list = await this.store.list()
    if (!list.length) {
      await this.create()
      list = await this.store.list()
    }
    return list
  }

  /** A new session in `projectRoot`; by default the open folder, or none. */
  async create(options: { projectRoot?: string | null; title?: string } = {}): Promise<SessionSummary> {
    const requested = options.projectRoot
    const root = requested === undefined ? this.workspaceRoot : typeof requested === 'string' && requested.trim() ? requested : null
    const log = await this.store.create({ root, ...(options.title?.trim() ? { title: options.title.trim().slice(0, 90) } : {}) })
    return (await this.make(log)).summary()
  }

  async update(sessionId: string, patch: unknown): Promise<SessionSummary | null> {
    let session: AgentSession
    try {
      session = await this.open(sessionId)
    } catch (error) {
      if (error instanceof Error && error.message === NO_SESSION) return null
      throw error
    }
    const before = session.marks().projectRoot
    await session.update(patch)
    const summary = session.summary()
    // Moved to another project: its shell and tools belong to the old folder, so the next use opens it afresh.
    if (session.marks().projectRoot !== before && !session.isRunning()) await this.retire(sessionId, session)
    return summary
  }

  /**
   * Opens the sessions whose agent asked to be woken (ScheduleWakeup), so that the wake-up fires although nobody opens
   * them; one missed while eNCode was closed fires now, and the agent is told it is late. Resolves to how many.
   */
  async resumeWakeups(): Promise<number> {
    const waiting = (await this.store.list()).filter((summary) => summary.wakeAt !== undefined && !summary.archived)
    let opened = 0
    for (const summary of waiting) {
      if (this.disposed) break
      try {
        await this.open(summary.id)
        opened++
      } catch (error) {
        this.o.warn?.(`Could not open session ${summary.id} for its wake-up: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return opened
  }

  /** The sessions an agent is working in or waiting on; idle ones are left out. */
  statuses(): Record<string, AgentStatus> {
    const live: Record<string, AgentStatus> = {}
    for (const [id, session] of this.loaded) {
      const status = session.status()
      if (status === 'thinking' || status === 'running-tool' || status === 'awaiting-approval' || status === 'awaiting-user') live[id] = status
    }
    return live
  }

  async history(sessionId?: string): Promise<AgentHistory> {
    const id = sessionId || (await this.sessions())[0]?.id
    if (!id) return { entries: [], status: 'idle' }
    return (await this.open(id)).history()
  }

  /** Runs a turn; resolves when it ends. */
  async start(sessionId: string, input: AgentStartInput): Promise<void> {
    const id = sessionId || (await this.sessions())[0].id
    const session = await this.open(id)
    const end = await session.start(input)
    this.afterTurn(session, end)
  }

  /** Runs a session's last request again from where a problem stopped it; resolves when it ends. */
  async retry(sessionId: string, mode?: AgentMode): Promise<void> {
    const session = await this.open(sessionId)
    const end = await session.retry(mode ? { mode } : {})
    this.afterTurn(session, end)
  }

  cancel(sessionId: string): void {
    this.loaded.get(sessionId)?.cancel()
  }

  /** A message for the turn running in a session, taken in between two of its steps; null when none takes it now. */
  steer(sessionId: string, text: string, id?: string): { id: string } | null {
    return this.loaded.get(sessionId)?.steer(text, id) ?? null
  }

  /** Starts a session's conversation over; without an id, every session's. */
  async reset(sessionId?: string): Promise<void> {
    if (sessionId) {
      await (await this.open(sessionId)).reset()
      return
    }
    for (const summary of await this.store.list()) await (await this.open(summary.id)).reset()
  }

  async remove(sessionId: string): Promise<void> {
    await this.retiring.get(sessionId)
    const session = this.loaded.get(sessionId)
    if (session) await this.retire(sessionId, session, 'deleted')
    await this.store.remove(sessionId)
    await this.outputs?.remove(sessionId)
    this.reportJobs()
  }

  /** A copy of a session as it stands, without its marks, plan or goal progress. */
  async fork(sessionId: string): Promise<SessionSummary> {
    const source = await this.open(sessionId)
    await source.flush()
    const { title, projectRoot } = { title: source.summary().title, projectRoot: source.marks().projectRoot }
    const log = await this.store.create({ root: projectRoot, title: `${title} (fork)`, fork: { sessionId, recordId: source.lastRecordId() } })
    const session = await this.make(log)
    await session.rename(`${title} (fork)`)
    await session.update({ pinned: false, archived: false, unread: false })
    const goal = session.goal()
    if (goal) session.setGoal({ ...goal, rounds: 0 })
    if (session.plan()) session.setPlan(null)
    return session.summary()
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await (await this.open(sessionId)).rename(title)
  }

  async goal(sessionId: string): Promise<SessionGoal | null> {
    return (await this.open(sessionId)).goal()
  }

  async setGoal(sessionId: string, goal: SessionGoal | null): Promise<void> {
    ;(await this.open(sessionId)).setGoal(goal)
  }

  async todos(sessionId: string): Promise<TodoItem[]> {
    return (await this.open(sessionId)).todos()
  }

  async setTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
    ;(await this.open(sessionId)).setTodos(todos)
  }

  async plan(sessionId: string): Promise<PlanRequest | null> {
    return (await this.open(sessionId)).plan()
  }

  async setPlan(sessionId: string, plan: PlanRequest | null): Promise<void> {
    ;(await this.open(sessionId)).setPlan(plan)
  }

  async compact(sessionId: string, instructions?: string): Promise<{ removed: number }> {
    return (await this.open(sessionId || (await this.sessions())[0].id)).compact(instructions)
  }

  /** Goes back to before one of the user's requests; resolves to its text. */
  async rewind(sessionId: string, entryId: string): Promise<{ text: string }> {
    return (await this.open(sessionId)).rewind(entryId)
  }

  /** The requests after which files changed, and whether a rewind can be undone. */
  async checkpointInfo(sessionId: string): Promise<CheckpointInfo> {
    return (await this.open(sessionId)).checkpointInfo()
  }

  /** What putting the files back to before one of the user's requests would do; nothing changes. */
  async rewindPlan(sessionId: string, turn: string): Promise<RewindPlan> {
    return (await this.open(sessionId)).rewindPlan(turn)
  }

  /** What undoing the latest rewind would do, or null. */
  async redoPlan(sessionId: string): Promise<RewindPlan | null> {
    return (await this.open(sessionId)).redoPlan()
  }

  /** Puts files back as a plan said, and the conversation with them if asked. */
  async rewindApply(sessionId: string, request: RewindRequest): Promise<RewindOutcome> {
    return (await this.open(sessionId)).rewindApply(request)
  }

  /** What one request's file tools changed (the latest such request when none is named), for the Review tab. */
  async turnChanges(sessionId: string, turn?: string, limits?: { maxFileBytes?: number; maxTotalBytes?: number }): Promise<TurnChangeSet> {
    return (await this.open(sessionId)).turnChanges(turn, limits)
  }

  /** Writes a file the agent changed, for the person, while it holds what they saw. */
  /** What a report of a request holds (ADR 0092), from the session it was made in. */
  async turnRecord(sessionId: string, turn: string | undefined, options: { scramble: boolean }): Promise<TurnRecordOutcome> {
    return (await this.open(sessionId)).turnRecord(turn, options)
  }

  async turnWrite(sessionId: string, write: TurnFileWrite): Promise<TurnWriteOutcome> {
    return (await this.open(sessionId)).turnWrite(write)
  }

  /** The conversation as Markdown and JSON, for the caller to save. */
  async exportData(sessionId: string): Promise<{ title: string; transcript: string; json: string }> {
    return (await this.open(sessionId || (await this.sessions())[0].id)).exportData()
  }

  /** The user's answer to an approval request, from whichever session asked. */
  approve(requestId: string, answer: ApprovalAnswer): boolean {
    for (const session of this.loaded.values()) if (session.resolveApproval(requestId, answer)) return true
    return false
  }

  answer(requestId: string, text: string): boolean {
    for (const session of this.loaded.values()) if (session.resolveAnswer(requestId, text)) return true
    return false
  }

  // ------------------------------------------------------------ background jobs

  /** The background jobs of every session. Job ids are numbered per session, so the host names them `<session>:<job>`. */
  jobs(): BackgroundJob[] {
    return [...this.loaded.values()]
      .flatMap((session) => session.jobs().map((job) => ({ ...job, id: `${session.id}:${job.id}` })))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  private jobSession(jobId: string): { session: AgentSession; local: string } | undefined {
    const split = jobId.indexOf(':')
    const session = split > 0 ? this.loaded.get(jobId.slice(0, split)) : undefined
    return session ? { session, local: jobId.slice(split + 1) } : undefined
  }

  jobOutput(jobId: string): string {
    const found = this.jobSession(jobId)
    return found?.session.jobOutput(found.local) ?? ''
  }

  async killJob(jobId: string): Promise<void> {
    const found = this.jobSession(jobId)
    await found?.session.killJob(found.local)
  }

  private reportJobs(): void {
    if (!this.disposed) this.o.onJobs?.(this.jobs())
  }

  // ------------------------------------------------------------ goals

  /** An active goal keeps the agent going: after a turn that ended on its own, work on it again, up to the round limit. */
  private afterTurn(session: AgentSession, end: TurnEnd): void {
    if (this.disposed || (end.kind !== 'done' && end.kind !== 'stopped' && end.kind !== 'max-steps')) return
    const goal = session.goal()
    // A plan waiting for the user's verdict is not something to carry on past.
    if (!goal || goal.status !== 'active' || session.isRunning() || session.plan()) return
    if (goal.rounds >= this.o.settings().maxGoalRounds) {
      session.setGoal({ ...goal, status: 'blocked' })
      return
    }
    session.setGoal({ ...goal, rounds: goal.rounds + 1 })
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.disposed || this.loaded.get(session.id) !== session) return
      this.start(session.id, { text: GOAL_CONTINUE_PROMPT, mode: 'code' }).catch(() => undefined)
    }, this.o.goalDelayMs ?? 400)
    this.timers.add(timer)
  }

  // ------------------------------------------------------------ closing

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.retiring.values(), ...[...this.loaded.values()].map((session) => session.dispose('quit'))])
    this.loaded.clear()
    await this.desktop?.dispose().catch(() => undefined)
    await this.store.dispose()
  }
}
