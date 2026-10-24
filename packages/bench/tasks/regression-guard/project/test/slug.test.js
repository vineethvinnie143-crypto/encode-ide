import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slug } from '../src/slug.js'

test('spaces become dashes', () => {
  assert.equal(slug('Getting Started'), 'getting-started')
})

test('keeps folders', () => {
  assert.equal(slug('docs/Getting Started'), 'docs/getting-started')
})

test('drops punctuation', () => {
  assert.equal(slug('Hello, World!'), 'hello-world')
})
