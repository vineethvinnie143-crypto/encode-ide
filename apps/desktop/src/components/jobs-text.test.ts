import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BackgroundJob } from '@shared/types'
import { jobText, runningLabel, wakeTime } from './jobs-text'

const job = (over: Partial<BackgroundJob>): BackgroundJob => ({ id: 's:1', command: 'npm run dev', cwd: '/p', sessionId: 's', startedAt: 0, status: 'running', output: '', ...over })

describe('a job card', () => {
  it('names a command by what the agent said it is for, with the command under it', () => {
    assert.deepEqual(jobText(job({})), { kind: 'command', name: 'npm run dev', mono: true, status: 'Running' })
    assert.deepEqual(jobText(job({ title: 'Dev server', status: 'error' })), { kind: 'command', name: 'Dev server', mono: false, command: 'npm run dev', status: 'Failed' })
    assert.deepEqual(jobText(job({ kind: 'monitor', title: 'Errors in the log', command: 'tail -f a.log', status: 'killed' })), {
      kind: 'monitor',
      name: 'Errors in the log',
      mono: false,
      badge: 'Monitor',
      command: 'tail -f a.log',
      status: 'Stopped',
    })
  })

  it('names a subagent by its task with its type as the badge', () => {
    assert.deepEqual(jobText(job({ kind: 'agent', command: 'Find the parser', title: 'Explore', status: 'done' })), { kind: 'agent', name: 'Find the parser', mono: false, badge: 'Explore', status: 'Done' })
  })

  it('says when a wake-up fires', () => {
    const at = new Date(2026, 9, 23, 14, 5).getTime()
    const text = jobText(job({ kind: 'wakeup', command: 'Check the build', startedAt: at }), at - 60_000)
    assert.equal(text.name, 'Check the build')
    assert.equal(text.badge, 'Wake-up')
    assert.equal(text.status, `Wakes at ${wakeTime(at, at)}`)
    assert.match(text.status, /(14|0?2).05/, 'in the clock the person uses')
    assert.notEqual(wakeTime(at, at - 2 * 86_400_000), wakeTime(at, at), 'another day is named')
  })
})

describe('the running chip', () => {
  it('counts subagents and commands apart and leaves out wake-ups and ended work', () => {
    assert.equal(runningLabel([]), null)
    assert.equal(runningLabel([job({ kind: 'wakeup' }), job({ status: 'done' })]), null)
    assert.equal(runningLabel([job({}), job({ kind: 'monitor' })]), '2 jobs running')
    assert.equal(runningLabel([job({ kind: 'agent' })]), '1 agent running')
    assert.equal(runningLabel([job({ kind: 'agent' }), job({ kind: 'agent' }), job({})]), '2 agents, 1 job running')
  })
})
