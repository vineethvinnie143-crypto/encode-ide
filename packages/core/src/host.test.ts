import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { messageText } from '@encode/providers'
import type { ManagedShell } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { toldWorkspaceRoot } from './environment'
import type { Script } from './scripted'
import { closeHarnesses, hostHarness, stubManagedShell, type HostHarness } from './testing'

after(closeHarnesses)

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The workspace root the model had been told about when it answered one request. */
const rootSeen = (h: HostHarness, request = 0) => toldWorkspaceRoot(h.client.requests[request].payload.messages)

/** Every session asks the same thing, calls a tool once, then says it is done. */
const callOnce = (call: () => { name: string; input: Record<string, unknown> }): Script => (request) => {
  const last = request.payload.messages.at(-1)
  const answered = last?.role === 'user' && last.content.some((block) => block.type === 'tool-result')
  return answered ? { text: 'done' } : { calls: [call()] }
}

describe('sessions', () => {
  it('opens with one session, and lists the same one afterwards', async () => {
    const h = await hostHarness()
    const first = await h.host.sessions()
    assert.equal(first.length, 1)
    assert.equal(first[0].projectRoot, h.root)
    assert.equal(first[0].title, 'New session')
    assert.deepEqual((await h.host.sessions()).map((session) => session.id), [first[0].id])
    assert.deepEqual(await h.host.history(), { entries: [], status: 'idle', approval: null, approvals: [], ask: null })
  })

  it('creates sessions in the open folder, in another project, or in none', async () => {
    const other = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const here = await h.host.create()
    const there = await h.host.create({ projectRoot: other, title: '  Elsewhere  ' })
    const nowhere = await h.host.create({ projectRoot: null })
    assert.equal(here.projectRoot, h.root)
    assert.equal(there.projectRoot, other)
    assert.equal(there.title, 'Elsewhere')
    assert.equal(nowhere.projectRoot, null)

    await h.host.start(there.id, { text: 'where am I', mode: 'code' })
    assert.equal(rootSeen(h), await fs.realpath(other))
    // A session without a project follows the open folder.
    await h.host.start(nowhere.id, { text: 'and me', mode: 'code' })
    assert.equal(rootSeen(h, 1), await fs.realpath(h.root))
  })

  it('moves sessions that follow the folder when the folder changes, but not those with a project', async () => {
    const next = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const free = await h.host.create({ projectRoot: null })
    const fixed = await h.host.create()
    await h.host.start(free.id, { text: 'one', mode: 'code' })
    await h.host.start(fixed.id, { text: 'two', mode: 'code' })
    await h.host.setWorkspace(next)
    await h.host.start(free.id, { text: 'three', mode: 'code' })
    await h.host.start(fixed.id, { text: 'four', mode: 'code' })
    const real = await fs.realpath(h.root)
    assert.deepEqual([0, 1, 2, 3].map((request) => rootSeen(h, request)), [real, real, await fs.realpath(next), real])
    // The model is told that its folder changed, and only then.
    const told = (request: number) => messageText(h.client.requests[request].payload.messages.at(-1)!)
    assert.match(told(2), /The workspace changed: this session was working in .+ and now works in the folder below/)
    assert.doesNotMatch(told(3), /The workspace changed/)
  })

  it('serves a session asked for while the folder change is still closing it, and the session can write', async () => {
    const next = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const free = await h.host.create({ projectRoot: null })
    await h.host.start(free.id, { text: 'one', mode: 'code' })
    // The change starts closing the idle session; the window asks for it in the same moment.
    const moving = h.host.setWorkspace(next)
    const [history] = await Promise.all([h.host.history(free.id), moving])
    assert.deepEqual(history.entries.map((entry) => entry.kind), ['user', 'assistant'])
    await h.host.reset(free.id)
    await h.host.rename(free.id, 'Renamed')
    await h.host.start(free.id, { text: 'two', mode: 'code' })
    assert.equal(rootSeen(h, 1), await fs.realpath(next))
  })

  it('closes cleanly while a folder change is still closing a session', async () => {
    const next = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const free = await h.host.create({ projectRoot: null })
    await h.host.start(free.id, { text: 'one', mode: 'code' })
    const moving = h.host.setWorkspace(next)
    await h.host.dispose()
    await moving
    await assert.rejects(h.host.history(free.id), /host is closed/)
  })

  it('removes a session that a folder change is closing, with its file', async () => {
    const next = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const free = await h.host.create({ projectRoot: null })
    await h.host.start(free.id, { text: 'one', mode: 'code' })
    const moving = h.host.setWorkspace(next)
    await h.host.remove(free.id)
    await moving
    assert.equal((await h.host.sessions()).some((session) => session.id === free.id), false)
    await assert.rejects(h.host.history(free.id), /does not exist/)
  })

  it('leaves a running session where it is, and moves it when it is next used', async () => {
    const next = await tempWorkspace()
    const h = await hostHarness({ client: { delayMs: 20 }, script: [{ text: 'one two three four five six seven eight' }] })
    const free = await h.host.create({ projectRoot: null })
    const running = h.host.start(free.id, { text: 'one', mode: 'code' })
    await until(() => h.host.statuses()[free.id])
    await h.host.setWorkspace(next)
    await running
    assert.equal(rootSeen(h, 0), await fs.realpath(h.root))
    await h.host.start(free.id, { text: 'two', mode: 'code' })
    assert.equal(rootSeen(h, 1), await fs.realpath(next))
  })

  it('sends a session to another project when its project changes', async () => {
    const other = await tempWorkspace()
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'one', mode: 'code' })
    const moved = await h.host.update(session.id, { projectRoot: other, pinned: true })
    assert.equal(moved?.projectRoot, other)
    assert.equal(moved?.pinned, true)
    await h.host.start(session.id, { text: 'two', mode: 'code' })
    assert.equal(rootSeen(h, 1), await fs.realpath(other))
    // The conversation came along.
    assert.equal((await h.host.history(session.id)).entries.filter((entry) => entry.kind === 'user').length, 2)
    assert.equal(await h.host.update('nonexistent', { pinned: true }), null)
  })

  it('refuses to run when no folder is open and none belongs to the session', async () => {
    const h = await hostHarness({ noWorkspace: true, script: [{ text: 'never' }] })
    const [session] = await h.host.sessions()
    assert.equal(session.projectRoot, null)
    await assert.rejects(h.host.start(session.id, { text: 'go', mode: 'code' }), /Open a folder/)
    assert.equal(h.client.requests.length, 0)
    const folder = await tempWorkspace()
    await h.host.setWorkspace(folder)
    await h.host.start(session.id, { text: 'go', mode: 'code' })
    assert.equal(h.client.requests.length, 1)
  })

  it('names a missing session plainly', async () => {
    const h = await hostHarness()
    await assert.rejects(h.host.start('nope', { text: 'go', mode: 'code' }), /does not exist/)
    await assert.rejects(h.host.history('nope'), /does not exist/)
    assert.equal(h.host.approve('nope', true), false)
    assert.equal(h.host.answer('nope', 'x'), false)
    h.host.cancel('nope')
  })

  it('reports the sessions an agent is working in, and only those', async () => {
    const h = await hostHarness({ client: { delayMs: 25 }, script: [{ text: 'one two three four five six seven eight nine ten eleven' }] })
    const busy = await h.host.create()
    const idle = await h.host.create()
    assert.deepEqual(h.host.statuses(), {})
    const running = h.host.start(busy.id, { text: 'go', mode: 'code' })
    await until(() => h.host.statuses()[busy.id])
    assert.deepEqual(h.host.statuses(), { [busy.id]: 'thinking' })
    assert.equal((await h.host.history(idle.id)).status, 'idle')
    h.host.cancel(busy.id)
    await running
    assert.deepEqual(h.host.statuses(), {})
  })

  it('removes a session with its log, and makes a fresh one when none is left', async () => {
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const [only] = await h.host.sessions()
    await h.host.start(only.id, { text: 'hello', mode: 'code' })
    await h.host.remove(only.id)
    const after = await h.host.sessions()
    assert.equal(after.length, 1)
    assert.notEqual(after[0].id, only.id)
    assert.equal((await fs.readdir(h.dir)).some((name) => name.includes(only.id)), false)
  })

  it('resets one session or all of them', async () => {
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const a = await h.host.create()
    const b = await h.host.create()
    await h.host.start(a.id, { text: 'a', mode: 'code' })
    await h.host.start(b.id, { text: 'b', mode: 'code' })
    await h.host.reset(a.id)
    assert.equal((await h.host.history(a.id)).entries.length, 0)
    assert.equal((await h.host.history(b.id)).entries.length, 2)
    await h.host.reset()
    assert.equal((await h.host.history(b.id)).entries.length, 0)
  })

  it('goes back to before a request, and exports a session', async () => {
    const h = await hostHarness({ script: [{ text: 'first answer' }, { text: 'second answer' }] })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'first question', mode: 'code' })
    await h.host.start(session.id, { text: 'second question', mode: 'code' })
    const { entries } = await h.host.history(session.id)
    const second = entries.filter((entry) => entry.kind === 'user')[1]

    const exported = await h.host.exportData(session.id)
    assert.match(exported.transcript, /second question/)
    assert.equal(JSON.parse(exported.json).entries.length, 4)

    assert.deepEqual(await h.host.rewind(session.id, second.id), { text: 'second question' })
    assert.deepEqual((await h.host.history(session.id)).entries.map((entry) => entry.text), ['first question', 'first answer'])
    await assert.rejects(h.host.rewind(session.id, 'nope'))
  })

  it('renames, and keeps the todo list and plan', async () => {
    const h = await hostHarness()
    const session = await h.host.create()
    await h.host.rename(session.id, '  Better name ')
    assert.equal((await h.host.sessions()).find((entry) => entry.id === session.id)?.title, 'Better name')
    await h.host.setTodos(session.id, [{ id: 't1', text: 'Do it', status: 'pending' }])
    assert.deepEqual(await h.host.todos(session.id), [{ id: 't1', text: 'Do it', status: 'pending' }])
    await h.host.setPlan(session.id, { id: 'p1', plan: '1. Go' })
    assert.equal((await h.host.plan(session.id))?.plan, '1. Go')
    await h.host.setPlan(session.id, null)
    assert.equal(await h.host.plan(session.id), null)
  })
})

describe('forking', () => {
  it('copies the conversation without the marks, the plan or the goal progress', async () => {
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const original = await h.host.create()
    await h.host.start(original.id, { text: 'build it', mode: 'code' })
    await h.host.update(original.id, { pinned: true })
    await h.host.setGoal(original.id, { text: 'Ship', status: 'blocked', rounds: 4, createdAt: 1, updatedAt: 1 })
    await h.host.setPlan(original.id, { id: 'p1', plan: '1. Go' })

    const copy = await h.host.fork(original.id)
    assert.notEqual(copy.id, original.id)
    assert.match(copy.title, /\(fork\)$/)
    assert.equal(copy.pinned, false)
    assert.equal(copy.projectRoot, original.projectRoot)
    assert.deepEqual((await h.host.history(copy.id)).entries.map((entry) => entry.text), ['build it', 'ok'])
    assert.equal((await h.host.goal(copy.id))?.rounds, 0)
    assert.equal(await h.host.plan(copy.id), null)
    // The original keeps everything.
    assert.equal((await h.host.sessions()).find((entry) => entry.id === original.id)?.pinned, true)
    assert.equal((await h.host.goal(original.id))?.rounds, 4)
    assert.equal((await h.host.plan(original.id))?.plan, '1. Go')

    // The model's side came along, so the copy carries on from the same point.
    await h.host.start(copy.id, { text: 'now test it', mode: 'code' })
    const sent = JSON.stringify(h.client.requests.at(-1)!.payload.messages)
    assert.match(sent, /build it/)
    assert.match(sent, /now test it/)
  })
})

describe('goals', () => {
  const goal = { text: 'Ship v1', status: 'active' as const, rounds: 0, createdAt: 1, updatedAt: 1 }

  it('keeps the agent working until it says the goal is done', async () => {
    const h = await hostHarness({
      script: (_request, step) => (step === 2 ? { calls: [{ name: 'UpdateGoal', input: { status: 'complete' } }] } : { text: `round ${step}` }),
    })
    const session = await h.host.create()
    await h.host.setGoal(session.id, goal)
    await h.host.start(session.id, { text: 'work on it', mode: 'code' })
    await until(() => h.of('goal', session.id).some((event) => event.goal?.status === 'complete'))
    assert.equal(h.client.requests.length, 3)
    assert.match(JSON.stringify(h.client.requests[1].payload.messages.at(-1)), /Continue working toward the active goal/)
    const done = await h.host.goal(session.id)
    assert.deepEqual({ status: done?.status, rounds: done?.rounds }, { status: 'complete', rounds: 2 })
  })

  it('stops at the round limit and marks the goal blocked', async () => {
    const h = await hostHarness({ script: [{ text: 'still working' }], settings: { maxGoalRounds: 2 } })
    const session = await h.host.create()
    await h.host.setGoal(session.id, goal)
    await h.host.start(session.id, { text: 'work on it', mode: 'code' })
    await until(() => h.of('goal', session.id).some((event) => event.goal?.status === 'blocked'))
    assert.equal(h.client.requests.length, 3)
    assert.equal((await h.host.goal(session.id))?.rounds, 2)
  })

  it('does not carry on after the user stops the agent', async () => {
    const h = await hostHarness({ client: { delayMs: 20 }, script: [{ text: 'one two three four five six seven eight nine ten' }] })
    const session = await h.host.create()
    await h.host.setGoal(session.id, goal)
    const running = h.host.start(session.id, { text: 'work on it', mode: 'code' })
    // Stopping before the model has been asked would end the turn with no request at all, and prove nothing.
    await until(() => h.client.requests.length === 1)
    h.host.cancel(session.id)
    await running
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(h.client.requests.length, 1)
    assert.equal((await h.host.goal(session.id))?.rounds, 0)
  })

  it('does not carry on once the host is closed', async () => {
    const h = await hostHarness({ script: [{ text: 'ok' }], host: { goalDelayMs: 60 } })
    const session = await h.host.create()
    await h.host.setGoal(session.id, goal)
    await h.host.start(session.id, { text: 'work on it', mode: 'code' })
    await h.host.dispose()
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(h.client.requests.length, 1)
  })
})

describe('approvals across sessions', () => {
  it('delivers an answer to the session that asked, leaving the others waiting', async () => {
    let notes = 0
    const h = await hostHarness({
      scriptFor: (root) => callOnce(() => ({ name: 'Write', input: { file_path: path.join(root, '.encode', `note-${++notes}.md`), content: 'x' } })),
    })
    const a = await h.host.create()
    const b = await h.host.create()
    const first = h.host.start(a.id, { text: 'write', mode: 'code' })
    const second = h.host.start(b.id, { text: 'write', mode: 'code' })
    await until(() => h.of('approval-request').length === 2)
    const [forA, forB] = [a.id, b.id].map((id) => h.of('approval-request', id)[0].request.id)
    assert.deepEqual(h.host.statuses(), { [a.id]: 'awaiting-approval', [b.id]: 'awaiting-approval' })

    assert.equal(h.host.approve(forB, { approved: true }), true)
    await second
    assert.equal(h.host.statuses()[a.id], 'awaiting-approval')
    assert.equal((await h.host.history(a.id)).approval?.id, forA)
    assert.equal(h.host.approve(forB, true), false)

    assert.equal(h.host.approve(forA, { approved: false, note: 'not here' }), true)
    await first
    assert.deepEqual(h.host.statuses(), {})
  })

  it('answers a question put to the user', async () => {
    const h = await hostHarness({
      script: [
        { calls: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } }] },
        { text: 'noted' },
      ],
    })
    const session = await h.host.create()
    const running = h.host.start(session.id, { text: 'choose', mode: 'code' })
    const ask = await until(() => h.of('ask', session.id)[0])
    assert.equal(h.host.statuses()[session.id], 'awaiting-user')
    assert.equal(h.host.answer(ask.id, 'B'), true)
    await running
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /B/)
  })
})

describe('background jobs', () => {
  function jobShell(control: { finish?: (exitCode: number | null) => void; killed: boolean }) {
    return (root: string): ManagedShell => ({
      ...stubManagedShell(root),
      start: async (_command, options) => {
        options.onOutput?.('listening on 3000\n')
        let finish!: (exitCode: number | null) => void
        const done = new Promise<{ exitCode: number | null; signal: string | null; cwdFile: string }>((resolve) => {
          finish = (exitCode) => resolve({ exitCode, signal: null, cwdFile: '' })
        })
        control.finish = finish
        return {
          child: {} as ChildProcess,
          done,
          kill: async () => {
            control.killed = true
            finish(null)
          },
        }
      },
    })
  }

  const startServer = callOnce(() => ({ name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }))

  it('names jobs by session, reports changes, and reads and stops them', async () => {
    const control = { killed: false } as { finish?: (exitCode: number | null) => void; killed: boolean }
    const h = await hostHarness({ script: startServer, settings: { policy: 'full-access' }, host: { createShell: jobShell(control) } })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'run the dev server', mode: 'code' })

    const [job] = h.host.jobs()
    assert.equal(job.id, `${session.id}:bash_1`)
    assert.equal(job.sessionId, session.id)
    assert.equal(job.status, 'running')
    assert.equal(job.command, 'npm run dev')
    assert.match(h.host.jobOutput(job.id), /listening on 3000/)
    assert.ok(h.jobReports.length >= 1)

    await h.host.killJob(job.id)
    assert.equal(control.killed, true)
    await until(() => h.host.jobs()[0].status === 'killed')
    assert.equal(h.host.jobOutput('nope:bash_1'), '')
    assert.equal(h.host.jobOutput('bash_1'), '')
  })

  it('shows a command that finished by itself', async () => {
    const control = { killed: false } as { finish?: (exitCode: number | null) => void; killed: boolean }
    const h = await hostHarness({ script: startServer, settings: { policy: 'full-access' }, host: { createShell: jobShell(control) } })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'run it', mode: 'code' })
    control.finish!(0)
    await until(() => h.host.jobs()[0].status === 'done')
    assert.equal(h.host.jobs()[0].exitCode, 0)
    assert.equal(control.killed, false)
  })

  it('keeps the jobs of different sessions apart', async () => {
    const control = { killed: false } as { finish?: (exitCode: number | null) => void; killed: boolean }
    const h = await hostHarness({ script: startServer, settings: { policy: 'full-access' }, host: { createShell: jobShell(control) } })
    const a = await h.host.create()
    const b = await h.host.create()
    await h.host.start(a.id, { text: 'one', mode: 'code' })
    await h.host.start(b.id, { text: 'two', mode: 'code' })
    assert.deepEqual(h.host.jobs().map((job) => job.id).sort(), [`${a.id}:bash_1`, `${b.id}:bash_1`].sort())
  })
})

describe('wake-ups across a restart', () => {
  it('opens the sessions that asked to be woken, so the wake-up fires with nobody looking at them', async () => {
    const script: Script = [
      { calls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 600, reason: 'check the build', prompt: 'WAKE-PROMPT' } }] },
      { text: 'I will look again.' },
      { text: 'Looked again.' },
    ]
    const first = await hostHarness({ script, host: { timing: { wakeup: () => 60_000 } } })
    const [summary] = await first.host.sessions()
    await first.host.start(summary.id, { text: 'build it', mode: 'code' })
    assert.ok((await first.host.sessions())[0].wakeAt)
    assert.equal(first.host.jobs().find((job) => job.kind === 'wakeup')?.title, 'check the build')
    await first.host.dispose()

    const second = await hostHarness({ host: { dir: first.dir, client: first.client, workspace: first.root, home: first.home, timing: { gather: 5, wakeup: () => 0 } } })
    assert.equal(await second.host.resumeWakeups(), 1)
    await until(() => first.client.requests.length === 3)
    await until(() => second.of('done', summary.id).length === 1)
    assert.match(JSON.stringify(first.client.requests[2].payload.messages.at(-1)), /WAKE-PROMPT/)
    assert.equal(await second.host.resumeWakeups(), 0)
  })
})
