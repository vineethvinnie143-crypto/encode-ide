import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentEvent, AgentStatus } from '../../shared/types'
import { AWAKE_GRACE_MS, Attention, DONE_SETTLE_MS, noticeBody, noticeTitle, type AttentionSettings, type Notice } from './attention'

/** Effects that record what Attention asked for, with timers the test moves by hand. */
function harness(options: { focused?: boolean; settings?: Partial<AttentionSettings>; titles?: Record<string, string> } = {}) {
  const settings: AttentionSettings = { notifyDone: 'background', notifyNeeds: 'background', flashTaskbar: true, keepAwake: true, ...options.settings }
  const state = { focused: options.focused ?? false, now: 0 }
  const notices: Notice[] = []
  const flashes: boolean[] = []
  const awake: boolean[] = []
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 1
  const attention = new Attention(() => settings, {
    focused: () => state.focused,
    titleOf: async (id) => options.titles?.[id],
    notify: (notice) => notices.push(notice),
    flash: (on) => flashes.push(on),
    keepAwake: (on) => awake.push(on),
    setTimer: (run, ms) => {
      const id = next++
      timers.set(id, { at: state.now + ms, run })
      return id
    },
    clearTimer: (id) => timers.delete(id as number),
  })
  /** Moves the clock, running the timers that come due, then lets the notices' title lookups finish. */
  const advance = async (ms: number) => {
    state.now += ms
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > state.now) continue
      timers.delete(id)
      timer.run()
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  const status = (sessionId: string, value: AgentStatus) => attention.see({ sessionId, type: 'status', status: value } as AgentEvent)
  const event = (sessionId: string, body: Record<string, unknown>) => attention.see({ sessionId, ...body } as AgentEvent)
  return { attention, settings, state, notices, flashes, awake, advance, status, event }
}

describe('Attention notices', () => {
  it('tells the person a request finished while eNCode was in the back, by the session\'s name', async () => {
    const h = harness({ titles: { s1: 'Fix the login form' } })
    h.status('s1', 'thinking')
    h.status('s1', 'done')
    h.event('s1', { type: 'done', summary: '' })
    await h.advance(DONE_SETTLE_MS - 1)
    assert.equal(h.notices.length, 0, 'not before the request has settled')
    await h.advance(1)
    assert.deepEqual(h.notices, [{ sessionId: 's1', kind: 'done', title: 'Fix the login form', body: 'Finished.' }])
  })

  it('says nothing while eNCode is in front, unless the person asked for every time', async () => {
    const front = harness({ focused: true })
    front.status('s1', 'thinking')
    front.status('s1', 'done')
    front.event('s1', { type: 'done', summary: '' })
    await front.advance(DONE_SETTLE_MS)
    assert.equal(front.notices.length, 0)

    const always = harness({ focused: true, settings: { notifyDone: 'always' } })
    always.status('s1', 'thinking')
    always.status('s1', 'done')
    always.event('s1', { type: 'done', summary: '' })
    await always.advance(DONE_SETTLE_MS)
    assert.equal(always.notices.length, 1)

    const never = harness({ settings: { notifyDone: 'never' } })
    never.status('s1', 'thinking')
    never.status('s1', 'done')
    never.event('s1', { type: 'done', summary: '' })
    await never.advance(DONE_SETTLE_MS)
    assert.equal(never.notices.length, 0)
  })

  it('waits for the end of a goal\'s rounds or a queued message: a request that starts again at once is not done', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    h.status('s1', 'done')
    h.event('s1', { type: 'done', summary: '' })
    await h.advance(500)
    h.status('s1', 'thinking')
    await h.advance(DONE_SETTLE_MS)
    assert.equal(h.notices.length, 0)
    h.status('s1', 'done')
    h.event('s1', { type: 'done', summary: '' })
    await h.advance(DONE_SETTLE_MS)
    assert.equal(h.notices.length, 1, 'one notice, for the end of the last round')
  })

  it('names an error without its text, and keeps eNCode\'s own line about the step limit', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    h.status('s1', 'error')
    h.event('s1', { type: 'error', message: 'HTTP 401: invalid key sk-or-v1-abc' })
    await h.advance(DONE_SETTLE_MS)
    assert.equal(h.notices[0].kind, 'error')
    assert.equal(h.notices[0].body, 'Stopped with an error. Open eNCode to see it.')
    assert.doesNotMatch(JSON.stringify(h.notices), /sk-or|401/)

    h.status('s2', 'thinking')
    h.status('s2', 'done')
    h.event('s2', { type: 'done', summary: 'Stopped after 30 steps. Send a follow-up to continue.' })
    h.status('s3', 'thinking')
    h.status('s3', 'done')
    h.event('s3', { type: 'done', summary: 'Here is the whole reply the model wrote, which stays in eNCode.' })
    await h.advance(DONE_SETTLE_MS)
    assert.equal(h.notices[1].body, 'Stopped after 30 steps. Send a follow-up to continue.')
    assert.equal(h.notices[2].body, 'Finished.')
  })

  it('says nothing when the person stopped the request', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    h.status('s1', 'idle')
    await h.advance(DONE_SETTLE_MS * 2)
    assert.equal(h.notices.length, 0)
  })

  it('tells the person once when the agent starts waiting for them, and says why', async () => {
    const h = harness({ titles: { s1: 'Deploy' } })
    h.status('s1', 'thinking')
    h.status('s1', 'awaiting-approval')
    h.status('s1', 'awaiting-user')
    await h.advance(0)
    assert.deepEqual(h.notices, [{ sessionId: 's1', kind: 'needs', title: 'Deploy', body: 'Wants your approval to go on.' }])
    h.status('s1', 'running-tool')
    h.status('s1', 'awaiting-user')
    await h.advance(0)
    assert.equal(h.notices[1].body, 'Is waiting for your answer.')
  })

  it('a request that ends waiting for the person has its own notice, not a second one for being done', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    h.event('s1', { type: 'done', summary: '' })
    h.status('s1', 'awaiting-user')
    await h.advance(DONE_SETTLE_MS)
    assert.deepEqual(h.notices.map((notice) => notice.kind), ['needs'])
  })

  it('shows a test notice whatever the settings say', async () => {
    const h = harness({ focused: true, settings: { notifyDone: 'never', notifyNeeds: 'never' } })
    h.attention.test()
    assert.deepEqual(h.notices, [{ sessionId: '', kind: 'test', title: 'eNCode', body: 'This is how eNCode tells you a request finished.' }])
  })

  it('names a session in one short line', () => {
    assert.equal(noticeTitle(undefined), 'eNCode')
    assert.equal(noticeTitle('  Fix\nthe   form '), 'Fix the form')
    const long = noticeTitle('x'.repeat(200))
    assert.equal(long.length, 80)
    assert.ok(long.endsWith('…'))
    assert.equal(noticeBody('needs'), 'Is waiting for your answer.')
  })
})

describe('Attention taskbar', () => {
  it('flashes while the agent waits for the person in the back, and stops when they come or it goes on', () => {
    const h = harness()
    h.status('s1', 'awaiting-approval')
    assert.deepEqual(h.flashes, [true])
    h.status('s2', 'awaiting-user')
    assert.deepEqual(h.flashes, [true], 'already flashing')
    h.status('s1', 'running-tool')
    assert.deepEqual(h.flashes, [true], 'another session still waits')
    h.status('s2', 'thinking')
    assert.deepEqual(h.flashes, [true, false])
    h.status('s1', 'awaiting-approval')
    h.attention.focusChanged(true)
    assert.deepEqual(h.flashes, [true, false, true, false])
  })

  it('does not flash in front, or when the person turned it off', () => {
    const front = harness({ focused: true })
    front.status('s1', 'awaiting-approval')
    assert.deepEqual(front.flashes, [])
    const off = harness({ settings: { flashTaskbar: false } })
    off.status('s1', 'awaiting-approval')
    assert.deepEqual(off.flashes, [])
  })
})

describe('Attention keeping awake', () => {
  it('keeps the computer awake while an agent works, across the gap between two requests, and lets it sleep after', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    assert.deepEqual(h.awake, [true])
    h.status('s1', 'done')
    await h.advance(AWAKE_GRACE_MS - 1)
    h.status('s1', 'thinking')
    assert.deepEqual(h.awake, [true], 'the next request started within the grace')
    h.status('s1', 'done')
    await h.advance(AWAKE_GRACE_MS)
    assert.deepEqual(h.awake, [true, false])
  })

  it('lets the computer sleep while the agent waits for the person', async () => {
    const h = harness()
    h.status('s1', 'thinking')
    h.status('s1', 'awaiting-approval')
    await h.advance(AWAKE_GRACE_MS)
    assert.deepEqual(h.awake, [true, false])
  })

  it('follows the setting at once, and never holds the computer when it is off', () => {
    const h = harness({ settings: { keepAwake: false } })
    h.status('s1', 'thinking')
    assert.deepEqual(h.awake, [])
    h.settings.keepAwake = true
    h.attention.settingsChanged()
    assert.deepEqual(h.awake, [true])
    h.settings.keepAwake = false
    h.attention.settingsChanged()
    assert.deepEqual(h.awake, [true, false])
  })

  it('lets go of everything when a session goes away or eNCode closes', async () => {
    const h = harness()
    h.status('s1', 'awaiting-approval')
    h.status('s2', 'thinking')
    h.attention.forget('s1')
    assert.deepEqual(h.flashes, [true, false])
    h.attention.dispose()
    assert.deepEqual(h.awake, [true, false])
    h.status('s3', 'thinking')
    h.status('s3', 'done')
    h.event('s3', { type: 'done', summary: '' })
    await h.advance(DONE_SETTLE_MS)
    assert.equal(h.notices.length, 0)
  })
})
