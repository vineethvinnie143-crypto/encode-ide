import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const load = (file) => import(pathToFileURL(path.join(process.env.BENCH_ROOT, ...file.split('/'))).href)

const { slug } = await load('src/slug.js')

test('punctuation, folders and spaces together', () => {
  assert.equal(slug('  Guides/Install & Run!  '), 'guides/install-run')
  assert.equal(slug('FAQ: What is it?'), 'faq-what-is-it')
  assert.equal(slug('a  -  b'), 'a-b')
})
