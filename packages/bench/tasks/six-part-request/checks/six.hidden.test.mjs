import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const api = await import(pathToFileURL(path.join(process.env.BENCH_ROOT, 'src', 'index.js')).href)
const items = () => [
  { sku: 'BLT-01', name: 'Bolt', onHand: 5, price: 1000, dailyUse: 1 },
  { sku: 'NUT-03', name: 'Nut; small', onHand: 30, price: 20, dailyUse: 10 },
  { sku: 'WSH-09', name: 'Washer "M8"', onHand: 18, price: 7, dailyUse: 2 },
  { sku: 'AXL-02', name: 'Axle', onHand: 8, price: 4000, dailyUse: 4 },
  { sku: 'PIN-05', name: 'Pin', onHand: 0, price: 3, dailyUse: 0 },
]

test('1. reserve refuses more than is on hand, and changes nothing', () => {
  const stock = api.createStock(items())
  assert.throws(() => stock.reserve('BLT-01', 6), RangeError)
  assert.equal(stock.get('BLT-01').onHand, 5)
  assert.equal(stock.reserve('BLT-01', 5), 0)
  assert.throws(() => stock.reserve('BLT-01', 1), RangeError)
})

test('2. bulk prices: 5% off from 50 units, 10% from 200', () => {
  const bolt = { price: 1000 }
  assert.equal(api.priceFor(bolt, 49), 49000)
  assert.equal(api.priceFor(bolt, 50), 47500)
  assert.equal(api.priceFor(bolt, 199), 189050)
  assert.equal(api.priceFor(bolt, 200), 180000)
  assert.equal(api.priceFor({ price: 3 }, 333), 899)
})

test('3. the low-stock report goes by days left, fewest first, ties by SKU', () => {
  const rows = api.lowStockReport(items(), api.loadConfig({}))
  assert.deepEqual(rows.map((row) => row.sku), ['AXL-02', 'NUT-03', 'BLT-01'])
  const tie = [{ sku: 'B', name: 'b', onHand: 2, dailyUse: 1 }, { sku: 'A', name: 'a', onHand: 4, dailyUse: 2 }]
  assert.deepEqual(api.lowStockReport(tie, api.loadConfig({})).map((row) => row.sku), ['A', 'B'])
})

test('4. lowStockDays comes from INVENTORY_LOW_STOCK_DAYS, 7 when it is not a positive whole number, and the report uses it', () => {
  assert.equal(api.loadConfig({}).lowStockDays, 7)
  assert.equal(api.loadConfig({ INVENTORY_LOW_STOCK_DAYS: '10' }).lowStockDays, 10)
  for (const bad of ['0', '-3', 'abc', '2.5', '']) assert.equal(api.loadConfig({ INVENTORY_LOW_STOCK_DAYS: bad }).lowStockDays, 7, bad)
  const wide = api.lowStockReport(items(), api.loadConfig({ INVENTORY_LOW_STOCK_DAYS: '10' }))
  assert.deepEqual(wide.map((row) => row.sku), ['AXL-02', 'NUT-03', 'BLT-01', 'WSH-09'])
  const narrow = api.lowStockReport(items(), api.loadConfig({ INVENTORY_LOW_STOCK_DAYS: '4' }))
  assert.deepEqual(narrow.map((row) => row.sku), ['AXL-02', 'NUT-03'])
})

test('5. a reservation is recorded in the audit log, as a delivery is', () => {
  const audit = api.createAudit()
  let tick = 1000
  const stock = api.createStock(items(), { audit, clock: () => tick++ })
  stock.reserve('AXL-02', 2)
  stock.restock('AXL-02', 3)
  assert.deepEqual(audit.entries(), [
    { action: 'reserve', sku: 'AXL-02', qty: 2, at: 1000 },
    { action: 'restock', sku: 'AXL-02', qty: 3, at: 1001 },
  ])
  assert.throws(() => stock.reserve('AXL-02', 99), RangeError)
  assert.equal(audit.entries().length, 2, 'a refused reservation is not recorded')
})

test('6. the export is semicolon-separated with a header row, and quotes what needs it', () => {
  const lines = api.exportCsv(items()).trimEnd().split(/\r?\n/)
  assert.equal(lines[0], 'sku;name;on_hand;price')
  assert.equal(lines[1], 'BLT-01;Bolt;5;1000')
  assert.equal(lines[2], 'NUT-03;"Nut; small";30;20')
  assert.equal(lines[3], 'WSH-09;"Washer ""M8""";18;7')
  assert.equal(lines.length, 6)
})
