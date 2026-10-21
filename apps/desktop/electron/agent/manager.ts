import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type {
  AgentEvent,
  AgentHistory,
  AgentStartInput,
  ConversationEntry,
  ModelProfile,
  PlanRequest,
  SessionGoal,
  SessionSummary,
  TodoItem,
} from '../../shared/types'
import { Agent } from './agent'
import { exportSessionZip } from '../services/export'
import { secureExisting, writePrivateFile } from '../services/private-file'
import type { ChatMessage } from './types'
import type { JobService } from '../services/jobs'
import type { SettingsService } from '../services/settings'
import type { ShellService } from '../services/shell'
import type { SkillService } from '../services/skills'
import type { WorkspaceService } from '../services/workspace'

interface StoredSession extends SessionSummary {
  messages: ChatMessage[]
  entries: ConversationEntry[]
  goal?: SessionGoal | null
  todos?: TodoItem[]
  plan?: PlanRequest | null
}

const MAX_GOAL_ROUNDS = 8
const CONTINUE_PROMPT =
  'Continue working toward the active goal. If it is genuinely finished, call update_goal with status "complete"; if you cannot proceed, call update_goal with status "blocked" and a reason.'

interface AgentManagerDeps {
  settings: SettingsService
  workspace: WorkspaceService
  shell: ShellService
  jobs: JobService
  skills: SkillService
  emit: (event: AgentEvent) => void
  /** The model's context window in tokens, when a catalog knows it. */
  contextWindow?: (profile: ModelProfile) => number | undefined
}

/**
 * Owns one Agent instance per session, persists every conversation to
 * `userData/eNCode-sessions.json`, and forwards events tagged with the session id
 * so the renderer can route them to the active session.
 */
export class AgentManager {
  private readonly agents = new Map<string, Agent>()
  private readonly meta = new Map<string, SessionSummary>()
  private readonly stored = new Map<string, StoredSession>()
  private readonly goals = new Map<string, SessionGoal>()
  private readonly todosBySession = new Map<string, TodoItem[]>()
  private readonly plans = new Map<string, PlanRequest | null>()
  private readonly file: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: AgentManagerDeps) {
    this.file = path.join(app.getPath('userData'), 'eNCode-sessions.json')
    secureExisting(this.file)
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { sessions?: StoredSession[] }
      for (const session of raw.sessions ?? []) {
        if (!session?.id) continue
        const summary: SessionSummary = {
          id: session.id,
          title: session.title || 'New session',
          createdAt: session.createdAt || Date.now(),
          updatedAt: session.updatedAt || Date.now(),
        }
        this.meta.set(summary.id, summary)
        this.stored.set(summary.id, {
          ...summary,
          messages: Array.isArray(session.messages) ? (session.messages as ChatMessage[]) : [],
          entries: Array.isArray(session.entries) ? (session.entries as ConversationEntry[]) : [],
          goal: session.goal ?? null,
          todos: Array.isArray(session.todos) ? session.todos : [],
          plan: session.plan ?? null,
        })
        if (session.goal) this.goals.set(summary.id, session.goal)
        if (Array.isArray(session.todos)) this.todosBySession.set(summary.id, session.todos)
        if (session.plan) this.plans.set(summary.id, session.plan)
      }
    } catch {
      /* first run or unreadable file */
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.persistNow(), 400)
  }

  persistNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      const sessions = [...this.meta.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50)
        .map((summary) => {
          const stored = this.stored.get(summary.id)
          return {
            ...summary,
            messages: stored?.messages ?? [],
            entries: stored?.entries ?? [],
            goal: this.goals.get(summary.id) ?? null,
            todos: this.todosBySession.get(summary.id) ?? [],
            plan: this.plans.get(summary.id) ?? null,
          }
        })
      writePrivateFile(this.file, JSON.stringify({ version: 1, sessions }, null, 0))
    } catch (error) {
      console.error('[sessions] failed to persist', error)
    }
  }

  private capture(id: string): void {
    const agent = this.agents.get(id)
    const summary = this.meta.get(id)
    if (!agent || !summary) return
    const snapshot = agent.snapshot()
    this.stored.set(id, { ...summary, messages: snapshot.messages, entries: snapshot.entries })
  }

  private makeAgent(id: string): Agent {
    let instance: Agent
    instance = new Agent({
      settings: this.deps.settings,
      workspace: this.deps.workspace,
      shell: this.deps.shell,
      goals: {
        get: () => this.goals.get(id) ?? null,
        set: (goal) => this.setGoalInternal(id, goal),
      },
      todos: {
        get: () => this.todosBySession.get(id) ?? [],
        set: (todos) => this.setTodosInternal(id, todos),
      },
      jobs: this.deps.jobs,
      skills: this.deps.skills,
      contextWindow: this.deps.contextWindow,
      plan: (plan) => this.setPlanInternal(id, plan ? { id: randomUUID(), plan } : null),
      emit: (event) => {
        const summary = this.meta.get(id)
        if (summary) summary.updatedAt = Date.now()
        if (event.type === 'done' || event.type === 'error' || event.type === 'session-reset') {
          this.capture(id)
          this.schedulePersist()
        }
        this.deps.emit({ ...event, sessionId: id })
        if (event.type === 'done') this.maybeContinueGoal(id)
      },
    })
    const stored = this.stored.get(id)
    if (stored) instance.restore(stored)
    this.agents.set(id, instance)
    return instance
  }

  private setGoalInternal(id: string, goal: SessionGoal | null): void {
    if (goal) this.goals.set(id, { ...goal, updatedAt: Date.now() })
    else this.goals.delete(id)
    const stored = this.stored.get(id)
    if (stored) stored.goal = this.goals.get(id) ?? null
    this.deps.emit({ type: 'goal', goal: this.goals.get(id) ?? null, sessionId: id })
    this.persistNow()
  }

  /** Auto-continuation: keep an active goal moving until it completes or caps out. */
  private maybeContinueGoal(id: string): void {
    const goal = this.goals.get(id)
    const agent = this.agents.get(id)
    if (!goal || goal.status !== 'active' || !agent || agent.isRunning()) return
    const cap = this.deps.settings.raw().maxGoalRounds ?? MAX_GOAL_ROUNDS
    if (goal.rounds >= cap) {
      this.setGoalInternal(id, { ...goal, status: 'blocked', updatedAt: Date.now() })
      return
    }
    const next: SessionGoal = { ...goal, rounds: goal.rounds + 1, updatedAt: Date.now() }
    this.goals.set(id, next)
    const stored = this.stored.get(id)
    if (stored) stored.goal = next
    this.deps.emit({ type: 'goal', goal: { ...next }, sessionId: id })
    this.persistNow()
    setTimeout(() => {
      void this.start(id, { text: CONTINUE_PROMPT, mode: 'code' }).catch(() => {
        /* session may have been deleted */
      })
    }, 400)
  }

  goal(sessionId: string): SessionGoal | null {
    return this.goals.get(sessionId) ?? null
  }

  setGoal(sessionId: string, goal: SessionGoal | null): void {
    this.summary(sessionId)
    this.setGoalInternal(sessionId, goal)
  }

  private setTodosInternal(id: string, todos: TodoItem[]): void {
    this.todosBySession.set(id, todos)
    const stored = this.stored.get(id)
    if (stored) stored.todos = todos
    this.deps.emit({ type: 'todos', todos, sessionId: id })
    this.persistNow()
  }

  private setPlanInternal(id: string, plan: PlanRequest | null): void {
    if (plan) this.plans.set(id, plan)
    else this.plans.delete(id)
    const stored = this.stored.get(id)
    if (stored) stored.plan = plan
    this.deps.emit({ type: 'plan', plan, sessionId: id })
    this.persistNow()
  }

  todos(sessionId: string): TodoItem[] {
    return this.todosBySession.get(sessionId) ?? []
  }

  setTodos(sessionId: string, todos: TodoItem[]): void {
    this.summary(sessionId)
    this.setTodosInternal(sessionId, Array.isArray(todos) ? todos : [])
  }

  plan(sessionId: string): PlanRequest | null {
    return this.plans.get(sessionId) ?? null
  }

  setPlan(sessionId: string, plan: PlanRequest | null): void {
    this.summary(sessionId)
    this.setPlanInternal(sessionId, plan)
  }

  private agent(id: string): Agent {
    return this.agents.get(id) ?? this.makeAgent(id)
  }

  private summary(id: string): SessionSummary {
    const existing = this.meta.get(id)
    if (existing) return existing
    const created: SessionSummary = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now() }
    this.meta.set(id, created)
    return created
  }

  create(title = 'New session'): SessionSummary {
    const id = randomUUID()
    const created: SessionSummary = { id, title, createdAt: Date.now(), updatedAt: Date.now() }
    this.meta.set(id, created)
    this.stored.set(id, { ...created, messages: [], entries: [] })
    this.persistNow()
    return created
  }

  list(): SessionSummary[] {
    if (!this.meta.size) this.create()
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  history(sessionId?: string): AgentHistory {
    const id = sessionId ?? this.list()[0]?.id
    if (!id) return { entries: [], status: 'idle' }
    const agent = this.agent(id)
    return agent.getHistory()
  }

  async start(sessionId: string, input: AgentStartInput): Promise<void> {
    const id = sessionId || this.list()[0].id
    this.summary(id)
    const agent = this.agent(id)
    await agent.start(input)
    this.capture(id)
    this.schedulePersist()
  }

  cancel(sessionId: string): void {
    this.agents.get(sessionId)?.cancel()
  }

  reset(sessionId?: string): void {
    if (sessionId) {
      this.agents.get(sessionId)?.reset()
      const summary = this.summary(sessionId)
      this.stored.set(sessionId, { ...summary, messages: [], entries: [] })
    } else {
      for (const [id, agent] of this.agents) {
        agent.reset()
        const summary = this.summary(id)
        this.stored.set(id, { ...summary, messages: [], entries: [] })
      }
      for (const [id, stored] of this.stored) {
        this.stored.set(id, { ...stored, messages: [], entries: [] })
      }
    }
    this.persistNow()
  }

  remove(sessionId: string): void {
    this.agents.get(sessionId)?.reset()
    this.agents.delete(sessionId)
    this.meta.delete(sessionId)
    this.stored.delete(sessionId)
    this.goals.delete(sessionId)
    this.todosBySession.delete(sessionId)
    this.plans.delete(sessionId)
    this.persistNow()
  }

  fork(sessionId: string): SessionSummary {
    const source = this.agent(sessionId)
    const snapshot = source.snapshot()
    const id = randomUUID()
    const created: SessionSummary = {
      id,
      title: `${this.summary(sessionId).title} (fork)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.meta.set(id, created)
    this.stored.set(id, {
      ...created,
      messages: snapshot.messages,
      entries: snapshot.entries,
      goal: this.goals.get(sessionId) ? { ...this.goals.get(sessionId)!, rounds: 0 } : null,
      todos: [...(this.todosBySession.get(sessionId) ?? [])],
    })
    const goal = this.goals.get(sessionId)
    if (goal) this.goals.set(id, { ...goal, rounds: 0, updatedAt: Date.now() })
    const todos = this.todosBySession.get(sessionId)
    if (todos) this.todosBySession.set(id, todos.map((todo) => ({ ...todo })))
    this.persistNow()
    return created
  }

  rename(sessionId: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const summary = this.summary(sessionId)
    summary.title = trimmed.slice(0, 90)
    summary.updatedAt = Date.now()
    const stored = this.stored.get(sessionId)
    if (stored) stored.title = summary.title
    this.persistNow()
  }

  resolveApproval(requestId: string, approved: boolean): boolean {
    for (const agent of this.agents.values()) {
      if (agent.resolveApproval(requestId, approved)) return true
    }
    return false
  }

  resolveAnswer(requestId: string, answer: string): boolean {
    for (const agent of this.agents.values()) {
      if (agent.resolveAnswer(requestId, answer)) return true
    }
    return false
  }

  /** Summarizes older history into the session's context; see Agent.compact. */
  async compact(sessionId: string): Promise<{ removed: number }> {
    const id = sessionId || this.list()[0].id
    const result = await this.agent(id).compact()
    this.capture(id)
    this.persistNow()
    return result
  }

  /** Builds the markdown + json payload and writes it as a zip archive. */
  async exportSession(sessionId: string, targetPath?: string): Promise<string | null> {
    const id = sessionId || this.list()[0].id
    const summary = this.summary(id)
    const history = this.agent(id).getHistory()
    const entries = history.entries
    const transcript = [
      `# ${summary.title}`,
      '',
      ...entries.map((entry) => {
        if (entry.kind === 'tool') {
          const path = String(entry.tool?.input.path ?? entry.tool?.input.command ?? '')
          return `## ${entry.tool?.name ?? 'tool'} ${path}\n\n\`\`\`\n${entry.tool?.output ?? ''}\n\`\`\`\n`
        }
        return `## ${entry.kind}\n\n${entry.text ?? ''}\n`
      }),
    ].join('\n')
    const json = JSON.stringify(
      { ...summary, goal: this.goals.get(id) ?? null, todos: this.todosBySession.get(id) ?? [], entries },
      null,
      2,
    )
    return exportSessionZip({ title: summary.title, transcript, json }, targetPath)
  }

  dispose(): void {
    for (const agent of this.agents.values()) agent.cancel()
    this.persistNow()
  }
}
