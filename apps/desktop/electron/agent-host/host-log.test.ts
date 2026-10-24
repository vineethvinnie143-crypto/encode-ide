import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hostLogLine } from './host-log'

describe('the agent host’s lines in the log', () => {
  it('keeps the router’s own level and names the host once', () => {
    assert.deepEqual(hostLogLine('[agent-host] router info: a model was set aside'), { level: 'info', text: '[agent-host] router info: a model was set aside' })
    assert.equal(hostLogLine('router warn: all keys paused').level, 'warn')
    assert.equal(hostLogLine('[agent-host] router error: the catalog could not be read').level, 'error')
  })

  it('writes a request that worked after a retry, or that the person stopped, as routine, and one that failed as a warning', () => {
    assert.equal(hostLogLine('[agent-host] request main: done, 4 attempts ending at Some Model').level, 'info')
    assert.equal(hostLogLine('[agent-host] request main: aborted, 1 attempt').level, 'info')
    assert.equal(hostLogLine('[agent-host] request explore: failed (rate limited), 3 attempts').level, 'warn')
  })

  it('keeps everything else an error', () => {
    assert.deepEqual(hostLogLine('[agent-host] The sandbox could not be prepared: x'), { level: 'error', text: '[agent-host] The sandbox could not be prepared: x' })
    assert.equal(hostLogLine('TypeError: x is not a function').level, 'error')
    assert.equal(hostLogLine('    at run (agent-host.cjs:1:2)').text, '[agent-host]     at run (agent-host.cjs:1:2)')
  })
})
