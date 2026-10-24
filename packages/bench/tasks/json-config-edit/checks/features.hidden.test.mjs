import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const text = await fs.readFile(path.join(process.env.BENCH_ROOT, 'config', 'features.json'), 'utf8')
const config = JSON.parse(text)

test('the flags are as asked', () => {
  assert.deepEqual(config.features.newCheckout, { enabled: true, rollout: 10 })
  assert.deepEqual(config.features.fastShipping, { enabled: false, rollout: 0 })
})

test('nothing else changed', () => {
  assert.equal(config.version, 3)
  assert.deepEqual(config.features.darkMode, { enabled: true, rollout: 100 })
  assert.deepEqual(config.features.betaSearch, { enabled: true, rollout: 25 })
  assert.deepEqual(config.owners, ['web', 'payments'])
  assert.deepEqual(Object.keys(config.features).slice(0, 3), ['darkMode', 'newCheckout', 'betaSearch'])
})

test('the layout is kept: two spaces, one flag a line', () => {
  for (const name of Object.keys(config.features)) assert.match(text, new RegExp(`^    "${name}": \\{ [^\\n]* \\},?$`, 'm'), name)
  assert.match(text, /^  "version": 3,$/m)
  assert.match(text, /^  "owners": \["web", "payments"\]$/m)
  assert.ok(text.endsWith('}\n'), 'ends with one newline')
})
