/**
 * eNCode at a prompt: type a request, watch the agent work, answer what it asks, type the next one. The agent and
 * its sessions are the app's (runtime.ts); this file is the conversation with the person: the prompt, the slash
 * commands, approvals and questions as one-line answers, and what is offered after a request (a plan to carry out,
 * lines for ENCODE.md, the attempt to keep of a best-of request).
 *
 * Ctrl+C stops the running request, refuses a pending approval, or clears the line; twice at an empty prompt, or
 * Ctrl+D, leaves. A line typed while the agent works goes to the running request, as the app's steering does.
 */
import readline from 'node:readline'
import type { AgentEvent, AgentMode, ApprovalAnswer, ApprovalPolicy, ApprovalRequest, AskRequest, ConversationEntry } from '@encode/core'
import { redactSecrets, type ModelClient } from '@encode/providers'
import type { ServerTools } from '@encode/workspace'
import { MODES, POLICIES, UsageError, type CliOptions } from './args'
import { chooseModel, type ModelChoice } from './model'
import { Renderer, approvalLines, askLines, usageLine } from './render'
import { openRuntime, type Runtime } from './runtime'
import { VERSION } from './version'
import { chooseSession, folderSessions, sessionLine, settingsFor, trustFolder } from './session'
import { counted, firstLine, plain, styleFor, type Style } from './text'

export interface ReplIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream & { isTTY?: boolean }
  env: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  profile?: string
  tools?: ServerTools
  /** Ctrl+C when the prompt is not a terminal's (a terminal's comes to readline itself); returns a function that stops listening. */
  onInterrupt?(handler: () => void): () => void
}

/** A model client whose model can change between requests (/model). */
export class SwitchableClient implements ModelClient {
  constructor(public current: ModelClient) {}
  complete(...args: Parameters<ModelClient['complete']>): ReturnType<ModelClient['complete']> {
    return this.current.complete(...args)
  }
  budget(...args: Parameters<ModelClient['budget']>): ReturnType<ModelClient['budget']> {
    return this.current.budget(...args)
  }
}

const HELP: readonly [string, string][] = [
  ['/help', 'these commands'],
  ['/new', 'a new session in this folder (also /clear)'],
  ['/sessions', "this folder's sessions"],
  ['/resume <id>', 'carry on with a session'],
  ['/mode [code|ask|plan]', 'what the agent may do: change files, only read, or plan first'],
  ['/policy [policy]', 'read-only, workspace-write, full-access or auto-review'],
  ['/model [model]', 'the model, for example openrouter:<id> or demo'],
  ['/best <2-4> <request>', 'several attempts side by side; keep the best'],
  ['/compact [what to keep]', 'shorten the conversation into a summary'],
  ['/todos', "the agent's task list"],
  ['/cost', 'what this session has used'],
  ['/trust', 'trust this folder: its settings, hooks and servers apply'],
  ['/status', 'model, folder, policy, mode and sandbox'],
  ['/exit', 'leave (also Ctrl+D)'],
]

const PLAN_PREFIX = 'Execute the approved plan:\n\n'

type Waiter = (line: string | null) => void

export async function runRepl(options: CliOptions, firstPrompt: string, model: ModelChoice, root: string, io: ReplIo): Promise<number> {
  const style: Style = styleFor(Boolean(io.output.isTTY), io.env, options.color)
  const client = new SwitchableClient(model.client)
  let label = model.label
  let secrets = [...model.secrets]
  const scrub = (text: string) => redactSecrets(text, secrets)
  const write = (text: string) => void io.output.write(scrub(text))
  const renderer = new Renderer({ style, root, write })
  const say = (text = '') => renderer.line(text)

  const settings = settingsFor(options)
  let mode: AgentMode = options.mode
  let sessionId = ''
  let running = false
  let closed = false
  let lastInterrupt = 0
  const entries = new Map<string, ConversationEntry>()
  const pending: (() => Promise<void>)[] = []
  let pumping = false
  let waiter: Waiter | null = null
  let buffer: string[] = []
  let runtime: Runtime | undefined

  const terminal = Boolean(io.input.isTTY && io.output.isTTY)
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal, historySize: 500, prompt: '› ' })
  const prompt = () => {
    if (closed) return
    rl.setPrompt(buffer.length ? '. ' : '› ')
    rl.prompt()
  }

  /** The next line the person types, or null when they press Ctrl+C or leave. */
  const ask = (question: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) return resolve(null)
      waiter = (line) => {
        waiter = null
        resolve(line)
      }
      rl.setPrompt(question)
      rl.prompt()
    })

  const yes = async (question: string, byDefault: boolean): Promise<boolean> => {
    const answer = (await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `))?.trim().toLowerCase()
    if (answer === null || answer === undefined) return false
    return answer === '' ? byDefault : answer === 'y' || answer === 'yes'
  }

  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (pending.length) await pending.shift()!()
    } finally {
      pumping = false
    }
  }

  async function answerApproval(request: ApprovalRequest): Promise<void> {
    for (const line of approvalLines(request, style)) say(scrub(line))
    const choices = ['y yes']
    if (request.grantable) choices.push('s yes for this session')
    if (request.always) choices.push(`a always (${firstLine(request.always.rules.join(', '), 80)})`)
    choices.push('n no, or type what to do instead')
    say(style.dim(`  ${choices.join(' · ')}`))
    const word = request.tool === 'EnterPlanMode' ? 'Plan first?' : request.tool === 'StrongerModel' ? 'Use the stronger model?' : 'Allow?'
    const keys = ['Y', 'n', ...(request.grantable ? ['s'] : []), ...(request.always ? ['a'] : [])]
    const line = await ask(`${word} [${keys.join('/')}] `)
    let answer: ApprovalAnswer
    if (line === null) {
      answer = { approved: false }
      if (running) runtime?.host.cancel(sessionId)
    } else {
      const text = line.trim()
      const lower = text.toLowerCase()
      if (lower === '' || lower === 'y' || lower === 'yes') answer = { approved: true }
      else if (lower === 's' && request.grantable) answer = { approved: true, remember: 'session' }
      else if (lower === 'a' && request.always) answer = { approved: true, remember: 'always', scope: 'user' }
      else if (lower === 'n' || lower === 'no') answer = { approved: false }
      else answer = { approved: false, note: text }
    }
    runtime?.host.approve(request.id, answer)
  }

  async function answerQuestion(request: AskRequest): Promise<void> {
    for (const line of askLines(request, style)) say(scrub(line))
    const line = await ask(request.options?.length ? 'Answer (a number, or your own words): ' : 'Answer: ')
    if (line === null) {
      if (running) runtime?.host.cancel(sessionId)
      return
    }
    const number = Number(line.trim())
    const option = Number.isInteger(number) && number >= 1 ? request.options?.[number - 1] : undefined
    runtime?.host.answer(request.id, option ?? line.trim())
  }

  const emit = (event: AgentEvent) => {
    if (event.sessionId !== sessionId) return
    if (event.type === 'entry') entries.set(event.entry.id, event.entry)
    if (event.type === 'approval-request') {
      renderer.breakLine()
      pending.push(() => answerApproval(event.request))
      void pump()
      return
    }
    if (event.type === 'ask') {
      renderer.breakLine()
      const { sessionId: _session, type: _type, ...request } = event
      pending.push(() => answerQuestion(request))
      void pump()
      return
    }
    renderer.event(event)
  }

  async function send(text: string, best?: number): Promise<void> {
    if (!runtime) return
    const host = runtime.host
    const before = new Set(entries.keys())
    for (const entry of (await host.history(sessionId)).entries) before.add(entry.id)
    running = true
    const started = Date.now()
    try {
      await host.start(sessionId, { text, mode, ...(best ? { best } : {}) })
    } catch (error) {
      say(style.red(`x ${firstLine(scrub(error instanceof Error ? error.message : String(error)), 300)}`))
    } finally {
      running = false
    }
    say(style.dim(`  ${usageLine(renderer.usage, Date.now() - started)}`))
    renderer.usage = undefined
    await afterRequest(before)
  }

  /** What a request leaves to the person: a plan to carry out, lines for the instructions file, an attempt to keep. */
  async function afterRequest(before: Set<string>): Promise<void> {
    if (!runtime || closed) return
    const host = runtime.host
    const fresh = [...entries.values()].filter((entry) => !before.has(entry.id))
    for (const entry of fresh) {
      if (entry.kind === 'notice' && entry.suggestion?.state === 'open') {
        if (await yes(`Add these lines to ${plain(entry.suggestion.file)}?`, false)) {
          const outcome = await host.answerSuggestion(sessionId, entry.id, true)
          say(outcome.ok ? style.dim(`  Added to ${plain(outcome.file ?? entry.suggestion.file)}.`) : style.red(`x ${plain(outcome.error)}`))
        } else await host.answerSuggestion(sessionId, entry.id, false)
      }
      const best = entries.get(entry.id)?.best
      if (best?.state === 'ready') await pickAttempt(entry.id)
    }
    const plan = await host.plan(sessionId)
    if (plan && !closed) {
      if (await yes('Carry out this plan?', false)) {
        await host.setPlan(sessionId, null)
        mode = 'code'
        say(style.dim('  Mode: code'))
        await send(`${PLAN_PREFIX}${plan.plan}`)
      } else say(style.dim('  The plan waits. Say what to change, or /mode code to go ahead without it.'))
    }
  }

  async function pickAttempt(entryId: string): Promise<void> {
    if (!runtime) return
    const best = entries.get(entryId)?.best
    if (!best) return
    say(style.bold('Attempts'))
    for (const attempt of best.attempts) {
      const facts = [attempt.state, counted(attempt.files.length, 'file'), attempt.checks === 'none' ? 'no checks' : `checks ${attempt.checks}`]
      say(`  ${attempt.n}. ${facts.join(' · ')}${attempt.note ? style.dim(` · ${firstLine(attempt.note, 100)}`) : ''}`)
    }
    if (best.pick) say(style.dim(`  ${best.pickedBy === 'checks' ? 'The checks pick' : 'The Reviewer picks'} ${best.pick}${best.reason ? `: ${firstLine(best.reason, 160)}` : ''}`))
    const line = await ask(`Keep which attempt? [1-${best.attempts.length}, d discards all, Enter decides later] `)
    const text = line?.trim().toLowerCase() ?? ''
    if (!text) return say(style.dim('  The attempts wait in their worktrees.'))
    const keep = text === 'd' ? 0 : Number(text)
    if (!Number.isInteger(keep) || keep < 0 || keep > best.attempts.length) return say(style.red('x That is not one of the attempts.'))
    const outcome = await runtime.host.answerBest(sessionId, entryId, keep)
    say(outcome.ok ? style.dim(keep ? `  Kept attempt ${keep}${outcome.files?.length ? `: ${counted(outcome.files.length, 'file')} changed` : ''}.` : '  Discarded the attempts.') : style.red(`x ${plain(outcome.error)}`))
  }

  async function status(): Promise<void> {
    if (!runtime) return
    const sandbox = runtime.sandbox ? (runtime.sandbox.state === 'active' ? 'sandbox on' : `sandbox off: ${plain(runtime.sandbox.reason ?? runtime.sandbox.state)}`) : 'sandbox off (--no-sandbox)'
    say(`${style.bold(`eNCode ${VERSION}`)}  ${style.dim('·')}  ${plain(label)}`)
    say(style.dim(`${plain(runtime.root)}  ·  ${settings.policy}  ·  ${mode}  ·  ${sandbox}  ·  session ${sessionId.slice(0, 8)}`))
  }

  async function command(line: string): Promise<void> {
    if (!runtime) return
    const host = runtime.host
    const [name = '', ...words] = line.slice(1).split(/\s+/)
    const rest = line.slice(1 + name.length).trim()
    switch (name.toLowerCase()) {
      case 'help':
      case '?':
        for (const [usage, what] of HELP) say(`  ${usage.padEnd(26)}${style.dim(what)}`)
        say(style.dim('  A line ending in \\ goes on to the next. Ctrl+C stops a request; Ctrl+D leaves.'))
        return
      case 'exit':
      case 'quit':
        rl.close()
        return
      case 'new':
      case 'clear': {
        sessionId = (await host.create({ projectRoot: runtime.root })).id
        entries.clear()
        say(style.dim(`  New session ${sessionId.slice(0, 8)}.`))
        return
      }
      case 'sessions': {
        const sessions = await folderSessions(host, runtime.root)
        if (!sessions.length) return say(style.dim('  No sessions in this folder yet.'))
        for (const session of sessions.slice(0, 20)) say(`  ${session.id === sessionId ? style.bold(sessionLine(session)) : sessionLine(session)}`)
        if (sessions.length > 20) say(style.dim(`  and ${counted(sessions.length - 20, 'more')}`))
        return
      }
      case 'resume': {
        if (!rest) return say(style.red('x /resume takes a session id; /sessions lists them.'))
        const { session } = await chooseSession(host, runtime.root, { continue: false, resume: rest })
        sessionId = session.id
        entries.clear()
        const history = await host.history(sessionId)
        for (const entry of history.entries) entries.set(entry.id, entry)
        say(style.dim(`  Session ${sessionId.slice(0, 8)}: ${firstLine(session.title || 'New session', 80)}`))
        const last = [...history.entries].reverse().find((entry) => entry.kind === 'assistant' && entry.text?.trim())
        if (last) say(style.dim(`  Last reply: ${firstLine(scrub(last.text ?? ''), 160)}`))
        return
      }
      case 'mode': {
        if (!words[0]) return say(`  ${mode}`)
        if (!MODES.includes(words[0] as AgentMode)) return say(style.red(`x /mode is one of ${MODES.join(', ')}`))
        mode = words[0] as AgentMode
        return say(style.dim(`  Mode: ${mode}`))
      }
      case 'policy': {
        if (!words[0]) return say(`  ${settings.policy}`)
        if (!POLICIES.includes(words[0] as ApprovalPolicy)) return say(style.red(`x /policy is one of ${POLICIES.join(', ')}`))
        settings.policy = words[0] as ApprovalPolicy
        return say(style.dim(`  Policy: ${settings.policy}`))
      }
      case 'model': {
        if (!rest) return say(`  ${plain(label)}`)
        const next = await chooseModel(rest, undefined, io.env, (text) => say(style.dim(`  ${plain(text)}`)))
        client.current = next.client
        label = next.label
        secrets = [...new Set([...secrets, ...next.secrets])]
        if (next.free) say(style.yellow("  OpenRouter's free models may keep what they are sent: keep secrets and private code out."))
        return say(style.dim(`  Model: ${plain(label)}`))
      }
      case 'best': {
        const count = Number(words[0])
        const request = rest.slice((words[0] ?? '').length).trim()
        if (!Number.isInteger(count) || count < 2 || count > 4 || !request) return say(style.red('x /best takes 2 to 4 and a request: /best 3 make the parser faster'))
        if (mode !== 'code') return say(style.red('x /best works in code mode: /mode code first.'))
        return send(request, count)
      }
      case 'compact': {
        const { removed } = await host.compact(sessionId, rest || undefined)
        return say(style.dim(removed ? `  Shortened ${counted(removed, 'entry', 'entries')} into a summary.` : '  Nothing to shorten yet.'))
      }
      case 'todos': {
        const todos = await host.todos(sessionId)
        if (!todos.length) return say(style.dim('  No tasks.'))
        for (const todo of todos) say(`  ${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'} ${firstLine(todo.text, 120)}`)
        return
      }
      case 'cost': {
        const history = await host.history(sessionId)
        let input = 0
        let output = 0
        let cost = 0
        let priced = true
        for (const entry of history.entries) {
          if (entry.kind !== 'user' || !entry.usage) continue
          input += entry.usage.inputTokens
          output += entry.usage.outputTokens
          if (entry.usage.cost === undefined) priced = false
          else cost += entry.usage.cost
        }
        return say(`  ${input.toLocaleString('en-US')} tokens in, ${output.toLocaleString('en-US')} out${priced && cost ? `, $${cost.toFixed(4)}` : ''}`)
      }
      case 'trust': {
        const outcome = await trustFolder(runtime.workspaces, runtime.root)
        return say(outcome.ok ? style.dim(`  ${outcome.text}`) : style.red(`x ${outcome.text}`))
      }
      case 'status':
        return status()
      default:
        say(style.red(`x No command /${plain(name)}. /help lists them.`))
    }
  }

  async function settleTrust(): Promise<void> {
    if (!runtime) return
    const report = await runtime.workspaces.report(runtime.root)
    if (report.trusted) return
    if (options.trust) {
      const outcome = await trustFolder(runtime.workspaces, runtime.root)
      if (!outcome.ok) say(style.red(`x ${outcome.text}`))
      return
    }
    say(style.bold(`${style.yellow('?')} Trust this folder?`))
    say(style.dim("  Until you do, its own settings, hooks, MCP servers and language servers stay off. eNCode still works here."))
    if (report.trustWarning) say(style.yellow(`  ! ${plain(report.trustWarning)}`))
    if (!(await yes('Trust it?', false))) return say(style.dim('  Not trusted. /trust changes that later.'))
    const outcome = await trustFolder(runtime.workspaces, runtime.root)
    if (!outcome.ok) return say(style.red(`x ${outcome.text}`))
    const after = await runtime.workspaces.report(runtime.root)
    if (after.configApproved || !after.heldBack.length) return
    say(style.bold('Its settings also ask for:'))
    for (const line of after.heldBack.slice(0, 12)) say(`  ${firstLine(line, 200)}`)
    if (await yes('Apply them?', false)) {
      const approved = await runtime.workspaces.act(runtime.root, { type: 'approve' })
      say(approved.ok ? style.dim('  Applied.') : style.red(`x ${plain(approved.reason)}`))
    } else say(style.dim('  Held back. They apply once approved here or in the app.'))
  }

  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>((resolve) => (resolveDone = resolve))

  rl.on('line', (line) => {
    if (waiter) return waiter(line)
    if (line.endsWith('\\')) {
      buffer.push(line.slice(0, -1))
      return prompt()
    }
    const text = [...buffer, line].join('\n').trim()
    buffer = []
    if (!text) return prompt()
    if (running) {
      if (text.startsWith('/')) say(style.dim('  The agent is working: wait for it, or press Ctrl+C to stop it.'))
      else say(style.dim(runtime?.host.steer(sessionId, text) ? '  Sent to the running request.' : '  The request had just ended; send it again.'))
      return
    }
    void (async () => {
      try {
        if (text.startsWith('/')) await command(text)
        else await send(text)
      } catch (error) {
        const message = error instanceof UsageError || error instanceof Error ? error.message : String(error)
        say(style.red(`x ${firstLine(scrub(message), 300)}`))
      }
      prompt()
    })()
  })

  const interrupt = () => {
    if (waiter) {
      write('\n')
      return waiter(null)
    }
    if (running) {
      say(style.dim('  Stopping...'))
      runtime?.host.cancel(sessionId)
      return
    }
    if (rl.line) {
      write('\n')
      buffer = []
      ;(rl as unknown as { line: string }).line = ''
      return prompt()
    }
    const now = Date.now()
    if (now - lastInterrupt < 2_000) return rl.close()
    lastInterrupt = now
    say(style.dim('  Press Ctrl+C again to leave, or Ctrl+D.'))
    prompt()
  }
  rl.on('SIGINT', interrupt)
  const stopListening = !terminal && io.onInterrupt ? io.onInterrupt(interrupt) : () => {}

  rl.on('close', () => {
    closed = true
    stopListening()
    waiter?.(null)
    if (running) runtime?.host.cancel(sessionId)
    write('\n')
    void (async () => {
      await runtime?.close()
      resolveDone(0)
    })()
  })

  // While the agent works the prompt is not shown; the person's typing still reaches it as steering.
  rl.pause()
  try {
    runtime = await openRuntime({
      root,
      ...(io.home ? { home: io.home } : {}),
      ...(io.platform ? { platform: io.platform } : {}),
      env: io.env,
      ...(io.profile ? { profile: io.profile } : {}),
      ...(io.tools ? { tools: io.tools } : {}),
      client,
      settings: () => settings,
      emit,
      sandbox: options.sandbox,
      nameSessions: true,
      warn: (text) => say(style.dim(`  ${plain(text)}`)),
    })
    const chosen = await chooseSession(runtime.host, runtime.root, options)
    sessionId = chosen.session.id
    if (chosen.resumed) for (const entry of (await runtime.host.history(sessionId)).entries) entries.set(entry.id, entry)
    await status()
    if (model.free) say(style.yellow("  OpenRouter's free models may keep what they are sent: keep secrets and private code out."))
    if (chosen.resumed) say(style.dim(`  Carrying on with ${firstLine(chosen.session.title || 'the session', 80)}.`))
    say(style.dim('  Type a request. /help lists the commands; Ctrl+C stops a request, Ctrl+D leaves.'))
    // The trust question is the first thing read, so nothing typed before it is taken for a request.
    await settleTrust()
    rl.resume()
    if (firstPrompt) {
      say(`${style.dim('›')} ${plain(firstPrompt)}`)
      await send(firstPrompt)
    }
    prompt()
  } catch (error) {
    rl.close()
    await done
    throw error
  }
  return done
}
