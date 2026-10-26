/**
 * Subagents: the Task tool's workers. A subagent runs the same loop as the
 * main agent on a conversation of its own, with a brief for its first message
 * and a report for its last. It cannot start subagents of its own, set goals
 * or plans, or keep a task list; its questions and approvals go to the user
 * through the main agent's surface, under the Task call.
 *
 * A subagent runs while the Task call waits, or in the background, telling the
 * main agent how it ended through a notice. Its conversation is stored in the
 * session's log under its id, so SendMessage can take it on from where it
 * stopped: after it finished, after it was stopped, and after eNCode closed in
 * the middle of its work. The pool that knows them belongs to the session, not
 * to one loop: a changed setting builds a new loop, and the subagents running
 * in the background carry on.
 *
 * Besides the built-in types, users define their own as Markdown files in
 * `.encode/agents/` (the workspace's) or `~/.encode/agents/`:
 *
 *   ---
 *   name: security-reviewer
 *   description: Reviews a diff for bugs and missing tests.
 *   tools: Read, Grep, Glob, Bash
 *   disallowedTools: WebFetch
 *   role: reviewer
 *   maxTurns: 20
 *   color: blue
 *   ---
 *   Instructions that follow the brief...
 *
 * `model` is read as `role` (which model the work goes to); the names of other tools' models (sonnet, opus, inherit)
 * mean nothing here and leave the main agent's. A repository fills the workspace's folder, so it is read with care:
 * regular files only, no links out of the workspace, nothing large, and no more than a few dozen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { textBlock, userText, type Message, type ModelClient, type ModelRole, type SystemPart, type Usage } from '@encode/providers'
import {
  createFileStateTracker,
  withoutSeen,
  BUILTIN_SUBAGENT_TYPES,
  TOOL_SEARCH,
  type AgentShell,
  type FileStateTracker,
  type AgentMode,
  type ShellCommandAssessor,
  type SubagentMessage,
  type SubagentRequest,
  type SubagentResult,
  type Subagents,
  type SubagentType,
  type ToolRegistry,
} from '@encode/tools'
import type { RuleJudge } from './approval'
import { memoryConversation, type MemoryConversation } from './conversation'
import type { AgentHooks } from './hooks'
import { AgentLoop, type LoopServices } from './loop'
import { reminder } from './prompt'
import type { AutoReviewer } from './reviewer'
import { describeError, detailsOf, plainError } from './problems'
import { readSmallFile, staysInProject } from './safe-files'
import type { SubagentInfo } from './session-records'
import { parseFrontMatter } from './skills'
import { AgentAbortedError, type AgentSettings, type ApprovalPrompt, type ApprovalResult, type Conversation, type NewEntry, type Surface } from './types'
import type { AgentStatus, ConversationEntry } from './ui'

export interface SubagentDefinition extends SubagentType {
  /** Which model the work goes to; the router decides what that means. Default: the main agent's. */
  role?: ModelRole
  /** Instructions added to the subagent's system prompt. */
  prompt?: string
  /** Tools taken away from `tools` (or from all of them when `tools` is absent). */
  disallowedTools?: string[]
  /** Steps before it must report, in place of the usual limit. */
  maxTurns?: number
  /** An accent for the lists that show it. */
  color?: string
  source: 'builtin' | 'user' | 'workspace'
  /** The file it was read from; built-in agents have none. */
  file?: string
}

/**
 * What a subagent never gets: it must not start more agents, or touch what only the main agent owns. The Computer
 * tool is one of those: up to four subagents run side by side, and there is one mouse; so is the Browser, whose tab is
 * the chat's one. Monitor, ScheduleWakeup and
 * SendMessage report back through notices only the main agent reads. A subagent works where the main agent works, so
 * it does not enter or leave worktrees either. Debug runs are the session's, each approved by the person while they
 * watch the main agent's turn (ADR 0145).
 */
export const SUBAGENT_EXCLUDED: readonly string[] = [
  'Task',
  'SendMessage',
  'Monitor',
  'ScheduleWakeup',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'UpdateGoal',
  'GetGoal',
  'TodoWrite',
  'attempt_completion',
  'Computer',
  'Browser',
  'EnterWorktree',
  'ExitWorktree',
  'Debug',
]

/** The most steps a subagent takes before it must report. */
const MAX_SUBAGENT_STEPS = 40
const MAX_REPORT_CHARS = 30_000
const MAX_AGENT_FILES = 64
const MAX_AGENT_BYTES = 64 * 1024
const MAX_TURNS_SETTING = 100
/** Subagents one session runs in the background at once. */
export const MAX_BACKGROUND_SUBAGENTS = 4
/** Lines of what a background subagent did that the background panel keeps. */
const PROGRESS_LINES = 40
const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'])
/** What other tools call their models. They name nothing here, so they leave the main agent's model in place. */
const FOREIGN_MODELS = new Set(['inherit', 'sonnet', 'opus', 'haiku', 'fable'])

export const SUBAGENT_PROMPT = `# You are a subagent

The main agent started you to do one self-contained piece of work. Your first message is its brief; your last message is your report, and the main agent reads nothing else of what you do, so it cannot see your tool calls.

- Do what the brief asks and nothing beyond it. Do not change files unless the brief says you may.
- You cannot talk to the user, except through AskUserQuestion, which you should use only when the brief cannot be carried out without their answer.
- Finish with a report and no tool call: what you found or changed, the absolute paths involved, and anything the main agent needs to go on. Be complete and brief; no preamble, no repeating the brief.
- If you could not finish, say what is missing and what you tried.`

const PLAN_PROMPT = `# Your work: plan, do not build

Read what you need, then return a plan the main agent can carry out without asking you anything.

- Open with the goal in one sentence and the approach you chose, with the reason and the alternatives you turned down in two or three lines.
- List the steps in order. For each: the files (absolute paths) and what changes in them, naming the functions, types and tests involved.
- Say what could go wrong, what to verify, and the commands that run the checks.
- If the brief leaves out something that changes the plan, say so instead of guessing.
- Never change a file.`

const REVIEW_PROMPT = `# Your work: review, do not fix

Judge what the brief gives you to review, and read the code around it where a finding depends on it.

- Report findings by severity: blocking (wrong or unsafe), should fix, minor. For each: the file and line, what is wrong, how it fails (the input and what happens), and the smallest fix.
- Report only what you checked and can show. No style notes to fill space, and nothing about code you did not read.
- Say which tests cover what you reviewed and which cases have none.
- End with a verdict: ready, or what must change first.
- Never change a file.`

const BUILTIN_EXTRAS: Record<string, { role?: ModelRole; prompt?: string }> = {
  Explore: { role: 'explore' },
  Plan: { role: 'planner', prompt: PLAN_PROMPT },
  Review: { role: 'reviewer', prompt: REVIEW_PROMPT },
}

export function builtinDefinitions(): SubagentDefinition[] {
  return BUILTIN_SUBAGENT_TYPES.map((type) => ({ ...type, source: 'builtin' as const, ...BUILTIN_EXTRAS[type.name] }))
}

export interface AgentSource {
  dir: string
  source: 'user' | 'workspace'
}

/** A front-matter list: `Read, Grep`, `[Read, Grep]` or quoted names. */
function listOf(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter(Boolean)
}

/** The agents defined in the folders; later folders override earlier ones, and none may reuse a built-in name. */
export function loadAgentDefinitions(sources: readonly AgentSource[]): SubagentDefinition[] {
  const builtin = new Set(BUILTIN_SUBAGENT_TYPES.map((type) => type.name))
  const found = new Map<string, SubagentDefinition>()
  for (const { dir, source } of sources) {
    // The workspace's folder is filled by the repository, so it must not lead out of the workspace.
    if (source === 'workspace' && !staysInProject(dir)) continue
    let names: string[]
    try {
      names = fs.readdirSync(dir).sort()
    } catch {
      continue
    }
    let read = 0
    for (const file of names) {
      if (!file.toLowerCase().endsWith('.md')) continue
      if (read++ >= MAX_AGENT_FILES) break
      const text = readSmallFile(path.join(dir, file), { maxBytes: MAX_AGENT_BYTES, followLinks: source !== 'workspace' })
      if (text === null) continue
      const { fields, body } = parseFrontMatter(text)
      const name = (fields.name || file.replace(/\.md$/i, '')).trim()
      const description = fields.description?.trim()
      if (!/^[A-Za-z][\w-]{0,40}$/.test(name) || builtin.has(name) || !description) continue
      const tools = listOf(fields.tools)
      const disallowed = listOf(fields.disallowedtools ?? fields['disallowed-tools'])
      const turns = Number.parseInt(fields.maxturns ?? fields['max-turns'] ?? '', 10)
      const requested = (fields.role ?? fields.model ?? '').trim()
      const role = requested && !FOREIGN_MODELS.has(requested.toLowerCase()) ? requested : ''
      const color = fields.color?.trim().toLowerCase()
      found.set(name, {
        name,
        description: description.slice(0, 300),
        ...(tools.length ? { tools } : {}),
        ...(disallowed.length ? { disallowedTools: disallowed } : {}),
        ...(role ? { role } : {}),
        ...(Number.isFinite(turns) && turns > 0 ? { maxTurns: Math.min(turns, MAX_TURNS_SETTING) } : {}),
        ...(color && COLORS.has(color) ? { color } : {}),
        ...(body.trim() ? { prompt: body.trim() } : {}),
        source,
        file: path.join(dir, file),
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Where a session keeps its subagents, so that one can go on later (SendMessage), also after a restart. */
export interface SubagentStore {
  /** The subagents stored, as their latest records have them. */
  list(): SubagentInfo[]
  save(info: SubagentInfo): void
  /** A conversation stored under the subagent's id, holding what was stored for it so far. */
  conversation(agentId: string): Conversation
}

/** A store that keeps nothing past the process: for a session without a log, and for tests. */
export function memorySubagentStore(): SubagentStore {
  const infos = new Map<string, SubagentInfo>()
  const conversations = new Map<string, MemoryConversation>()
  return {
    list: () => [...infos.values()].map((info) => ({ ...info })),
    save: (info) => {
      infos.set(info.id, { ...info })
    },
    conversation: (agentId) => {
      let conversation = conversations.get(agentId)
      if (!conversation) conversations.set(agentId, (conversation = memoryConversation()))
      return conversation
    },
  }
}

export interface SubagentPoolEvents {
  /** A subagent that worked in the background ended: the main agent hears how through a notice. */
  ended?(info: SubagentInfo, result: SubagentResult): void
  /** What the background panel shows changed: a subagent started, ended or did something. */
  changed?(): void
}

interface LiveAgent {
  controller: AbortController
  /** Messages SendMessage left for it, read between two of its steps; null once its run takes no more. */
  steers: string[] | null
  done: Promise<SubagentResult>
}

const newAgentId = (): string => `agent_${randomBytes(4).toString('hex')}`

/**
 * The subagents of one session: those it knows from its log, and those running now. It outlives the loops the session
 * builds, so a subagent in the background keeps going when a setting changes, and SendMessage finds it from any loop.
 */
export class SubagentPool {
  private readonly agents = new Map<string, SubagentInfo>()
  private readonly live = new Map<string, LiveAgent>()
  private readonly conversations = new Map<string, Conversation>()
  /** What each subagent last did, for the background panel. */
  private readonly lines = new Map<string, string[]>()
  /** What each one has read in this process, so that going on with SendMessage does not need it read again. */
  readonly trackers = new Map<string, FileStateTracker>()
  /** How a run stopped now ends. */
  private stopping: 'stopped' | 'interrupted' = 'stopped'

  constructor(
    private readonly store: SubagentStore,
    private readonly events: SubagentPoolEvents = {},
  ) {
    for (const info of store.list()) {
      // One that was running when eNCode closed was cut off; SendMessage takes it on from where it stopped.
      this.agents.set(info.id, info.status === 'running' ? { ...info, status: 'interrupted' } : { ...info })
    }
  }

  list(): SubagentInfo[] {
    return [...this.agents.values()].map((info) => ({ ...info }))
  }

  get(id: string): SubagentInfo | undefined {
    const info = this.agents.get(id)
    return info ? { ...info } : undefined
  }

  save(info: SubagentInfo): void {
    this.agents.set(info.id, { ...info })
    this.store.save({ ...info })
    this.events.changed?.()
  }

  conversation(id: string): Conversation {
    let conversation = this.conversations.get(id)
    if (!conversation) this.conversations.set(id, (conversation = this.store.conversation(id)))
    return conversation
  }

  /** How many run in the background now. */
  runningInBackground(): number {
    return [...this.live.keys()].filter((id) => this.agents.get(id)?.background).length
  }

  isRunning(id: string): boolean {
    return this.live.has(id)
  }

  /** What it did last, newest last. */
  progress(id: string): string {
    return (this.lines.get(id) ?? []).join('')
  }

  note(id: string, line: string): void {
    if (!line) return
    const lines = this.lines.get(id) ?? []
    lines.push(line)
    if (lines.length > PROGRESS_LINES) lines.splice(0, lines.length - PROGRESS_LINES)
    this.lines.set(id, lines)
    this.events.changed?.()
  }

  /** Leaves a message for a running subagent to read between two steps; false when none of its runs takes it now. */
  steer(id: string, text: string): boolean {
    const steers = this.live.get(id)?.steers
    if (!steers) return false
    steers.push(text)
    return true
  }

  /** Whether a message waits for it. */
  hasSteers(id: string): boolean {
    return Boolean(this.live.get(id)?.steers?.length)
  }

  /** The messages left for it, oldest first. */
  takeSteers(id: string): string[] {
    const steers = this.live.get(id)?.steers
    return steers ? steers.splice(0) : []
  }

  closeSteers(id: string): void {
    const live = this.live.get(id)
    if (live) live.steers = null
  }

  /** Waits for a run that is ending, so that a message for it starts the next one. */
  async settled(id: string): Promise<void> {
    await this.live.get(id)?.done.catch(() => undefined)
  }

  /**
   * Runs `work` as the subagent's run: it can be stopped (KillShell, closing the session) and counted, and its end is
   * stored. `outer` is the main agent's turn, for a subagent that runs while a call waits.
   */
  track(info: SubagentInfo, outer: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<SubagentResult>): Promise<SubagentResult> {
    const controller = new AbortController()
    const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal
    // In place before the work starts, so a message sent at once is read by this run.
    const live: LiveAgent = { controller, steers: [], done: Promise.resolve({ ok: false, report: '' }) }
    this.live.set(info.id, live)
    // The Jobs tab lists it as running from now, not from its first step.
    this.events.changed?.()
    live.done = (async (): Promise<SubagentResult> => {
      try {
        const result = await work(signal)
        this.finish(info, signal.aborted ? this.stopping : result.ok ? 'done' : 'failed', result)
        return result
      } catch (error) {
        const stopped = error instanceof AgentAbortedError || signal.aborted
        const result: SubagentResult = { ok: false, report: stopped ? 'The subagent was stopped before it finished.' : `The subagent failed: ${plainError(error)}`, agentId: info.id }
        this.finish(info, stopped ? this.stopping : 'failed', result)
        if (stopped && outer?.aborted) throw new AgentAbortedError()
        return result
      } finally {
        if (this.live.get(info.id) === live) this.live.delete(info.id)
        this.events.changed?.()
      }
    })()
    return live.done
  }

  private finish(info: SubagentInfo, status: SubagentInfo['status'], result: SubagentResult): void {
    const current = this.agents.get(info.id) ?? info
    // The report is kept only until the main agent has been told: one that waited for it already has it.
    const ended: SubagentInfo = { ...current, status, ok: result.ok, endedAt: Date.now(), ...(current.background ? { report: result.report.slice(0, MAX_REPORT_CHARS), told: false } : {}) }
    if (!current.background) delete ended.report
    this.save(ended)
    if (current.background && status !== 'interrupted') this.events.ended?.(ended, result)
  }

  /** Ended in the background, also before a restart, and the main agent has not been told. */
  untold(): SubagentInfo[] {
    return this.list().filter((info) => info.background && info.status !== 'running' && !info.told)
  }

  /** The main agent read how it ended: the report need not be kept any more. */
  told(id: string): void {
    const info = this.agents.get(id)
    if (!info || info.told || info.status === 'running') return
    const kept = { ...info, told: true }
    delete kept.report
    this.save(kept)
  }

  /** Stops a running subagent. Undefined when none has that id. */
  async stop(id: string): Promise<{ stopped: boolean; description: string } | undefined> {
    const info = this.agents.get(id)
    if (!info) return undefined
    const live = this.live.get(id)
    if (!live) return { stopped: false, description: info.description }
    live.controller.abort()
    await live.done.catch(() => undefined)
    return { stopped: true, description: info.description }
  }

  /**
   * Stops every running subagent and waits for them: the conversation is cut (`stopped`), or the session closes
   * (`interrupted`: SendMessage takes them on after a restart, and nobody is told they ended).
   */
  async stopAll(as: 'stopped' | 'interrupted' = 'stopped'): Promise<void> {
    const running = [...this.live.values()]
    this.stopping = as
    try {
      for (const live of running) live.controller.abort()
      await Promise.all(running.map((live) => live.done.catch(() => undefined)))
    } finally {
      this.stopping = 'stopped'
    }
  }

  /** Forgets subagents the log no longer has (after a rewind or a reset). */
  reload(): void {
    this.agents.clear()
    this.conversations.clear()
    this.lines.clear()
    this.trackers.clear()
    for (const info of this.store.list()) this.agents.set(info.id, info.status === 'running' ? { ...info, status: 'interrupted' } : { ...info })
    this.events.changed?.()
  }
}

export interface SubagentsOptions {
  definitions: () => readonly SubagentDefinition[]
  client: ModelClient
  registry: ToolRegistry
  system: SystemPart[]
  /** The main agent's instructions for a model that needs no guide (ADR 0094). */
  shortSystem?: SystemPart[]
  settings: () => AgentSettings
  hooks: AgentHooks
  /** The main agent's surface: approvals, questions, usage and file changes go through it. */
  parent: Surface
  /** The main agent's services; a subagent gets its own shell and a copy of what was read. */
  services: Omit<LoopServices, 'shell' | 'files' | 'subagents' | 'goals' | 'skills' | 'background' | 'worktrees'> & Pick<LoopServices, 'skills'>
  files: FileStateTracker
  /** A shell of the subagent's own, so working directories do not mix, starting where the main agent works. */
  createShell: () => (AgentShell & { dispose?(): Promise<void> }) | Promise<AgentShell & { dispose?(): Promise<void> }>
  approvedHosts: Set<string>
  assessor: ShellCommandAssessor
  rules?: RuleJudge
  extraRoots?: () => readonly string[]
  refresh?: () => Promise<void>
  readRoots?: () => readonly string[]
  preface?: () => Promise<string[]> | string[]
  /** The session's Reviewer: a subagent's commands are judged by it too. */
  reviewer?: AutoReviewer
  /** What the user asked, for the Reviewer: the session's, since a subagent's own prompt was written by a model. */
  requests?: () => readonly string[]
  /** The session's subagents. Default: a pool of its own that keeps them in memory. */
  pool?: SubagentPool
}

/** One line for what a tool call is about, for the progress shown on the Task card. */
export function describeCall(entry: ConversationEntry): string {
  const tool = entry.tool
  if (!tool) return ''
  const input = tool.input
  const subject = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'query', 'description', 'skill']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const text = subject ? `${tool.name} ${subject.replace(/\s+/g, ' ').slice(0, 100)}` : tool.name
  return `${tool.state === 'error' || tool.state === 'rejected' ? '✗' : '✓'} ${text}\n`
}

interface SurfaceRequest {
  /** The call that started this run (Task or SendMessage), whose card its questions and approvals show under. */
  toolUseId: string
  entryId?: string
  progress?: (text: string) => void
  /** It runs in the background: what it asks outlives the main agent's turn. */
  background: boolean
  /** Where what it does is noted for the background panel. */
  note: (line: string) => void
}

class SubagentSurface implements Surface {
  private counter = 0

  constructor(
    private readonly parent: Surface,
    private readonly request: SurfaceRequest,
  ) {}

  status(_status: AgentStatus): void {}

  entry(entry: NewEntry): ConversationEntry {
    return { ...entry, id: entry.id ?? `${this.request.toolUseId}:${++this.counter}`, createdAt: Date.now() }
  }

  update(): void {}

  settle(entry: ConversationEntry): void {
    if (entry.kind !== 'tool') return
    const line = describeCall(entry)
    this.request.progress?.(line)
    this.request.note(line)
  }

  delta(entry: ConversationEntry, text: string): void {
    entry.text = (entry.text ?? '') + text
  }

  usage(usage: Usage, model?: string): void {
    this.parent.usage(usage, model)
  }

  fileChanged(path: string): void {
    this.parent.fileChanged(path)
  }

  approve(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalResult> {
    return this.parent.approve(
      { ...prompt, entryId: this.request.entryId ?? prompt.entryId, title: `Subagent: ${prompt.title}`, ...(this.request.background ? { background: true } : {}) },
      signal,
    )
  }

  granted(grant: string): boolean {
    return this.parent.granted?.(grant) ?? false
  }

  ask(entryId: string, question: Parameters<Surface['ask']>[1], signal: AbortSignal): Promise<string> {
    return this.parent.ask(this.request.entryId ?? entryId, question, signal, this.request.background ? { background: true } : undefined)
  }

  async enterPlan(): Promise<{ approved: false; note: string }> {
    return { approved: false, note: 'A subagent cannot enter plan mode.' }
  }

  async proposePlan(): Promise<{ approved: false; feedback: string }> {
    return { approved: false, feedback: 'A subagent cannot propose plans.' }
  }

  setTodos(): void {}
}

/** A copy of what the main agent has read, so a subagent can edit those files without reading them again. */
export function cloneTracker(source: FileStateTracker): FileStateTracker {
  const copy = createFileStateTracker()
  // What the parent's Read showed is in the parent's conversation, not the subagent's.
  for (const [file, state] of source.entries()) copy.set(file, withoutSeen(state))
  return copy
}

function allowedTools(definition: SubagentDefinition, registry: ToolRegistry): string[] {
  const offered = registry.list().map((tool) => tool.definition.name)
  // Tool names are matched without regard to case: a definition that says "read" means Read.
  const named = (name: string) => offered.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  const wanted = definition.tools ? definition.tools.map(named).filter((name): name is string => name !== undefined) : offered
  const denied = new Set([...SUBAGENT_EXCLUDED, ...(definition.disallowedTools ?? []).map(named).filter((name): name is string => name !== undefined)])
  // ToolSearch helps only when some tool it loads is one this subagent may use.
  if (!registry.searchable().some((tool) => !denied.has(tool.definition.name) && wanted.includes(tool.definition.name))) denied.add(TOOL_SEARCH)
  return wanted.filter((name) => !denied.has(name))
}

/** Put before what the main agent sends a running subagent, so it knows who is speaking. */
const FROM_MAIN = 'The main agent sent this while you worked; take it into account before your next step:'

export function createSubagents(options: SubagentsOptions): Subagents {
  const pool = options.pool ?? new SubagentPool(memorySubagentStore())
  const find = (name: string) => options.definitions().find((item) => item.name === name)

  /** Runs the subagent's loop on its conversation once. */
  async function execute(
    definition: SubagentDefinition,
    info: SubagentInfo,
    call: { toolUseId: string; entryId?: string; progress?: (text: string) => void; turnId: string },
    signal: AbortSignal,
  ): Promise<SubagentResult> {
    const conversation = pool.conversation(info.id)
    const shell = await options.createShell()
    const own = { text: [SUBAGENT_PROMPT, definition.prompt].filter(Boolean).join('\n\n') }
    const system = [...options.system, own]
    let files = pool.trackers.get(info.id)
    if (!files) pool.trackers.set(info.id, (files = cloneTracker(options.files)))
    const loop = new AgentLoop({
      agentId: info.id,
      role: definition.role ?? 'main',
      client: options.client,
      registry: options.registry,
      tools: allowedTools(definition, options.registry),
      system,
      ...(options.shortSystem ? { shortSystem: [...options.shortSystem, own] } : {}),
      settings: options.settings,
      hooks: options.hooks,
      surface: new SubagentSurface(options.parent, {
        toolUseId: call.toolUseId,
        ...(call.entryId ? { entryId: call.entryId } : {}),
        ...(call.progress ? { progress: call.progress } : {}),
        background: info.background,
        note: (line) => pool.note(info.id, line),
      }),
      conversation,
      services: { ...options.services, shell, files },
      approvedHosts: options.approvedHosts,
      assessor: options.assessor,
      ...(options.rules ? { rules: options.rules } : {}),
      ...(options.extraRoots ? { extraRoots: options.extraRoots } : {}),
      ...(options.refresh ? { refresh: options.refresh } : {}),
      ...(options.readRoots ? { readRoots: options.readRoots } : {}),
      ...(options.preface ? { preface: options.preface } : {}),
      ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      ...(options.requests ? { requests: options.requests } : {}),
      steers: {
        waiting: () => pool.hasSteers(info.id),
        take: async () => {
          const texts = pool.takeSteers(info.id)
          return texts.length ? [textBlock(FROM_MAIN), ...texts.map((text) => textBlock(text))] : []
        },
        close: () => pool.closeSteers(info.id),
      },
      // A definition can shorten the run, never lengthen it past the person's own limit: a repository fills the workspace's folder.
      maxSteps: Math.min(definition.maxTurns ?? MAX_SUBAGENT_STEPS, options.settings().maxSteps, MAX_SUBAGENT_STEPS),
    })
    try {
      const end = await loop.run({ turnId: call.turnId, mode: info.mode, signal })
      const ok = (report: string): SubagentResult => ({ ok: true, report: report.slice(0, MAX_REPORT_CHARS), agentId: info.id })
      const failed = (report: string): SubagentResult => ({ ok: false, report, agentId: info.id })
      switch (end.kind) {
        case 'done':
          return ok(end.reply)
        case 'stopped':
          return ok(end.summary)
        case 'max-steps':
          return failed(`The subagent ran out of steps (${end.steps}) before it finished. Its last message was:\n${lastText(conversation.messages()) || '(none)'}`)
        case 'paused':
          return failed(`The subagent could not run: ${end.message}`)
        default:
          return failed(`The subagent failed: ${end.message}`)
      }
    } catch (error) {
      if (error instanceof AgentAbortedError || signal.aborted) throw new AgentAbortedError()
      return { ok: false, report: `The subagent failed: ${plainError(error)}`, agentId: info.id }
    } finally {
      await Promise.resolve(shell.dispose?.()).catch(() => undefined)
    }
  }

  /** The first message of a new subagent: what a SubagentStart hook adds, then the brief. */
  async function brief(definition: SubagentDefinition, info: SubagentInfo, prompt: string, turnId: string, signal: AbortSignal): Promise<void> {
    let context = ''
    try {
      const started = await options.hooks.subagentStart?.({ sessionId: options.services.sessionId, agentId: info.id, root: options.services.root, mode: info.mode, agentType: definition.name, signal })
      context = started?.context?.trim() ?? ''
    } catch (error) {
      const details = detailsOf(describeError(error))
      options.parent.settle(options.parent.entry({ kind: 'notice', text: 'The SubagentStart hook could not run.', ...(details ? { details } : {}) }))
    }
    if (signal.aborted) throw new AgentAbortedError()
    await pool.conversation(info.id).add(context ? { role: 'user', content: [textBlock(reminder(context)), textBlock(prompt)] } : userText(prompt), { turnId })
  }

  function unknownType(type: string): SubagentResult {
    const names = options.definitions().map((item) => item.name).join(', ')
    return { ok: false, report: `There is no subagent type "${type}". Available: ${names}.` }
  }

  function busy(): { ok: false; report: string } | undefined {
    if (pool.runningInBackground() < MAX_BACKGROUND_SUBAGENTS) return undefined
    return { ok: false, report: `${MAX_BACKGROUND_SUBAGENTS} subagents already work in the background. Wait for one to report, or stop one with KillShell.` }
  }

  function fresh(definition: SubagentDefinition, request: SubagentRequest, background: boolean): SubagentInfo {
    return { id: newAgentId(), type: definition.name, description: request.description.trim().slice(0, 120), status: 'running', background, mode: request.mode, startedAt: Date.now() }
  }

  return {
    types: () => options.definitions().map(({ name, description, tools }) => ({ name, description, ...(tools ? { tools } : {}) })),

    async run(request, signal) {
      const definition = find(request.type)
      if (!definition) return unknownType(request.type)
      const info = fresh(definition, request, false)
      const turnId = request.turnId ?? info.id
      pool.save(info)
      return pool.track(info, signal, async (inner) => {
        await brief(definition, info, request.prompt, turnId, inner)
        return execute(definition, info, { toolUseId: request.toolUseId, ...(request.entryId ? { entryId: request.entryId } : {}), ...(request.progress ? { progress: request.progress } : {}), turnId }, inner)
      })
    },

    async start(request) {
      const definition = find(request.type)
      if (!definition) return { ok: false, report: unknownType(request.type).report }
      const full = busy()
      if (full) return full
      const info = fresh(definition, request, true)
      const turnId = request.turnId ?? info.id
      pool.save(info)
      void pool
        .track(info, undefined, async (inner) => {
          await brief(definition, info, request.prompt, turnId, inner)
          return execute(definition, info, { toolUseId: request.toolUseId, ...(request.entryId ? { entryId: request.entryId } : {}), turnId }, inner)
        })
        .catch(() => undefined)
      return { ok: true, agentId: info.id }
    },

    async message(request: SubagentMessage, signal) {
      const info = pool.get(request.to)
      if (!info) {
        const known = pool.list().map((agent) => `${agent.id} (${agent.description})`)
        return { ok: false, report: `There is no subagent ${request.to}.${known.length ? ` Known: ${known.slice(-10).join(', ')}.` : ' Start one with Task.'}` }
      }
      if (pool.steer(info.id, request.text)) {
        return { ok: true, delivered: true, agentId: info.id, report: `Delivered to ${info.id}; it reads it before its next step.${info.background ? ' Its report reaches you as a notice when it ends.' : ''}` }
      }
      // A run that is just ending takes no more messages: this one starts the next run once it has ended, unless another
      // message started one meanwhile.
      await pool.settled(info.id)
      if (pool.steer(info.id, request.text)) {
        return { ok: true, delivered: true, agentId: info.id, report: `Delivered to ${info.id}; it reads it before its next step.` }
      }
      const definition = find(info.type)
      if (!definition) return { ok: false, agentId: info.id, report: `The subagent type ${info.type} is no longer defined, so ${info.id} cannot go on. Start a new subagent with Task.` }
      const conversation = pool.conversation(info.id)
      if (!conversation.messages().length) return { ok: false, agentId: info.id, report: `Nothing of ${info.id}'s work was kept, so it cannot go on. Start a new subagent with Task.` }
      if (request.background) {
        const full = busy()
        if (full) return { ...full, agentId: info.id }
      }
      const turnId = request.turnId ?? info.id
      const next: SubagentInfo = { ...(pool.get(info.id) ?? info), status: 'running', background: request.background, mode: request.mode, told: false }
      delete next.report
      delete next.endedAt
      delete next.ok
      pool.save(next)
      const run = (inner: AbortSignal) =>
        (async () => {
          await conversation.add(userText(request.text), { turnId })
          return execute(definition, next, { toolUseId: request.toolUseId, ...(request.entryId ? { entryId: request.entryId } : {}), ...(request.progress && !request.background ? { progress: request.progress } : {}), turnId }, inner)
        })()
      if (!request.background) return pool.track(next, signal, run)
      void pool.track(next, undefined, run).catch(() => undefined)
      return { ok: true, agentId: info.id, report: `${info.id} goes on in the background. Its report reaches you as a notice when it ends.` }
    },

    stop: (agentId) => pool.stop(agentId),
  }
}

function lastText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text' && Boolean((block as { text?: string }).text))
      .map((block) => block.text)
      .join('\n')
    if (text.trim()) return text.trim().slice(0, 4_000)
  }
  return ''
}
