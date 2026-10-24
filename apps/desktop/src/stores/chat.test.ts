import { answer, calls } from '../testing/bridge'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentEventBody, AgentStatus } from '@shared/types'
import { setActiveSessionId } from './active'
import { finishedList, useChat } from './chat'
import { useStatus } from './status'

setActiveSessionId('session-1')
const apply = (event: AgentEventBody, sessionId = 'session-1') => useChat.getState().applyEvent({ ...event, sessionId })
const usage = () => useChat.getState().usageTotals

describe('the tokens of the open conversation', () => {
  it('add up what each request used, and start again from nothing when the conversation is reset', () => {
    apply({ type: 'usage', promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 })
    apply({ type: 'usage', promptTokens: 150, completionTokens: 30, totalTokens: 180 })
    assert.deepEqual(usage(), { total: 300, cached: 40, prompt: 250, completion: 50 })

    apply({ type: 'session-reset' })
    assert.deepEqual(usage(), { total: 0, cached: 0, prompt: 0, completion: 0 })
    assert.deepEqual(useChat.getState().entries, [])
  })

  it('leave out what another session used', () => {
    apply({ type: 'usage', promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 'session-2')
    assert.deepEqual(usage(), { total: 0, cached: 0, prompt: 0, completion: 0 })
  })
})

describe('messages handed to the running request', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const lastCall = (path: string) => [...calls].reverse().find((call) => call.path === path)
  const texts = (list: { text: string }[] | undefined) => (list ?? []).map((item) => item.text)
  const steering = () => texts(useChat.getState().steering['session-1'])
  const queued = () => texts(useChat.getState().queues['session-1'])
  const follow = (event: AgentEventBody, sessionId = 'session-1') => useChat.getState().followSteers({ ...event, sessionId })
  const working = (status: AgentStatus) => {
    useStatus.getState().set('session-1', status)
    useChat.setState({ running: status === 'thinking' || status === 'running-tool', status })
  }
  const fresh = () => useChat.setState({ queues: {}, steering: {}, draft: '' })

  it('go to the request under an id of ours, and leave the list when it shows them', async () => {
    fresh()
    working('thinking')
    answer('agent.steer', (_session, _text, id) => Promise.resolve({ id }))
    useChat.setState({ draft: 'use tabs' })
    useChat.getState().steer('  use tabs ')
    assert.deepEqual(steering(), ['use tabs'])
    assert.equal(useChat.getState().draft, '')
    const [session, text, id] = lastCall('agent.steer')!.args as [string, string, string]
    assert.deepEqual([session, text], ['session-1', 'use tabs'])
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    await tick()
    // Another message's entry, or another session's, leaves it waiting.
    follow({ type: 'entry', entry: { id: 'other', kind: 'steer', text: 'x', createdAt: 1 } })
    follow({ type: 'entry', entry: { id, kind: 'steer', text: 'use tabs', createdAt: 1 } }, 'session-2')
    assert.deepEqual(steering(), ['use tabs'])
    follow({ type: 'entry', entry: { id, kind: 'steer', text: 'use tabs', createdAt: 1 } })
    assert.deepEqual(steering(), [])
  })

  it('come back to the front of the queue, in the order sent, when the request ends without taking them', async () => {
    fresh()
    working('running-tool')
    answer('agent.steer', (_session, _text, id) => Promise.resolve({ id }))
    useChat.getState().enqueue('later')
    useChat.getState().steer('first')
    useChat.getState().steer('second')
    await tick()
    follow({ type: 'status', status: 'awaiting-approval' })
    assert.deepEqual(steering(), ['first', 'second'], 'a request waiting on an approval still takes them')
    follow({ type: 'status', status: 'done' })
    assert.deepEqual([steering(), queued()], [[], ['first', 'second', 'later']])
    // The request is over: the first one goes out as the next request.
    working('done')
    useChat.getState().drainQueue('session-1')
    assert.deepEqual(lastCall('agent.start')!.args.slice(0, 2), ['session-1', { text: 'first', mode: 'code' }])
    assert.deepEqual(queued(), ['second', 'later'])
  })

  it('keep the pictures and files of a queued message until it is sent, and give them back to edit (ADR 0113)', () => {
    fresh()
    working('running-tool')
    const picture = { id: 'p1', kind: 'picture' as const, name: 'Screenshot 1.png', mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', preview: 'data:image/jpeg;base64,AAAA', width: 2, height: 2 }
    useChat.setState({ attachments: [picture], draft: 'why is this red?' })
    useChat.getState().enqueue('why is this red?', { attachments: [picture] })
    assert.deepEqual([useChat.getState().draft, useChat.getState().attachments], ['', []], 'the chat box is empty again')
    const id = useChat.getState().queues['session-1'][0].id
    useChat.getState().sendQueued(id)
    assert.deepEqual(queued(), ['why is this red?'], 'a running request reads words only, so it waits')
    useChat.getState().editQueued(id)
    assert.deepEqual([useChat.getState().draft, useChat.getState().attachments], ['why is this red?', [picture]])
    useChat.getState().enqueue('why is this red?', { attachments: [picture] })
    working('done')
    useChat.getState().drainQueue('session-1')
    assert.deepEqual(lastCall('agent.start')!.args[1], {
      text: 'why is this red?',
      mode: 'code',
      media: [{ name: 'Screenshot 1.png', mediaType: 'image/png', data: 'iVBORw0KGgo=', preview: 'data:image/jpeg;base64,AAAA' }],
    })
  })

  it('that the request refuses wait for it to end while it runs, and come back at once when nothing runs', async () => {
    fresh()
    answer('agent.steer', () => Promise.resolve(null))
    working('thinking')
    useChat.getState().steer('too late')
    await tick()
    assert.deepEqual([steering(), queued()], [['too late'], []])
    follow({ type: 'error', message: 'The provider failed.' })
    assert.deepEqual([steering(), queued()], [[], ['too late']])

    fresh()
    working('idle')
    useChat.setState({ running: true })
    answer('agent.steer', () => Promise.reject(new Error('The agent process stopped.')))
    useChat.getState().steer('anyone?')
    await tick()
    assert.deepEqual([steering(), queued()], [[], ['anyone?']])
  })

  it('can come from the queue: steered while a request runs, sent when none does', async () => {
    fresh()
    working('thinking')
    answer('agent.steer', (_session, _text, id) => Promise.resolve({ id }))
    useChat.setState({ draft: 'half typed' })
    useChat.getState().enqueue('one', { keepDraft: true })
    useChat.getState().enqueue('two', { keepDraft: true })
    useChat.getState().sendQueued(useChat.getState().queues['session-1'][1].id)
    assert.deepEqual([steering(), queued(), useChat.getState().draft], [['two'], ['one'], 'half typed'])
    await tick()

    working('done')
    useChat.getState().sendQueued(useChat.getState().queues['session-1'][0].id)
    assert.equal((lastCall('agent.start')!.args[1] as { text: string }).text, 'one')
    assert.deepEqual(queued(), [])
    assert.equal(useChat.getState().draft, 'half typed')
  })
})

describe('cards a subagent in the background waits on', () => {
  const card = (id: string, background?: boolean) => ({ id, entryId: 'e', tool: 'Bash', title: `Run ${id}`, detail: id, input: {}, ...(background ? { background: true } : {}) })
  const ids = () => useChat.getState().approvals.map((item) => item.id)

  it('stay when the turn ends, and the turn\'s own leave with it', () => {
    useChat.setState({ approvals: [], ask: null })
    apply({ type: 'approval-request', request: card('own') })
    apply({ type: 'approval-request', request: card('sub', true) })
    apply({ type: 'ask', id: 'q', entryId: 'e', question: 'Which one?', background: true })
    apply({ type: 'done', summary: '' })
    assert.deepEqual(ids(), ['sub'])
    assert.equal(useChat.getState().ask?.id, 'q')
    apply({ type: 'status', status: 'awaiting-approval' })
    assert.equal(useChat.getState().running, true)
    apply({ type: 'error', message: 'x', entryId: 'e' })
    assert.deepEqual(ids(), ['sub'])
    apply({ type: 'status', status: 'idle' })
    assert.deepEqual(ids(), ['sub'])
  })

  it('leave with the conversation when it starts over, and a turn\'s own question leaves with its turn', () => {
    apply({ type: 'session-reset' })
    assert.deepEqual(ids(), [])
    apply({ type: 'ask', id: 'q2', entryId: 'e', question: 'Which one?' })
    apply({ type: 'status', status: 'running-tool' })
    assert.equal(useChat.getState().ask, null)
  })
})

describe('the task list (ADR 0115)', () => {
  const item = (id: string, status: 'pending' | 'in_progress' | 'completed') => ({ id, text: id, status })

  it('is finished once every item is done, and an empty list is not', () => {
    assert.equal(finishedList([item('a', 'completed'), item('b', 'completed')]), true)
    assert.equal(finishedList([item('a', 'completed'), item('b', 'in_progress')]), false)
    assert.equal(finishedList([]), false)
  })

  it('of a session opened with every item done shows no card, and one with work left shows it', async () => {
    answer('agent.history', () => Promise.resolve({ entries: [], status: 'idle' }))
    answer('agent.todos', () => Promise.resolve([item('a', 'completed'), item('b', 'completed')]))
    await useChat.getState().load('session-1')
    assert.deepEqual(useChat.getState().todos, [])

    const left = [item('a', 'completed'), item('b', 'pending')]
    answer('agent.todos', () => Promise.resolve(left))
    await useChat.getState().load('session-1')
    assert.deepEqual(useChat.getState().todos, left)
  })

  it('that the agent finishes while it works stays, for its card to fold away', () => {
    const done = [item('a', 'completed')]
    apply({ type: 'todos', todos: done })
    assert.deepEqual(useChat.getState().todos, done)
  })
})
