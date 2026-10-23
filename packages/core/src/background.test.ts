/**
 * Work in the background of a session: subagents started with run_in_background, SendMessage, Monitor and
 * ScheduleWakeup, and how what they report reaches the main agent (between its steps, with the person's next message,
 * or in a turn of its own), also across a restart.
 */
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import type { ManagedShell, RunningCommand } from '@encode/tools'
import { createScriptedClient, type ScriptedClient, type ScriptedStep } from './scripted'
import { AgentSession, type SessionEnv } from './session'
import type { AgentSettings } from './types'
import { closeHarnesses, sessionHarness, stubManagedShell, type SessionHarness } from './testing'

after(closeHarnesses)

// ------------------------------------------------------------ helpers

type Step = ScriptedStep | ((request: CompletionRequest) => ScriptedStep)
type Hold = (request: CompletionRequest, who: 'main' | 'sub', index: number) => Promise<void> | undefined

interface Model extends ScriptedClient {
  /** The main agent's requests, and the subagents'. */
  main: CompletionRequest[]
  sub: CompletionRequest[]
}

/** A model that answers the main agent and its subagents from two scripts; `hold` keeps an answer back until it resolves. */
function model(main: Step[], sub: Step[] = [{ text: 'SUB-REPORT' }], hold?: Hold): Model {
  const pick = (steps: Step[], index: number, request: CompletionRequest): ScriptedStep => {
    const step = steps[Math.min(index, steps.length - 1)]
    return typeof step === 'function' ? step(request) : step
  }
  const mainClient = createScriptedClient((request, index) => pick(main, index, request))
  const subClient = createScriptedClient((request, index) => pick(sub, index, request))
  const requests: CompletionRequest[] = []
  const mainRequests: CompletionRequest[] = []
  const subRequests: CompletionRequest[] = []
  return {
    requests,
    main: mainRequests,
    sub: subRequests,
    budget: (role) => mainClient.budget(role),
    async complete(request) {
      requests.push(request)
      const who = request.agent ? 'sub' : 'main'
      const list = who === 'sub' ? subRequests : mainRequests
      list.push(request)
      const wait = hold?.(request, who, list.length - 1)
      if (wait) await abortable(wait, request.signal)
      return (who === 'sub' ? subClient : mainClient).complete(request)
    },
  }
}

function abortable(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    wait.then(resolve, reject)
  })
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

const never = (): Promise<void> => new Promise<void>(() => undefined)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await sleep(5)
  }
}

const textOf = (message: Message): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? JSON.stringify(block.content) : '')).join('\n')
const lastUser = (request: CompletionRequest): string => textOf(request.payload.messages.at(-1)!)
const allText = (request: CompletionRequest): string => request.payload.messages.map(textOf).join('\n')

const task = (extra: Record<string, unknown> = {}) => ({ name: 'Task', input: { description: 'Do the work', prompt: 'SUB-BRIEF', subagent_type: 'general-purpose', ...extra } })
const startedId = (request: CompletionRequest): string => /Started agent (agent_[0-9a-f]+)/.exec(allText(request))?.[1] ?? 'missing'

/** A shell whose background commands print what the test tells them to, and end when it says. */
function scriptedShell(): { create: (root: string) => ManagedShell; emit(command: string, text: string): void; end(command: string, code: number): void } {
  const running = new Map<string, { emit(text: string): void; end(code: number | null): void }>()
  return {
    create: (root) => ({
      ...stubManagedShell(root),
      start: async (command, options): Promise<RunningCommand> => {
        let finish!: (value: { exitCode: number | null; signal: string | null; cwdFile: string }) => void
        const done = new Promise<{ exitCode: number | null; signal: string | null; cwdFile: string }>((resolve) => (finish = resolve))
        const handle = { emit: (text: string) => options.onOutput?.(text), end: (code: number | null) => finish({ exitCode: code, signal: null, cwdFile: '' }) }
        running.set(command, handle)
        return { child: {} as ChildProcess, done, kill: async () => handle.end(null) }
      },
    }),
    emit: (command, text) => running.get(command)!.emit(text),
    end: (command, code) => running.get(command)!.end(code),
  }
}

const FAST = { gather: 5, monitorBatch: 5 }

async function harness(client: Model, options: { env?: Partial<SessionEnv>; settings?: Partial<AgentSettings>; createShell?: (root: string) => ManagedShell } = {}): Promise<SessionHarness> {
  return sessionHarness({
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.createShell ? { createShell: options.createShell } : {}),
    env: { client, timing: FAST, ...options.env },
  })
}

// ------------------------------------------------------------ subagents

describe('a subagent in the background', () => {
  it('reports in a turn of its own once the agent is idle, which is no request of the person', async () => {
    const release = gate()
    const client = model([{ calls: [task({ run_in_background: true })] }, { text: 'Started it.' }, { text: 'Read the report.' }], [{ text: 'SUB-REPORT' }], (_request, who) =>
      who === 'sub' ? release.promise : undefined,
    )
    const h = await harness(client)
    const end = await h.session.start({ text: 'go', mode: 'code' })
    assert.equal(end.kind, 'done')
    const job = h.session.jobs().find((item) => item.kind === 'agent')
    assert.equal(job?.status, 'running')
    assert.equal(job?.command, 'Do the work')
    assert.equal(job?.title, 'general-purpose')
    assert.match(allText(client.main[1]), /Started agent agent_[0-9a-f]{8} in the background/)

    release.open()
    await until(() => client.main.length === 3, 'the turn for the report')
    await h.session.idle()
    const told = lastUser(client.main[2])
    assert.match(told, /Background work you started reports \(the user did not write this\)/)
    assert.match(told, /Subagent agent_[0-9a-f]{8} \(general-purpose: Do the work\) finished\. Its report:\nSUB-REPORT/)
    assert.match(told, /SendMessage to "agent_[0-9a-f]{8}" goes on with this work/)
    const entries = h.session.history().entries
    assert.equal(entries.filter((entry) => entry.kind === 'user').length, 1)
    assert.ok(entries.some((entry) => entry.kind === 'notice' && entry.text === 'Subagent finished: Do the work'))
    assert.equal(entries.at(-1)?.text, 'Read the report.')
    assert.equal(h.session.status(), 'done')
    assert.equal(h.session.jobs().find((item) => item.kind === 'agent')?.status, 'done')

    // Told once: after a restart there is nothing left to tell.
    const session = await h.reopen()
    await session.start({ text: 'next', mode: 'code' })
    assert.doesNotMatch(lastUser(client.main[3]), /Background work/)
  })

  it('reports between two steps of a turn that runs, without a turn of its own', async () => {
    const ready = gate()
    const client = model(
      [{ calls: [task({ run_in_background: true })] }, { calls: [{ name: 'Glob', input: { pattern: '*' } }] }, { text: 'Done.' }],
      [{ text: 'SUB-REPORT' }],
      (_request, who, index) => (who === 'main' && index === 1 ? ready.promise : undefined),
    )
    const h = await harness(client)
    const running = h.session.start({ text: 'go', mode: 'code' })
    await until(() => h.session.jobs().some((job) => job.kind === 'agent' && job.status === 'done'), 'the subagent to end')
    ready.open()
    await running
    assert.match(lastUser(client.main[2]), /SUB-REPORT/)
    await sleep(40)
    assert.equal(client.main.length, 3)
  })

  it('reads a message sent to it while it works, between two of its steps', async () => {
    const release = gate()
    let id = ''
    const client = model(
      [
        { calls: [task({ run_in_background: true })] },
        (request) => {
          id = startedId(request)
          return { text: 'Started.' }
        },
        () => ({ calls: [{ name: 'SendMessage', input: { to: id, message: 'CHANGE-PLAN' } }] }),
        { text: 'Told it.' },
        { text: 'Read the report.' },
      ],
      [{ calls: [{ name: 'Glob', input: { pattern: '*' } }] }, { text: 'SUB-REPORT' }],
      (_request, who, index) => (who === 'sub' && index === 0 ? release.promise : undefined),
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await h.session.start({ text: 'tell it', mode: 'code' })
    assert.match(allText(client.main[3]), /Delivered to agent_[0-9a-f]{8}; it reads it before its next step/)
    release.open()
    await until(() => client.main.length === 5, 'the report')
    await h.session.idle()
    assert.match(allText(client.sub[1]), /The main agent sent this while you worked[^]*CHANGE-PLAN/)
  })

  it('goes on from where it finished, with everything it saw, also after a restart', async () => {
    let id = ''
    const client = model(
      [
        { calls: [task()] },
        (request) => {
          id = /agent id: (agent_[0-9a-f]+)/.exec(allText(request))?.[1] ?? 'missing'
          return { text: 'First part done.' }
        },
        () => ({ calls: [{ name: 'SendMessage', input: { to: id, message: 'NEXT-PART' } }] }),
        { text: 'Second part done.' },
      ],
      [{ text: 'FIRST-REPORT' }, { text: 'SECOND-REPORT' }],
    )
    const h = await harness(client)
    await h.session.start({ text: 'first', mode: 'code' })
    assert.match(id, /^agent_[0-9a-f]{8}$/)
    const session = await h.reopen()
    await session.start({ text: 'second', mode: 'code' })
    const resumed = client.sub[1]
    assert.equal(resumed.agent, id)
    const seen = allText(resumed)
    assert.ok(seen.includes('SUB-BRIEF') && seen.includes('FIRST-REPORT') && seen.includes('NEXT-PART'), seen)
    assert.match(allText(client.main[3]), /SECOND-REPORT/)
    // The subagent's messages never enter the main conversation.
    assert.doesNotMatch(allText(client.main[3]), /SUB-BRIEF/)
  })

  it('is named with the next message after eNCode closed on it, and SendMessage takes it on', async () => {
    let id = ''
    const client = model(
      [
        { calls: [task({ run_in_background: true })] },
        (request) => {
          id = startedId(request)
          return { text: 'Started.' }
        },
        () => ({ calls: [{ name: 'SendMessage', input: { to: id, message: 'GO-ON' } }] }),
        { text: 'It finished.' },
      ],
      // The first request is held before the script is read, so the script's first step answers the second.
      [{ text: 'SUB-REPORT' }],
      (_request, who, index) => (who === 'sub' && index === 0 ? never() : undefined),
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await until(() => client.sub.length === 1, 'the subagent to start')
    const session = await h.reopen()
    await session.start({ text: 'what happened?', mode: 'code' })
    assert.match(lastUser(client.main[2]), new RegExp(`Subagent ${id} \\(general-purpose: Do the work\\) was cut off when eNCode closed\\. SendMessage to "${id}" goes on from where it stopped`))
    const seen = allText(client.sub[1])
    assert.ok(seen.includes('SUB-BRIEF') && seen.includes('GO-ON'), seen)
    assert.match(allText(client.main[3]), /SUB-REPORT/)
  })

  it('is told, not woken for, when the person stops a subagent', async () => {
    const client = model([{ calls: [task({ run_in_background: true })] }, { text: 'Started.' }, { text: 'Noted.' }], [{ text: 'never sent' }], (_request, who) =>
      who === 'sub' ? never() : undefined,
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await until(() => client.sub.length === 1, 'the subagent to start')
    const job = h.session.jobs().find((item) => item.kind === 'agent')!
    assert.equal(await h.session.killJob(job.id), true)
    assert.equal(h.session.jobs().find((item) => item.kind === 'agent')?.status, 'killed')
    await sleep(40)
    assert.equal(client.main.length, 2)
    await h.session.start({ text: 'and now?', mode: 'code' })
    const told = lastUser(client.main[2])
    assert.match(told, /The user stopped subagent agent_[0-9a-f]{8} \(general-purpose: Do the work\) before it finished/)
    assert.ok(told.indexOf('The user stopped') < told.indexOf('and now?'), 'the news comes before the person\'s words')
  })

  it('needs no notice when the agent stops one itself', async () => {
    let id = ''
    const client = model(
      [
        { calls: [task({ run_in_background: true })] },
        (request) => {
          id = startedId(request)
          return { calls: [{ name: 'KillShell', input: { shell_id: id } }] }
        },
        { text: 'Stopped it.' },
      ],
      [{ text: 'never sent' }],
      (_request, who) => (who === 'sub' ? never() : undefined),
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    assert.match(allText(client.main[2]), /Stopped agent agent_[0-9a-f]{8}: Do the work/)
    await sleep(40)
    assert.equal(client.main.length, 3)
  })

  it('keeps its question for the person after the turn ends, and the session rests again once it is answered', async () => {
    const client = model(
      [{ calls: [task({ run_in_background: true })] }, { text: 'Started.' }, { text: 'Read the report.' }],
      [{ calls: [{ name: 'Bash', input: { command: 'npm install left-pad', description: 'Install a package' } }] }, { text: 'SUB-REPORT' }],
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await until(() => (h.session.history().approvals ?? []).length === 1, 'the approval')
    await sleep(20)
    const [request] = h.session.history().approvals ?? []
    assert.match(request.title, /^Subagent: /)
    assert.equal(request.background, true, 'the client keeps the card when the turn ends')
    assert.equal(h.session.status(), 'awaiting-approval')
    assert.equal(h.session.resolveApproval(request.id, true), true)
    await until(() => client.main.length === 3, 'the report')
    await h.session.idle()
    assert.equal(h.session.status(), 'done')
  })

  it('is refused what it waits on when the person presses Stop with no turn running, and goes on without it', async () => {
    const client = model(
      [{ calls: [task({ run_in_background: true })] }, { text: 'Started.' }, { text: 'Read the report.' }],
      [{ calls: [{ name: 'Bash', input: { command: 'npm install left-pad', description: 'Install a package' } }] }, { text: 'SUB-REPORT' }],
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await until(() => (h.session.history().approvals ?? []).length === 1, 'the approval')
    await h.session.idle()
    h.session.cancel()
    assert.deepEqual(h.session.history().approvals ?? [], [])
    await until(() => client.sub.length === 2, 'the subagent to go on')
    assert.match(lastUser(client.sub[1]), /The user rejected this action/)
    await until(() => h.session.jobs().every((job) => job.status !== 'running'), 'the subagent to end')
    // Stop holds background news until the person writes, as it does for a turn.
    await sleep(40)
    assert.equal(client.main.length, 2)
    assert.equal(h.session.status(), 'done')
  })

  it('is announced as running to the Jobs tab as it starts, before its first step', async () => {
    const client = model([{ calls: [task({ run_in_background: true })] }, { text: 'Started.' }], [{ text: 'never sent' }], (_request, who) => (who === 'sub' ? never() : undefined))
    let session: AgentSession | undefined
    const announced: string[][] = []
    const h = await harness(client, { env: { jobsChanged: () => announced.push((session?.jobs() ?? []).map((job) => `${job.kind}:${job.status}`)) } })
    session = h.session
    await h.session.start({ text: 'go', mode: 'code' })
    assert.ok(announced.some((jobs) => jobs.includes('agent:running')), `announced: ${JSON.stringify(announced)}`)
    await h.session.reset()
  })

  it('stops with the conversation when it starts over', async () => {
    const client = model([{ calls: [task({ run_in_background: true })] }, { text: 'Started.' }], [{ text: 'never sent' }], (_request, who) => (who === 'sub' ? never() : undefined))
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    await until(() => client.sub.length === 1, 'the subagent to start')
    await h.session.reset()
    assert.deepEqual(h.session.jobs(), [])
    await sleep(40)
    assert.equal(client.main.length, 2)
    assert.equal(h.session.history().entries.length, 0)
  })

  it('takes no more than four at once', async () => {
    const client = model(
      [{ calls: Array.from({ length: 5 }, (_, index) => ({ ...task({ run_in_background: true, description: `Part ${index + 1}` }), id: `t${index}` })) }, { text: 'Started.' }],
      [{ text: 'never sent' }],
      (_request, who) => (who === 'sub' ? never() : undefined),
    )
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    const results = allText(client.main[1])
    assert.equal((results.match(/Started agent/g) ?? []).length, 4)
    assert.match(results, /4 subagents already work in the background/)
  })
})

// ------------------------------------------------------------ commands and monitors

describe('background commands and monitors', () => {
  it('tells the agent when a command it started in the background ends, with the end of its output', async () => {
    const fake = scriptedShell()
    const client = model([{ calls: [{ name: 'Bash', input: { command: 'npm run build', description: 'Build', run_in_background: true } }] }, { text: 'Building.' }, { text: 'Built.' }])
    const h = await harness(client, { createShell: fake.create, settings: { policy: 'full-access' } })
    await h.session.start({ text: 'build it', mode: 'code' })
    assert.match(allText(client.main[1]), /You are told when it ends, so do not wait for it/)
    fake.emit('npm run build', 'compiling\nbuilt in 2s\n')
    fake.end('npm run build', 0)
    await until(() => client.main.length === 3, 'the end of the build')
    await h.session.idle()
    assert.match(lastUser(client.main[2]), /Background command bash_1 \(`npm run build`\) finished with exit code 0\. The end of its output:\ncompiling\nbuilt in 2s/)
  })

  it('sends a monitor\'s lines in batches, leaves out what does not fit, and says when it ends', async () => {
    const fake = scriptedShell()
    const command = 'tail -f app.log'
    const client = model([{ calls: [{ name: 'Monitor', input: { command, description: 'Watch the log' } }] }, { text: 'Watching.' }, { text: 'Saw them.' }, { text: 'Saw more.' }, { text: 'It ended.' }])
    const h = await harness(client, { createShell: fake.create, settings: { policy: 'full-access' } })
    await h.session.start({ text: 'watch', mode: 'code' })
    assert.match(allText(client.main[1]), /Watching with id bash_1, for at most 300 s/)
    const job = h.session.jobs().find((item) => item.kind === 'monitor')
    assert.equal(job?.title, 'Watch the log')

    fake.emit(command, 'first\nsec')
    fake.emit(command, 'ond\n\nthird\r\n')
    await until(() => client.main.length === 3, 'the first lines')
    await h.session.idle()
    assert.match(lastUser(client.main[2]), /Monitor bash_1 \(Watch the log\):\nfirst\nsecond\nthird\n/)
    assert.ok(h.session.history().entries.some((entry) => entry.kind === 'notice' && entry.text === 'Watch the log: 3 new lines'))

    fake.emit(command, Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n') + '\n')
    await until(() => client.main.length === 4, 'the long batch')
    await h.session.idle()
    const batch = lastUser(client.main[3])
    assert.match(batch, /line 49\n\(10 more lines came at the same time and were left out/)
    assert.doesNotMatch(batch, /line 50/)

    fake.end(command, 1)
    await until(() => client.main.length === 5, 'the end')
    await h.session.idle()
    assert.match(lastUser(client.main[4]), /Monitor bash_1 \(Watch the log\) ended with exit code 1/)
  })

  it('stops a monitor at its time limit', async () => {
    const fake = scriptedShell()
    const client = model([{ calls: [{ name: 'Monitor', input: { command: 'watch', description: 'Wait for it', timeout_ms: 1000 } }] }, { text: 'Watching.' }, { text: 'Gave up.' }])
    const h = await harness(client, { createShell: fake.create, settings: { policy: 'full-access' } })
    await h.session.start({ text: 'watch', mode: 'code' })
    await until(() => client.main.length === 3, 'the time limit', 4_000)
    await h.session.idle()
    assert.match(lastUser(client.main[2]), /Monitor bash_1 \(Wait for it\) stopped at its time limit/)
  })

  it('waits for the person after twenty turns of news in a row', async () => {
    const fake = scriptedShell()
    const command = 'chatty'
    const client = model([{ calls: [{ name: 'Monitor', input: { command, description: 'Chatty', persistent: true } }] }, { text: 'ok' }])
    const h = await harness(client, { createShell: fake.create, settings: { policy: 'full-access' } })
    await h.session.start({ text: 'watch', mode: 'code' })
    assert.match(allText(client.main[1]), /until it ends or you stop it/)
    let count = 0
    const timer = setInterval(() => fake.emit(command, `tick ${count++}\n`), 10)
    try {
      await until(() => h.session.history().entries.some((entry) => entry.text?.includes('reported 20 times in a row')), 'the limit', 20_000)
    } finally {
      clearInterval(timer)
    }
    await h.session.idle()
    assert.equal(client.main.length, 2 + 20)
    await h.session.start({ text: 'what did you see?', mode: 'code' })
    assert.match(lastUser(client.main.at(-1)!), /Monitor bash_1 \(Chatty\):\ntick/)
  })
})

// ------------------------------------------------------------ wake-ups

describe('a wake-up', () => {
  it('wakes the agent once with the prompt it left, and is shown until then', async () => {
    const client = model([
      { calls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 600, reason: 'check the deploy', prompt: 'WAKE-PROMPT' } }] },
      { text: 'Will check.' },
      { text: 'Checked.' },
    ])
    const h = await harness(client, { env: { timing: { ...FAST, wakeup: () => 150 } } })
    await h.session.start({ text: 'deploy', mode: 'code' })
    assert.match(allText(client.main[1]), /You will be woken at \d/)
    assert.ok((h.session.summary().wakeAt ?? 0) > Date.now() + 500_000)
    assert.equal(h.session.jobs().find((job) => job.kind === 'wakeup')?.title, 'check the deploy')
    await until(() => client.main.length === 3, 'the wake-up')
    await h.session.idle()
    assert.match(lastUser(client.main[2]), /It is time for the wake-up you scheduled \(check the deploy\)\. What you asked yourself to do:\nWAKE-PROMPT/)
    assert.equal(h.session.summary().wakeAt, undefined)
    assert.equal(h.session.jobs().some((job) => job.kind === 'wakeup'), false)
    await sleep(200)
    assert.equal(client.main.length, 3, 'once')
  })

  it('outlives a restart, and says it is late when eNCode was closed at the time', async () => {
    const client = model([{ text: 'Hello.' }, { text: 'Woke.' }])
    const h = await harness(client, { env: { timing: { ...FAST, wakeup: (ms) => Math.min(ms, 30) } } })
    await h.session.start({ text: 'hi', mode: 'code' })
    const id = h.session.id
    await h.session.dispose()
    const log = (await h.store.open(id))!
    await log.append({ type: 'wakeup', wakeup: { at: Date.now() - 5 * 60_000, reason: 'look again', prompt: 'LATE-PROMPT' } })
    h.session = new AgentSession(log, h.env)
    await until(() => client.main.length === 2, 'the late wake-up')
    await h.session.idle()
    assert.match(lastUser(client.main[1]), /\(look again\)\. It comes 5 minutes late: eNCode was not running when it was due\. What you asked yourself to do:\nLATE-PROMPT/)
  })

  it('is taken back by the agent with cancel, and by the person, who the agent then hears about', async () => {
    const client = model([
      { calls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'first', prompt: 'P1' } }] },
      { calls: [{ name: 'ScheduleWakeup', input: { cancel: true } }] },
      { calls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'second', prompt: 'P2' } }] },
      { text: 'Set.' },
      { text: 'Heard.' },
    ])
    const h = await harness(client)
    await h.session.start({ text: 'go', mode: 'code' })
    assert.match(allText(client.main[2]), /The wake-up is cancelled/)
    assert.equal(h.session.jobs().find((job) => job.kind === 'wakeup')?.title, 'second')
    assert.equal(await h.session.killJob('wakeup'), true)
    await h.session.flush()
    assert.equal(h.session.summary().wakeAt, undefined)
    await h.session.start({ text: 'ok', mode: 'code' })
    assert.match(lastUser(client.main[4]), /The user cancelled the wake-up you scheduled \(second\)/)
  })

  it('is taken back by Stop, which also holds background news until the person writes', async () => {
    const release = gate()
    const client = model(
      [
        { calls: [task({ run_in_background: true })] },
        { calls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'look later', prompt: 'P' } }] },
        { text: 'never sent' },
        { text: 'Heard it all.' },
      ],
      [{ text: 'SUB-REPORT' }],
      (_request, who, index) => (who === 'sub' ? release.promise : index === 2 ? never() : undefined),
    )
    const h = await harness(client)
    const running = h.session.start({ text: 'go', mode: 'code' })
    await until(() => client.main.length === 3, 'the third step')
    h.session.cancel()
    assert.equal((await running).kind, 'cancelled')
    assert.equal(h.session.summary().wakeAt, undefined)
    release.open()
    await until(() => h.session.jobs().some((job) => job.kind === 'agent' && job.status === 'done'), 'the subagent to end')
    await sleep(40)
    assert.equal(client.main.length, 3, 'no turn after a Stop')
    await h.session.start({ text: 'carry on', mode: 'code' })
    const told = lastUser(client.main[3])
    assert.match(told, /SUB-REPORT/)
    assert.match(told, /The user stopped you, which also cancelled the wake-up you scheduled \(look later\)/)
  })
})
