/**
 * Helpers for testing the loop, the session and the host: a surface that
 * records what it is shown, stand-ins for the shell and background jobs, and
 * a harness that runs a scripted model against real tools in a temporary
 * workspace.
 */
import os from 'node:os'
import type { Usage } from '@encode/providers'
import { userText } from '@encode/providers'
import { createToolRegistry, createFileStateTracker, type AgentShell, type JobManager, type PlanVerdict, type Question, type Tool, type TodoInput, type WebAccess } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { createDefaultAssessor } from './approval'
import { memoryConversation, type MemoryConversation } from './conversation'
import type { AgentHooks } from './hooks'
import { AgentLoop, type LoopServices } from './loop'
import { systemParts } from './prompt'
import { createScriptedClient, type Script, type ScriptedClient, type ScriptedOptions } from './scripted'
import { DEFAULT_SETTINGS, type AgentSettings, type ApprovalPrompt, type NewEntry, type Surface, type TurnEnd } from './types'
import type { AgentStatus, ConversationEntry } from './ui'

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
  decide: (prompt: ApprovalPrompt, signal: AbortSignal) => boolean | Promise<boolean> = () => true
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

  async approve(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean> {
    this.approvals.push(prompt)
    return this.decide(prompt, signal)
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

export interface Harness {
  root: string
  surface: RecordingSurface
  conversation: MemoryConversation
  client: ScriptedClient
  loop: AgentLoop
  settings: AgentSettings
  approvedHosts: Set<string>
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
}

export async function loopHarness(options: HarnessOptions): Promise<Harness> {
  const root = await tempWorkspace(options.files ?? {})
  const surface = new RecordingSurface()
  const conversation = memoryConversation()
  const client = createScriptedClient(options.scriptFor ? options.scriptFor(root) : (options.script ?? []), options.client)
  const registry = createToolRegistry({ dialect: 'bash', platform: process.platform, web: false, completion: options.completion }, options.extraTools ?? [])
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, ...options.settings }
  const approvedHosts = new Set<string>()
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
    assessor: createDefaultAssessor(),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.preface ? { preface: options.preface } : {}),
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
    async run(prompt, mode = 'code', signal = new AbortController().signal) {
      const turnId = `turn${++turns}`
      await conversation.add(userText(prompt), { turnId })
      return loop.run({ turnId, mode, signal })
    },
  }
}
