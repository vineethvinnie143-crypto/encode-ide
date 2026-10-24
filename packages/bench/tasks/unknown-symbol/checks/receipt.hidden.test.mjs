import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)

const { renderReceipt } = await load('src/receipt.js')

test('prices and the total are shown as money', () => {
  const text = renderReceipt({ items: [{ name: 'Tea', quantity: 2, price: 625 }, { name: 'Cake', quantity: 1, price: 350 }] })
  assert.match(text, /\$12\.50/)
  assert.match(text, /\$3\.50/)
  assert.match(text, /\$16\.00/)
  assert.doesNotMatch(text, /\b1250\b|\b1600\b/)
})
