import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)
const api = await load('src/index.js')
const { ProtocolError } = await load('src/errors.js')

const NEEDS = {
  Join: { type: 'join', fields: ["room", "name"] },
  Leave: { type: 'leave', fields: ["room"] },
  Chat: { type: 'chat', fields: ["room", "text"] },
  Move: { type: 'move', fields: ["x", "y"] },
  Trade: { type: 'trade', fields: ["to", "items"] },
  Emote: { type: 'emote', fields: ["name"] },
  Ping: { type: 'ping', fields: ["at"] },
  Report: { type: 'report', fields: ["player", "reason"] },
}
const value = (field) => (field === 'items' ? ['sword'] : field === 'x' || field === 'y' || field === 'at' ? 7 : 'v')

for (const [name, { type, fields }] of Object.entries(NEEDS)) {
  test(`handle${name} answers a full message and refuses one that lacks a field`, () => {
    const full = { type, ...Object.fromEntries(fields.map((field) => [field, value(field)])) }
    assert.equal(typeof api[`handle${name}`](full), 'object')
    for (const field of fields) {
      const { [field]: _left, ...rest } = full
      assert.throws(() => api[`handle${name}`](rest), (error) => error instanceof ProtocolError, `${type} without ${field}`)
    }
  })
}

test('encodeFrame writes a frame as the protocol describes', () => {
  const payload = { type: 'chat', room: 'lobby', text: 'hé' }
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  let checksum = 0
  for (const byte of body) checksum ^= byte
  const want = Buffer.concat([Buffer.from([0x45, 0x4e, 0x43, 0x37, 3, body.length >> 8, body.length & 0xff]), body, Buffer.from([checksum])])
  assert.ok(Buffer.from(api.encodeFrame(payload)).equals(want))
  const long = { type: 'chat', room: 'lobby', text: 'x'.repeat(300) }
  const frame = Buffer.from(api.encodeFrame(long))
  assert.equal(frame.readUInt16BE(5), Buffer.byteLength(JSON.stringify(long)))
})
