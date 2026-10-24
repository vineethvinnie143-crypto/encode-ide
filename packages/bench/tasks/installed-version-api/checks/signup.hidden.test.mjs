import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)

const { validateSignup } = await load('src/signup.js')

test('a good form passes', () => {
  assert.deepEqual(validateSignup({ email: 'ada@example.com', password: 'correct horse' }), { ok: true, errors: [] })
})

test('each problem gives one message', () => {
  const result = validateSignup({ email: 'ada.example.com', password: 'short' })
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
  assert.ok(result.errors.every((error) => typeof error === 'string' && error.length > 0))
})

test('one problem, one message', () => {
  const result = validateSignup({ email: 'ada@example.com', password: '1234567' })
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
})
