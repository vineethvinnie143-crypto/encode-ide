import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.env.BENCH_ROOT
const { readCsv } = await import(pathToFileURL(path.join(root, 'src', 'csv.js')).href)

test('the summary of sales.csv matches the finance team', () => {
  const lines = execFileSync(process.execPath, ['summary.js', 'sales.csv'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/)
  for (const expected of ['300 records', 'north 105130.06', 'south 86511.23', 'east 82765.50', 'west 95478.91']) assert.ok(lines.includes(expected), `${expected} in:\n${lines.join('\n')}`)
})

test("every record of sales.csv is read right, customers' names too", () => {
  const records = readCsv(fs.readFileSync(path.join(root, 'sales.csv'), 'utf8'))
  assert.equal(records.length, 300)
  const byId = new Map(records.map((record) => [record.id, record]))
  assert.deepEqual({ ...byId.get('217') }, { id: '217', customer: 'Smith, Jones & Co', region: 'north', amount: '1250.40' })
  assert.deepEqual({ ...byId.get('89') }, { id: '89', customer: 'Lake, Hill and Sons', region: 'east', amount: '342.75' })
  assert.equal(byId.get('151').customer, 'The "Best" Shop')
  assert.equal(byId.get('41').customer, 'Corner Store')
  for (const record of records) assert.match(record.region, /^(north|south|east|west)$/, `record ${record.id}`)
})

test('other quoted fields, and empty ones', () => {
  const text = 'id,customer,region,amount\n1,"A, B, and C",west,1.00\n2,"Say ""hi""",east,2.00\n3,,south,3.00\n4,"",north,4.00\n'
  const records = readCsv(text).map((record) => ({ ...record }))
  assert.deepEqual(records, [
    { id: '1', customer: 'A, B, and C', region: 'west', amount: '1.00' },
    { id: '2', customer: 'Say "hi"', region: 'east', amount: '2.00' },
    { id: '3', customer: '', region: 'south', amount: '3.00' },
    { id: '4', customer: '', region: 'north', amount: '4.00' },
  ])
})
