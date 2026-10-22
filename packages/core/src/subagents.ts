/**
 * Subagents: the Task tool's workers. A subagent runs the same loop as the
 * main agent on a conversation of its own, in memory, with a brief for its
 * first message and a report for its last. It cannot start subagents of its
 * own, set goals or plans, or keep a task list; its questions and approvals
 * go to the user through the main agent's surface, under the Task call.
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
import { userText, type ModelClient, type ModelRole, type SystemPart, type Usage } from '@encode/providers'
import {
  createFileStateTracker,
  BUILTIN_SUBAGENT_TYPES,
  type AgentShell,
  type FileStateTracker,
  type ShellCommandAssessor,
  type SubagentRequest,
  type Subagents,
  type SubagentType,
  type ToolRegistry,
} from '@encode/tools'
import type { RuleJudge } from './approval'
import { memoryConversation } from './conversation'
import type { AgentHooks } from './hooks'
import { AgentLoop, type LoopServices } from './loop'
import type { AutoReviewer } from './reviewer'
import { readSmallFile, staysInProject } from './safe-files'
import { parseFrontMatter } from './skills'
import { AgentAbortedError, type AgentSettings, type ApprovalPrompt, type ApprovalResult, type NewEntry, type Surface } from './types'
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
}

/**
 * What a subagent never gets: it must not start more agents, or touch what only the main agent owns. The Computer
 * tool is one of those: up to four subagents run side by side, and there is one mouse.
 */
export const SUBAGENT_EXCLUDED: readonly string[] = ['Task', 'ExitPlanMode', 'CreateGoal', 'UpdateGoal', 'GetGoal', 'TodoWrite', 'attempt_completion', 'Computer']

/** The most steps a subagent takes before it must report. */
const MAX_SUBAGENT_STEPS = 40
const MAX_REPORT_CHARS = 30_000
const MAX_AGENT_FILES = 64
const MAX_AGENT_BYTES = 64 * 1024
const MAX_TURNS_SETTING = 100
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
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface SubagentsOptions {
  definitions: () => readonly SubagentDefinition[]
  client: ModelClient
  registry: ToolRegistry
  system: SystemPart[]
  settings: () => AgentSettings
  hooks: AgentHooks
  /** The main agent's surface: approvals, questions, usage and file changes go through it. */
  parent: Surface
  /** The main agent's services; a subagent gets its own shell and a copy of what was read. */
  services: Omit<LoopServices, 'shell' | 'files' | 'subagents' | 'goals' | 'skills'> & Pick<LoopServices, 'skills'>
  files: FileStateTracker
  /** A shell of the subagent's own, so working directories do not mix. */
  createShell: () => AgentShell & { dispose?(): Promise<void> }
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
}

/** One line for what a tool call is about, for the progress shown on the Task card. */
export function describeCall(entry: ConversationEntry): string {
  const tool = entry.tool
  if (!tool) return ''
  const input = tool.input
  const subject = ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description', 'skill']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  const text = subject ? `${tool.name} ${subject.replace(/\s+/g, ' ').slice(0, 100)}` : tool.name
  return `${tool.state === 'error' || tool.state === 'rejected' ? '✗' : '✓'} ${text}\n`
}

class SubagentSurface implements Surface {
  private counter = 0

  constructor(
    private readonly parent: Surface,
    private readonly request: SubagentRequest,
  ) {}

  status(_status: AgentStatus): void {}

  entry(entry: NewEntry): ConversationEntry {
    return { ...entry, id: entry.id ?? `${this.request.toolUseId}:${++this.counter}`, createdAt: Date.now() }
  }

  update(): void {}

  settle(entry: ConversationEntry): void {
    if (entry.kind === 'tool' && this.request.progress) this.request.progress(describeCall(entry))
  }

  delta(entry: ConversationEntry, text: string): void {
    entry.text = (entry.text ?? '') + text
  }

  usage(usage: Usage): void {
    this.parent.usage(usage)
  }

  fileChanged(path: string): void {
    this.parent.fileChanged(path)
  }

  approve(prompt: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalResult> {
    return this.parent.approve({ ...prompt, entryId: this.request.entryId ?? prompt.entryId, title: `Subagent: ${prompt.title}` }, signal)
  }

  granted(grant: string): boolean {
    return this.parent.granted?.(grant) ?? false
  }

  ask(entryId: string, question: Parameters<Surface['ask']>[1], signal: AbortSignal): Promise<string> {
    return this.parent.ask(this.request.entryId ?? entryId, question, signal)
  }

  async proposePlan(): Promise<{ approved: false; feedback: string }> {
    return { approved: false, feedback: 'A subagent cannot propose plans.' }
  }

  setTodos(): void {}
}

/** A copy of what the main agent has read, so a subagent can edit those files without reading them again. */
export function cloneTracker(source: FileStateTracker): FileStateTracker {
  const copy = createFileStateTracker()
  for (const [file, state] of source.entries()) copy.set(file, { ...state })
  return copy
}

function allowedTools(definition: SubagentDefinition, registry: ToolRegistry): string[] {
  const offered = registry.list().map((tool) => tool.definition.name)
  // Tool names are matched without regard to case: a definition that says "read" means Read.
  const named = (name: string) => offered.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  const wanted = definition.tools ? definition.tools.map(named).filter((name): name is string => name !== undefined) : offered
  const denied = new Set([...SUBAGENT_EXCLUDED, ...(definition.disallowedTools ?? []).map(named).filter((name): name is string => name !== undefined)])
  return wanted.filter((name) => !denied.has(name))
}

export function createSubagents(options: SubagentsOptions): Subagents {
  let counter = 0
  return {
    types: () => options.definitions().map(({ name, description, tools }) => ({ name, description, ...(tools ? { tools } : {}) })),

    async run(request, signal) {
      const definition = options.definitions().find((item) => item.name === request.type)
      if (!definition) {
        const names = options.definitions().map((item) => item.name).join(', ')
        return { ok: false, report: `There is no subagent type "${request.type}". Available: ${names}.` }
      }

      const agentId = `sub_${++counter}_${request.toolUseId.slice(-6)}`
      const conversation = memoryConversation()
      await conversation.add(userText(request.prompt), { turnId: agentId })
      const shell = options.createShell()
      const system = [...options.system, { text: [SUBAGENT_PROMPT, definition.prompt].filter(Boolean).join('\n\n') }]
      const loop = new AgentLoop({
        agentId,
        role: definition.role ?? 'main',
        client: options.client,
        registry: options.registry,
        tools: allowedTools(definition, options.registry),
        system,
        settings: options.settings,
        hooks: options.hooks,
        surface: new SubagentSurface(options.parent, request),
        conversation,
        services: { ...options.services, shell, files: cloneTracker(options.files) },
        approvedHosts: options.approvedHosts,
        assessor: options.assessor,
        ...(options.rules ? { rules: options.rules } : {}),
        ...(options.extraRoots ? { extraRoots: options.extraRoots } : {}),
        ...(options.refresh ? { refresh: options.refresh } : {}),
        ...(options.readRoots ? { readRoots: options.readRoots } : {}),
        ...(options.preface ? { preface: options.preface } : {}),
        ...(options.reviewer ? { reviewer: options.reviewer } : {}),
        ...(options.requests ? { requests: options.requests } : {}),
        // A definition can shorten the run, never lengthen it past the person's own limit: a repository fills the workspace's folder.
        maxSteps: Math.min(definition.maxTurns ?? MAX_SUBAGENT_STEPS, options.settings().maxSteps, MAX_SUBAGENT_STEPS),
      })
      try {
        const end = await loop.run({ turnId: agentId, mode: request.mode, signal })
        switch (end.kind) {
          case 'done':
            return { ok: true, report: end.reply.slice(0, MAX_REPORT_CHARS) }
          case 'stopped':
            return { ok: true, report: end.summary.slice(0, MAX_REPORT_CHARS) }
          case 'max-steps':
            return { ok: false, report: `The subagent ran out of steps (${end.steps}) before it finished. Its last message was:\n${lastText(conversation.messages()) || '(none)'}` }
          case 'paused':
            return { ok: false, report: `The subagent could not run: ${end.message}` }
          case 'failed':
            return { ok: false, report: `The subagent failed: ${end.message}` }
        }
      } catch (error) {
        if (error instanceof AgentAbortedError || signal.aborted) throw new AgentAbortedError()
        return { ok: false, report: `The subagent failed: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        await Promise.resolve(shell.dispose?.()).catch(() => undefined)
      }
    },
  }
}

function lastText(messages: readonly { role: string; content: readonly unknown[] }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const text = (message.content as { type: string; text?: string }[])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n')
    if (text.trim()) return text.trim().slice(0, 4_000)
  }
  return ''
}
