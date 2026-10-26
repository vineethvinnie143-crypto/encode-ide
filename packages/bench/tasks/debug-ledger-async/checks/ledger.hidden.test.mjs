import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.env.BENCH_ROOT
const { Ledger } = await import(pathToFileURL(path.join(root, 'src', 'ledger.ts')).href)

test('main.ts prints the balances of entries.json', () => {
  const lines = execFileSync(process.execPath, [path.join('src', 'main.ts')], { cwd: root, encoding: 'utf8' }).split(/\r?\n/)
  for (const expected of ['alice 100', 'bob 30', 'carol 10']) assert.ok(lines.includes(expected), `${expected} in:\n${lines.join('\n')}`)
})

test('applyAll is done when it resolves, and no entry is lost', async () => {
  const ledger = new Ledger()
  await ledger.applyAll(Array.from({ length: 20 }, (_, index) => ({ account: index % 2 ? 'odd' : 'even', amount: index + 1 })))
  assert.equal(ledger.balance('even'), 100)
  assert.equal(ledger.balance('odd'), 110)
})

test('a later applyAll adds to what is there', async () => {
  const ledger = new Ledger()
  await ledger.applyAll([{ account: 'a', amount: 5 }])
  await ledger.applyAll([{ account: 'a', amount: 7 }, { account: 'a', amount: -2 }])
  assert.equal(ledger.balance('a'), 10)
})
