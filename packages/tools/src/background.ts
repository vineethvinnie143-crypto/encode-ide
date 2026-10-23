/**
 * Work that goes on while the agent does something else: Monitor (a command whose lines reach the agent as they
 * come), ScheduleWakeup (the agent asks to be woken later in the conversation) and SendMessage (more work for a
 * subagent it started, also one that ended or was cut off by a restart). They are seldom needed, so their
 * definitions wait for ToolSearch, as in Claude Code; the main agent alone has them.
 */
import type { Tool, ToolOutcome } from './types'

function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

// ---------------------------------------------------------------------------
// Monitor

export const MONITOR_DEFAULT_MS = 300_000
export const MONITOR_MAX_MS = 3_600_000

interface MonitorInput extends Record<string, unknown> {
  command: string
  description: string
  timeout_ms?: number
  persistent?: boolean
}

export const monitorTool: Tool<MonitorInput> = {
  definition: {
    name: 'Monitor',
    description: [
      'Runs a command in the background and tells you each line it prints, as notices that reach you between your steps, or wake you when you are idle. Use it to wait for something: a log line, a build finishing, a test failing, a file appearing.',
      '',
      '- Print one line per event and only what matters: filter with grep --line-buffered (Select-String in PowerShell) instead of printing everything. Lines that come together arrive together.',
      `- timeout_ms: how long it may run, default ${MONITOR_DEFAULT_MS} (5 minutes), at most ${MONITOR_MAX_MS}. persistent true runs it until it ends or you stop it.`,
      '- You get an id at once and are told when it ends. Stop it with KillShell once you no longer need it.',
      '- Never poll in a loop with sleep; this is what Monitor is for.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'The command whose output lines are the events.' },
        description: { type: 'string', minLength: 1, description: 'A few words on what it watches for, shown with each notice.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: MONITOR_MAX_MS, description: `Milliseconds before it is stopped (default ${MONITOR_DEFAULT_MS}).` },
        persistent: { type: 'boolean', description: 'Run until the command ends or you stop it, with no timeout.' },
      },
      required: ['command', 'description'],
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: false,
  defer: 'always',
  access: (input, ctx) => ({ type: 'command', command: input.command, cwd: ctx.shell.state().cwd, background: true }),
  describe: (input) => ({ title: `Watch: ${input.description.trim()}`, detail: `${input.command}\n(in the background)` }),
  async run(input, ctx) {
    if (!ctx.background) return fail('Monitor is not available here. Run the command with Bash and read its output.')
    const started = await ctx.background.monitor({
      command: input.command,
      description: input.description.trim(),
      cwd: ctx.shell.state().cwd,
      timeoutMs: input.persistent ? null : (input.timeout_ms ?? MONITOR_DEFAULT_MS),
    })
    if (!started.ok) return fail(started.reason)
    const until = input.persistent ? 'until it ends or you stop it' : `for at most ${Math.round((input.timeout_ms ?? MONITOR_DEFAULT_MS) / 1000)} s`
    return {
      ok: true,
      content: `Watching with id ${started.id}, ${until}. Its lines reach you as notices; carry on with other work or end your turn. Stop it with KillShell (shell_id "${started.id}").`,
      display: { output: `Watching (${started.id})` },
    }
  },
}

// ---------------------------------------------------------------------------
// ScheduleWakeup

export const WAKE_MIN_SECONDS = 60
export const WAKE_MAX_SECONDS = 3_600

interface ScheduleWakeupInput extends Record<string, unknown> {
  delaySeconds?: number
  reason?: string
  prompt?: string
  cancel?: boolean
}

/** "14:05", in the person's own clock. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export const scheduleWakeupTool: Tool<ScheduleWakeupInput> = {
  definition: {
    name: 'ScheduleWakeup',
    description: [
      'Wakes you later in this conversation with a prompt, without the user writing: to check on something slow (a deploy, a long job elsewhere) or to come back to a task at a set time.',
      '',
      `- delaySeconds: ${WAKE_MIN_SECONDS} to ${WAKE_MAX_SECONDS}. One wake-up at a time; a new one replaces the one before.`,
      '- prompt: what to do when you wake, as a complete instruction to yourself. reason: a few words for the user, such as "check the deploy".',
      '- cancel true removes the wake-up.',
      '- Background work you started (Bash, Monitor, Task) tells you itself when it ends: do not schedule a wake-up for that.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        delaySeconds: { type: 'integer', minimum: WAKE_MIN_SECONDS, maximum: WAKE_MAX_SECONDS, description: 'Seconds from now.' },
        reason: { type: 'string', maxLength: 120, description: 'A few words for the user on why.' },
        prompt: { type: 'string', maxLength: 4000, description: 'What to do on waking, as a complete instruction.' },
        cancel: { type: 'boolean', description: 'Remove the wake-up instead of setting one.' },
      },
      additionalProperties: false,
    },
  },
  kind: 'interaction',
  readOnly: true,
  defer: 'always',
  check(input) {
    if (input.cancel) return undefined
    if (input.delaySeconds === undefined || !input.prompt?.trim() || !input.reason?.trim()) return 'give delaySeconds, reason and prompt, or cancel true.'
    return undefined
  },
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: input.cancel ? 'Cancel the wake-up' : `Wake up in ${Math.round((input.delaySeconds ?? 0) / 60)} min: ${input.reason?.trim() ?? ''}` }),
  async run(input, ctx) {
    if (!ctx.background) return fail('ScheduleWakeup is not available here.')
    if (input.cancel) {
      return ctx.background.cancelWake() ? { ok: true, content: 'The wake-up is cancelled.' } : { ok: true, content: 'There was no wake-up to cancel.' }
    }
    const seconds = Math.min(WAKE_MAX_SECONDS, Math.max(WAKE_MIN_SECONDS, Math.round(input.delaySeconds ?? WAKE_MIN_SECONDS)))
    const { at, replaced } = ctx.background.wake({ delayMs: seconds * 1000, reason: input.reason!.trim(), prompt: input.prompt!.trim() })
    return {
      ok: true,
      content: `You will be woken at ${clock(at)} (in ${seconds} s)${replaced ? ', in place of the wake-up set before' : ''}. End your turn now unless there is other work to do.`,
      display: { output: `Wakes at ${clock(at)}` },
    }
  },
}

// ---------------------------------------------------------------------------
// SendMessage

interface SendMessageInput extends Record<string, unknown> {
  to: string
  message: string
  run_in_background?: boolean
}

export const sendMessageTool: Tool<SendMessageInput> = {
  definition: {
    name: 'SendMessage',
    description: [
      'Sends a message to a subagent you started with Task, by its agent id. A running subagent reads it between its steps. One that finished, or was cut off when eNCode closed, goes on from where it stopped, with everything it saw, and answers with a new report.',
      '',
      'Use it for more on the same work (a follow-up question, the next part) instead of a new subagent that would have to look again.',
      '- to: the agent id from Task. message: what to do next, as a complete instruction.',
      '- run_in_background true returns at once; the report reaches you as a notice.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1, description: 'The agent id Task returned.' },
        message: { type: 'string', minLength: 1, description: 'What the subagent should do next.' },
        run_in_background: { type: 'boolean', description: 'Return at once; the report arrives as a notice.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  kind: 'agent',
  readOnly: true,
  defer: 'always',
  access: () => ({ type: 'agent' }),
  describe: (input) => ({ title: `Message ${input.to}`, detail: input.message }),
  async run(input, ctx) {
    if (!ctx.subagents?.message) return fail('There are no subagents to message here.')
    const result = await ctx.subagents.message(
      { to: input.to.trim(), text: input.message, background: Boolean(input.run_in_background), toolUseId: ctx.toolUseId, mode: ctx.mode },
      ctx.signal,
    )
    return { ok: result.ok, content: result.report || '(the subagent returned no report)' }
  },
}
