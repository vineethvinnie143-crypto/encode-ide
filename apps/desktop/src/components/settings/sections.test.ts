import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SECTIONS, SETTINGS, searchSettings, sectionInfo } from './sections'

const found = (query: string) => searchSettings(query).map((hit) => [hit.section.id, hit.settings.map((setting) => setting.id)])

describe('the Settings page sections', () => {
  it('lists each section once, every setting under a section that exists, and no setting twice', () => {
    const ids = SECTIONS.map((section) => section.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(SECTIONS[0].id, 'general', 'the page opens on General')
    for (const setting of SETTINGS) assert.ok(ids.includes(setting.section), setting.id)
    const settingIds = SETTINGS.map((setting) => setting.id)
    assert.equal(new Set(settingIds).size, settingIds.length)
    for (const setting of SETTINGS) assert.ok(setting.id.startsWith(`${setting.section}.`), `${setting.id} is named after its section`)
  })

  it('finds a section by id, and falls back to the first', () => {
    assert.equal(sectionInfo('shortcuts').title, 'Keyboard shortcuts')
    assert.equal(sectionInfo('nothing' as never).id, 'general')
  })
})

describe('searching the settings', () => {
  it('lists every section, with no settings under them, before anything is typed', () => {
    assert.deepEqual(
      found('  '),
      SECTIONS.map((section) => [section.id, []]),
    )
  })

  it('finds a setting by the start of each word typed, in any order', () => {
    assert.deepEqual(found('keep aw'), [['general', ['general.keepAwake']]])
    assert.deepEqual(found('awake keep'), [['general', ['general.keepAwake']]])
    assert.deepEqual(found('wake'), [], 'words match from their start')
  })

  it('finds settings by their other words, and a section by its own', () => {
    assert.deepEqual(found('sleep'), [['general', ['general.keepAwake']]])
    assert.deepEqual(found('taskbar'), [['notifications', ['notifications.flash']]])
    const shortcuts = found('rebind')
    assert.deepEqual(shortcuts, [['shortcuts', ['shortcuts.list']]])
    assert.deepEqual(found('history'), [['archived', []]], 'the section itself, by its keywords')
  })

  it('keeps the page order and every match in a section', () => {
    const hits = found('font')
    assert.deepEqual(hits, [['appearance', ['appearance.uiFont', 'appearance.uiSize', 'appearance.codeFont', 'appearance.codeSize']]])
    const order = searchSettings('key').map((hit) => hit.section.id)
    assert.deepEqual(
      order,
      SECTIONS.map((section) => section.id).filter((id) => order.includes(id)),
      'sections come in the order of the page',
    )
  })

  it('finds the editor\'s wrapping and spaces', () => {
    assert.deepEqual(found('wrap'), [['editor', ['editor.wordWrap', 'editor.wrapAt', 'editor.wrapColumn', 'editor.wrapIndent']]])
    assert.deepEqual(found('alt z'), [['editor', ['editor.wordWrap']]])
    assert.deepEqual(found('trailing'), [['editor', ['editor.whitespace']]])
  })

  it('finds what the editor does for screen readers and the keyboard', () => {
    assert.deepEqual(found('narrator'), [['editor', ['editor.screenReader']]])
    assert.deepEqual(found('arabic'), [['editor', ['editor.bidi']]])
    assert.deepEqual(found('keyboard trap'), [['editor', ['editor.tabMovesFocus']]])
    assert.deepEqual(found('accessibility'), [
      ['appearance', ['appearance.contrast']],
      ['editor', ['editor.screenReader', 'editor.tabMovesFocus']],
    ])
  })

  it('ignores case and punctuation', () => {
    assert.deepEqual(found('SEND MESSAGES'), [['general', ['general.send']]])
    assert.deepEqual(found('ctrl+enter'), found('Ctrl+Enter'))
  })
})
