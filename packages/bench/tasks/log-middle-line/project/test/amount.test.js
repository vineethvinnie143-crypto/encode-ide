import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAmount, writeAmount } from '../src/amount.js'

test('reads an amount into cents', () => {
  assert.equal(parseAmount('12.50'), 1250)
  assert.equal(parseAmount('-3.10'), -310)
  assert.equal(parseAmount('nothing'), undefined)
})

test('writes cents back as the export does', () => {
  assert.equal(writeAmount(125000), '1250.00')
  assert.equal(writeAmount(-5), '-0.05')
})
