/**
 * Hooks: points in the agent's life where code outside the loop can look,
 * add context, or change what happens. User-configured hooks (scripts named
 * in settings) and eNCode's own features (checkpoints, the reviewer gate)
 * plug in here.
 *
 * Every hook is optional and awaited. A hook that throws is reported as a
 * notice and treated as if it returned nothing, except `preToolUse`, where a
 * failure denies the call: a broken guard must not wave calls through.
 *
 * Precedence for `preToolUse`: a hook's `deny` always wins; `ask` asks even
 * where the policy would allow; `allow` skips the prompt but never overrides a
 * policy that denies (protected paths, read-only mode).
 */
import type { AgentMode } from '@encode/tools'

export interface HookEvent {
  sessionId: string
  /** 'main', or the subagent's id. */
  agentId: string
  /** The workspace root. */
  root: string
  mode: AgentMode
  /** Aborts when the turn is stopped: a hook still running is stopped with it. */
  signal?: AbortSignal
}

export interface SessionStartEvent extends HookEvent {
  source: 'new' | 'resume' | 'compact' | 'clear'
}

export interface UserPromptEvent extends HookEvent {
  /** The record id the prompt will be stored under. */
  messageId: string
  prompt: string
}

export interface ToolEvent extends HookEvent {
  tool: string
  toolUseId: string
  input: Record<string, unknown>
}

export interface PostToolEvent extends ToolEvent {
  ok: boolean
  /** The result's text, as the model will read it. */
  output: string
}

export interface StopEvent extends HookEvent {
  /** The final assistant text. */
  lastMessage: string
  /** True when a `beforeStop` hook already sent the agent back this turn. */
  continued: boolean
}

export interface CompactEvent extends HookEvent {
  trigger: 'auto' | 'manual'
  /** What the user asked the summary to keep, for a manual compaction. */
  instructions?: string
}

/** What the agent is waiting for, as Claude Code names it for a Notification hook (question and plan_review are eNCode's). */
export type NotificationKind = 'permission_prompt' | 'idle_prompt' | 'question' | 'plan_review'

export interface NotificationEvent extends HookEvent {
  kind: NotificationKind
  /** The session's name. */
  title: string
  /** What eNCode would say about it: "eNCode needs your approval to use Bash". */
  message: string
}

export interface SessionEndEvent extends HookEvent {
  /** Claude Code's reason: clear, prompt_input_exit (eNCode quit) or other. */
  reason: 'clear' | 'prompt_input_exit' | 'other'
  /** Which of eNCode's endings it was. */
  detail: 'cleared' | 'quit' | 'deleted' | 'closed'
}

export interface SubagentStartEvent extends HookEvent {
  agentType: string
}

export interface ContextResult {
  /** Text added to the conversation as a reminder the model reads. */
  context?: string
}

export interface PromptResult extends ContextResult {
  /** Refuses the prompt with this reason; nothing is sent to the model. */
  block?: string
}

export interface PreToolResult {
  decision?: 'allow' | 'ask' | 'deny'
  /** Shown to the user, and to the model when the call is denied. */
  reason?: string
  /** Runs the call with this input instead; it is checked against the schema again. */
  input?: Record<string, unknown>
}

export interface PostToolResult extends ContextResult {
  /** Tells the model the call's result was not accepted, with this reason. */
  block?: string
}

export interface StopResult {
  /** Sends the agent back to work with this instruction instead of stopping. */
  continue?: string
}

export interface CompactResult {
  /** Extra instructions for the summary. */
  instructions?: string
}

export interface AgentHooks {
  sessionStart?(event: SessionStartEvent): Promise<ContextResult | void>
  userPromptSubmit?(event: UserPromptEvent): Promise<PromptResult | void>
  preToolUse?(event: ToolEvent): Promise<PreToolResult | void>
  postToolUse?(event: PostToolEvent): Promise<PostToolResult | void>
  beforeStop?(event: StopEvent): Promise<StopResult | void>
  preCompact?(event: CompactEvent): Promise<CompactResult | void>
  /** The agent waits for the person. Nothing it returns changes anything. */
  notification?(event: NotificationEvent): Promise<void>
  /** The session ends: cleared, closed, deleted, or eNCode quits. Only after a sessionStart. */
  sessionEnd?(event: SessionEndEvent): Promise<void>
  /** A subagent is about to start; the context goes into its first message. */
  subagentStart?(event: SubagentStartEvent): Promise<ContextResult | void>
}

/** Runs several hook sets as one, in order. */
export function combineHooks(...sets: (AgentHooks | undefined)[]): AgentHooks {
  const all = sets.filter((set): set is AgentHooks => Boolean(set))
  const joinContext = (results: (ContextResult | void)[]) => {
    const context = results.map((result) => result?.context?.trim()).filter(Boolean).join('\n\n')
    return context ? { context } : {}
  }
  return {
    async sessionStart(event) {
      const results: (ContextResult | void)[] = []
      for (const set of all) results.push(await set.sessionStart?.(event))
      return joinContext(results)
    },
    async userPromptSubmit(event) {
      const results: (PromptResult | void)[] = []
      for (const set of all) {
        const result = await set.userPromptSubmit?.(event)
        if (result?.block) return { block: result.block }
        results.push(result)
      }
      return joinContext(results)
    },
    async preToolUse(event) {
      let input = event.input
      let decision: PreToolResult['decision']
      const reasons: string[] = []
      for (const set of all) {
        const result = await set.preToolUse?.({ ...event, input })
        if (!result) continue
        if (result.input) input = result.input
        if (result.reason) reasons.push(result.reason)
        if (result.decision === 'deny') return { decision: 'deny', reason: result.reason ?? reasons.join(' ') }
        if (result.decision === 'ask' || (result.decision === 'allow' && decision !== 'ask')) decision = result.decision
      }
      return {
        ...(decision ? { decision } : {}),
        ...(reasons.length ? { reason: reasons.join(' ') } : {}),
        ...(input !== event.input ? { input } : {}),
      }
    },
    async postToolUse(event) {
      const results: (PostToolResult | void)[] = []
      for (const set of all) {
        const result = await set.postToolUse?.(event)
        if (result?.block) return { block: result.block }
        results.push(result)
      }
      return joinContext(results)
    },
    async beforeStop(event) {
      for (const set of all) {
        const result = await set.beforeStop?.(event)
        if (result?.continue) return result
      }
      return {}
    },
    async preCompact(event) {
      const parts: string[] = []
      for (const set of all) {
        const result = await set.preCompact?.(event)
        if (result?.instructions?.trim()) parts.push(result.instructions.trim())
      }
      return parts.length ? { instructions: parts.join('\n\n') } : {}
    },
    async notification(event) {
      for (const set of all) await set.notification?.(event)
    },
    async sessionEnd(event) {
      for (const set of all) await set.sessionEnd?.(event)
    },
    async subagentStart(event) {
      const results: (ContextResult | void)[] = []
      for (const set of all) results.push(await set.subagentStart?.(event))
      return joinContext(results)
    },
  }
}
