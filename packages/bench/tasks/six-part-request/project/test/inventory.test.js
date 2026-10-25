import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStock, exportCsv, loadConfig, lowStockReport, priceFor } from '../src/index.js'

const ITEMS = [
  { sku: 'BLT-01', name: 'Bolt', onHand: 40, price: 25, dailyUse: 10 },
  { sku: 'NUT-03', name: 'Nut', onHand: 500, price: 5, dailyUse: 20 },
]

test('a delivery adds to what is on hand', () => {
  assert.equal(createStock(ITEMS).restock('BLT-01', 10), 50)
})

test('one unit costs its price', () => {
  assert.equal(priceFor(ITEMS[0], 1), 25)
})

test('the low-stock report names what runs out soon', () => {
  assert.deepEqual(lowStockReport(ITEMS, loadConfig({})).map((row) => row.sku), ['BLT-01'])
})

test('the export has every item', () => {
  const csv = exportCsv(ITEMS)
  assert.ok(csv.includes('BLT-01') && csv.includes('NUT-03'))
})
