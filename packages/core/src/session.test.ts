import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { Message } from '@encode/providers'
import { tempWorkspace } from '@encode/tools/testing'
import { closeHarnesses, sessionHarness, type SessionHarness } from './testing'

after(closeHarnesses)

const text = (message: Message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const shown = (h: SessionHarness) => h.session.history().entries.map((entry) => [entry.kind, entry.text])

describe('a session', () => {
  it('runs a turn, shows it as events and stores it', async () => {
    const h = await sessionHarness({ script: [{ text: 'Hello there' }] })
    const end = await h.session.start({ text: 'say hi', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'Hello there' })
    assert.deepEqual(shown(h), [['user', 'say hi'], ['assistant', 'Hello there']])
    assert.equal(h.session.history().status, 'done')
    assert.deepEqual(h.of('status').map((event) => event.status), ['thinking', 'done'])
    assert.equal(h.of('done').length, 1)
    assert.ok(h.events.every((event) => event.sessionId === h.session.id))
    assert.ok(h.of('usage').length >= 1)
    assert.equal(h.session.summary().title, 'say hi')

    const again = await h.reopen()
    assert.deepEqual(shown(h), [['user', 'say hi'], ['assistant', 'Hello there']])
    assert.equal(again.summary().title, 'say hi')
  })

  it('refuses a second turn while one runs, and an empty request', async () => {
    const h = await sessionHarness({ client: { delayMs: 20 }, script: [{ text: 'one two three four five six seven eight nine ten' }] })
    await assert.rejects(h.session.start({ text: '   ', mode: 'code' }), /Type a request first/)
    const running = h.session.start({ text: 'go', mode: 'code' })
    await assert.rejects(h.session.start({ text: 'again', mode: 'code' }), /already working/)
    h.session.cancel()
    await running
  })

  it('takes the next request as soon as a turn has reported its end, while that end is still being saved', async () => {
    const h = await sessionHarness({ script: [{ text: 'first' }, { text: 'second' }] })
    const flush = h.session.flush.bind(h.session)
    // A slow disk: the client has been told the turn is over and the session is still writing it down.
    h.session.flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      await flush()
    }
    let second: ReturnType<typeof h.session.start> | undefined
    const emit = h.env.emit
    h.env.emit = (event) => {
      emit(event)
      // A queued message goes out the moment the client hears "done", on a later tick as across a port.
      if (event.type === 'done' && !second) setImmediate(() => (second = h.session.start({ text: 'two', mode: 'code' })))
    }
    await h.session.start({ text: 'one', mode: 'code' })
    assert.ok(second)
    assert.deepEqual(await second, { kind: 'done', reply: 'second' })
    assert.deepEqual(shown(h), [['user', 'one'], ['assistant', 'first'], ['user', 'two'], ['assistant', 'second']])
  })

  it('stops on request, finishing what was streaming', async () => {
    const h = await sessionHarness({ client: { delayMs: 15 }, script: [{ text: 'one two three four five six seven eight nine ten eleven twelve' }] })
    const running = h.session.start({ text: 'talk', mode: 'code' })
    await until(() => h.of('delta')[0])
    h.session.cancel()
    const end = await running
    assert.equal(end.kind, 'cancelled')
    const entries = h.session.history().entries
    assert.ok(entries.every((entry) => !entry.streaming))
    assert.equal(entries.at(-1)?.text, 'Stopped.')
    assert.equal(h.session.status(), 'idle')
  })

  it('continues a stored conversation after a restart, telling the model about the environment once', async () => {
    const h = await sessionHarness({ files: { 'ENCODE.md': 'Use tabs.' }, script: [{ text: 'first' }, { text: 'second' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.reopen()
    await h.session.start({ text: 'two', mode: 'code' })

    const messages = h.client.requests.at(-1)!.payload.messages
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user'])
    assert.match(text(messages[0]), /Workspace root: /)
    assert.match(text(messages[0]), /Use tabs\./)
    assert.doesNotMatch(text(messages[2]), /Workspace root: /)
    // After a restart the agent cannot know what it was told last, so the project's instructions come again.
    assert.match(text(messages[2]), /Use tabs\./)
    assert.match(text(messages[2]), /two$/)
  })

  it('repeats the project instructions only when they change', async () => {
    const h = await sessionHarness({ files: { 'ENCODE.md': 'Use tabs.' }, script: [{ text: 'a' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.start({ text: 'two', mode: 'code' })
    await fs.writeFile(path.join(h.root, 'ENCODE.md'), 'Use spaces.')
    await h.session.start({ text: 'three', mode: 'code' })
    const messages = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user')
    assert.match(text(messages[0]), /Use tabs\./)
    assert.doesNotMatch(text(messages[1]), /Use tabs\./)
    assert.match(text(messages[2]), /changed since you last read them/)
    assert.match(text(messages[2]), /Use spaces\./)
  })

  it('reads the user\'s own instructions from their folder, and AGENTS.md as a fallback', async () => {
    const h = await sessionHarness({ homeFiles: { '.encode/ENCODE.md': 'Answer in Dutch.' }, files: { 'AGENTS.md': 'Run pnpm test.' }, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'go', mode: 'code' })
    const first = text(h.client.requests[0].payload.messages[0])
    assert.match(first, /Answer in Dutch\./)
    assert.match(first, /Run pnpm test\./)
  })

  it('announces the mode when it changes, the goal while it is active, and attached files', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.start({ text: 'two', mode: 'plan' })
    await h.session.start({ text: 'three', mode: 'plan' })
    h.session.setGoal({ text: 'Ship it', status: 'active', rounds: 0, createdAt: 1, updatedAt: 1 })
    await h.session.start({ text: 'four', mode: 'code', attachments: [{ path: 'src/a.ts', content: 'export const a = 1' }] })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.doesNotMatch(users[0], /Mode:/)
    assert.match(users[1], /Mode: plan/)
    assert.doesNotMatch(users[2], /Mode:/)
    assert.match(users[3], /Mode: code/)
    assert.match(users[3], /Active goal: Ship it/)
    assert.match(users[3], /<attached_files>\n--- src\/a\.ts ---\nexport const a = 1\n<\/attached_files>/)
    // The transcript shows what the user typed, not what was added to it.
    assert.equal(h.session.history().entries.filter((entry) => entry.kind === 'user').at(-1)?.text, 'four')
  })

  it('notes a new day to the model', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    ;(h.session as unknown as { turn: { date?: string } }).turn.date = '2001-01-01'
    await h.session.start({ text: 'two', mode: 'code' })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.match(users[1], /Today's date is now \d{4}-\d{2}-\d{2}\./)
  })

  it('lets a hook refuse a request before the model sees it', async () => {
    const h = await sessionHarness({ hooks: { async userPromptSubmit() { return { block: 'not today' } } }, script: [{ text: 'never' }] })
    const end = await h.session.start({ text: 'go', mode: 'code' })
    assert.equal(end.kind, 'cancelled')
    assert.equal(h.client.requests.length, 0)
    assert.match(h.session.history().entries.at(-1)?.text ?? '', /not today/)
    assert.equal(h.session.status(), 'idle')
  })
})

describe('approvals and questions', () => {
  const writeNote = (root: string) => [
    { calls: [{ name: 'Write', input: { file_path: path.join(root, '.encode', 'note.md'), content: 'x' } }] },
    { text: 'done' },
  ]

  it('asks for protected paths, and writes once the user approves', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.equal(h.session.status(), 'awaiting-approval')
    assert.match(request.title, /note\.md/)
    assert.ok(request.preview?.length)
    assert.equal(h.session.resolveApproval(request.id, true), true)
    assert.equal(h.session.resolveApproval(request.id, true), false)
    assert.equal((await running).kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, '.encode', 'note.md'), 'utf8'), 'x')
  })

  it('tells the model when the user refuses', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, false)
    await running
    await assert.rejects(fs.stat(path.join(h.root, '.encode', 'note.md')))
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.state, 'rejected')
    const results = h.client.requests.at(-1)!.payload.messages.at(-1)!
    assert.match(JSON.stringify(results), /rejected this action/)
  })

  it('answers every waiting request when the user stops the agent', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    await until(() => h.of('approval-request')[0])
    h.session.cancel()
    assert.equal((await running).kind, 'cancelled')
    assert.equal(h.session.status(), 'idle')
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.state, 'rejected')
  })

  it('tells the model what the user said when refusing', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, { approved: false, note: 'use the docs folder instead' })
    await running
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.output, 'Rejected by user: use the docs folder instead')
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /The user said: use the docs folder instead/)
  })

  it('does not offer to remember a protected folder, and honours "for this session" elsewhere', async () => {
    const outside = await tempWorkspace({ 'one.txt': 'one', 'two.txt': 'two' })
    const h = await sessionHarness({
      script: [
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'one.txt') } }] },
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'one.txt') } }] },
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'two.txt') } }] },
        { text: 'read them' },
      ],
    })
    const running = h.session.start({ text: 'read', mode: 'code' })
    const first = await until(() => h.of('approval-request')[0])
    assert.equal(first.request.grantable, true)
    h.session.resolveApproval(first.request.id, { approved: true, remember: 'session' })
    // The same file again runs unasked; another file asks again.
    const second = await until(() => h.of('approval-request')[1])
    assert.match(second.request.title, /two\.txt/)
    h.session.resolveApproval(second.request.id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(h.of('approval-request').length, 2)

    const guarded = await sessionHarness({ scriptFor: writeNote })
    const asked = guarded.session.start({ text: 'write', mode: 'code' })
    const protectedRequest = await until(() => guarded.of('approval-request')[0])
    assert.equal(protectedRequest.request.grantable, false)
    guarded.session.resolveApproval(protectedRequest.request.id, { approved: true, remember: 'session' })
    await asked
    // Remembering was ignored, so a second write there would ask again: nothing was granted.
    assert.equal((guarded.session as unknown as { grants: Set<string> }).grants.size, 0)
  })

  it('keeps several approvals pending at once, and shows them all when the session is opened again', async () => {
    const outside = await tempWorkspace({ 'a.txt': 'a', 'b.txt': 'b' })
    const steps = new Map<string, number>()
    const h = await sessionHarness({
      script: (request) => {
        const who = request.agent ?? 'main'
        const step = steps.get(who) ?? 0
        steps.set(who, step + 1)
        if (!request.agent) {
          return step === 0
            ? {
                calls: ['a', 'b'].map((name) => ({ name: 'Task', input: { description: `Read ${name}`, prompt: name, subagent_type: 'Explore' } })),
              }
            : { text: 'both read' }
        }
        const name = JSON.stringify(request.payload.messages[0]).includes('"a"') ? 'a' : 'b'
        return step === 0 ? { calls: [{ name: 'Read', input: { file_path: path.join(outside, `${name}.txt`) } }] } : { text: `read ${name}` }
      },
    })
    const running = h.session.start({ text: 'read both', mode: 'code' })
    await until(() => h.of('approval-request').length === 2)
    const history = h.session.history()
    assert.equal(history.approvals?.length, 2)
    assert.equal(history.approval?.id, history.approvals?.[0].id)
    assert.equal(history.status, 'awaiting-approval')
    h.session.resolveApproval(history.approvals![0].id, true)
    assert.equal(h.session.status(), 'awaiting-approval')
    assert.equal(h.session.history().approvals?.length, 1)
    h.session.resolveApproval(history.approvals![1].id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(h.session.history().approvals?.length, 0)
    assert.equal(h.session.history().approval, null)
  })

  it('puts a question to the user and passes the answer on', async () => {
    const h = await sessionHarness({
      script: [
        {
          calls: [
            {
              name: 'AskUserQuestion',
              input: {
                questions: [
                  { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'a file' }, { label: 'Postgres' }] },
                ],
              },
            },
          ],
        },
        { text: 'noted' },
      ],
    })
    const running = h.session.start({ text: 'build', mode: 'code' })
    const ask = await until(() => h.of('ask')[0])
    assert.equal(h.session.status(), 'awaiting-user')
    assert.deepEqual(ask.options, ['SQLite', 'Postgres'])
    assert.match(ask.question, /Which database\?[\s\S]*- SQLite: a file/)
    h.session.resolveAnswer(ask.id, 'Postgres')
    await running
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /Postgres/)
  })

  it('leaves a plan with the user, who answers in a new message', async () => {
    const h = await sessionHarness({ script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Do it' } }] }] })
    const end = await h.session.start({ text: 'plan it', mode: 'plan' })
    assert.equal(end.kind, 'stopped')
    assert.equal(h.session.plan()?.plan, '1. Do it')
    assert.equal(h.of('plan')[0].plan?.plan, '1. Do it')
    assert.equal(h.of('done')[0].summary, 'Plan proposed.')
    await h.reopen()
    assert.equal(h.session.plan()?.plan, '1. Do it')
    h.session.setPlan(null)
    assert.equal(h.session.plan(), null)
    assert.equal(h.of('plan').at(-1)?.plan, null)
  })

  it('can review a plan on the spot, and then carry it out', async () => {
    const h = await sessionHarness({
      env: { reviewPlan: async () => ({ approved: true }) },
      scriptFor: (root) => [
        { calls: [{ name: 'ExitPlanMode', input: { plan: 'write a.txt' } }] },
        { calls: [{ name: 'Write', input: { file_path: path.join(root, 'a.txt'), content: 'a' } }] },
        { text: 'done' },
      ],
    })
    const end = await h.session.start({ text: 'plan and do it', mode: 'plan' })
    assert.equal(end.kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, 'a.txt'), 'utf8'), 'a')
  })
})

describe('what a session keeps', () => {
  it('keeps the task list and the goal across a restart', async () => {
    const h = await sessionHarness({
      script: [
        { calls: [{ name: 'TodoWrite', input: { todos: [{ content: 'Write it', activeForm: 'Writing it', status: 'in_progress' }] } }, { name: 'CreateGoal', input: { goal: 'Finish the job' } }] },
        { text: 'ok' },
      ],
    })
    await h.session.start({ text: 'go', mode: 'code' })
    assert.deepEqual(h.of('todos').at(-1)?.todos.map((todo) => [todo.text, todo.status]), [['Write it', 'in_progress']])
    assert.equal(h.of('goal').at(-1)?.goal?.text, 'Finish the job')
    await h.reopen()
    assert.equal(h.session.todos()[0].text, 'Write it')
    assert.equal(h.session.goal()?.status, 'active')
  })

  it('starts the conversation over on reset, keeping the title, goal and tasks', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'first request', mode: 'code' })
    h.session.setGoal({ text: 'A goal', status: 'active', rounds: 2, createdAt: 1, updatedAt: 1 })
    h.session.setTodos([{ id: 'a', text: 'Task', status: 'pending' }])
    await h.session.reset()
    assert.deepEqual(h.session.history().entries, [])
    assert.equal(h.of('session-reset').length, 1)
    assert.equal(h.session.summary().title, 'first request')
    await h.reopen()
    assert.deepEqual(h.session.history().entries, [])
    assert.equal(h.session.goal()?.text, 'A goal')
    assert.equal(h.session.todos().length, 1)
    await h.session.start({ text: 'second request', mode: 'code' })
    assert.equal(h.client.requests.at(-1)!.payload.messages.length, 1)
  })

  it('goes back to before a request, and hands its text back', async () => {
    const h = await sessionHarness({ script: [{ text: 'answer' }] })
    await h.session.start({ text: 'first', mode: 'code' })
    await h.session.start({ text: 'second', mode: 'code' })
    const second = h.session.history().entries.filter((entry) => entry.kind === 'user')[1]
    assert.deepEqual(await h.session.rewind(second.id), { text: 'second' })
    assert.deepEqual(shown(h), [['user', 'first'], ['assistant', 'answer']])
    await h.session.start({ text: 'other', mode: 'code' })
    assert.deepEqual(
      h.client.requests.at(-1)!.payload.messages.map((message) => message.role),
      ['user', 'assistant', 'user'],
    )
    await h.reopen()
    assert.deepEqual(shown(h).map(([kind]) => kind), ['user', 'assistant', 'user', 'assistant'])
    await assert.rejects(h.session.rewind('nope'), /not in this session/)
  })

  it('renames, and shortens a long first request into a title', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: `${'word '.repeat(40)}\nsecond line`, mode: 'code' })
    assert.ok(h.session.summary().title.length <= 60)
    assert.ok(h.session.summary().title.endsWith('…'))
    await h.session.rename('  A better name  ')
    assert.equal((await h.store.list()).find((session) => session.id === h.session.id)?.title, 'A better name')
  })

  it('summarizes the conversation on request', async () => {
    const h = await sessionHarness({ script: (request) => (request.role === 'summarizer' ? { text: 'THE SUMMARY' } : { text: 'ok' }) })
    for (const prompt of ['one', 'two', 'three']) await h.session.start({ text: prompt, mode: 'code' })
    const result = await h.session.compact('keep file names')
    assert.ok(result.removed > 0)
    assert.match(JSON.stringify(h.client.requests.find((request) => request.role === 'summarizer')?.payload.messages), /keep file names/)
    await h.reopen()
    await h.session.start({ text: 'four', mode: 'code' })
    assert.match(text(h.client.requests.at(-1)!.payload.messages[0]), /THE SUMMARY/)
    // The transcript the user sees keeps everything.
    assert.equal(h.session.history().entries.filter((entry) => entry.kind === 'user').length, 4)
  })

  it('keeps the project, pin, archive and unread marks apart from the conversation', async () => {
    const h = await sessionHarness({ script: [{ text: 'A reply with `code` and **bold** text.' }] })
    await h.session.start({ text: 'hello', mode: 'code' })
    const before = h.session.summary()
    assert.equal(before.projectRoot, h.root)
    assert.equal(before.entryCount, 2)
    assert.equal(before.preview, 'A reply with code and bold text.')

    await h.session.update({ pinned: true, unread: true, projectRoot: null, bogus: 1, title: 'Renamed' })
    await h.session.update({ archived: true })
    const after = h.session.summary()
    assert.deepEqual([after.pinned, after.archived, after.unread, after.projectRoot, after.title], [false, true, true, null, 'Renamed'])
    assert.equal((await h.store.list({ root: null })).length, 1)
    assert.equal((await h.store.list({ root: h.root })).length, 0)

    await h.reopen()
    assert.deepEqual([h.session.summary().archived, h.session.summary().unread, h.session.summary().projectRoot], [true, true, null])
    const updatedAt = h.session.summary().updatedAt
    await h.session.update({ unread: false })
    assert.equal(h.session.summary().updatedAt, updatedAt)
  })

  it('names the model on each reply', async () => {
    const h = await sessionHarness({ script: [{ text: 'hi' }] })
    await h.session.start({ text: 'hello', mode: 'code' })
    assert.equal(h.session.history().entries.find((entry) => entry.kind === 'assistant')?.model, 'scripted')
  })

  it('exports the transcript', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'export me', mode: 'code' })
    const data = h.session.exportData()
    assert.equal(data.title, 'export me')
    assert.match(data.transcript, /^# export me\n\n## user\n\nexport me/)
    assert.equal(JSON.parse(data.json).entries.length, 2)
  })
})

describe('subagents', () => {
  const scripted = (calls: { name: string; input: Record<string, unknown> }[]) => {
    let main = 0
    let sub = 0
    return (request: { agent?: string }) => {
      if (request.agent) return sub++ === 0 ? { calls } : { text: 'Found a.txt' }
      return main++ === 0 ? { calls: [{ name: 'Task', input: { description: 'Look around', prompt: 'List the files', subagent_type: 'Explore' } }] } : { text: 'all done' }
    }
  }

  it('runs a subagent on its own conversation and returns its report', async () => {
    const h = await sessionHarness({ files: { 'a.txt': 'a' }, script: scripted([{ name: 'Glob', input: { pattern: '*.txt' } }]) })
    const end = await h.session.start({ text: 'explore', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'all done' })
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'explore', 'explore', 'main'])
    const subagent = h.client.requests[1]
    assert.deepEqual(subagent.payload.tools.map((tool) => tool.name).sort(), ['Bash', 'BashOutput', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'])
    assert.equal(subagent.payload.messages.length, 1)
    assert.match(text(subagent.payload.messages[0]), /List the files/)
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /Found a\.txt/)
    // Only the main agent's messages are in the session's log.
    await h.reopen()
    assert.equal(shown(h).filter(([kind]) => kind === 'tool').length, 1)
  })

  it('sends a subagent\'s approvals to the user under the Task call', async () => {
    const h = await sessionHarness({
      script: (request: { agent?: string }, step) => {
        void step
        if (request.agent) return request.agent.endsWith('1') || !(h.client.requests.filter((item) => item.agent).length > 1)
          ? { calls: [{ name: 'Write', input: { file_path: path.join(h.root, '.encode', 'sub.md'), content: 'y' } }] }
          : { text: 'wrote it' }
        return h.client.requests.filter((item) => !item.agent).length === 1
          ? { calls: [{ name: 'Task', input: { description: 'Write a note', prompt: 'Write it', subagent_type: 'general-purpose' } }] }
          : { text: 'ok' }
      },
    })
    const running = h.session.start({ text: 'delegate', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.match(request.title, /^Subagent: /)
    const task = h.session.history().entries.find((entry) => entry.tool?.name === 'Task')
    assert.equal(request.entryId, task?.id)
    h.session.resolveApproval(request.id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, '.encode', 'sub.md'), 'utf8'), 'y')
  })

  it('offers the agents the user defines', async () => {
    const h = await sessionHarness({
      files: { '.encode/agents/linter.md': '---\ndescription: Checks style.\ntools: Read, Grep, Task\n---\nBe strict.' },
      script: [{ text: 'ok' }],
      env: {},
    })
    h.env.agentSources = () => [{ dir: path.join(h.root, '.encode', 'agents'), source: 'workspace' }]
    await h.session.start({ text: 'go', mode: 'code' })
    const task = h.client.requests[0].payload.tools.find((tool) => tool.name === 'Task')
    assert.match(task?.description ?? '', /- linter: Checks style\. \(tools: Read, Grep, Task\)/)
  })
})

describe('without a shell', () => {
  it('works for everything else and tells the model why commands fail', async () => {
    const h = await sessionHarness({
      settings: { policy: 'full-access' },
      createShell: () => {
        throw new Error('No shell was found.')
      },
      script: [{ calls: [{ name: 'Bash', input: { command: 'ls' } }] }, { text: 'sorry' }],
    })
    const end = await h.session.start({ text: 'list', mode: 'code' })
    assert.equal(end.kind, 'done')
    assert.ok(h.session.history().entries.some((entry) => entry.kind === 'notice' && /Commands cannot run/.test(entry.text ?? '')))
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /No shell was found/)
  })
})
