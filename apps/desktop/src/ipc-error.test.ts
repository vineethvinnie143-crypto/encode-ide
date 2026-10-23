import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorText } from './ipc-error'

describe('an error from the main process', () => {
  it("says a fault in the interface's own code in one fixed sentence, and logs what it said", () => {
    const logged: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(...args)
    try {
      const thrown = new TypeError("Cannot read properties of undefined (reading 'path')")
      assert.equal(errorText(thrown), 'Something went wrong inside eNCode, so that did not finish. Try again.')
      assert.deepEqual(logged, [thrown])
    } finally {
      console.error = original
    }
  })

  it('loses the wrapper Electron puts around it', () => {
    assert.equal(errorText(new Error("Error invoking remote method 'models:provider': Error: OpenAI did not accept the key (HTTP 401).")), 'OpenAI did not accept the key (HTTP 401).')
    assert.equal(errorText(new Error("Error invoking remote method 'settings:save': plain text")), 'plain text')
  })

  it('is left alone when there is nothing to remove, and anything thrown is made into text', () => {
    assert.equal(errorText(new Error('Could not reach OpenRouter')), 'Could not reach OpenRouter')
    assert.equal(errorText('a string'), 'a string')
    assert.equal(errorText(undefined), 'eNCode could not do that. Try again.')
  })

  it('shows one plain line of an error thrown in the interface: no class, no stack, no key', () => {
    assert.equal(errorText(new Error('Error: failed\n    at send (api.ts:3:9)')), 'failed')
    assert.equal(errorText(new Error('Error: failed with sk-or-v1-abcdef0123456789\n    at send (api.ts:3:9)')), 'failed with [redacted]')
    assert.equal(errorText(new Error("Error invoking remote method 'x': Error: Bearer abcdefgh12345678 refused")), '[redacted] refused')
    assert.equal(errorText(new Error('y'.repeat(400))).length, 301)
  })
})
