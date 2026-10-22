import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanKeybindings, MAX_CHORDS, MAX_KEYBINDINGS } from './keybindings'

describe('the shortcuts kept in the settings file', () => {
  it('keeps command ids with their chords, and an empty list for a command left without one', () => {
    const kept = { 'view.bottomPanel': ['Ctrl+Shift+J'], 'edit.find': [], 'session.go1': ['Ctrl+Alt+1', 'F6'] }
    assert.deepEqual(cleanKeybindings(kept), kept)
  })

  it('drops anything that is not a list of chords under a command id', () => {
    assert.deepEqual(cleanKeybindings(null), {})
    assert.deepEqual(cleanKeybindings(['Ctrl+J']), {})
    assert.deepEqual(cleanKeybindings('Ctrl+J'), {})
    const parsed = JSON.parse('{"__proto__": ["Ctrl+J"], "constructor": ["Ctrl+K"], "toString": [], "view": ["Ctrl+L"], "Edit.find": ["Ctrl+M"]}')
    const clean = cleanKeybindings(parsed)
    assert.deepEqual(clean, {}, 'names that are not command ids, __proto__ above all')
    assert.equal(Object.getPrototypeOf(clean), Object.prototype)
    assert.deepEqual(cleanKeybindings({ 'edit.find': 'Ctrl+F' }), {})
  })

  it('keeps chords as short plain text, once each, a few per command', () => {
    const chords = ['Ctrl+F', 'Ctrl+F', 7, '', 'Ctrl+ F', 'Ctrl+é', 'x'.repeat(41), 'F1', 'F2', 'F3', 'F4', 'F5']
    assert.deepEqual(cleanKeybindings({ 'edit.find': chords })['edit.find'], ['Ctrl+F', 'F1', 'F2', 'F3'])
    assert.equal(MAX_CHORDS, 4)
  })

  it('reads no more entries than eNCode could have commands', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_KEYBINDINGS + 50 }, (_, index) => [`cmd.c${index}`, ['F1']]))
    assert.equal(Object.keys(cleanKeybindings(many)).length, MAX_KEYBINDINGS)
  })
})
