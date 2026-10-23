import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sendAction, sendKeys, type EnterLike } from './send-key'

const press = (key: string, mods: Partial<EnterLike> = {}): EnterLike => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods })

describe('the send key', () => {
  it('with Enter: Enter sends, Ctrl+Enter sends the other follow-up, Shift+Enter starts a new line', () => {
    assert.equal(sendAction(press('Enter'), 'enter'), 'send')
    assert.equal(sendAction(press('Enter', { ctrlKey: true }), 'enter'), 'other')
    assert.equal(sendAction(press('Enter', { metaKey: true }), 'enter'), 'other')
    assert.equal(sendAction(press('Enter', { shiftKey: true }), 'enter'), null)
    assert.equal(sendAction(press('Enter', { shiftKey: true, ctrlKey: true }), 'enter'), null)
  })

  it('with Ctrl+Enter: Enter and Shift+Enter start a new line, Ctrl+Enter sends, Ctrl+Shift+Enter sends the other follow-up', () => {
    assert.equal(sendAction(press('Enter'), 'ctrl-enter'), null)
    assert.equal(sendAction(press('Enter', { shiftKey: true }), 'ctrl-enter'), null)
    assert.equal(sendAction(press('Enter', { ctrlKey: true }), 'ctrl-enter'), 'send')
    assert.equal(sendAction(press('Enter', { ctrlKey: true, shiftKey: true }), 'ctrl-enter'), 'other')
  })

  it('leaves every other key, and Alt+Enter, to the field', () => {
    for (const sendKey of ['enter', 'ctrl-enter'] as const) {
      assert.equal(sendAction(press('a'), sendKey), null)
      assert.equal(sendAction(press('Tab'), sendKey), null)
      assert.equal(sendAction(press('Enter', { altKey: true }), sendKey), null)
      assert.equal(sendAction(press('Enter', { altKey: true, ctrlKey: true }), sendKey), null)
    }
  })

  it('names the keys for the buttons and hints', () => {
    assert.deepEqual(sendKeys('enter'), { send: 'Enter', other: 'Ctrl+Enter' })
    assert.deepEqual(sendKeys('ctrl-enter'), { send: 'Ctrl+Enter', other: 'Ctrl+Shift+Enter' })
  })
})
