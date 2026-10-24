import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CrashCounter, crashPrompt, isCrash } from './renderer-crash'

describe('a window whose page stopped', () => {
  it('is offered a reload, with what was kept and what was lost, and the reason in plain words', () => {
    const prompt = crashPrompt('oom', 1)
    assert.equal(prompt.message, "eNCode's window stopped")
    assert.match(prompt.detail, /ran out of memory/)
    assert.match(prompt.detail, /chats and running agents are kept/)
    assert.match(prompt.detail, /not yet saved in the editor are lost/)
    assert.equal(prompt.choices[prompt.defaultId], 'reload')
    assert.equal(prompt.choices[prompt.cancelId], 'reload', 'closing the box reloads rather than leaving a blank window')
    assert.deepEqual(prompt.buttons, ['Reload', 'Quit eNCode'])
  })

  it('is told when it keeps stopping, and pointed at a diagnostics report', () => {
    const counter = new CrashCounter()
    assert.equal(counter.record(0), 1)
    assert.equal(counter.record(20_000), 2)
    const third = counter.record(40_000)
    assert.equal(third, 3)
    const prompt = crashPrompt('crashed', third)
    assert.equal(prompt.message, "eNCode's window keeps stopping")
    assert.match(prompt.detail, /3 times in the last minute/)
    assert.match(prompt.detail, /diagnostics report/)
    // A minute later the count starts again.
    assert.equal(counter.record(130_000), 1)
  })

  it('is not asked about when the page closes with the window', () => {
    assert.equal(isCrash('clean-exit'), false)
    for (const reason of ['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure']) assert.equal(isCrash(reason), true, reason)
  })
})
