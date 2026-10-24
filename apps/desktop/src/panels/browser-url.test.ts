import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addressOf, shownAddress } from './browser-url'

describe('the Browser address bar', () => {
  it('opens addresses typed with or without a scheme, http on this computer and https elsewhere', () => {
    assert.equal(addressOf('example.com/docs'), 'https://example.com/docs')
    assert.equal(addressOf('localhost:5173'), 'http://localhost:5173/')
    assert.equal(addressOf('127.0.0.1:8/'), 'http://127.0.0.1:8/')
    assert.equal(addressOf('app.localhost'), 'http://app.localhost/')
    assert.equal(addressOf('  http://example.com  '), 'http://example.com/')
    assert.equal(addressOf('intranet:8080'), 'https://intranet:8080/')
  })

  it('opens nothing that is not a web page, a word, or an address with a password in it', () => {
    for (const raw of ['', 'file:///C:/x', 'javascript://alert(1)', 'ftp://example.com', 'two words', 'hello', 'https://me:pw@example.com', 'chrome://settings']) assert.equal(addressOf(raw), null, raw)
  })

  it('shows the address without https:// and a lone slash', () => {
    assert.equal(shownAddress('https://example.com/'), 'example.com')
    assert.equal(shownAddress('https://example.com/a/'), 'example.com/a/')
    assert.equal(shownAddress('http://localhost:5173/'), 'http://localhost:5173/')
    assert.equal(shownAddress('about:blank'), '')
  })
})
