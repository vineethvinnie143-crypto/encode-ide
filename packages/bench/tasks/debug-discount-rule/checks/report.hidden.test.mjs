import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = process.env.BENCH_ROOT
const report = (dir) => execFileSync(process.execPath, ['report.js'], { cwd: dir, encoding: 'utf8' })
const line = (output, id) => output.split(/\r?\n/).find((text) => text.startsWith(`${id} `)) ?? ''

test("the shop's own orders", () => {
  const output = report(root)
  assert.match(line(output, 'A-1040'), /no discount\s+total 25\.00$/)
  assert.match(line(output, 'A-1041'), /Weekend\s+total 44\.1[34]$/)
  assert.match(line(output, 'A-1042'), /Loyal customer\s+total 85\.00$/)
  assert.match(line(output, 'A-1043'), /Bulk order\s+total 220\.80$/)
})

test('another export of the rules, with other percentages as text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-'))
  try {
    fs.cpSync(root, dir, { recursive: true })
    const rules = [
      { name: 'Nine', minTotal: 0, percent: '9' },
      { name: 'Ten', minTotal: 0, percent: '10' },
      { name: 'Twelve and a half', minTotal: 90, percent: '12.5' },
      { name: 'Two', minTotal: 0, percent: 2 },
    ]
    const orders = [
      { id: 'B-1', items: [{ sku: 'X', price: 50, qty: 2 }] },
      { id: 'B-2', items: [{ sku: 'Y', price: 40, qty: 1 }] },
    ]
    fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(rules))
    fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(orders))
    const output = report(dir)
    assert.match(line(output, 'B-1'), /Twelve and a half\s+total 87\.50$/)
    assert.match(line(output, 'B-2'), /Ten\s+total 36\.00$/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
