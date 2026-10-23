import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OUTLINE_MAX, OUTLINE_MIN, normalizeLayout } from './editor-layout'

describe('the editor layout as saved', () => {
  it('gives every field its default when nothing or something else was saved', () => {
    const defaults = { breadcrumbs: true, outline: false, outlineWidth: 248, outlineSort: 'position', outlineFollow: true }
    assert.deepEqual(normalizeLayout(null), defaults)
    assert.deepEqual(normalizeLayout('wide'), defaults)
    assert.deepEqual(normalizeLayout({ breadcrumbs: 'yes', outline: 1, outlineWidth: 'big', outlineSort: 'size', outlineFollow: null }), defaults)
  })

  it('keeps what is right and holds the width inside its limits', () => {
    assert.deepEqual(normalizeLayout({ breadcrumbs: false, outline: true, outlineWidth: 300.4, outlineSort: 'kind', outlineFollow: false }), {
      breadcrumbs: false,
      outline: true,
      outlineWidth: 300,
      outlineSort: 'kind',
      outlineFollow: false,
    })
    assert.equal(normalizeLayout({ outlineWidth: 10 }).outlineWidth, OUTLINE_MIN)
    assert.equal(normalizeLayout({ outlineWidth: 5000 }).outlineWidth, OUTLINE_MAX)
    assert.equal(normalizeLayout({ outlineWidth: Number.NaN }).outlineWidth, 248)
  })
})
