import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eventKey, matchesChord, parseChord, type KeyEventLike } from './keys'
import { CommandRegistry } from './registry'

const press = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('chords', () => {
  it('parses modifiers and key names', () => {
    assert.deepEqual(parseChord('Ctrl+Shift+P'), { ctrl: true, shift: true, alt: false, meta: false, key: 'p' })
    assert.deepEqual(parseChord('Alt+1')?.key, '1')
    assert.equal(parseChord('F11')?.key, 'f11')
    assert.equal(parseChord('Ctrl++')?.key, '+')
    assert.equal(parseChord('Ctrl+Plus')?.key, '+')
    assert.equal(parseChord('Esc')?.key, 'escape')
    assert.equal(parseChord('Ctrl+`')?.key, '`')
    assert.equal(parseChord(''), null)
    assert.equal(parseChord('Ctrl+'), null)
    assert.equal(parseChord('Ctrl+A+B'), null, 'one key per chord')
  })

  it('names letters by the layout and punctuation by position', () => {
    assert.equal(eventKey(press('A', 'KeyA', { ctrlKey: true, shiftKey: true })), 'a')
    assert.equal(eventKey(press('}', 'BracketRight', { ctrlKey: true, shiftKey: true })), ']')
    assert.equal(eventKey(press('!', 'Digit1', { shiftKey: true })), '1')
    assert.equal(eventKey(press('`', 'Backquote', { ctrlKey: true })), '`')
    assert.equal(eventKey(press('+', 'NumpadAdd', { ctrlKey: true })), '+')
    assert.equal(eventKey(press(' ', 'Space')), 'space')
    assert.equal(eventKey(press('F11', 'F11')), 'f11')
    assert.equal(eventKey(press('Tab', 'Tab', { ctrlKey: true })), 'tab')
  })

  it('finds Ctrl+letter on a layout without Latin letters', () => {
    assert.equal(eventKey(press('ф', 'KeyA', { ctrlKey: true })), 'a')
    assert.equal(eventKey(press('ф', 'KeyA')), 'ф', 'typing without Ctrl stays typing')
  })

  it('treats characters typed with AltGr as text', () => {
    const polishO = press('ó', 'KeyO', { ctrlKey: true, altKey: true })
    assert.equal(matchesChord(polishO, parseChord('Ctrl+Alt+O')!), false)
    const germanAt = press('@', 'KeyQ', { ctrlKey: true, altKey: true })
    assert.equal(eventKey(germanAt), '@')
    const germanBrace = press('{', 'Digit7', { ctrlKey: true, altKey: true })
    assert.equal(matchesChord(germanBrace, parseChord('Ctrl+Alt+7')!), false)
    assert.equal(matchesChord(press('o', 'KeyO', { ctrlKey: true, altKey: true }), parseChord('Ctrl+Alt+O')!), true)
  })

  it('keeps Alt with numpad digits for typing characters', () => {
    assert.equal(matchesChord(press('1', 'Numpad1', { altKey: true }), parseChord('Alt+1')!), false)
    assert.equal(matchesChord(press('1', 'Digit1', { altKey: true }), parseChord('Alt+1')!), true)
  })

  it('matches modifiers exactly', () => {
    const chord = parseChord('Ctrl+B')!
    assert.equal(matchesChord(press('b', 'KeyB', { ctrlKey: true }), chord), true)
    assert.equal(matchesChord(press('B', 'KeyB', { ctrlKey: true, shiftKey: true }), chord), false)
    assert.equal(matchesChord(press('b', 'KeyB'), chord), false)
  })
})

describe('command registry', () => {
  const make = () => {
    const ran: string[] = []
    const registry = new CommandRegistry()
    let canPin = true
    registry.register(
      { id: 'new', title: 'New session', group: 'File', keys: ['Ctrl+N'], run: () => void ran.push('new') },
      { id: 'pin', title: 'Pin', group: 'Session', keys: ['Ctrl+Alt+P'], enabled: () => canPin, run: () => void ran.push('pin') },
      { id: 'help', title: 'Help', group: 'Help', keys: ['F1'], run: () => void ran.push('help') },
      { id: 'escape', title: 'Close', group: 'View', keys: ['Escape'], run: () => void ran.push('escape') },
      { id: 'copy', title: 'Copy', group: 'Edit', hint: 'Ctrl+C', run: () => void ran.push('copy') },
    )
    return { registry, ran, disablePin: () => (canPin = false) }
  }

  it('finds the command a key triggers, and skips disabled ones', () => {
    const { registry, disablePin } = make()
    assert.equal(registry.forEvent(press('n', 'KeyN', { ctrlKey: true }), false)?.id, 'new')
    assert.equal(registry.forEvent(press('p', 'KeyP', { ctrlKey: true, altKey: true }), false)?.id, 'pin')
    disablePin()
    assert.equal(registry.forEvent(press('p', 'KeyP', { ctrlKey: true, altKey: true }), false), undefined)
    assert.equal(registry.run('pin'), false)
  })

  it('lets plain keys keep typing in a field', () => {
    const { registry } = make()
    assert.equal(registry.forEvent(press('Escape', 'Escape'), true), undefined)
    assert.equal(registry.forEvent(press('Escape', 'Escape'), false)?.id, 'escape')
    assert.equal(registry.forEvent(press('F1', 'F1'), true)?.id, 'help')
    assert.equal(registry.forEvent(press('n', 'KeyN', { ctrlKey: true }), true)?.id, 'new')
  })

  it('shows hints without binding them', () => {
    const { registry } = make()
    assert.equal(registry.shortcut('copy'), 'Ctrl+C')
    assert.equal(registry.forEvent(press('c', 'KeyC', { ctrlKey: true }), false), undefined)
  })

  it('reports shortcuts bound twice', () => {
    const { registry } = make()
    assert.deepEqual(registry.conflicts(), [])
    registry.register({ id: 'other', title: 'Other', group: 'View', keys: ['Ctrl+N'], run: () => {} })
    assert.deepEqual(registry.conflicts(), ['Ctrl+n: new, other'])
  })
})
