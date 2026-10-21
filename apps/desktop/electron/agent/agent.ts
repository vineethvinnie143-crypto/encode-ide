import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type {
  AgentEventBody,
  AgentHistory,
  AgentMode,
  AgentStartInput,
  AgentStatus,
  ApprovalRequest,
  ConversationEntry,
  DiffHunk,
  ModelProfile,
  Settings,
} from '../../shared/types'
import type { SettingsService } from '../services/settings'
import { agentEnvironment, type ShellService } from '../services/shell'
import type { JobService } from '../services/jobs'
import type { SkillService } from '../services/skills'
import type { WorkspaceService } from '../services/workspace'
import { decideApproval, fetchHost, toolKind, type ApprovalDecision } from './approval'
import {
  applyCompaction,
  CHARS_PER_TOKEN,
  COMPACT_AT,
  type CompactionPlan,
  contextOverflow,
  DEFAULT_CONTEXT_WINDOW,
  digest,
  elideOldOutputs,
  estimateTokens,
  KEEP_SHARE,
  NOT_RUN,
  planCompaction,
  repairPairing,
  summaryRequest,
  textTokens,
} from './compaction'
import { buildSystemPrompt } from './prompt'
import { AgentAbortedError, chat, ProviderError, type ChatResult, type ChatUsage } from './provider'
import { applyEdit, buildDiff, executeTool, parseToolArguments, summarizeApproval, toolDefs } from './tools'
import type { ChatMessage, GoalAccess, ParsedToolCall, TodoAccess, ToolCallPayload } from './types'

export interface AgentDeps {
  settings: SettingsService
  workspace: WorkspaceService
  shell: ShellService
  goals: GoalAccess
  todos: TodoAccess
  jobs: JobService
  skills: SkillService
  plan: (plan: string | null) => void
  emit: (event: AgentEventBody) => void
  depth?: number
  /** Set for subagents: the agent that started this one through the `task` tool. */
  parent?: SubagentParent
  /** The model's context window in tokens, when a catalog knows it. */
  contextWindow?: (profile: ModelProfile) => number | undefined
}

/**
 * What a subagent borrows from its parent. The parent owns the conversation
 * the user sees, so approvals and questions go through it, and the subagent
 * stops when the parent does.
 */
export interface SubagentParent {
  signal: AbortSignal
  requestApproval(tool: string, input: Record<string, unknown>, reason?: string): Promise<boolean>
  ask(question: string, options?: string[]): Promise<string>
  /** The session's approved web sites, shared so the user is not asked twice. */
  approvedHosts: Set<string>
}

interface DemoStep {
  text: string
  tool: string
  args: Record<string, unknown>
}

const DEMO_SCRIPT: DemoStep[] = [
  {
    text: 'Let me look around the workspace first.',
    tool: 'glob',
    args: { path: '', depth: 2 },
  },
  {
    text: 'I will create a small note so you can see edits, diffs and the approval flow in action. Approve or reject it when prompted.',
    tool: 'write',
    args: {
      path: '.eNCode/demo-note.md',
      content:
        '# eNCode demo\n\nThis file was written by the offline demo agent.\n\n- Tools run locally against your real workspace.\n- Connect DeepSeek, OpenRouter (free models available) or any OpenAI-compatible endpoint in Settings.\n- Choose how much runs without asking from the approval-policy chip in the composer.\n',
    },
  },
  {
    text: 'Now let me read it back to confirm the write landed.',
    tool: 'read',
    args: { path: '.eNCode/demo-note.md' },
  },
  {
    text: 'That completes the offline demo.',
    tool: 'attempt_completion',
    args: {
      result:
        'Demo complete: listed the workspace, created `.eNCode/demo-note.md` through the approval flow, and read it back. Open Settings to connect a real model.',
    },
  },
]

const MAX_PREVIEW_HUNKS = 4

/** The tool definitions travel with every request. */
const TOOLS_TOKENS = textTokens(JSON.stringify(toolDefs))
/** A manual compaction keeps less verbatim than an automatic one. */
const MANUAL_KEEP_SHARE = 0.1
const MAX_SUMMARY_CHARS = 12_000

/** Context windows that providers' overflow errors revealed, by endpoint and model, for every session. */
const learnedWindows = new Map<string, number>()
const windowKey = (profile: ModelProfile) => `${profile.baseUrl.trim()}\n${profile.model}`

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function compactedNotice(count: number, byModel: boolean): string {
  const what = `Compacted ${count} earlier message${count === 1 ? '' : 's'}`
  return byModel
    ? `${what} into a summary to stay within the model's context.`
    : `${what} into an outline of the requests, files and commands, because the model could not write a summary.`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function streamChunks(text: string): string[] {
  const parts = text.match(/\S+\s*/g) ?? [text]
  const chunks: string[] = []
  for (let i = 0; i < parts.length; i += 3) chunks.push(parts.slice(i, i + 3).join(''))
  return chunks
}

function toolCallPayloads(calls: { id: string; name: string; arguments: string }[]): ToolCallPayload[] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  }))
}

export class Agent {
  private messages: ChatMessage[] = []
  private entries: ConversationEntry[] = []
  private status: AgentStatus = 'idle'
  private controller: AbortController | null = null
  private running = false
  private demoStep = 0
  private pendingApprovals = new Map<string, (approved: boolean) => void>()
  private pendingQuestions = new Map<string, (answer: string) => void>()
  /** The cards still waiting for an answer, so a session opened again later shows them again. */
  private pendingApprovalCards = new Map<string, ApprovalRequest>()
  private pendingQuestionCards = new Map<string, { id: string; entryId: string; question: string; options?: string[] }>()
  /** Sites the user let web_fetch reach in this session. Not persisted. */
  private readonly approvedHosts: Set<string>
  /** Provider tokens per estimated token, from the last response that reported usage. */
  private tokenRatio = 1

  constructor(private readonly deps: AgentDeps) {
    this.approvedHosts = deps.parent?.approvedHosts ?? new Set()
  }

  getHistory(): AgentHistory {
    return {
      entries: this.entries.map((entry) => structuredClone(entry)),
      status: this.status,
      approval: structuredClone([...this.pendingApprovalCards.values()][0] ?? null),
      ask: structuredClone([...this.pendingQuestionCards.values()][0] ?? null),
    }
  }

  async start(input: AgentStartInput): Promise<void> {
    if (this.running) throw new Error('eNCode Agent is already working. Stop it first.')
    const workspace = this.deps.workspace.current
    if (!workspace) throw new Error('Open a folder before using the agent.')
    if (!input.text.trim()) throw new Error('Type a request first.')

    this.running = true
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const parentSignal = this.deps.parent?.signal
    const stopWithParent = () => controller.abort()
    if (parentSignal?.aborted) controller.abort()
    parentSignal?.addEventListener('abort', stopWithParent, { once: true })

    try {
      const settings = this.deps.settings.raw()
      const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
      const isDemo = !profile || profile.kind === 'demo'
      if (!isDemo && !profile?.model) {
        throw new Error('The selected model profile has no model id. Open Settings and pick a model.')
      }

      const mode: AgentMode = input.mode === 'ask' || input.mode === 'plan' ? input.mode : 'code'
      let topLevel: string[] = []
      try {
        topLevel = (await this.deps.workspace.list('')).map((entry) => entry.name + (entry.isDir ? '/' : ''))
      } catch {
        topLevel = []
      }

      const systemPrompt = buildSystemPrompt({
        root: workspace.root,
        mode,
        topLevel,
        demo: isDemo,
        goal: this.deps.goals.get(),
        skills: this.deps.skills.list().slice(0, 20),
      })
      if (this.messages.length) this.messages[0] = { role: 'system', content: systemPrompt }
      else this.messages.push({ role: 'system', content: systemPrompt })

      if (!this.entries.length && isDemo) {
        this.addEntry({ kind: 'notice', text: 'Offline demo agent — no API key needed. Open Settings to connect a real model.' })
      }

      const attachmentBlock = (input.attachments ?? [])
        .filter((file) => file.content)
        .map((file) => `--- ${file.path} ---\n${file.content.slice(0, 20_000)}`)
        .join('\n\n')

      const userContent = attachmentBlock
        ? `${input.text}\n\n<attached_files>\n${attachmentBlock}\n</attached_files>`
        : input.text

      this.messages.push({ role: 'user', content: userContent })
      this.addEntry({ kind: 'user', text: input.text })
      this.demoStep = 0

      await this.runLoop({
        mode,
        isDemo,
        profile: isDemo ? null : (profile as ModelProfile),
        settings,
        signal,
      })
    } catch (error) {
      if (error instanceof AgentAbortedError || signal.aborted) {
        this.setStatus('idle')
        this.addEntry({ kind: 'notice', text: 'Stopped.' })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.addEntry({ kind: 'error', text: message })
        this.setStatus('error')
        this.send({ type: 'error', message })
      }
    } finally {
      parentSignal?.removeEventListener('abort', stopWithParent)
      this.running = false
      this.controller = null
      this.pendingApprovals.clear()
      this.pendingQuestions.clear()
      this.pendingApprovalCards.clear()
      this.pendingQuestionCards.clear()
    }
  }

  cancel(): void {
    this.controller?.abort()
  }

  reset(): void {
    this.controller?.abort()
    for (const [id, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(id)
      resolve(false)
    }
    for (const [id, resolve] of this.pendingQuestions) {
      this.pendingQuestions.delete(id)
      resolve('(cancelled)')
    }
    this.pendingApprovalCards.clear()
    this.pendingQuestionCards.clear()
    this.messages = []
    this.entries = []
    this.approvedHosts.clear()
    this.status = 'idle'
    this.running = false
    this.send({ type: 'session-reset' })
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const resolve = this.pendingApprovals.get(id)
    if (!resolve) return false
    this.pendingApprovals.delete(id)
    this.pendingApprovalCards.delete(id)
    resolve(approved)
    return true
  }

  resolveAnswer(id: string, answer: string): boolean {
    const resolve = this.pendingQuestions.get(id)
    if (!resolve) return false
    this.pendingQuestions.delete(id)
    this.pendingQuestionCards.delete(id)
    resolve(answer)
    return true
  }

  private async runLoop(args: {
    mode: AgentMode
    isDemo: boolean
    profile: ModelProfile | null
    settings: Pick<Settings, 'maxSteps'>
    signal: AbortSignal
  }): Promise<void> {
    const { mode, isDemo, profile, settings, signal } = args
    const maxSteps = Math.max(1, Math.min(100, settings.maxSteps || 30))

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new AgentAbortedError()

      this.setStatus('thinking')
      if (profile && !isDemo) await this.fitContext(profile, signal)
      const assistantEntry = this.addEntry({ kind: 'assistant', text: '', streaming: true })

      let result: ChatResult
      if (isDemo) {
        result = await this.demoTurn(step, (text) => this.appendDelta(assistantEntry, text))
      } else if (profile) {
        result = await this.request(profile, signal, (text) => this.appendDelta(assistantEntry, text))
      } else {
        throw new Error('No model profile is configured. Open Settings to add one.')
      }

      assistantEntry.streaming = false
      this.send({ type: 'entry', entry: structuredClone(assistantEntry) })
      if (result.usage) this.reportUsage(result.usage)

      const calls = result.toolCalls
      if (result.content.trim() || calls.length) {
        this.messages.push({
          role: 'assistant',
          content: result.content.trim() ? result.content : null,
          tool_calls: calls.length ? toolCallPayloads(calls) : undefined,
        })
      }

      if (!calls.length) {
        if (!result.content.trim()) {
          throw new Error('The model returned an empty response. Check the model id and provider settings.')
        }
        this.setStatus('done')
        this.send({ type: 'done', summary: '' })
        return
      }

      // Every call gets exactly one result, also when the loop ends early: strict providers refuse the next request otherwise.
      const answered = new Set<string>()
      const answer = (id: string, content: string) => {
        this.messages.push({ role: 'tool', tool_call_id: id, content })
        answered.add(id)
      }
      /** Set when the task ends with this step; reported once every call is answered. */
      let finished: string | null = null
      try {
        for (const rawCall of calls) {
          if (signal.aborted) throw new AgentAbortedError()

          const parsed = parseToolArguments(rawCall.arguments)
          const call: ParsedToolCall = { id: rawCall.id, name: rawCall.name, input: parsed.input }
          if (!call.name) continue

          if (parsed.error) {
            // Often a reply cut off by the output limit. Running with no arguments would only fail less clearly.
            this.addEntry({
              kind: 'tool',
              tool: { name: call.name, input: {}, state: 'error', ok: false, output: `Not run: ${parsed.error}.` },
            })
            answer(call.id, `Not run: ${parsed.error}. Call ${call.name} again with its arguments as one JSON object.`)
            continue
          }

          if (call.name === 'attempt_completion') {
            const summary = String(call.input.result ?? call.input.summary ?? '').trim() || 'Task complete.'
            answer(call.id, 'Reported to the user.')
            this.addEntry({ kind: 'assistant', text: summary })
            finished = summary
            break
          }

          const toolEntry = this.addEntry({
            kind: 'tool',
            tool: { name: call.name, input: call.input, state: 'running' },
          })

          const approval = await this.approvalFor(call, mode)
          if (approval.ask) {
            toolEntry.tool = { ...toolEntry.tool!, state: 'waiting' }
            this.send({ type: 'entry', entry: structuredClone(toolEntry) })
            this.setStatus('awaiting-approval')
            const approved = await this.requestApproval(toolEntry.id, call.name, call.input, approval.reason)
            if (!approved) {
              const stopped = signal.aborted
              toolEntry.tool = {
                ...toolEntry.tool!,
                state: 'rejected',
                output: stopped ? 'Stopped.' : 'Rejected by user.',
                ok: false,
              }
              this.send({ type: 'entry', entry: structuredClone(toolEntry) })
              if (stopped) throw new AgentAbortedError()
              answer(
                call.id,
                'The user rejected this action. Do not retry it unchanged. Ask what they would prefer or choose a different approach.',
              )
              continue
            }
            toolEntry.tool = { ...toolEntry.tool!, state: 'running' }
            this.send({ type: 'entry', entry: structuredClone(toolEntry) })
            if (toolKind(call.name) === 'web') {
              const host = fetchHost(call.input)
              if (host) this.approvedHosts.add(host)
            }
          }

          this.setStatus('running-tool')
          let toolResult
          try {
            if (call.name === 'task') {
              const prompt = String(call.input.prompt ?? '').trim()
              toolResult = prompt
                ? await this.runSubagent(prompt, mode, toolEntry.id, signal)
                : { ok: false, output: 'prompt is required' }
            } else {
              toolResult = await executeTool(call, {
                workspace: this.deps.workspace,
                settings: this.deps.settings,
                shell: this.deps.shell,
                goals: this.deps.goals,
                todos: this.deps.todos,
                jobs: this.deps.jobs,
                skills: this.deps.skills,
                proposePlan: (plan) => this.deps.plan(plan),
                mode,
                signal,
                ask: (question, options) => this.askUser(question, options, toolEntry.id),
              })
            }
          } catch (error) {
            if (signal.aborted) {
              toolEntry.tool = { ...toolEntry.tool!, state: 'rejected', output: 'Stopped.', ok: false }
              this.send({ type: 'entry', entry: structuredClone(toolEntry) })
              throw new AgentAbortedError()
            }
            toolResult = { ok: false, output: `Error: ${(error as Error).message}` }
          }

          toolEntry.tool = {
            ...toolEntry.tool!,
            output: toolResult.output,
            ok: toolResult.ok,
            diff: toolResult.diff,
            state: toolResult.ok ? 'done' : 'error',
          }
          this.send({ type: 'entry', entry: structuredClone(toolEntry) })
          if (toolResult.changedPath) this.send({ type: 'file-changed', path: toolResult.changedPath })

          answer(call.id, toolResult.output.slice(0, 40_000))

          if (toolResult.done) {
            finished = toolResult.summary ?? toolResult.output
            break
          }
        }
      } finally {
        for (const call of calls) {
          if (!answered.has(call.id)) this.messages.push({ role: 'tool', tool_call_id: call.id, content: NOT_RUN })
        }
      }
      if (finished !== null) {
        this.setStatus('done')
        this.send({ type: 'done', summary: finished })
        return
      }
    }

    this.setStatus('done')
    this.send({ type: 'done', summary: `Stopped after ${maxSteps} steps. Send a follow-up to continue.` })
  }

  private async demoTurn(step: number, onDelta: (text: string) => void): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> {
    const item = DEMO_SCRIPT[Math.min(step, DEMO_SCRIPT.length - 1)]
    const content = item.text
    for (const chunk of streamChunks(content)) {
      onDelta(chunk)
      await delay(14)
    }
    return {
      content,
      toolCalls: [{ id: `demo_${step}_${randomUUID().slice(0, 8)}`, name: item.tool, arguments: JSON.stringify(item.args) }],
    }
  }

  /** Asks the approval policy, reading the live policy so a change mid-run applies to the next call. */
  private async approvalFor(call: ParsedToolCall, mode: AgentMode): Promise<ApprovalDecision> {
    const root = this.deps.workspace.rootPath
    const rootReal = this.deps.workspace.rootRealPath
    const kind = toolKind(call.name)
    if (!root || !rootReal) return kind === 'other' ? { ask: false } : { ask: true, reason: 'No folder is open.' }
    try {
      return await decideApproval(call.name, call.input, {
        mode,
        policy: this.deps.settings.raw().policy,
        root,
        rootReal,
        env: agentEnvironment(),
        home: os.homedir(),
        approvedHosts: this.approvedHosts,
      })
    } catch (error) {
      return { ask: true, reason: `eNCode could not check this call (${(error as Error).message}).` }
    }
  }

  /** The diff a write or edit would produce, for the approval card. */
  private async previewChange(tool: string, input: Record<string, unknown>): Promise<DiffHunk[] | undefined> {
    const rel = String(input.path ?? '').trim()
    if (!rel) return undefined
    let previous = ''
    try {
      previous = (await this.deps.workspace.read(rel)).content
    } catch {
      previous = ''
    }
    let next: string
    if (tool === 'write' || tool === 'write_file') {
      next = typeof input.content === 'string' ? input.content : ''
    } else {
      const edit = applyEdit(previous, String(input.old_string ?? ''), String(input.new_string ?? ''))
      if (!edit.ok) return undefined
      next = edit.updated
    }
    try {
      return buildDiff(rel, previous, next)
    } catch {
      return undefined
    }
  }

  private async requestApproval(
    entryId: string,
    tool: string,
    input: Record<string, unknown>,
    reason?: string,
    source?: string,
  ): Promise<boolean> {
    if (this.deps.parent) return this.deps.parent.requestApproval(tool, input, reason)

    const summary = summarizeApproval(tool, input)
    const title = source ? `${source}: ${summary.title}` : summary.title
    let { detail } = summary

    // Show the exact change before asking for approval.
    let preview: DiffHunk[] | undefined
    if (toolKind(tool) === 'write') {
      const hunks = await this.previewChange(tool, input)
      if (hunks && hunks.length > MAX_PREVIEW_HUNKS) {
        detail += `\nShowing ${MAX_PREVIEW_HUNKS} of ${hunks.length} changed regions.`
      }
      preview = hunks?.slice(0, MAX_PREVIEW_HUNKS)
    }

    return new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const request: ApprovalRequest = { id, entryId, tool, title, detail, reason, input, preview }
      this.pendingApprovals.set(id, resolve)
      this.pendingApprovalCards.set(id, request)

      const onAbort = () => {
        this.pendingApprovalCards.delete(id)
        if (this.pendingApprovals.delete(id)) resolve(false)
      }
      this.controller?.signal.addEventListener('abort', onAbort, { once: true })
      this.send({ type: 'approval-request', request })
    })
  }

  private askUser(question: string, options: string[] | undefined, entryId: string): Promise<string> {
    if (this.deps.parent) return this.deps.parent.ask(question, options)
    return new Promise<string>((resolve) => {
      const id = randomUUID()
      this.pendingQuestions.set(id, resolve)
      this.pendingQuestionCards.set(id, { id, entryId, question, options })
      this.setStatus('awaiting-user')
      this.send({ type: 'ask', id, entryId, question, options })

      const onAbort = () => {
        this.pendingQuestionCards.delete(id)
        if (this.pendingQuestions.delete(id)) resolve('(cancelled)')
      }
      this.controller?.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private windowFor(profile: ModelProfile): number {
    return learnedWindows.get(windowKey(profile)) ?? this.deps.contextWindow?.(profile) ?? DEFAULT_CONTEXT_WINDOW
  }

  /** The prompt's size in the provider's tokens, as well as eNCode can tell. */
  private promptTokens(messages: readonly ChatMessage[]): number {
    return Math.ceil((estimateTokens(messages) + TOOLS_TOKENS) * this.tokenRatio)
  }

  /**
   * Makes the transcript valid and small enough for the next request: old
   * tool outputs are shortened first, and only if that is not enough are the
   * oldest whole units summarized. `force` compacts regardless of the
   * estimate, after the provider refused a prompt as too long.
   */
  private async fitContext(profile: ModelProfile, signal: AbortSignal, force = false): Promise<void> {
    let messages = repairPairing(this.messages)
    const window = this.windowFor(profile)
    const limit = Math.floor(window * COMPACT_AT)
    if (force || this.promptTokens(messages) > limit) {
      messages = elideOldOutputs(messages)
      if (force || this.promptTokens(messages) > limit) {
        const plan = planCompaction(messages, Math.floor((window * KEEP_SHARE) / this.tokenRatio), force)
        if (plan) {
          const summary = await this.summarize(plan, profile, signal, window)
          messages = repairPairing(applyCompaction(plan, summary.text))
          this.addEntry({ kind: 'notice', text: compactedNotice(plan.dropped.length, summary.byModel) })
        }
        // Still too long: the recent steps' outputs have to give way too.
        if (this.promptTokens(messages) > limit) messages = elideOldOutputs(messages, 0, 600)
      }
    }
    this.messages = messages
  }

  /** Sends the transcript. A prompt refused as too long is compacted to the window the provider names and sent once more. */
  private async request(profile: ModelProfile, signal: AbortSignal, onDelta: (text: string) => void): Promise<ChatResult> {
    const send = async () => {
      const sent = this.messages
      const result = await chat({
        profile,
        apiKey: this.deps.settings.keyFor(profile.id),
        messages: sent,
        tools: toolDefs,
        signal,
        temperature: 0.2,
        onDelta,
      })
      if (result.usage?.promptTokens) {
        this.tokenRatio = clamp(result.usage.promptTokens / (estimateTokens(sent) + TOOLS_TOKENS), 0.5, 3)
      }
      return result
    }
    try {
      return await send()
    } catch (error) {
      const overflow = error instanceof ProviderError ? contextOverflow(error.message) : null
      if (!overflow || signal.aborted) throw error
      const estimate = estimateTokens(this.messages) + TOOLS_TOKENS
      if (overflow.used) this.tokenRatio = clamp(overflow.used / estimate, 0.5, 3)
      learnedWindows.set(
        windowKey(profile),
        overflow.window ?? Math.floor(Math.min(this.windowFor(profile), estimate * this.tokenRatio) * 0.75),
      )
      await this.fitContext(profile, signal, true)
      return await send()
    }
  }

  /** A summary of what a plan drops, written by the model when it can be reached. */
  private async summarize(
    plan: CompactionPlan,
    profile: ModelProfile | null,
    signal: AbortSignal,
    window: number,
  ): Promise<{ text: string; byModel: boolean }> {
    if (profile) {
      try {
        // The transcript to summarize may take about half the window.
        const maxChars = Math.floor((window * 0.5 * CHARS_PER_TOKEN) / this.tokenRatio)
        const result = await chat({
          profile,
          apiKey: this.deps.settings.keyFor(profile.id),
          messages: summaryRequest(plan, maxChars),
          signal,
          temperature: 0,
        })
        if (result.usage) this.reportUsage(result.usage)
        const text = result.content.trim()
        if (text) return { text: text.slice(0, MAX_SUMMARY_CHARS), byModel: true }
      } catch (error) {
        if (error instanceof AgentAbortedError || signal.aborted) throw new AgentAbortedError()
      }
    }
    return { text: digest(plan.dropped), byModel: false }
  }

  /**
   * Summarizes older history at the user's request, keeping only the most
   * recent messages verbatim. Refuses while the agent is working; Stop cancels it.
   */
  async compact(): Promise<{ removed: number }> {
    if (this.running) throw new Error('eNCode Agent is working. Stop it before compacting.')
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    this.setStatus('thinking')
    try {
      const settings = this.deps.settings.raw()
      const active = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
      const profile = active && active.kind !== 'demo' && active.model ? (active as ModelProfile) : null
      const window = profile ? this.windowFor(profile) : DEFAULT_CONTEXT_WINDOW
      const messages = elideOldOutputs(repairPairing(this.messages))
      const plan = planCompaction(messages, Math.floor((window * MANUAL_KEEP_SHARE) / this.tokenRatio), true)
      if (!plan) {
        this.messages = messages
        return { removed: 0 }
      }
      let summary: { text: string; byModel: boolean }
      try {
        summary = await this.summarize(plan, profile, controller.signal, window)
      } catch (error) {
        if (error instanceof AgentAbortedError) throw new Error('Compaction was stopped. Nothing changed.')
        throw error
      }
      this.messages = repairPairing(applyCompaction(plan, summary.text))
      this.addEntry({ kind: 'notice', text: compactedNotice(plan.dropped.length, summary.byModel) })
      return { removed: plan.dropped.length }
    } finally {
      this.running = false
      this.controller = null
      this.setStatus('idle')
    }
  }

  private reportUsage(usage: ChatUsage): void {
    this.send({
      type: 'usage',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
    })
  }

  private appendDelta(entry: ConversationEntry, text: string): void {
    entry.text = (entry.text ?? '') + text
    this.send({ type: 'delta', entryId: entry.id, text })
  }

  private addEntry(partial: Omit<ConversationEntry, 'id' | 'createdAt'>): ConversationEntry {
    const entry: ConversationEntry = { id: randomUUID(), createdAt: Date.now(), ...partial }
    this.entries.push(entry)
    this.send({ type: 'entry', entry: structuredClone(entry) })
    return entry
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.send({ type: 'status', status })
  }

  /**
   * Runs a nested agent for the `task` tool and returns its final report. The
   * subagent works in the parent's mode under the same approval policy; its
   * approvals and questions appear on the parent's `task` card, and it stops
   * when the parent is stopped.
   */
  private async runSubagent(
    prompt: string,
    mode: AgentMode,
    entryId: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; output: string }> {
    if ((this.deps.depth ?? 0) >= 1) {
      return { ok: false, output: 'Nested subagents are not supported. Do the work directly.' }
    }
    let plan: string | null = null
    const child = new Agent({
      settings: this.deps.settings,
      workspace: this.deps.workspace,
      shell: this.deps.shell,
      goals: this.deps.goals,
      todos: { get: () => [], set: () => {} },
      jobs: this.deps.jobs,
      skills: this.deps.skills,
      plan: (proposed) => {
        plan = proposed
      },
      emit: () => {},
      contextWindow: this.deps.contextWindow,
      depth: (this.deps.depth ?? 0) + 1,
      parent: {
        signal,
        approvedHosts: this.approvedHosts,
        requestApproval: async (tool, input, reason) => {
          this.setStatus('awaiting-approval')
          try {
            return await this.requestApproval(entryId, tool, input, reason, 'Subagent')
          } finally {
            if (!signal.aborted) this.setStatus('running-tool')
          }
        },
        ask: async (question, options) => {
          try {
            return await this.askUser(question, options, entryId)
          } finally {
            if (!signal.aborted) this.setStatus('running-tool')
          }
        },
      },
    })

    await child.start({ text: prompt, mode })
    if (signal.aborted) throw new AgentAbortedError()

    const entries = child.getHistory().entries
    if (child.getStatus() === 'error') {
      const failure = [...entries].reverse().find((entry) => entry.kind === 'error')?.text ?? 'unknown error'
      return { ok: false, output: `Subagent failed: ${failure}` }
    }
    const summary = [...entries].reverse().find((entry) => entry.kind === 'assistant' && entry.text)?.text
    const report = [summary, plan && `Proposed plan:\n${plan}`].filter(Boolean).join('\n\n')
    return { ok: true, output: report ? `Subagent report:\n${report}` : 'Subagent finished without a summary.' }
  }

  private send(event: AgentEventBody): void {
    try {
      this.deps.emit(event)
    } catch {
      /* window is gone */
    }
  }

  /** Snapshot for session persistence. */
  snapshot(): { messages: ChatMessage[]; entries: ConversationEntry[] } {
    return {
      messages: this.messages.map((message) => structuredClone(message)),
      entries: this.entries.map((entry) => structuredClone(entry)),
    }
  }

  /** Restore a persisted conversation into this agent instance. */
  restore(snapshot: { messages?: ChatMessage[]; entries?: ConversationEntry[] }): void {
    // Sessions saved by earlier builds can hold calls without results.
    this.messages = repairPairing((snapshot.messages ?? []).map((message) => structuredClone(message)))
    this.entries = (snapshot.entries ?? []).map((entry) => structuredClone(entry))
    this.status = 'idle'
    this.running = false
  }

  getStatus(): AgentStatus {
    return this.status
  }

  isRunning(): boolean {
    return this.running
  }
}
