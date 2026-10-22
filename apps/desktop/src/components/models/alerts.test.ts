import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelAlert } from '@shared/types'
import { alertGate, toastOf } from './alerts'

const alert = (patch: Partial<ModelAlert> = {}): ModelAlert => ({ kind: 'key-refused', profileId: 'p', message: 'OpenAI did not accept the key.', ...patch })

describe('a notice from the model router', () => {
  it('is an error that points to Models when the key is refused or the sign-in is gone', () => {
    assert.deepEqual(toastOf(alert()), { kind: 'error', text: 'OpenAI did not accept the key.', tab: 'models' })
    assert.equal(toastOf(alert({ kind: 'sign-in' })).tab, 'models')
  })

  it('is an error that points to Roles for a payment problem or an unexpected charge, where "Check again" is', () => {
    assert.equal(toastOf(alert({ kind: 'payment' })).tab, 'roles')
    assert.equal(toastOf(alert({ kind: 'billed' })).kind, 'error')
  })

  it('is plain information otherwise, with nothing to open', () => {
    for (const kind of ['quota', 'catalog', 'model-refused'] as const) assert.deepEqual(toastOf(alert({ kind })), { kind: 'info', text: 'OpenAI did not accept the key.' })
  })
})

describe('showing a notice once', () => {
  it('lets the same one through again only after the window', () => {
    let now = 0
    const gate = alertGate(1000, () => now)
    assert.equal(gate(alert()), true)
    now = 500
    assert.equal(gate(alert()), false)
    now = 1000
    assert.equal(gate(alert()), true)
  })

  it('tells notices apart by kind, connection and words', () => {
    const gate = alertGate(1000, () => 0)
    assert.equal(gate(alert()), true)
    assert.equal(gate(alert({ kind: 'payment' })), true)
    assert.equal(gate(alert({ profileId: 'q' })), true)
    assert.equal(gate(alert({ message: 'Another thing.' })), true)
    assert.equal(gate(alert()), false)
  })
})
