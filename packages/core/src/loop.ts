/**
 * The agent loop: ask the model, run the tools it calls, feed the results
 * back, until it answers without a call or a tool ends the turn.
 *
 * The same loop runs a session's main agent and its subagents; they differ in
 * the Surface (what is shown and asked), the Conversation (what is stored)
 * and the tools they may use.
 *
 * Invariants:
 *  - Every tool call is answered exactly once, also when the run ends early,
 *    so the next request is always valid.
 *  - History is only ever appended to; the one rewrite is compaction, which
 *    drops thinking after the first changed message.
 *  - Calls that only read run together; everything else runs in order.
 */
import path from 'node:path'
import {
  isEmptyReply,
  messageText,
  textBlock,
  toolUses,
  userText,
  type AssistantMessage,
  type ClientEvent,
  type FinishReason,
  type Message,
  type ModelClient,
  type ModelRequest,
  type ModelRole,
  type SystemPart,
  type ToolDefinition,
  type ToolResultBlock,
  type ToolResultContent,
  type ToolUseBlock,
  type UserBlock,
} from '@encode/providers'
import {
  truncateMiddle,
  type AgentShell,
  type DesktopServices,
  type DiffHunk,
  type FileStateTracker,
  type Goals,
  type JobManager,
  type ShellCommandAssessor,
  type Skills,
  type Subagents,
  type Tool,
  type ToolAccess,
  type ToolContext,
  type ToolOutcome,
  type ToolRegistry,
  type WebAccess,
} from '@encode/tools'
import { alwaysAllowFor, decideApproval, grantKey, hostOf, type ApprovalDecision, type RuleJudge } from './approval'
import {
  applyCompaction,
  CHARS_PER_TOKEN,
  clamp,
  COMPACT_AT,
  ContextMeter,
  digest,
  dropThinkingFrom,
  elideOldOutputs,
  KEEP_SHARE,
  MANUAL_KEEP_SHARE,
  MAX_SUMMARY_CHARS,
  NOT_RUN,
  planCompaction,
  repairPairing,
  summaryRequest,
  textTokens,
  type CompactionPlan,
} from './compaction'
import type { AgentHooks, HookEvent } from './hooks'
import { CONTINUE_AFTER_LENGTH, reminder } from './prompt'
import { withoutScreensFrom } from './screens'
import { AgentAbortedError, type AgentSettings, type AlwaysAllow, type Conversation, type LoopEnd, type Surface, type Turn } from './types'
import type { ConversationEntry } from './ui'

/** What a call may ask of the model for its answer. */
const MAX_OUTPUT_TOKENS = 32_000
/** Room left for the answer when judging whether the prompt fits, and the most of a window it may take. */
const OUTPUT_RESERVE = 16_000
const OUTPUT_RESERVE_SHARE = 0.25
const MAX_PARALLEL_READS = 8
const MAX_PARALLEL_SUBAGENTS = 4
const MAX_LENGTH_RETRIES = 3
const MAX_EMPTY_RETRIES = 2
const MAX_STOP_ROUNDS = 3
const MAX_OVERFLOW_RETRIES = 2
const MAX_MODEL_RESULT_CHARS = 60_000
const MAX_UI_OUTPUT = 20_000
const MAX_UI_STRING = 8_000
const MAX_PREVIEW_HUNKS = 4
const REJECTED = 'The user rejected this action. Do not retry it unchanged. Ask what they would prefer or choose a different approach.'

export interface LoopServices {
  root: string
  home: string
  platform: NodeJS.Platform
  sessionId: string
  files: FileStateTracker
  shell: AgentShell
  jobs: JobManager
  web: WebAccess
  skills?: Skills
  goals?: Goals
  subagents?: Subagents
  /** The desktop the Computer tool works on; absent when the session has none. */
  desktop?: DesktopServices
  beforeWrite?: ToolContext['beforeWrite']
  summarize?: ToolContext['summarize']
}

export interface LoopOptions {
  /** 'main', or the subagent's id. */
  agentId: string
  role: ModelRole
  client: ModelClient
  registry: ToolRegistry
  /** Names of the tools this agent may use; all of the registry's when absent. */
  tools?: readonly string[]
  system: SystemPart[]
  settings: () => AgentSettings
  hooks: AgentHooks
  surface: Surface
  conversation: Conversation
  services: LoopServices
  /** Sites the user already let the agent contact; shared between a session's agents. */
  approvedHosts: Set<string>
  /** Applications the user already let the agent use, by program name; shared like the sites. */
  approvedApps?: Set<string>
  assessor: ShellCommandAssessor
  /** The user's rules for reads, edits, sites and outside tools; shell lines are judged by the assessor. */
  rules?: RuleJudge
  /** Folders outside the workspace the user counts as part of it. */
  extraRoots?: () => readonly string[]
  /** Brings the rules and the trust the assessor holds up to date with their files; awaited before each call is judged. */
  refresh?: () => Promise<void>
  /** Directories read without asking, besides the workspace. */
  readRoots?: () => readonly string[]
  /** Text that must survive a compaction, such as the project's memory files. */
  preface?: () => Promise<string[]> | string[]
  /** Steps per turn, in place of the setting. */
  maxSteps?: number
}

interface Prepared {
  block: ToolUseBlock
  tool: Tool
  input: Record<string, unknown>
  entry: ConversationEntry
  parallel: boolean
}

interface StepState {
  results: Map<string, ToolResultBlock>
  /** Reminders hooks added while the step ran. */
  context: string[]
  stop?: string
  mode?: Turn['mode']
}

interface FitOptions {
  force?: boolean
  manual?: boolean
  window?: number
  instructions?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trimInput(input: Record<string, unknown>): Record<string, unknown> {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX_UI_STRING) {
      out[key] = `${value.slice(0, MAX_UI_STRING)}… [${value.length - MAX_UI_STRING} more characters]`
      changed = true
    } else out[key] = value
  }
  return changed ? out : input
}

function textOf(content: readonly ToolResultContent[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
}

/** What the model reads of an outcome: never empty, never huge. */
function modelContent(outcome: ToolOutcome): ToolResultContent[] {
  const parts = typeof outcome.content === 'string' ? [textBlock(outcome.content)] : outcome.content
  const kept = parts
    .filter((part) => part.type === 'image' || part.text.length > 0)
    .map((part) => (part.type === 'text' && part.text.length > MAX_MODEL_RESULT_CHARS ? textBlock(truncateMiddle(part.text, MAX_MODEL_RESULT_CHARS)) : part))
  return kept.length ? kept : [textBlock('(no output)')]
}

function failed(toolUseId: string, text: string): ToolResultBlock {
  return { type: 'tool-result', toolUseId, content: [textBlock(text || '(no output)')], isError: true }
}

function hasImages(messages: readonly Message[]): boolean {
  return messages.some((message) =>
    (message.content as UserBlock[]).some((block) => block.type === 'image' || (block.type === 'tool-result' && block.content.some((part) => part.type === 'image'))),
  )
}

/** Runs `fn` over the items, `limit` at a time, and waits for all of them before reporting the first failure. */
async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: unknown
  let broken = false
  const worker = async () => {
    while (!broken) {
      const index = next++
      if (index >= items.length) return
      try {
        await fn(items[index])
      } catch (error) {
        if (!broken) {
          broken = true
          failure = error
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (broken) throw failure
}

function relativeToRoot(root: string, file: string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(root, file)
  if (!relative || relative.startsWith('..') || api.isAbsolute(relative)) return file
  return relative.split(api.sep).join('/')
}

/** What a rule that names a tool puts in parentheses: the skill, or the kind of subagent. */
function specifierOf(tool: string, input: Record<string, unknown>): { specifier?: string } {
  const value = tool === 'Skill' ? input.skill : tool === 'Task' ? input.subagent_type : undefined
  return typeof value === 'string' && value ? { specifier: value } : {}
}

export class AgentLoop {
  private readonly meter = new ContextMeter()
  private fixed = 0
  private contextKey = ''
  private readonly inflight = new Set<ConversationEntry>()
  private readonly approvedApps: Set<string>
  /** Whether the model that answered last reads images; unknown until the first request. */
  private vision: boolean | undefined

  constructor(private readonly o: LoopOptions) {
    this.approvedApps = o.approvedApps ?? new Set()
  }

  private get base(): Omit<HookEvent, 'mode'> {
    return { sessionId: this.o.services.sessionId, agentId: this.o.agentId, root: this.o.services.root }
  }

  private event(turn: Turn): HookEvent {
    return { ...this.base, mode: turn.mode }
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentAbortedError()
  }

  // ------------------------------------------------------------ the turn

  /** Runs steps until the turn ends. Rejects only with AgentAbortedError. */
  async run(turn: Turn): Promise<LoopEnd> {
    try {
      return await this.steps(turn)
    } catch (error) {
      if (turn.signal.aborted || error instanceof AgentAbortedError) {
        this.sweep()
        throw new AgentAbortedError()
      }
      throw error
    }
  }

  private async steps(turn: Turn): Promise<LoopEnd> {
    const { o } = this
    const { signal } = turn
    let mode = turn.mode
    const maxSteps = clamp(Math.floor(o.maxSteps ?? o.settings().maxSteps) || 30, 1, 100)
    let lengthRetries = 0
    let stopRounds = 0

    for (let step = 0; step < maxSteps; step++) {
      this.checkAbort(signal)
      o.surface.status('thinking')
      const response = await this.complete({ ...turn, mode })
      if (response.kind === 'end') return response.end
      const { message, finish } = response
      const calls = toolUses(message)

      if (!calls.length) {
        if (finish === 'length' && lengthRetries++ < MAX_LENGTH_RETRIES) {
          await o.conversation.add(userText(CONTINUE_AFTER_LENGTH), { turnId: turn.turnId })
          continue
        }
        const reply = messageText(message)
        const stop = await this.hook('beforeStop', { ...this.event({ ...turn, mode }), lastMessage: reply, continued: stopRounds > 0 })
        if (stop?.continue && stopRounds++ < MAX_STOP_ROUNDS) {
          await o.conversation.add(userText(stop.continue), { turnId: turn.turnId })
          continue
        }
        return { kind: 'done', reply }
      }

      const state: StepState = { results: new Map(), context: [] }
      try {
        await this.runCalls(calls, { ...turn, mode }, state)
      } finally {
        // Every call gets exactly one result, also when the run ends early: strict providers refuse the next request otherwise.
        const content: UserBlock[] = calls.map((call) => state.results.get(call.id) ?? failed(call.id, NOT_RUN))
        for (const text of state.context) content.push(textBlock(reminder(text)))
        await o.conversation.add({ role: 'user', content }, { turnId: turn.turnId })
      }
      if (state.mode) mode = state.mode
      if (state.stop !== undefined) return { kind: 'stopped', summary: state.stop }
    }
    return { kind: 'max-steps', steps: maxSteps }
  }

  // ------------------------------------------------------------ one model call

  private async complete(turn: Turn): Promise<{ kind: 'reply'; message: AssistantMessage; finish: FinishReason } | { kind: 'end'; end: LoopEnd }> {
    const { o } = this
    let overflows = 0
    let empties = 0
    for (;;) {
      const tools = o.registry.allDefinitions(o.tools)
      await this.noteContext(tools, turn)
      await this.fit(turn)
      const settings = o.settings()
      const budget = await o.client.budget(o.role, this.query())
      this.vision = budget.images
      // A model that cannot read images is not sent the screens it could not see anyway.
      const sent = budget.images === false ? withoutScreensFrom(o.conversation.messages()) : o.conversation.messages()
      const maxOutputTokens = Math.min(budget.maxOutputTokens, MAX_OUTPUT_TOKENS)
      const payload: ModelRequest = {
        system: o.system,
        messages: [...sent],
        tools,
        maxOutputTokens,
        ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
        ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
      }

      let streaming: ConversationEntry | undefined
      const onEvent = (event: ClientEvent) => {
        switch (event.type) {
          case 'text':
            streaming ??= o.surface.entry({ kind: 'assistant', text: '', streaming: true })
            o.surface.delta(streaming, event.text)
            return
          case 'discard':
            if (streaming) {
              streaming.text = ''
              o.surface.update(streaming)
            }
            return
          case 'switch':
            o.surface.settle(o.surface.entry({ kind: 'notice', text: `Switched from ${event.from} to ${event.to}: ${event.reason}` }))
            return
          case 'wait':
            o.surface.settle(o.surface.entry({ kind: 'notice', text: `Waiting until ${new Date(event.until).toLocaleTimeString()}: ${event.reason}` }))
            return
          default:
            return
        }
      }

      const outcome = await o.client.complete({
        role: o.role,
        ...(o.agentId !== 'main' ? { agent: o.agentId } : {}),
        payload,
        requirements: { promptTokens: this.meter.estimate(sent, this.fixed), maxOutputTokens, tools: tools.length > 0, images: hasImages(sent) },
        sticky: o.services.sessionId,
        signal: turn.signal,
        onEvent,
        validateToolCall: (name, input) => o.registry.check(name, input),
      })

      if (outcome.kind === 'paused') {
        return { kind: 'end', end: { kind: 'paused', reason: outcome.reason, message: outcome.message, ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}) } }
      }
      if (outcome.kind === 'compact') {
        if (overflows++ >= MAX_OVERFLOW_RETRIES) {
          // The instructions and tools are sent with every request and cannot be compacted: on a small window they may be most of it.
          const fixed = Math.ceil(this.fixed * this.meter.scale)
          const share = fixed > outcome.window / 2 ? ` eNCode's instructions and tools alone take about ${fixed.toLocaleString('en-US')} tokens.` : ''
          const message = `The conversation does not fit the model's context window (${outcome.window.toLocaleString('en-US')} tokens), even after compacting it.${share} Choose a model with a larger window.`
          return { kind: 'end', end: { kind: 'failed', message } }
        }
        if (outcome.used) this.meter.calibrate(sent, this.fixed, outcome.used)
        await this.fit(turn, { force: true, window: outcome.window })
        continue
      }

      const { message, usage, finish } = outcome
      o.surface.usage(usage)
      if (isEmptyReply(message)) {
        if (finish === 'content_filter') return { kind: 'end', end: { kind: 'failed', message: "The provider's safety system stopped the reply." } }
        if (empties++ < MAX_EMPTY_RETRIES) continue
        return { kind: 'end', end: { kind: 'failed', message: 'The model returned an empty response. Check the model and provider settings.' } }
      }

      this.meter.record(sent, this.fixed, usage)
      await o.conversation.add(message, { turnId: turn.turnId, usage })
      const text = messageText(message)
      const model = message.origin?.model
      if (streaming) {
        streaming.text = text
        streaming.streaming = false
        if (model) streaming.model = model
        o.surface.settle(streaming)
      } else if (text.trim()) {
        o.surface.settle(o.surface.entry({ kind: 'assistant', text, ...(model ? { model } : {}) }))
      }
      return { kind: 'reply', message, finish }
    }
  }

  private query() {
    return { sticky: this.o.services.sessionId, ...(this.o.agentId !== 'main' ? { agent: this.o.agentId } : {}) }
  }

  /** Records the system prompt and tools when they changed, and sizes them. */
  private async noteContext(tools: ToolDefinition[], turn: Turn): Promise<void> {
    const { o } = this
    const key = JSON.stringify([o.system, tools])
    if (key === this.contextKey) return
    this.contextKey = key
    this.fixed = textTokens(key)
    const changed = await o.conversation.context(o.system, tools)
    const messages = o.conversation.messages()
    // Thinking is bound to the prompt it was written under: with a different one, it has to go.
    if (changed && messages.length) {
      const stripped = dropThinkingFrom(messages, 0)
      if (stripped.some((message, i) => message !== messages[i])) {
        this.meter.reset()
        await o.conversation.replace(stripped, { trigger: 'auto', summary: '', removed: 0, turnId: turn.turnId })
      }
    }
  }

  // ------------------------------------------------------------ context

  /**
   * Makes the conversation valid and small enough for the next request: old
   * tool outputs are shortened first, and only if that is not enough are the
   * oldest whole units summarized. `force` compacts regardless of the
   * estimate (the provider refused the prompt as too long); `manual` is the
   * user's own request. Returns how many messages were summarized away.
   */
  private async fit(turn: Turn, options: FitOptions = {}): Promise<number> {
    const { o } = this
    const budget = await o.client.budget(o.role, this.query())
    const window = options.window ?? budget.contextWindow
    // On a small window the answer's share is capped, or the limit would sit below the instructions and tools alone.
    const reserve = Math.min(budget.maxOutputTokens, OUTPUT_RESERVE, Math.floor(window * OUTPUT_RESERVE_SHARE))
    let limit = Math.min(Math.floor(window * COMPACT_AT), window - reserve)
    const cap = o.settings().contextCap
    if (cap) limit = Math.min(limit, cap)
    limit = Math.max(limit, 2_000)

    const original = o.conversation.messages()
    let messages = repairPairing(original)
    let rewritten = messages.length !== original.length || messages.some((message, i) => message !== original[i])
    if (rewritten) this.meter.reset()
    const forced = Boolean(options.force || options.manual)
    const size = () => this.meter.estimate(messages, this.fixed)
    if (!forced && !rewritten && size() <= limit) return 0

    let removed = 0
    let summary = ''
    const trigger = options.manual ? 'manual' : 'auto'
    if (forced || size() > limit) {
      const elided = elideOldOutputs(messages)
      if (elided.some((message, i) => message !== messages[i])) {
        messages = elided
        rewritten = true
        this.meter.reset()
      }
      if (forced || size() > limit) {
        const keep = Math.floor((window * (options.manual ? MANUAL_KEEP_SHARE : KEEP_SHARE)) / this.meter.scale)
        const plan = planCompaction(messages, keep, forced)
        if (plan) {
          const hook = await this.hook('preCompact', { ...this.event(turn), trigger, ...(options.instructions ? { instructions: options.instructions } : {}) })
          const instructions = [options.instructions, hook?.instructions].filter(Boolean).join('\n')
          const written = await this.summarize(plan, window, turn.signal, instructions)
          const started = await this.hook('sessionStart', { ...this.event(turn), source: 'compact' })
          const preface = [...(await o.preface?.() ?? []), ...(started?.context ? [reminder(started.context)] : [])]
          messages = repairPairing(applyCompaction(plan, written.text, preface))
          removed = plan.dropped.length
          summary = written.text
          rewritten = true
          this.meter.reset()
          o.surface.settle(o.surface.entry({ kind: 'notice', text: compactedNotice(removed, written.byModel) }))
        }
        // Still too long: the recent steps' outputs have to give way too.
        if (size() > limit) {
          const trimmed = elideOldOutputs(messages, 0, 600)
          if (trimmed.some((message, i) => message !== messages[i])) {
            messages = trimmed
            rewritten = true
            this.meter.reset()
          }
        }
      }
    }
    if (rewritten) await o.conversation.replace(messages, { trigger, summary, removed, turnId: turn.turnId })
    return removed
  }

  /** The user's request to compact now, keeping only the latest messages verbatim. */
  async compact(options: { signal: AbortSignal; turnId: string; instructions?: string }): Promise<{ removed: number }> {
    const turn: Turn = { turnId: options.turnId, mode: 'code', signal: options.signal }
    try {
      return { removed: await this.fit(turn, { manual: true, instructions: options.instructions }) }
    } catch (error) {
      if (options.signal.aborted) throw new AgentAbortedError()
      throw error
    }
  }

  /** A summary of what a plan drops, written by a model when one can be reached. */
  private async summarize(plan: CompactionPlan, window: number, signal: AbortSignal, instructions: string): Promise<{ text: string; byModel: boolean }> {
    const { o } = this
    // The transcript to summarize may take about half the window.
    const maxChars = Math.floor((window * 0.5 * CHARS_PER_TOKEN) / this.meter.scale)
    const payload = summaryRequest(plan, maxChars, instructions)
    try {
      const outcome = await o.client.complete({
        role: 'summarizer',
        ...(o.agentId !== 'main' ? { agent: o.agentId } : {}),
        payload,
        requirements: { promptTokens: textTokens(JSON.stringify(payload.messages)), maxOutputTokens: payload.maxOutputTokens ?? 4096, tools: false, images: false },
        sticky: o.services.sessionId,
        signal,
      })
      if (outcome.kind === 'done') {
        o.surface.usage(outcome.usage)
        const text = messageText(outcome.message).trim()
        if (text) return { text: text.slice(0, MAX_SUMMARY_CHARS), byModel: true }
      }
    } catch (error) {
      if (signal.aborted) throw new AgentAbortedError()
      void error
    }
    return { text: digest(plan.dropped), byModel: false }
  }

  // ------------------------------------------------------------ tool calls

  private async runCalls(calls: readonly ToolUseBlock[], turn: Turn, state: StepState): Promise<void> {
    let batch: Prepared[] = []
    const flush = async () => {
      const group = batch
      batch = []
      if (!group.length) return
      const limit = group.some((item) => item.tool.kind === 'agent') ? MAX_PARALLEL_SUBAGENTS : MAX_PARALLEL_READS
      await runLimited(group, limit, (item) => this.execute(item, turn, state))
    }
    try {
      for (const block of calls) {
        this.checkAbort(turn.signal)
        const prepared = await this.prepare(block, turn, state)
        if (!prepared) continue
        if (prepared.parallel) {
          batch.push(prepared)
          continue
        }
        await flush()
        await this.execute(prepared, turn, state)
        if (state.stop !== undefined) return
      }
      await flush()
    } finally {
      // Nothing may still be running when the step's results are written.
      await flush().catch(() => undefined)
    }
  }

  private settleEntry(entry: ConversationEntry, patch: Partial<NonNullable<ConversationEntry['tool']>>): void {
    entry.tool = { ...entry.tool!, ...patch }
    this.inflight.delete(entry)
    this.o.surface.settle(entry)
  }

  /** Marks calls that were in flight when the run stopped. */
  private sweep(): void {
    for (const entry of this.inflight) {
      entry.tool = { ...entry.tool!, state: 'rejected', ok: false, output: 'Stopped.' }
      this.o.surface.settle(entry)
    }
    this.inflight.clear()
  }

  private async judge(access: ToolAccess, call: { name: string; input: Record<string, unknown> }): Promise<ApprovalDecision> {
    const { o } = this
    try {
      return await decideApproval(access, {
        policy: o.settings().policy,
        root: o.services.root,
        home: o.services.home,
        platform: o.services.platform,
        readRoots: o.readRoots?.(),
        ...(o.rules ? { rules: o.rules } : {}),
        ...(o.extraRoots ? { extraRoots: o.extraRoots() } : {}),
        tool: { name: call.name, ...specifierOf(call.name, call.input) },
        approvedHosts: o.approvedHosts,
        approvedApps: this.approvedApps,
        shell: o.services.shell.state(),
        assessor: o.assessor,
      })
    } catch (error) {
      return { kind: 'ask', reason: `eNCode could not check this call (${errorMessage(error)}).`, grantable: false }
    }
  }

  /**
   * Checks a call, runs the hooks and asks for approval. Returns the call to
   * run, or nothing when it was settled here (refused, invalid or rejected).
   */
  private async prepare(block: ToolUseBlock, turn: Turn, state: StepState): Promise<Prepared | undefined> {
    const { o } = this
    const entry = o.surface.entry({ kind: 'tool', tool: { name: block.name, input: trimInput(block.input), state: 'running' } })
    this.inflight.add(entry)
    const refuse = (shown: string, ui: 'error' | 'rejected', told = shown): undefined => {
      this.settleEntry(entry, { state: ui, ok: false, output: shown })
      state.results.set(block.id, failed(block.id, told))
      return undefined
    }

    if (block.invalid) {
      const hint = block.invalid.error.startsWith('The arguments') ? ` Call ${block.name} again with its arguments as one JSON object.` : ''
      return refuse(`Not run: ${block.invalid.error}`, 'error', `Not run: ${block.invalid.error}${hint}`)
    }
    if (o.tools && !o.tools.includes(block.name)) return refuse(`${block.name} is not available to this agent.`, 'error')
    const problem = o.registry.check(block.name, block.input, turn.mode)
    if (problem) return refuse(problem, 'error')
    const tool = o.registry.get(block.name)!
    // The user may have changed a rule, or the folder's settings, since the last call.
    await o.refresh?.().catch(() => undefined)

    let input = block.input
    const pre = await this.hook('preToolUse', { ...this.event(turn), tool: block.name, toolUseId: block.id, input })
    if (pre?.decision === 'deny') return refuse(pre.reason || 'A hook refused this call.', 'rejected', `A hook refused this call: ${pre.reason || 'no reason given'}`)
    if (pre?.input) {
      input = pre.input
      const again = o.registry.check(block.name, input, turn.mode)
      if (again) return refuse(again, 'error')
      entry.tool = { ...entry.tool!, input: trimInput(input) }
    }

    const ctx = this.contextFor(block, input, entry, turn)
    let access: ToolAccess
    try {
      access = await tool.access(input, ctx)
    } catch (error) {
      return refuse(`${block.name} could not be checked: ${errorMessage(error)}`, 'error')
    }
    const verdict = await this.judge(access, { name: block.name, input })
    if (verdict.kind === 'deny') return refuse(verdict.reason, 'rejected', `Refused by the approval policy: ${verdict.reason}`)

    let ask: string | undefined
    let grant: string | undefined
    let always: AlwaysAllow | undefined
    if (verdict.kind === 'ask') {
      ask = pre?.decision === 'allow' ? undefined : verdict.reason
      // A hook that asked wants to see each call.
      if (verdict.grantable && pre?.decision !== 'ask') grant = grantKey(access)
      // So does a rule that asked: an allow rule would lose to it.
      if (!verdict.byRule && pre?.decision !== 'ask') {
        always = alwaysAllowFor(access, { root: o.services.root, platform: o.services.platform, dialect: o.services.shell.state().dialect }) ?? undefined
      }
    } else if (pre?.decision === 'ask') ask = pre.reason || 'A hook asks for approval.'
    if (ask !== undefined) {
      entry.tool = { ...entry.tool!, state: 'waiting' }
      o.surface.update(entry)
      let summary: { title: string; detail?: string; preview?: DiffHunk[] }
      try {
        summary = await tool.describe(input, ctx)
      } catch {
        summary = { title: block.name }
      }
      let detail = summary.detail ?? ''
      if (summary.preview && summary.preview.length > MAX_PREVIEW_HUNKS) {
        detail += `${detail ? '\n' : ''}Showing ${MAX_PREVIEW_HUNKS} of ${summary.preview.length} changed regions.`
      }
      const answer = await o.surface.approve(
        {
          entryId: entry.id,
          tool: block.name,
          title: summary.title,
          detail,
          reason: ask,
          input: trimInput(input),
          preview: summary.preview?.slice(0, MAX_PREVIEW_HUNKS),
          ...(grant ? { grant } : {}),
          ...(always ? { always } : {}),
        },
        turn.signal,
      )
      if (!answer.approved) {
        if (turn.signal.aborted) throw new AgentAbortedError()
        const note = answer.note?.trim().slice(0, 2_000)
        return refuse(note ? `Rejected by user: ${note}` : 'Rejected by user.', 'rejected', note ? `${REJECTED} The user said: ${note}` : REJECTED)
      }
      entry.tool = { ...entry.tool!, state: 'running' }
      o.surface.update(entry)
      if (access.type === 'web') {
        const host = hostOf(access.url)
        if (host) o.approvedHosts.add(host)
      }
    }
    // Allowing an application covers the rest of the session, also when a hook did the allowing.
    if (access.type === 'desktop' && verdict.kind === 'ask') this.approvedApps.add(access.app)

    return { block, tool, input, entry, parallel: (tool.readOnly && tool.kind !== 'interaction') || tool.kind === 'agent' }
  }

  private async execute(prepared: Prepared, turn: Turn, state: StepState): Promise<void> {
    const { o } = this
    const { block, tool, input, entry } = prepared
    o.surface.status('running-tool')
    const progress = this.progressFor(entry)
    const ctx = this.contextFor(block, input, entry, turn, progress.push)

    let outcome: ToolOutcome
    try {
      outcome = await tool.run(input, ctx)
    } catch (error) {
      progress.stop()
      if (turn.signal.aborted) {
        this.settleEntry(entry, { state: 'rejected', ok: false, output: 'Stopped.' })
        throw new AgentAbortedError()
      }
      outcome = { ok: false, content: `Error: ${errorMessage(error)}` }
    }
    progress.stop()

    let content = modelContent(outcome)
    let isError = !outcome.ok
    const output = outcome.display?.output ?? textOf(content)
    const post = await this.hook('postToolUse', { ...this.event(turn), tool: block.name, toolUseId: block.id, input, ok: outcome.ok, output: textOf(content) })
    if (post?.block) {
      content = [...content, textBlock(`A hook did not accept this result: ${post.block}`)]
      isError = true
    }
    if (post?.context) state.context.push(post.context)

    state.results.set(block.id, { type: 'tool-result', toolUseId: block.id, content, ...(isError ? { isError: true } : {}) })
    this.settleEntry(entry, {
      state: outcome.ok ? 'done' : 'error',
      ok: outcome.ok,
      output: truncateMiddle(output, MAX_UI_OUTPUT),
      ...(outcome.display?.diff ? { diff: outcome.display.diff } : {}),
    })
    for (const file of outcome.changed ?? []) o.surface.fileChanged(relativeToRoot(o.services.root, file, o.services.platform))
    if (outcome.stop) {
      state.stop = outcome.stop.summary
      if (block.name === 'attempt_completion') o.surface.settle(o.surface.entry({ kind: 'assistant', text: outcome.stop.summary }))
    }
    if (outcome.mode) state.mode = outcome.mode
    this.checkAbort(turn.signal)
  }

  /** Live output of a long call, shown on its card at most every 80 ms. */
  private progressFor(entry: ConversationEntry): { push: (text: string) => void; stop: () => void } {
    let buffer = ''
    let timer: NodeJS.Timeout | undefined
    const flush = () => {
      timer = undefined
      if (!this.inflight.has(entry)) return
      entry.tool = { ...entry.tool!, output: truncateMiddle(buffer, MAX_UI_OUTPUT) }
      this.o.surface.update(entry)
    }
    return {
      push: (text) => {
        buffer += text
        if (buffer.length > MAX_UI_OUTPUT * 2) buffer = buffer.slice(-MAX_UI_OUTPUT)
        timer ??= setTimeout(flush, 80)
      },
      stop: () => {
        if (timer) clearTimeout(timer)
        timer = undefined
      },
    }
  }

  private contextFor(block: ToolUseBlock, _input: Record<string, unknown>, entry: ConversationEntry, turn: Turn, progress?: (text: string) => void): ToolContext {
    const { o } = this
    const s = o.services
    return {
      root: s.root,
      home: s.home,
      platform: s.platform,
      sessionId: s.sessionId,
      agentId: o.agentId,
      mode: turn.mode,
      turnId: turn.turnId,
      toolUseId: block.id,
      signal: turn.signal,
      files: s.files,
      shell: s.shell,
      jobs: s.jobs,
      web: s.web,
      interaction: {
        ask: async (questions, signal) => {
          const answers: string[] = []
          for (const question of questions) {
            answers.push(await o.surface.ask(entry.id, question, signal))
            o.surface.status('running-tool')
          }
          return answers
        },
        proposePlan: (plan, signal) => o.surface.proposePlan(entry.id, plan, signal),
        setTodos: (todos) => o.surface.setTodos(todos),
      },
      ...(s.subagents ? { subagents: { types: () => s.subagents!.types(), run: (request, signal) => s.subagents!.run({ ...request, entryId: entry.id, ...(progress ? { progress } : {}) }, signal) } } : {}),
      ...(s.skills ? { skills: s.skills } : {}),
      ...(s.goals ? { goals: s.goals } : {}),
      ...(s.desktop
        ? {
            desktop: {
              ...s.desktop,
              permitted: (app: string) => o.settings().policy === 'full-access' || this.approvedApps.has(app),
              vision: () => this.vision === true,
            },
          }
        : {}),
      ...(s.beforeWrite ? { beforeWrite: s.beforeWrite } : {}),
      ...(s.summarize ? { summarize: s.summarize } : {}),
      ...(progress ? { progress } : {}),
    }
  }

  // ------------------------------------------------------------ hooks

  private async hook<K extends keyof AgentHooks>(name: K, event: Parameters<NonNullable<AgentHooks[K]>>[0]): Promise<Awaited<ReturnType<NonNullable<AgentHooks[K]>>> | undefined> {
    const fn = this.o.hooks[name] as ((event: unknown) => Promise<unknown>) | undefined
    if (!fn) return undefined
    try {
      return ((await fn.call(this.o.hooks, event)) ?? undefined) as Awaited<ReturnType<NonNullable<AgentHooks[K]>>> | undefined
    } catch (error) {
      // A broken guard must not wave calls through.
      if (name === 'preToolUse') return { decision: 'deny', reason: `A preToolUse hook failed (${errorMessage(error)}), so the call was not run.` } as never
      this.o.surface.settle(this.o.surface.entry({ kind: 'notice', text: `The ${name} hook failed: ${errorMessage(error)}` }))
      return undefined
    }
  }
}

export function compactedNotice(count: number, byModel: boolean): string {
  const what = `Compacted ${count} earlier message${count === 1 ? '' : 's'}`
  return byModel
    ? `${what} into a summary to stay within the model's context.`
    : `${what} into an outline of the requests, files and commands, because the model could not write a summary.`
}
