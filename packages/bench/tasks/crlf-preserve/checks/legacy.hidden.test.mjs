import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)

const legacy = await load('src/legacy.js')

test('the new values', () => {
  assert.equal(legacy.RETRY_LIMIT, 5)
  assert.equal(legacy.RETRY_DELAY_MS, 2500)
  assert.equal(legacy.nextDelay(2), 10000)
})
