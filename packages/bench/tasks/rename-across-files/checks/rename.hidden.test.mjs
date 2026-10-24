import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)

const api = await load('src/index.js')
const ada = { firstName: 'Ada', lastName: 'Lovelace' }

test('the function goes by its new name', () => {
  assert.equal(typeof api.getDisplayName, 'function')
  assert.equal(api.getUserName, undefined)
  assert.equal(api.getDisplayName({ displayName: 'ada' }), 'ada')
})

test('its callers use it', () => {
  assert.equal(api.profileHeading(ada), 'Profile of Ada Lovelace')
  assert.equal(api.greeting(ada), 'Hello Ada Lovelace,')
  assert.equal(api.userReport([ada]), 'Ada Lovelace (Lovelace, Ada)')
  assert.equal(api.getUserNameLegacy(ada), 'Lovelace, Ada')
})
