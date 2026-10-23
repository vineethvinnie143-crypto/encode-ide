import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keymap, comboOf, defaultBindings, isMac, parseCombo, type KeyEventLike } from './keymap'

function key(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }
}

describe('parseCombo', () => {
  it('orders modifiers and lowercases letters', () => {
    assert.equal(parseCombo('Shift-Mod-K', false), 'Ctrl-Shift-k')
    assert.equal(parseCombo('Mod-Alt-ArrowUp', false), 'Ctrl-Alt-ArrowUp')
    assert.equal(parseCombo('Mod-Alt-ArrowUp', true), 'Alt-Meta-ArrowUp')
    assert.equal(parseCombo('Esc', false), 'Escape')
    assert.equal(parseCombo('Mod--', false), 'Ctrl--')
    assert.equal(parseCombo('Mod-Shift-\\', false), 'Ctrl-Shift-\\')
    assert.equal(parseCombo('Mod-Space', false), 'Ctrl-Space')
  })

  it('rejects unknown modifiers', () => {
    assert.throws(() => parseCombo('Hyper-k', false), /Unknown modifier/)
  })
})

describe('comboOf', () => {
  it('names shortcuts by modifiers and key', () => {
    assert.equal(comboOf(key({ key: 'z', code: 'KeyZ', ctrlKey: true })), 'Ctrl-z')
    assert.equal(comboOf(key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })), 'Ctrl-Shift-z')
    assert.equal(comboOf(key({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })), 'Shift-ArrowLeft')
    assert.equal(comboOf(key({ key: 'F3', code: 'F3', shiftKey: true })), 'Shift-F3')
    assert.equal(comboOf(key({ key: 'Enter', code: 'Enter' })), 'Enter')
    assert.equal(comboOf(key({ key: ' ', code: 'Space', ctrlKey: true })), 'Ctrl-Space')
  })

  it('leaves typed characters alone', () => {
    assert.equal(comboOf(key({ key: 'a', code: 'KeyA' })), 'a')
    assert.equal(comboOf(key({ key: 'A', code: 'KeyA', shiftKey: true })), 'a')
    assert.equal(comboOf(key({ key: '!', code: 'Digit1', shiftKey: true })), '!')
  })

  it('follows the physical key for punctuation under a command modifier', () => {
    // Ctrl+Shift+\ types "|" on a US keyboard.
    assert.equal(comboOf(key({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })), 'Ctrl-Shift-\\')
    assert.equal(comboOf(key({ key: '/', code: 'Slash', ctrlKey: true })), 'Ctrl-/')
    // Another layout puts "/" on Shift+7; the shortcut stays where the US layout has it.
    assert.equal(comboOf(key({ key: '7', code: 'Slash', ctrlKey: true })), 'Ctrl-/')
    assert.equal(comboOf(key({ key: '[', code: 'BracketLeft', metaKey: true })), 'Meta-[')
  })

  it('follows the physical key for letters of other scripts', () => {
    // Ctrl+Z on a Russian layout reports "я".
    assert.equal(comboOf(key({ key: 'я', code: 'KeyZ', ctrlKey: true })), 'Ctrl-z')
    // macOS Option+A reports "å".
    assert.equal(comboOf(key({ key: 'å', code: 'KeyA', altKey: true, shiftKey: true })), 'Alt-Shift-a')
  })

  it('ignores composition, bare modifiers, dead keys and AltGr text', () => {
    assert.equal(comboOf(key({ key: 'a', isComposing: true })), null)
    assert.equal(comboOf(key({ key: 'Process', keyCode: 229 })), null)
    assert.equal(comboOf(key({ key: 'Control', ctrlKey: true })), null)
    assert.equal(comboOf(key({ key: 'Dead', code: 'Quote' })), null)
    const altGr = key({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' })
    assert.equal(comboOf(altGr), null)
    // AltGr with a non-text key is still a shortcut.
    const altGrArrow = key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, altKey: true, getModifierState: (name) => name === 'AltGraph' })
    assert.equal(comboOf(altGrArrow), 'Ctrl-Alt-ArrowUp')
  })
})

describe('Keymap', () => {
  const windows = new Keymap(defaultBindings, false)
  const mac = new Keymap(defaultBindings, true)

  it('looks events up in the table', () => {
    assert.deepEqual(windows.lookup(key({ key: 'f', code: 'KeyF', ctrlKey: true })), ['openFind'])
    assert.deepEqual(mac.lookup(key({ key: 'f', code: 'KeyF', metaKey: true })), ['openFind'])
    assert.deepEqual(windows.lookup(key({ key: 'f', code: 'KeyF', metaKey: true })), [])
    assert.deepEqual(windows.lookup(key({ key: 'a', code: 'KeyA' })), [])
  })

  it('tries several commands bound to one key in order', () => {
    assert.deepEqual(windows.lookup(key({ key: 'Escape', code: 'Escape' })), ['closeFind', 'exitSnippet', 'collapseSelection'])
    // A snippet being filled in takes Tab and Shift+Tab first; without one they indent.
    assert.deepEqual(windows.lookup(key({ key: 'Tab', code: 'Tab' })), ['nextSnippetStop', 'insertTab'])
    assert.deepEqual(windows.lookup(key({ key: 'Tab', code: 'Tab', shiftKey: true })), ['previousSnippetStop', 'indentLess'])
  })

  it("puts an editor's own bindings before the built-in ones", () => {
    const own = new Keymap([{ key: 'Escape', command: 'closePeek' }, { key: 'F12', command: 'goToDefinition' }, { key: 'Ctrl-Space', command: 'triggerSuggest' }, ...defaultBindings], false)
    assert.deepEqual(own.lookup(key({ key: 'Escape', code: 'Escape' })), ['closePeek', 'closeFind', 'exitSnippet', 'collapseSelection'])
    assert.deepEqual(own.lookup(key({ key: 'F12', code: 'F12' })), ['goToDefinition'])
    assert.deepEqual(own.lookup(key({ key: ' ', code: 'Space', ctrlKey: true })), ['triggerSuggest'])
  })

  it('uses the macOS variant of a binding', () => {
    assert.deepEqual(windows.lookup(key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true })), ['cursorWordLeft'])
    assert.deepEqual(mac.lookup(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })), ['cursorWordLeft'])
    assert.deepEqual(mac.lookup(key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })), ['cursorLineStart'])
    assert.deepEqual(windows.lookup(key({ key: 'Home', code: 'Home' })), ['cursorLineStart'])
  })

  it('binds a combo to one command, except where a chain is meant', () => {
    for (const isMacPlatform of [false, true]) {
      const byCombo = new Map<string, Set<string>>()
      for (const binding of defaultBindings) {
        const id = parseCombo(isMacPlatform && binding.mac ? binding.mac : binding.key, isMacPlatform)
        byCombo.set(id, (byCombo.get(id) ?? new Set()).add(binding.command))
      }
      const chains: Record<string, string[]> = {
        Escape: ['closeFind', 'exitSnippet', 'collapseSelection'],
        Tab: ['nextSnippetStop', 'insertTab'],
        'Shift-Tab': ['previousSnippetStop', 'indentLess'],
      }
      for (const [id, commands] of byCombo) {
        if (chains[id]) assert.deepEqual([...commands], chains[id])
        else assert.equal(commands.size, 1, `${id} is bound to ${[...commands].join(' and ')}`)
      }
    }
  })

  it('labels commands the way a user reads shortcuts', () => {
    assert.equal(windows.labelFor('openFind', defaultBindings), 'Ctrl+f')
    assert.equal(mac.labelFor('openFind', defaultBindings), '⌘f')
    assert.equal(windows.labelFor('nothing', defaultBindings), null)
  })
})

describe('isMac', () => {
  it('recognises Apple platforms', () => {
    assert.ok(isMac('MacIntel'))
    assert.ok(isMac('iPhone'))
    assert.ok(!isMac('Win32'))
    assert.ok(!isMac('Linux x86_64'))
    assert.ok(!isMac(undefined))
  })
})
