import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rendererMayUse } from './permissions'

const isRenderer = (url: string) => url.startsWith('app://renderer/')
const PAGE = 'app://renderer/index.html?mode=dark'

describe('what eNCode’s page may ask for', () => {
  it('lets its own page list the fonts and write plain text to the clipboard', () => {
    assert.equal(rendererMayUse('local-fonts', PAGE, true, isRenderer), true)
    assert.equal(rendererMayUse('clipboard-sanitized-write', PAGE, true, isRenderer), true)
  })

  it('never lets it read the clipboard, or ask for anything else', () => {
    for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'openExternal', 'fullscreen']) {
      assert.equal(rendererMayUse(permission, PAGE, true, isRenderer), false, permission)
    }
  })

  it('gives nothing to a frame inside the page, another page, or a request that names no page', () => {
    assert.equal(rendererMayUse('clipboard-sanitized-write', PAGE, false, isRenderer), false)
    assert.equal(rendererMayUse('clipboard-sanitized-write', PAGE, undefined, isRenderer), false)
    assert.equal(rendererMayUse('clipboard-sanitized-write', 'https://example.com/', true, isRenderer), false)
    assert.equal(rendererMayUse('clipboard-sanitized-write', undefined, true, isRenderer), false)
  })
})
