import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)
import fs from 'node:fs/promises'

const { handleRefundRequested, handleRefundIssued } = await load('src/handlers.js')

test('refuses a refund of zero or less', () => {
  for (const amount of [0, -1, -0.5]) assert.throws(() => handleRefundRequested({ id: 'r1', amount }), { name: 'RangeError', message: 'refund amount must be positive' })
})

test('still takes a refund above zero as before', () => {
  assert.deepEqual(handleRefundRequested({ id: 'r2', amount: 25, at: 'now' }), { type: 'refund.requested', id: 'r2', amount: 25, at: 'now' })
  assert.throws(() => handleRefundRequested({ id: 'r3', amount: 'x' }), TypeError)
})

test('leaves the other handlers alone', async () => {
  assert.deepEqual(handleRefundIssued({ id: 'r4', amount: -5 }), { type: 'refund.issued', id: 'r4', amount: -5, at: null })
  const handlers = (text) => new Map([...text.replace(/\r\n/g, '\n').matchAll(/export function (\w+)\(payload\) \{\n[\s\S]*?\n\}/g)].map((match) => [match[1], match[0]]))
  const before = handlers(await fs.readFile(path.join(process.env.BENCH_CHECKS, 'handlers.original.js'), 'utf8'))
  const after = handlers(await fs.readFile(path.join(process.env.BENCH_ROOT, 'src', 'handlers.js'), 'utf8'))
  assert.equal(after.size, before.size)
  for (const [name, body] of before) if (name !== 'handleRefundRequested') assert.equal(after.get(name), body, name)
})
