/**
 * Print mode (`encode -p`): one request, its answer on standard output, and an exit status. Nobody is there to ask:
 * an approval the policy leaves to the person is refused with a note the agent can act on, and a question is told to
 * choose. Standard error carries the problems, and with --verbose what the agent does.
 */
import type { AgentEvent, ConversationEntry } from '@encode/core'
import { redactSecrets } from '@encode/providers'
import type { ServerTools } from '@encode/workspace'
import type { CliOptions } from './args'
import type { ModelChoice } from './model'
import { Renderer, usageLine } from './render'
import { openRuntime, type Runtime } from './runtime'
import { chooseSession, settingsFor, trustFolder } from './session'
import { firstLine, plain, safeJson, styleFor } from './text'

export interface PrintIo {
  stdout(text: string): void
  stderr(text: string): void
  stderrTty: boolean
  env: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  /** For tests: where the command line keeps its sessions. */
  profile?: string
  tools?: ServerTools
  /** Called with a function that stops the request (Ctrl+C); returns a function that stops listening. */
  onInterrupt(stop: () => void): () => void
}

export const NOBODY_APPROVES =
  'No one is here to approve this: eNCode runs in print mode, where only what the approval policy allows runs. It was not done. Finish the request without it, or say in your reply what it needs.'
export const NOBODY_ANSWERS = 'No one can answer: eNCode runs in print mode. Choose what fits the request best, say what you chose, and go on.'

export interface PrintResult {
  type: 'result'
  session: string
  ok: boolean
  result: string
  error: string | null
  /** What else is known about the error: its name, message and where it came from. */
  details: string | null
  plan: string | null
  model: string
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; cost: number | null; calls: number }
  durationMs: number
}

export async function runPrint(options: CliOptions, prompt: string, model: ModelChoice, root: string, io: PrintIo): Promise<number> {
  const scrub = (text: string) => redactSecrets(text, model.secrets)
  const errStyle = styleFor(io.stderrTty, io.env, options.color)
  const verbose = options.verbose && options.outputFormat !== 'stream-json' ? new Renderer({ style: errStyle, root, write: (text) => io.stderr(scrub(text)), quietReply: true }) : undefined
  const entries = new Map<string, ConversationEntry>()
  let sessionId = ''
  let failure: string | null = null
  let plan: string | null = null
  let runtime: Runtime | undefined

  const emit = (event: AgentEvent) => {
    if (event.sessionId !== sessionId) return
    if (options.outputFormat === 'stream-json') io.stdout(`${scrub(safeJson(event))}\n`)
    verbose?.event(event)
    switch (event.type) {
      case 'entry':
        entries.set(event.entry.id, event.entry)
        return
      case 'approval-request':
        if (verbose) verbose.line(errStyle.dim(`  Refused (print mode): ${firstLine(event.request.title, 160)}`))
        setImmediate(() => runtime?.host.approve(event.request.id, { approved: false, note: NOBODY_APPROVES }))
        return
      case 'ask':
        setImmediate(() => runtime?.host.answer(event.id, NOBODY_ANSWERS))
        return
      case 'plan':
        if (event.plan) plan = event.plan.plan
        return
      case 'error':
        failure ??= event.message
        return
      default:
        return
    }
  }

  /** Our own lines to standard error; whatever comes from the session or the folder is made plain where it is put in. */
  const say = (text: string) => io.stderr(`${scrub(text)}\n`)
  runtime = await openRuntime({
    root,
    ...(io.home ? { home: io.home } : {}),
    ...(io.platform ? { platform: io.platform } : {}),
    env: io.env,
    ...(io.profile ? { profile: io.profile } : {}),
    ...(io.tools ? { tools: io.tools } : {}),
    client: model.client,
    settings: () => settingsFor(options),
    emit,
    sandbox: options.sandbox,
    nameSessions: false,
    warn: (text) => {
      if (options.verbose) say(errStyle.dim(plain(text)))
    },
  })
  const started = Date.now()
  let stopListening = () => {}
  try {
    if (options.sandbox && runtime.sandbox?.state !== 'active') say(`eNCode: commands run without the sandbox here: ${plain(runtime.sandbox?.reason ?? 'it is not available')}.`)
    if (options.trust) {
      const trusted = await trustFolder(runtime.workspaces, runtime.root)
      if (!trusted.ok) say(`eNCode: ${trusted.text}`)
    }
    const { session } = await chooseSession(runtime.host, runtime.root, options)
    sessionId = session.id
    const before = new Set((await runtime.host.history(session.id)).entries.map((entry) => entry.id))
    const host = runtime.host
    stopListening = io.onInterrupt(() => host.cancel(session.id))
    // The cap refuses the call that could pass it; the request stops there, and says why.
    const capped = () => {
      failure = `Stopped: ${model.cap?.stopped() ?? 'the spending cap was reached'}.`
      host.cancel(session.id)
    }
    model.cap?.signal.addEventListener('abort', capped, { once: true })
    await host.start(session.id, { text: prompt, mode: options.mode }).finally(() => model.cap?.signal.removeEventListener('abort', capped))

    const added = [...entries.values()].filter((entry) => !before.has(entry.id))
    const reply = scrub(plain(added.filter((entry) => entry.kind === 'assistant' && entry.text?.trim()).at(-1)?.text?.trim() ?? ''))
    const usage = [...added].reverse().find((entry) => entry.kind === 'user' && entry.usage)?.usage
    const durationMs = Date.now() - started
    const error = failure === null ? null : scrub(plain(failure))
    const problem = added.filter((entry) => entry.kind === 'error' && entry.details?.trim()).at(-1)
    const details = error === null || !problem ? null : scrub(plain(problem.details!.trim()))
    if (options.outputFormat === 'json') {
      const result: PrintResult = {
        type: 'result',
        session: session.id,
        ok: error === null,
        result: reply,
        error,
        details,
        plan: plan === null ? null : scrub(plain(plan)),
        model: model.label,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          cachedTokens: usage?.cachedTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cost: usage?.cost ?? null,
          calls: usage?.calls ?? 0,
        },
        durationMs,
      }
      io.stdout(`${safeJson(result)}\n`)
    } else if (options.outputFormat === 'text') {
      if (reply) io.stdout(`${reply}\n`)
      if (plan !== null) io.stdout(`\nProposed plan:\n${scrub(plain(plan)).trim()}\n`)
      if (error !== null) say(errStyle.red(`eNCode: ${error}`))
      if (details !== null) say(errStyle.dim(`  ${firstLine(details, 300)}`))
      if (options.verbose) say(errStyle.dim(usageLine(usage, durationMs)))
    }
    return error === null ? 0 : 1
  } finally {
    stopListening()
    await runtime.close()
  }
}
