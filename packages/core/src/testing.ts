/**
 * Helpers for testing the loop, the session and the host: a surface that
 * records what it is shown, stand-ins for the shell and background jobs, and
 * a harness that runs a scripted model against real tools in a temporary
 * workspace.
 */
import os from 'node:os'
import type { Usage } from '@encode/providers'
import { userText } from '@encode/providers'
import {
  ComputerState,
  createToolRegistry,
  createFileStateTracker,
  DEFAULT_DESKTOP_OPTIONS,
  type AgentShell,
  type DesktopBackend,
  type DesktopOptions,
  type DesktopServices,
  type JobManager,
  type ManagedShell,
  type PlanVerdict,
  type Question,
  type Tool,
  type TodoInput,
  type WebAccess,
} from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { createDefaultAssessor } from './approval'
import type { AutoReviewer } from './reviewer'
import { createSkills } from './skills'
import { AgentHost, type HostOptions } from './host'
import { AgentSession, type SessionEnv } from './session'
import { createSessionStore, type FileSessionStore } from './session-store'
import { memoryConversation, type MemoryConversation } from './conversation'
import type { AgentHooks } from './hooks'
import { AgentLoop, type LoopServices } from './loop'
import { systemParts } from './prompt'
import { createScriptedClient, type Script, type ScriptedClient, type ScriptedOptions } from './scripted'
import { DEFAULT_SETTINGS, type AgentSettings, type ApprovalPrompt, type ApprovalResult, type NewEntry, type Surface, type TurnEnd } from './types'
import type { AgentEvent, AgentStatus, BackgroundJob, ConversationEntry } from './ui'

export class RecordingSurface implements Surface {
  readonly statuses: AgentStatus[] = []
  /** Every entry created, live: later changes show in them. */
  readonly entries: ConversationEntry[] = []
  /** Entries as they were when they settled. */
  readonly settled: ConversationEntry[] = []
  readonly approvals: ApprovalPrompt[] = []
  readonly questions: Question[] = []
  readonly usages: Usage[] = []
  readonly changes: string[] = []
  readonly plans: string[] = []
  todos: TodoInput[] = []
  /** How the test answers an approval request. */
  decide: (prompt: ApprovalPrompt, signal: AbortSignal) => boolean | ApprovalResult | Promise<boolean | ApprovalResult> = () => true
  answer: (question: Question) => string = (question) => question.options[0]?.label ?? ''
  verdict: PlanVerdict = { approved: true }
  private counter = 0

  status(status: AgentStatus): void {
    this.statuses.push(status)
  }

  entry(entry: NewEntry): ConversationEntry {
    const created: ConversationEntry = { id: `e${++this.counter}`, createdAt: 0, ...entry }
    this.entries.push(created)
    return created
  }

  update(): void {}

  settle(entry: ConversationEntry): void {
    this.settled.push(structuredClone(entry))
  }

  delta(entry: ConversationEntry, text: string): void {
    entry.text = (entry.text ?? '') + text
  }

  usage(usage: Usage): void {
    this.usages.push(usage)
  }

  fileChanged(path: string): void {
    this.changes.push(path)
  }

  async approve(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalResult> {
    this.approvals.push(prompt)
    const answer = await this.decide(prompt, signal)
    return typeof answer === 'boolean' ? { approved: answer } : answer
  }

  async ask(_entryId: string, question: Question): Promise<string> {
    this.questions.push(question)
    return this.answer(question)
  }

  async proposePlan(_entryId: string, plan: string): Promise<PlanVerdict> {
    this.plans.push(plan)
    return this.verdict
  }

  setTodos(todos: TodoInput[]): void {
    this.todos = todos
  }

  /** The settled tool entries, as name, state and output. */
  tools(): { name: string; state?: string; output?: string }[] {
    return this.settled.filter((entry) => entry.kind === 'tool').map((entry) => ({ name: entry.tool!.name, state: entry.tool!.state, output: entry.tool!.output }))
  }

  notices(): string[] {
    return this.settled.filter((entry) => entry.kind === 'notice').map((entry) => entry.text ?? '')
  }
}

export function stubShell(root: string): AgentShell {
  return {
    dialect: 'bash',
    program: '/bin/sh',
    state: () => ({ cwd: root, env: { PATH: process.env.PATH ?? '' }, dialect: 'bash' }),
    run: async () => {
      throw new Error('This test has no shell.')
    },
  }
}

/** A shell that records the lines it is asked to run and answers each with `output`. */
export function recordingShell(root: string, ran: string[], output = 'ok'): AgentShell {
  return {
    ...stubShell(root),
    run: async (command) => {
      ran.push(command)
      return { output, exitCode: 0, timedOut: false, interrupted: false, cwd: root }
    },
  }
}

export const stubJobs: JobManager = {
  start: async () => {
    throw new Error('This test has no background jobs.')
  },
  read: () => undefined,
  kill: async () => false,
  list: () => [],
}

export const stubWeb: WebAccess = {
  fetch: async () => {
    throw new Error('This test has no web.')
  },
  search: async () => {
    throw new Error('This test has no web.')
  },
}

/** What a session hands the Computer tool, over a backend a test controls (the pointer jumps instead of gliding). */
export function desktopServices(backend: DesktopBackend, options: Partial<DesktopOptions> = {}): DesktopServices {
  return { backend, state: new ComputerState(), options: { ...DEFAULT_DESKTOP_OPTIONS, pace: 'instant', ...options } }
}

export interface Harness {
  root: string
  surface: RecordingSurface
  conversation: MemoryConversation
  client: ScriptedClient
  loop: AgentLoop
  settings: AgentSettings
  approvedHosts: Set<string>
  approvedApps: Set<string>
  /** Adds a user prompt and runs the loop on it. */
  run(prompt: string, mode?: 'code' | 'ask' | 'plan', signal?: AbortSignal): Promise<TurnEnd>
}

export interface HarnessOptions {
  script?: Script
  /** For a script that names paths in the workspace, which does not exist until the harness makes it. */
  scriptFor?: (root: string) => Script
  files?: Record<string, string | Buffer>
  settings?: Partial<AgentSettings>
  hooks?: AgentHooks
  extraTools?: Tool[]
  completion?: boolean
  client?: ScriptedOptions
  shell?: (root: string) => AgentShell
  services?: Partial<LoopServices>
  tools?: readonly string[]
  maxSteps?: number
  preface?: () => string[]
  /** Answers the commands the assessor cannot prove read-only, under Auto review. */
  reviewer?: AutoReviewer
  requests?: () => readonly string[]
}

export async function loopHarness(options: HarnessOptions): Promise<Harness> {
  const root = await tempWorkspace(options.files ?? {})
  const surface = new RecordingSurface()
  const conversation = memoryConversation()
  const client = createScriptedClient(options.scriptFor ? options.scriptFor(root) : (options.script ?? []), options.client)
  const registry = createToolRegistry(
    { dialect: 'bash', platform: process.platform, web: false, completion: options.completion, computer: Boolean(options.services?.desktop) },
    options.extraTools ?? [],
  )
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, ...options.settings }
  const approvedHosts = new Set<string>()
  const approvedApps = new Set<string>()
  const loop = new AgentLoop({
    agentId: 'main',
    role: 'main',
    client,
    registry,
    system: systemParts(),
    settings: () => settings,
    hooks: options.hooks ?? {},
    surface,
    conversation,
    approvedHosts,
    approvedApps,
    assessor: createDefaultAssessor(),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.preface ? { preface: options.preface } : {}),
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
    ...(options.requests ? { requests: options.requests } : {}),
    services: {
      root,
      home: os.homedir(),
      platform: process.platform,
      sessionId: 'test-session',
      files: createFileStateTracker(),
      shell: options.shell ? options.shell(root) : stubShell(root),
      jobs: stubJobs,
      web: stubWeb,
      ...options.services,
    },
  })
  let turns = 0
  return {
    root,
    surface,
    conversation,
    client,
    loop,
    settings,
    approvedHosts,
    approvedApps,
    async run(prompt, mode = 'code', signal = new AbortController().signal) {
      const turnId = `turn${++turns}`
      await conversation.add(userText(prompt), { turnId })
      return loop.run({ turnId, mode, signal })
    },
  }
}

export function stubManagedShell(root: string): ManagedShell {
  return {
    ...stubShell(root),
    removedEnv: [],
    start: async () => {
      throw new Error('This test has no shell.')
    },
    setCwd: async () => false,
    dispose: async () => undefined,
  }
}

export interface SessionHarnessOptions {
  script?: Script
  scriptFor?: (root: string) => Script
  files?: Record<string, string | Buffer>
  settings?: Partial<AgentSettings>
  hooks?: AgentHooks
  client?: ScriptedOptions
  /** Files in the user's home folder, such as .encode/ENCODE.md. */
  homeFiles?: Record<string, string>
  createShell?: (root: string) => ManagedShell
  env?: Partial<SessionEnv>
}

export interface SessionHarness {
  root: string
  home: string
  dir: string
  store: FileSessionStore
  events: AgentEvent[]
  client: ScriptedClient
  env: SessionEnv
  session: AgentSession
  settings: AgentSettings
  /** Closes the session and opens it again from its log, as after a restart. */
  reopen(): Promise<AgentSession>
  /** The events of one type. */
  of<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[]
}

const openHarnesses: SessionHarness[] = []
const openHosts: AgentHost[] = []

/** Closes every session, store and host the harnesses made; call it from a test file's `after`. */
export async function closeHarnesses(): Promise<void> {
  for (const harness of openHarnesses.splice(0)) {
    await harness.session.dispose().catch(() => undefined)
    await harness.store.dispose().catch(() => undefined)
  }
  for (const host of openHosts.splice(0)) await host.dispose().catch(() => undefined)
}

/** A session on a scripted model, in a temporary workspace and store. */
export async function sessionHarness(options: SessionHarnessOptions = {}): Promise<SessionHarness> {
  const root = await tempWorkspace(options.files ?? {})
  const home = await tempWorkspace(options.homeFiles ?? {})
  const dir = await tempWorkspace()
  const store = createSessionStore({ dir, indexDelayMs: 0 })
  const events: AgentEvent[] = []
  const client = createScriptedClient(options.scriptFor ? options.scriptFor(root) : (options.script ?? []), options.client)
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, ...options.settings }
  const env: SessionEnv = {
    root,
    home,
    platform: process.platform,
    client,
    settings: () => settings,
    hooks: options.hooks ?? {},
    assessor: createDefaultAssessor(),
    web: stubWeb,
    createShell: () => (options.createShell ?? stubManagedShell)(root),
    skills: createSkills(() => []),
    emit: (event) => events.push(event),
    // The scripted model answers every request, so a naming call or a review would only change what the tests count.
    nameSessions: false,
    autoReview: false,
    ...options.env,
  }
  const log = await store.create({ root })
  const harness: SessionHarness = {
    root,
    home,
    dir,
    store,
    events,
    client,
    env,
    settings,
    session: new AgentSession(log, env),
    async reopen() {
      const id = harness.session.id
      await harness.session.dispose()
      const reopened = await store.open(id)
      if (!reopened) throw new Error('The session log is gone.')
      harness.session = new AgentSession(reopened, env)
      return harness.session
    },
    of: (type) => events.filter((event): event is Extract<AgentEvent, { type: typeof type }> => event.type === type),
  }
  openHarnesses.push(harness)
  return harness
}

export interface HostHarnessOptions {
  script?: Script
  scriptFor?: (root: string) => Script
  files?: Record<string, string | Buffer>
  settings?: Partial<AgentSettings>
  client?: ScriptedOptions
  /** No folder is open. */
  noWorkspace?: boolean
  homeFiles?: Record<string, string>
  host?: Partial<HostOptions>
}

export interface HostHarness {
  host: AgentHost
  /** The open folder, or '' when there is none. */
  root: string
  home: string
  dir: string
  events: AgentEvent[]
  /** What the host reported each time the background jobs changed. */
  jobReports: BackgroundJob[][]
  client: ScriptedClient
  settings: AgentSettings
  of<T extends AgentEvent['type']>(type: T, sessionId?: string): Extract<AgentEvent, { type: T }>[]
}

/** A host on a scripted model, in a temporary workspace, home and log folder. */
export async function hostHarness(options: HostHarnessOptions = {}): Promise<HostHarness> {
  const root = options.noWorkspace ? '' : await tempWorkspace(options.files ?? {})
  const home = await tempWorkspace(options.homeFiles ?? {})
  const dir = await tempWorkspace()
  const events: AgentEvent[] = []
  const jobReports: BackgroundJob[][] = []
  const client = createScriptedClient(options.scriptFor ? options.scriptFor(root) : (options.script ?? []), options.client)
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, ...options.settings }
  const host = new AgentHost({
    dir,
    client,
    settings: () => settings,
    emit: (event) => events.push(event),
    onJobs: (jobs) => jobReports.push(jobs),
    workspace: root || null,
    home,
    web: stubWeb,
    createShell: stubManagedShell,
    goalDelayMs: 0,
    nameSessions: false,
    ...options.host,
  })
  openHosts.push(host)
  return {
    host,
    root,
    home,
    dir,
    events,
    jobReports,
    client,
    settings,
    of: (type, sessionId) => events.filter((event): event is Extract<AgentEvent, { type: typeof type }> => event.type === type && (!sessionId || event.sessionId === sessionId)),
  }
}
