import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KEY_NAMES, describeCombos, parseKeys } from './keys'

const ok = (text: string) => {
  const parsed = parseKeys(text)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error)
  return parsed.ok ? parsed.combos : []
}
const error = (text: string) => {
  const parsed = parseKeys(text)
  assert.equal(parsed.ok, false, `${text} should be refused`)
  return parsed.ok ? '' : parsed.error
}

describe('key combinations', () => {
  it('reads modifiers and a key, in any case and spelling', () => {
    assert.deepEqual(ok('Ctrl+S'), [{ modifiers: ['ctrl'], key: 's' }])
    assert.deepEqual(ok('control+SHIFT+t'), [{ modifiers: ['ctrl', 'shift'], key: 't' }])
    assert.deepEqual(ok('Option+F4'), [{ modifiers: ['alt'], key: 'f4' }])
    assert.deepEqual(ok('Return'), [{ modifiers: [], key: 'enter' }])
    assert.deepEqual(ok('esc'), [{ modifiers: [], key: 'escape' }])
    assert.deepEqual(ok('PgDn'), [{ modifiers: [], key: 'pagedown' }])
    assert.deepEqual(ok('ArrowLeft'), [{ modifiers: [], key: 'left' }])
  })

  it('reads several in a row', () => {
    assert.deepEqual(ok('ctrl+a delete'), [{ modifiers: ['ctrl'], key: 'a' }, { modifiers: [], key: 'delete' }])
    assert.equal(ok('down down down').length, 3)
  })

  it('reads punctuation and the plus key', () => {
    assert.deepEqual(ok('ctrl+-'), [{ modifiers: ['ctrl'], key: 'minus' }])
    assert.deepEqual(ok('ctrl++'), [{ modifiers: ['ctrl'], key: 'equals' }])
    assert.deepEqual(ok('ctrl+plus'), [{ modifiers: ['ctrl'], key: 'equals' }])
    assert.deepEqual(ok('+'), [{ modifiers: [], key: 'equals' }])
    assert.deepEqual(ok('ctrl+,'), [{ modifiers: ['ctrl'], key: 'comma' }])
    assert.deepEqual(ok('numpad5'), [{ modifiers: [], key: 'numpad5' }])
  })

  it('knows every name it can produce', () => {
    for (const name of KEY_NAMES) assert.deepEqual(ok(name), [{ modifiers: [], key: name }], name)
  })

  it('refuses the Windows key in any spelling', () => {
    for (const text of ['win+r', 'super+e', 'meta+d', 'cmd+c', 'windows', 'ctrl+win+left']) assert.match(error(text), /Windows key is not available/)
  })

  it('refuses combinations that leave the window', () => {
    assert.match(error('alt+tab'), /switches to another window/)
    assert.match(error('alt+shift+tab'), /switches to another window/)
    assert.match(error('alt+escape'), /switches to another window/)
    assert.match(error('ctrl+escape'), /Start menu/)
    assert.match(error('ctrl+shift+esc'), /Start menu or the task manager/)
    assert.match(error('ctrl+alt+delete'), /security screen/)
    assert.deepEqual(ok('alt+f4'), [{ modifiers: ['alt'], key: 'f4' }])
  })

  it('explains what is wrong with a mistake', () => {
    assert.match(error(''), /give the keys to press/)
    assert.match(error('ctrl+'), /has no key after the modifiers/)
    assert.match(error('ctrl+shift'), /ends with a modifier/)
    assert.match(error('hyper+a'), /"hyper" is not a modifier/)
    assert.match(error('f25'), /"f25" is not a key name/)
    assert.match(error(Array.from({ length: 21 }, () => 'a').join(' ')), /at most 20 key combinations/)
  })

  it('writes combinations back for people', () => {
    assert.equal(describeCombos(ok('ctrl+shift+t')), 'Ctrl+Shift+T')
    assert.equal(describeCombos(ok('ctrl+a delete')), 'Ctrl+A Delete')
  })
})
