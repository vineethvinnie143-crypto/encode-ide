import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const { parseAmount } = await import(pathToFileURL(path.join(process.env.BENCH_ROOT, 'src', 'amount.js')).href)

test('reads amounts with and without a thousands separator', () => {
  assert.equal(parseAmount('1,250.00'), 125000)
  assert.equal(parseAmount('1250.00'), 125000)
  assert.equal(parseAmount('12,345,678.90'), 1234567890)
  assert.equal(parseAmount('-1,000.01'), -100001)
  assert.equal(parseAmount(' 7.5 '), 750)
})

test('still refuses what is not an amount', () => {
  for (const text of ['', 'abc', '1.2.3', 'USD']) assert.equal(parseAmount(text), undefined, JSON.stringify(text))
})
