import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const { total } = await import(pathToFileURL(path.join(process.env.BENCH_ROOT, 'src', 'cart.js')).href)

test('a whole discount leaves nothing to pay', () => {
  assert.equal(total([{ price: 1500, quantity: 1 }], { discountPercent: 100, taxPercent: 20 }), 0)
})

test('tax alone', () => {
  assert.equal(total([{ price: 1000, quantity: 1 }], { taxPercent: 7 }), 1070)
})

test('rounds to a whole cent once, at the end', () => {
  assert.equal(total([{ price: 333, quantity: 1 }], { discountPercent: 15, taxPercent: 7 }), 303)
})
