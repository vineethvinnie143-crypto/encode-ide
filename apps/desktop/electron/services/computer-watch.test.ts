import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentEvent, AgentStatus, ConversationEntry } from '@encode/core'
import { ComputerWatch, type ComputerActivity } from './computer-watch'

function watch() {
  const changes: ComputerActivity[] = []
  return { watch: new ComputerWatch((activity) => changes.push(activity)), changes }
}

const status = (sessionId: string, value: AgentStatus): AgentEvent => ({ type: 'status', sessionId, status: value })
const tool = (sessionId: string, name: string, state: 'running' | 'waiting' | 'done' | 'rejected' | 'error'): AgentEvent => ({
  type: 'entry',
  sessionId,
  entry: { id: `${name}-1`, kind: 'tool', createdAt: 1, tool: { name, input: {}, state } } as ConversationEntry,
})

describe('knowing when the agent is using the computer', () => {
  it('is quiet until a Computer call is let through, and for any other tool', () => {
    const { watch: w, changes } = watch()
    w.see(status('a', 'thinking'))
    w.see(tool('a', 'Bash', 'running'))
    w.see(tool('a', 'Computer', 'waiting'))
    w.see(tool('a', 'Computer', 'rejected'))
    assert.deepEqual(changes, [])
    assert.equal(w.activity().active, false)
  })

  it('stays on between calls, while the model thinks, and goes off with the turn', () => {
    const { watch: w, changes } = watch()
    w.see(status('a', 'running-tool'))
    w.see(tool('a', 'Computer', 'running'))
    assert.deepEqual(changes.at(-1), { active: true, sessions: ['a'], waiting: false })
    w.see(tool('a', 'Computer', 'done'))
    w.see(status('a', 'thinking'))
    w.see(tool('a', 'Bash', 'running'))
    assert.equal(w.activity().active, true, 'a turn that used the computer keeps the banner until it ends')
    assert.equal(changes.length, 1, 'and says nothing more while nothing changes')
    w.see(status('a', 'idle'))
    assert.deepEqual(changes.at(-1), { active: false, sessions: [], waiting: false })
  })

  it('says when everything is waiting for the person', () => {
    const { watch: w } = watch()
    w.see(status('a', 'running-tool'))
    w.see(tool('a', 'Computer', 'done'))
    w.see(status('a', 'awaiting-approval'))
    assert.deepEqual(w.activity(), { active: true, sessions: ['a'], waiting: true })
    w.see(status('b', 'running-tool'))
    w.see(tool('b', 'Computer', 'running'))
    assert.deepEqual(w.activity(), { active: true, sessions: ['a', 'b'], waiting: false }, 'not while another one is working')
  })

  it('does not count a turn that never used it, and counts each turn afresh', () => {
    const { watch: w } = watch()
    w.see(status('a', 'thinking'))
    assert.equal(w.activity().active, false)
    w.see(status('a', 'running-tool'))
    w.see(tool('a', 'Computer', 'error'))
    assert.equal(w.activity().active, true, 'a call that failed still reached for the computer')
    w.see({ type: 'done', sessionId: 'a', summary: '' })
    assert.equal(w.activity().active, false)
    w.see(status('a', 'thinking'))
    assert.equal(w.activity().active, false, 'the next turn has used nothing yet')
  })

  it('lets go of a session that ended with an error, was reset or was removed', () => {
    const { watch: w } = watch()
    for (const end of [
      (): AgentEvent => ({ type: 'error', sessionId: 'a', message: 'x' }),
      (): AgentEvent => ({ type: 'session-reset', sessionId: 'a' }),
    ]) {
      w.see(status('a', 'running-tool'))
      w.see(tool('a', 'Computer', 'running'))
      assert.equal(w.activity().active, true)
      w.see(end())
      assert.equal(w.activity().active, false)
    }
    w.see(status('a', 'running-tool'))
    w.see(tool('a', 'Computer', 'running'))
    w.forget('a')
    assert.equal(w.activity().active, false)
  })

  it('lets go of everything when the feature is turned off, and says so once', () => {
    const { watch: w, changes } = watch()
    for (const id of ['a', 'b']) {
      w.see(status(id, 'running-tool'))
      w.see(tool(id, 'Computer', 'running'))
    }
    assert.deepEqual(w.activity().sessions, ['a', 'b'])
    const before = changes.length
    w.reset()
    w.reset()
    assert.deepEqual(w.activity(), { active: false, sessions: [], waiting: false })
    assert.equal(changes.length, before + 1)
  })
})
