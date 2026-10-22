import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorText } from './ipc-error'

describe('an error from the main process', () => {
  it('loses the wrapper Electron puts around it', () => {
    assert.equal(errorText(new Error("Error invoking remote method 'models:provider': Error: OpenAI did not accept the key (HTTP 401).")), 'OpenAI did not accept the key (HTTP 401).')
    assert.equal(errorText(new Error("Error invoking remote method 'settings:save': plain text")), 'plain text')
  })

  it('is left alone when there is nothing to remove, and anything thrown is made into text', () => {
    assert.equal(errorText(new Error('Could not reach OpenRouter')), 'Could not reach OpenRouter')
    assert.equal(errorText('a string'), 'a string')
    assert.equal(errorText(undefined), 'undefined')
  })
})
