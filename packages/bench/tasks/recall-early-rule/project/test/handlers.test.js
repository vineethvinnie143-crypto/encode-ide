import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleJoin, handlePing } from '../src/index.js'

test('a full join is answered', () => {
  assert.deepEqual(handleJoin({ type: 'join', room: 'lobby', name: 'ada' }), { type: 'joined', room: 'lobby', name: 'ada', host: false })
})

test('a ping is answered with its time', () => {
  assert.deepEqual(handlePing({ type: 'ping', at: 5 }), { type: 'pong', at: 5 })
})
