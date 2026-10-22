import type { HookEventName, HookGroup } from './config'
import type { HookRun, HookRunner } from './runner'

/**
 * Turns configured hook commands into the agent's hooks. Each event runs
 * every matching command at once, with Claude Code's input on stdin, and
 * reads the answers the way Claude Code does:
 *
 * - exit 0: success; JSON on stdout may decide (permissionDecision,
 *   decision "block", continue false) or add context, and for
 *   UserPromptSubmit and SessionStart plain stdout is added as context;
 * - exit 2: blocks, with stderr as the reason (the call is denied, the
 *   prompt refused, the result rejected, or the agent sent back to work);
 * - any other exit: an error the user is told about, and the agent goes on.
 *
 * eNCode is stricter in one place: a PreToolUse hook that cannot run or
 * times out denies the call, because a guard that broke must not wave calls
 * through. Several answers combine as deny, then ask, then allow. A Stop
 * hook may send the agent back at most three times in a row.
 *
 * The event and result types mirror @encode/core's AgentHooks, which this
 * object is passed as.
 */

export interface HookEvent {
  sessionId: string
  agentId: string
  root: string
  mode: string
}

export interface SessionStartEvent extends HookEvent {
  source: 'new' | 'resume' | 'compact'
}

export interface UserPromptEvent extends HookEvent {
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
  output: string
}

export interface StopEvent extends HookEvent {
  lastMessage: string
  continued: boolean
}

export interface CompactEvent extends HookEvent {
  trigger: 'auto' | 'manual'
  instructions?: string
}

export interface CommandHooks {
  sessionStart(event: SessionStartEvent): Promise<{ context?: string }>
  userPromptSubmit(event: UserPromptEvent): Promise<{ block?: string; context?: string }>
  preToolUse(event: ToolEvent): Promise<{ decision?: 'allow' | 'ask' | 'deny'; reason?: string; input?: Record<string, unknown> }>
  postToolUse(event: PostToolEvent): Promise<{ block?: string; context?: string }>
  beforeStop(event: StopEvent): Promise<{ continue?: string }>
  preCompact(event: CompactEvent): Promise<{ instructions?: string }>
}

export interface HookHost {
  /** Base environment for hook commands; the project directory is added. */
  env: Record<string, string>
  runner: HookRunner
  /** The session's transcript file, for transcript_path. */
  transcriptPath?(sessionId: string): string | undefined
  /** Tells the user about a hook's error or message. */
  notice?(text: string): void
}

/** Context one hook may add; more is cut. */
const MAX_CONTEXT = 10_000
const MAX_STOP_CONTINUATIONS = 3

interface Answer {
  command: string
  decision?: 'allow' | 'ask' | 'deny'
  reason?: string
  input?: Record<string, unknown>
  /** Blocks: exit 2, decision "block", or continue false. */
  block?: string
  context?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string): string {
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n[cut: the hook printed more]` : text
}

function parseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** Reads one command's run as Claude Code would. */
function interpret(event: HookEventName, command: string, run: HookRun, notice: (text: string) => void): Answer {
  const answer: Answer = { command }
  const name = command.length > 60 ? `${command.slice(0, 57)}...` : command
  if (run.error || run.timedOut) {
    const why = run.error ? `could not run (${run.error})` : 'did not finish in time'
    notice(`The ${event} hook "${name}" ${why}.`)
    if (event === 'PreToolUse') {
      answer.decision = 'deny'
      answer.reason = `The PreToolUse hook "${name}" ${why}, so the call was not run.`
    }
    return answer
  }
  if (run.exitCode === 2) {
    answer.block = run.stderr.trim() || `Blocked by the ${event} hook "${name}".`
    if (event === 'PreToolUse') {
      answer.decision = 'deny'
      answer.reason = answer.block
    }
    return answer
  }
  if (run.exitCode !== 0) {
    notice(`The ${event} hook "${name}" failed (exit ${run.exitCode})${run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 500)}` : '.'}`)
    return answer
  }

  const json = parseJson(run.stdout)
  if (!json) {
    if ((event === 'UserPromptSubmit' || event === 'SessionStart') && run.stdout.trim()) answer.context = clip(run.stdout.trim())
    return answer
  }
  if (typeof json.systemMessage === 'string' && json.systemMessage.trim()) notice(json.systemMessage.trim())
  const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {}
  if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
    answer.context = clip(specific.additionalContext.trim())
  }
  const reason = typeof json.reason === 'string' ? json.reason.trim() : ''
  if (json.continue === false) {
    answer.block = (typeof json.stopReason === 'string' && json.stopReason.trim()) || reason || `Stopped by the ${event} hook "${name}".`
  }
  if (event === 'PreToolUse') {
    const decision = specific.permissionDecision ?? (json.decision === 'approve' ? 'allow' : json.decision === 'block' ? 'deny' : undefined)
    if (decision === 'allow' || decision === 'ask' || decision === 'deny') answer.decision = decision
    const why = typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason.trim() : reason
    if (why) answer.reason = why
    if (isObject(specific.updatedInput)) answer.input = specific.updatedInput
    if (answer.block) {
      answer.decision = 'deny'
      answer.reason = answer.block
    }
  } else if (json.decision === 'block') {
    answer.block ??= reason || `Blocked by the ${event} hook "${name}".`
  }
  return answer
}

export function createCommandHooks(groups: readonly HookGroup[], host: HookHost): CommandHooks {
  const notice = (text: string) => host.notice?.(text)
  const stopStreaks = new Map<string, number>()

  /** Runs every hook of `event` whose matcher accepts `subject`, at once; identical commands run once. */
  async function run(event: HookEventName, subject: string, base: HookEvent, fields: Record<string, unknown>): Promise<Answer[]> {
    const commands = new Map<string, number>()
    for (const group of groups) {
      if (group.event !== event || !group.matcher.test(subject)) continue
      for (const hook of group.hooks) commands.set(hook.command, Math.max(commands.get(hook.command) ?? 0, hook.timeout))
    }
    if (!commands.size) return []
    const input = JSON.stringify({
      session_id: base.sessionId,
      transcript_path: host.transcriptPath?.(base.sessionId) ?? null,
      cwd: base.root,
      hook_event_name: event,
      permission_mode: base.mode,
      ...fields,
    })
    const env = { ...host.env, ENCODE_PROJECT_DIR: base.root, CLAUDE_PROJECT_DIR: base.root }
    return Promise.all(
      [...commands].map(async ([command, timeout]) => {
        let result: HookRun
        try {
          result = await host.runner(command, { stdin: input, env, cwd: base.root, timeoutMs: timeout * 1000 })
        } catch (error) {
          result = { exitCode: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) }
        }
        return interpret(event, command, result, notice)
      }),
    )
  }

  const contexts = (answers: Answer[]) => answers.map((answer) => answer.context).filter((text): text is string => Boolean(text))
  const joined = (texts: string[]) => (texts.length ? texts.join('\n\n') : undefined)

  return {
    async sessionStart(event) {
      const source = event.source === 'new' ? 'startup' : event.source
      const answers = await run('SessionStart', source, event, { source })
      const context = joined(contexts(answers))
      return context ? { context } : {}
    },

    async userPromptSubmit(event) {
      const answers = await run('UserPromptSubmit', '', event, { prompt: event.prompt })
      const blocked = answers.find((answer) => answer.block)
      if (blocked) return { block: blocked.block }
      const context = joined(contexts(answers))
      return context ? { context } : {}
    },

    async preToolUse(event) {
      const answers = await run('PreToolUse', event.tool, event, { tool_name: event.tool, tool_input: event.input, tool_use_id: event.toolUseId })
      const reasons = (decision: string) =>
        answers.filter((answer) => answer.decision === decision && answer.reason).map((answer) => answer.reason!).join(' ')
      if (answers.some((answer) => answer.decision === 'deny')) return { decision: 'deny', reason: reasons('deny') || 'Denied by a PreToolUse hook.' }
      const inputs = answers.filter((answer) => answer.input)
      const distinct = new Set(inputs.map((answer) => JSON.stringify(answer.input)))
      const input = inputs[0]?.input
      if (distinct.size > 1) {
        return { decision: 'ask', reason: 'Two PreToolUse hooks changed the call in different ways; the first change is shown.', input }
      }
      const decision = answers.some((answer) => answer.decision === 'ask') ? 'ask' : answers.some((answer) => answer.decision === 'allow') ? 'allow' : undefined
      const reason = decision ? reasons(decision) : ''
      return { ...(decision ? { decision } : {}), ...(reason ? { reason } : {}), ...(input ? { input } : {}) }
    },

    async postToolUse(event) {
      const answers = await run('PostToolUse', event.tool, event, {
        tool_name: event.tool,
        tool_input: event.input,
        tool_use_id: event.toolUseId,
        tool_response: { success: event.ok, output: event.output },
      })
      const blocked = answers.find((answer) => answer.block)
      if (blocked) return { block: blocked.block }
      const context = joined(contexts(answers))
      return context ? { context } : {}
    },

    async beforeStop(event) {
      const key = `${event.sessionId}\u0000${event.agentId}`
      if (!event.continued) stopStreaks.delete(key)
      const name = event.agentId === 'main' ? 'Stop' : 'SubagentStop'
      const answers = await run(name, '', event, { stop_hook_active: event.continued })
      const blocks = answers.map((answer) => answer.block).filter((text): text is string => Boolean(text))
      if (!blocks.length) {
        stopStreaks.delete(key)
        return {}
      }
      const streak = (stopStreaks.get(key) ?? 0) + 1
      if (streak > MAX_STOP_CONTINUATIONS) {
        stopStreaks.delete(key)
        notice(`A ${name} hook sent the agent back ${MAX_STOP_CONTINUATIONS} times in a row; letting it stop.`)
        return {}
      }
      stopStreaks.set(key, streak)
      return { continue: blocks.join('\n\n') }
    },

    async preCompact(event) {
      const answers = await run('PreCompact', event.trigger, event, { trigger: event.trigger, custom_instructions: event.instructions ?? '' })
      const instructions = joined(contexts(answers))
      return instructions ? { instructions } : {}
    },
  }
}
