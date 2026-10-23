import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OUTLINE_MAX, OUTLINE_MIN, WRAP_COLUMN_MAX, WRAP_COLUMN_MIN, normalizeLayout, textOptions } from './editor-layout'

describe('the editor layout as saved', () => {
  it('gives every field its default when nothing or something else was saved', () => {
    const defaults = {
      breadcrumbs: true,
      outline: false,
      folding: true,
      stickyScroll: true,
      bracketColors: true,
      minimap: true,
      inlayHints: true,
      semanticHighlighting: true,
      wordWrap: false,
      wrapAt: 'edge',
      wrapColumn: 80,
      wrapIndent: true,
      showWhitespace: false,
      whitespace: 'selection',
      outlineWidth: 248,
      outlineSort: 'position',
      outlineFollow: true,
    }
    assert.deepEqual(normalizeLayout(null), defaults)
    assert.deepEqual(normalizeLayout('wide'), defaults)
    assert.deepEqual(
      normalizeLayout({
        breadcrumbs: 'yes',
        outline: 1,
        folding: 0,
        stickyScroll: 'on',
        bracketColors: [],
        minimap: {},
        inlayHints: 'no',
        semanticHighlighting: 1,
        wordWrap: 'on',
        wrapAt: 'window',
        wrapColumn: '80',
        wrapIndent: 0,
        showWhitespace: 'all',
        whitespace: 'some',
        outlineWidth: 'big',
        outlineSort: 'size',
        outlineFollow: null,
      }),
      defaults,
    )
  })

  it('keeps what is right and holds the width inside its limits', () => {
    const saved = {
      breadcrumbs: false,
      outline: true,
      folding: false,
      stickyScroll: false,
      bracketColors: false,
      minimap: false,
      inlayHints: false,
      semanticHighlighting: false,
      wordWrap: true,
      wrapAt: 'bounded',
      wrapColumn: 100.4,
      wrapIndent: false,
      showWhitespace: true,
      whitespace: 'trailing',
      outlineWidth: 300.4,
      outlineSort: 'kind',
      outlineFollow: false,
    }
    assert.deepEqual(normalizeLayout(saved), {
      breadcrumbs: false,
      outline: true,
      folding: false,
      stickyScroll: false,
      bracketColors: false,
      minimap: false,
      inlayHints: false,
      semanticHighlighting: false,
      wordWrap: true,
      wrapAt: 'bounded',
      wrapColumn: 100,
      wrapIndent: false,
      showWhitespace: true,
      whitespace: 'trailing',
      outlineWidth: 300,
      outlineSort: 'kind',
      outlineFollow: false,
    })
    assert.equal(normalizeLayout({ outlineWidth: 10 }).outlineWidth, OUTLINE_MIN)
    assert.equal(normalizeLayout({ outlineWidth: 5000 }).outlineWidth, OUTLINE_MAX)
    assert.equal(normalizeLayout({ outlineWidth: Number.NaN }).outlineWidth, 248)
    assert.equal(normalizeLayout({ wrapColumn: 3 }).wrapColumn, WRAP_COLUMN_MIN)
    assert.equal(normalizeLayout({ wrapColumn: 1e9 }).wrapColumn, WRAP_COLUMN_MAX)
    assert.equal(normalizeLayout({ wrapColumn: Number.POSITIVE_INFINITY }).wrapColumn, 80)
  })
})

describe('what the editor is given for wrapping and spaces', () => {
  const layout = (patch: object) => normalizeLayout(patch)

  it('wraps only while word wrap is on, where the layout says', () => {
    assert.equal(textOptions(layout({ wordWrap: false, wrapAt: 'column' })).wordWrap, 'off')
    assert.equal(textOptions(layout({ wordWrap: true })).wordWrap, 'on')
    assert.equal(textOptions(layout({ wordWrap: true, wrapAt: 'column' })).wordWrap, 'column')
    assert.equal(textOptions(layout({ wordWrap: true, wrapAt: 'bounded', wrapColumn: 120 })).wordWrap, 'bounded')
    assert.equal(textOptions(layout({ wrapColumn: 120 })).wrapColumn, 120)
    assert.equal(textOptions(layout({ wrapIndent: false })).wrapIndent, false)
  })

  it('shows every space while Show whitespace is on, and the chosen ones otherwise', () => {
    assert.equal(textOptions(layout({})).renderWhitespace, 'selection')
    assert.equal(textOptions(layout({ whitespace: 'none', showWhitespace: true })).renderWhitespace, 'all')
    assert.equal(textOptions(layout({ whitespace: 'boundary' })).renderWhitespace, 'boundary')
  })
})
