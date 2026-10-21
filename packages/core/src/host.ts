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
  createWebAccess,
  type AgentShellOptions,
  type ManagedShell,
  type PlanVerdict,
  type ShellCommandAssessor,
  type Tool,
  type ToolContext,
  type WebAccess,
} from '@encode/tools'
import { createDefaultAssessor } from './approval'
import type { AgentHooks } from './hooks'
import { GOAL_CONTINUE_PROMPT } from './prompt'
import { AgentSession, type SessionEnv } from './session'
import { createSessionStore, type FileSessionStore } from './session-store'
import { createSkills, type SkillSource } from './skills'
import type { AgentSource } from './subagents'
import type { AgentSettings, TurnEnd } from './types'
import type {
  AgentEvent,
  AgentHistory,
  AgentStartInput,
  AgentStatus,
  ApprovalAnswer,
  BackgroundJob,
  PlanRequest,
  SessionGoal,
  SessionSummary,
  TodoItem,
} from './ui'

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
  web?: WebAccess
  /** Options for the agent's shells: sandboxing, variables to keep. */
  shell?: Omit<AgentShellOptions, 'root'>
  /** Replaces how a shell is made (tests, a sandbox that needs more than a spawn wrapper). */
  createShell?(root: string): ManagedShell
  /** The user's own folder: ENCODE.md, skills and agents. Default `<home>/.encode`. */
  userDir?: string
  beforeWrite?: ToolContext['beforeWrite']
  extraTools?: readonly Tool[]
  reviewPlan?(plan: string, signal: AbortSignal): Promise<PlanVerdict>
  system?: SystemPart[]
  warn?(message: string): void
  /** The pause before an active goal restarts the agent, ms. Default 400. */
  goalDelayMs?: number
}

const NO_SESSION = 'That session does not exist.'

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
  private readonly timers = new Set<NodeJS.Timeout>()
  private workspaceRoot: string | null
  private disposed = false
  private readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly userDir: string
  private readonly web: WebAccess
  private readonly assessor: ShellCommandAssessor

  constructor(private readonly o: HostOptions) {
    this.store = createSessionStore({ dir: o.dir })
    this.workspaceRoot = o.workspace ?? null
    this.home = o.home ?? os.homedir()
    this.platform = o.platform ?? process.platform
    this.userDir = o.userDir ?? path.join(this.home, '.encode')
    this.web = o.web ?? createWebAccess()
    this.assessor = o.assessor ?? createDefaultAssessor(this.platform)
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

  private envFor(root: string): SessionEnv {
    const { o } = this
    return {
      root,
      home: this.home,
      platform: this.platform,
      client: o.client,
      settings: o.settings,
      hooks: o.hooks ?? {},
      assessor: this.assessor,
      web: this.web,
      createShell: () => (o.createShell ? o.createShell(root) : createAgentShell({ ...o.shell, root, platform: this.platform })),
      skills: createSkills(() => this.skillSources(root)),
      agentSources: () => this.agentSources(root),
      userDir: this.userDir,
      // What the agent may read without asking besides the workspace: skills and the user's own folder.
      readRoots: () => [this.userDir, ...this.skillSources(root).map((source) => source.dir)],
      ...(o.beforeWrite ? { beforeWrite: o.beforeWrite } : {}),
      ...(o.extraTools ? { extraTools: o.extraTools } : {}),
      ...(o.reviewPlan ? { reviewPlan: o.reviewPlan } : {}),
      ...(o.system ? { system: o.system } : {}),
      ...(o.warn ? { warn: o.warn } : {}),
      emit: (event) => o.emit(event),
      jobsChanged: () => this.reportJobs(),
    }
  }

  // ------------------------------------------------------------ opening sessions

  private async open(id: string): Promise<AgentSession> {
    if (this.disposed) throw new Error('The agent host is closed.')
    const cached = this.loaded.get(id)
    if (cached) return cached
    const pending = this.opening.get(id)
    if (pending) return pending
    const task = (async () => {
      const log = await this.store.open(id)
      if (!log) throw new Error(NO_SESSION)
      const project = log.snapshot().marks.projectRoot ?? this.workspaceRoot
      const session = new AgentSession(log, this.envFor(project ? await realPath(project) : ''))
      this.loaded.set(id, session)
      return session
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
    for (const [id, session] of [...this.loaded]) {
      if (session.marks().projectRoot !== null || session.isRunning() || session.jobs().some((job) => job.status === 'running')) continue
      this.loaded.delete(id)
      await session.dispose()
    }
  }

  // ------------------------------------------------------------ the renderer's API

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
    const project = log.snapshot().marks.projectRoot ?? this.workspaceRoot
    const session = new AgentSession(log, this.envFor(project ? await realPath(project) : ''))
    this.loaded.set(log.id, session)
    return session.summary()
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
    if (session.marks().projectRoot !== before && !session.isRunning()) {
      this.loaded.delete(sessionId)
      await session.dispose()
    }
    return summary
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

  cancel(sessionId: string): void {
    this.loaded.get(sessionId)?.cancel()
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
    const session = this.loaded.get(sessionId)
    this.loaded.delete(sessionId)
    await session?.dispose()
    await this.store.remove(sessionId)
    this.reportJobs()
  }

  /** A copy of a session as it stands, without its marks, plan or goal progress. */
  async fork(sessionId: string): Promise<SessionSummary> {
    const source = await this.open(sessionId)
    await source.flush()
    const { title, projectRoot } = { title: source.summary().title, projectRoot: source.marks().projectRoot }
    const log = await this.store.create({ root: projectRoot, title: `${title} (fork)`, fork: { sessionId, recordId: source.lastRecordId() } })
    const project = projectRoot ?? this.workspaceRoot
    const session = new AgentSession(log, this.envFor(project ? await realPath(project) : ''))
    this.loaded.set(log.id, session)
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

  jobs(): BackgroundJob[] {
    return [...this.loaded.values()].flatMap((session) => session.jobs()).sort((a, b) => b.startedAt - a.startedAt)
  }

  jobOutput(jobId: string): string {
    for (const session of this.loaded.values()) {
      const output = session.jobOutput(jobId)
      if (output !== undefined) return output
    }
    return ''
  }

  async killJob(jobId: string): Promise<void> {
    for (const session of this.loaded.values()) if (await session.killJob(jobId)) return
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
    await Promise.all([...this.loaded.values()].map((session) => session.dispose()))
    this.loaded.clear()
    await this.store.dispose()
  }
}
