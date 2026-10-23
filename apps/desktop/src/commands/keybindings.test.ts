import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Keybindings } from '@shared/keybindings'
import { addChord, assignChord, chordUse, filterByChord, filterSections, removeChords, resetChords, shortcutSections } from './keybindings'
import { chordId, chordKey, chordOfEvent, chordProblem, formatChord, parseChord, sameChords, type KeyEventLike } from './keys'
import { CommandRegistry, type Command } from './registry'

const press = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})
const chord = (text: string) => {
  const parsed = parseChord(text)
  assert.ok(parsed, text)
  return parsed
}
const problem = (text: string) => chordProblem(chord(text))

describe('chords as the shortcut editor reads and writes them', () => {
  it('names a chord one way however it was written, and compares lists of them', () => {
    assert.equal(chordId(chord('ctrl+shift+p')), chordId(chord('Shift+Ctrl+P')))
    assert.equal(chordKey('Ctrl+Plus'), chordKey('Ctrl++'))
    assert.equal(chordKey('not a chord++x'), 'not a chord++x', 'text that is no chord stands for itself')
    assert.ok(sameChords(['ctrl+b', 'Ctrl+Shift+S'], ['Ctrl+B', 'shift+ctrl+s']))
    assert.ok(!sameChords(['Ctrl+B'], ['Ctrl+B', 'Ctrl+Shift+S']))
    assert.ok(!sameChords(['Ctrl+Shift+S', 'Ctrl+B'], ['Ctrl+B', 'Ctrl+Shift+S']), 'the first one is the one menus show')
  })

  it('writes a chord the way eNCode shows shortcuts, which reads back as the same chord', () => {
    const shown = ['Ctrl+Shift+K', 'Alt+Up', 'Shift+F3', 'Ctrl+Plus', 'Ctrl+=', 'Ctrl+-', 'Ctrl+`', 'Ctrl+Alt+Esc', 'Ctrl+PageDown', 'Alt+Num1', 'Ctrl+Space', 'Ctrl+]']
    for (const text of shown) {
      assert.equal(formatChord(chord(text)), text)
      assert.equal(chordId(chord(formatChord(chord(text)))), chordId(chord(text)))
    }
  })

  it('reads the chord a key press makes, and nothing while only modifiers are down', () => {
    assert.equal(chordOfEvent(press('Control', 'ControlLeft', { ctrlKey: true })), null)
    assert.equal(chordOfEvent(press('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true })), null)
    assert.equal(chordOfEvent(press('AltGraph', 'AltRight', { ctrlKey: true, altKey: true })), null)
    assert.equal(chordOfEvent(press('Dead', 'Quote', { altKey: true })), null, 'a dead key waits for the next')
    assert.equal(formatChord(chordOfEvent(press('K', 'KeyK', { ctrlKey: true, shiftKey: true }))!), 'Ctrl+Shift+K')
    assert.equal(formatChord(chordOfEvent(press('}', 'BracketRight', { ctrlKey: true, shiftKey: true }))!), 'Ctrl+Shift+]')
    assert.equal(formatChord(chordOfEvent(press('л', 'KeyK', { ctrlKey: true }))!), 'Ctrl+K', 'by its place, on a Cyrillic layout')
    assert.equal(formatChord(chordOfEvent(press('F3', 'F3', { shiftKey: true }))!), 'Shift+F3')
  })

  it('takes chords that leave typing, the system and every field alone', () => {
    for (const text of ['Ctrl+J', 'Ctrl+Shift+J', 'Alt+M', 'Ctrl+Alt+B', 'F2', 'Shift+F3', 'Ctrl+F12', 'Ctrl+Tab', 'Alt+Up', 'Ctrl+Alt+Left', 'Ctrl+`', 'Ctrl+Shift+Enter']) {
      assert.equal(problem(text), null, text)
    }
  })

  it('refuses a chord that would stop typing, and says why', () => {
    assert.match(problem('J')!, /Add Ctrl or Alt/)
    assert.match(problem('Shift+J')!, /Add Ctrl or Alt/)
    assert.match(problem('Enter')!, /Add Ctrl or Alt/)
  })

  it('refuses the keys Windows, the computer tool and every field keep, and says what they do', () => {
    assert.match(problem('Ctrl+C')!, /copies/)
    assert.match(problem('Ctrl+Shift+Z')!, /redoes/)
    assert.match(problem('Ctrl+Enter')!, /sends/)
    assert.match(problem('Alt+F4')!, /closes the window/)
    assert.match(problem('Ctrl+Alt+Esc')!, /stops the agent using the computer/)
    assert.match(problem('Ctrl+Esc')!, /Start menu/)
    assert.match(problem('Shift+F10')!, /menu/)
    assert.match(problem('Meta+K')!, /Windows key/)
    assert.match(problem('Alt+Tab')!, /Windows keeps Alt\+Tab/)
    assert.match(problem('Alt+Space')!, /Windows keeps Alt\+Space/)
    assert.match(problem('Alt+Num4')!, /Windows keeps/, 'Alt with the number pad types characters')
    assert.match(problem('Ctrl+Backspace')!, /deletes by words/)
    assert.match(problem('Ctrl+Shift+Right')!, /moves or deletes by words/)
  })

  it('refuses what AltGr types and keys a settings file could not keep', () => {
    assert.match(chordProblem({ ctrl: true, alt: true, shift: false, meta: false, key: '@' })!, /types characters/)
    assert.match(chordProblem({ ctrl: true, alt: true, shift: false, meta: false, key: 'ą' })!, /types characters/)
    assert.match(chordProblem({ ctrl: false, alt: true, shift: false, meta: false, key: 'ф' })!, /cannot be part of a shortcut/)
    assert.match(chordProblem({ ctrl: true, alt: false, shift: false, meta: false, key: 'audiovolumeup' })!, /cannot be part of a shortcut/)
    assert.match(chordProblem({ ctrl: true, alt: false, shift: false, meta: false, key: 'f25' })!, /cannot be part of a shortcut/)
    assert.equal(chordProblem({ ctrl: true, alt: true, shift: false, meta: false, key: 'q' }), null, 'Ctrl+Alt with a letter is a shortcut')
  })
})

const run = () => {}
/** A small app: two shortcuts to trade, one with two keys, one with none, one fixed, one a hint. */
function app() {
  const registry = new CommandRegistry()
  const commands: Command[] = [
    { id: 'view.sidebar', title: 'Toggle sidebar', group: 'View', keys: ['Ctrl+B', 'Ctrl+Shift+S'], run },
    { id: 'view.bottomPanel', title: 'Toggle bottom panel', group: 'View', keys: ['Ctrl+J'], run },
    { id: 'view.terminal', title: 'Show terminal', group: 'View', keys: ['Ctrl+`'], run },
    { id: 'session.fork', title: 'Fork session', group: 'Session', run },
    { id: 'session.go1', title: 'Go to session 1', group: 'Session', keys: ['Alt+1'], hidden: true, run },
    { id: 'edit.copy', title: 'Copy', group: 'Edit', hint: 'Ctrl+C', run },
  ]
  registry.register(...commands)
  return registry
}
const keys = (registry: CommandRegistry) =>
  Object.fromEntries(['view.sidebar', 'view.bottomPanel', 'view.terminal', 'session.fork', 'session.go1'].map((id) => [id, registry.keysOf(id).join(' ')]))

describe('the person\'s own shortcuts in the registry', () => {
  it('replace a command\'s shortcuts, take a chord from the command that ships with it, and leave the rest', () => {
    const registry = app()
    registry.setOverrides({ 'view.terminal': ['Ctrl+J'], 'session.fork': ['Ctrl+Alt+K'] })
    assert.deepEqual(keys(registry), {
      'view.sidebar': 'Ctrl+B Ctrl+Shift+S',
      'view.bottomPanel': '',
      'view.terminal': 'Ctrl+J',
      'session.fork': 'Ctrl+Alt+K',
      'session.go1': 'Alt+1',
    })
    assert.equal(registry.forEvent(press('j', 'KeyJ', { ctrlKey: true }), false)?.id, 'view.terminal')
    assert.equal(registry.forEvent(press('`', 'Backquote', { ctrlKey: true }), false), undefined, 'the old one does nothing now')
    assert.equal(registry.shortcut('view.terminal'), 'Ctrl+J', 'menus and tooltips show the new one')
    assert.equal(registry.shortcut('view.bottomPanel'), undefined)
    assert.deepEqual(registry.conflicts(), [])
  })

  it('leaves a command without a shortcut for an empty list, and goes back to the shipped ones when the entry goes', () => {
    const registry = app()
    registry.setOverrides({ 'view.sidebar': [] })
    assert.equal(registry.keysOf('view.sidebar').length, 0)
    assert.equal(registry.forEvent(press('b', 'KeyB', { ctrlKey: true }), false), undefined)
    registry.setOverrides({})
    assert.equal(registry.forEvent(press('b', 'KeyB', { ctrlKey: true }), false)?.id, 'view.sidebar')
  })

  it('ignores what a settings file must not change, whatever it says', () => {
    const registry = app()
    registry.setOverrides({
      'view.bottomPanel': ['Ctrl+C', 'J', 'Alt+1', 'Meta+J', 'not a chord++', 'ctrl+shift+j', 'Ctrl+Shift+J'],
      'session.go1': ['Ctrl+Alt+G'],
      'edit.copy': ['Ctrl+Alt+C'],
      'no.such': ['Ctrl+Alt+N'],
    })
    assert.deepEqual(registry.keysOf('view.bottomPanel'), ['Ctrl+Shift+J'], 'one usable chord, written as eNCode writes it, once')
    assert.deepEqual(registry.keysOf('session.go1'), ['Alt+1'], 'a fixed command keeps its keys, and its chord stays its own')
    assert.equal(registry.shortcut('edit.copy'), 'Ctrl+C', 'a hint is not a binding to change')
    assert.equal(registry.forEvent(press('c', 'KeyC', { ctrlKey: true, altKey: true }), false), undefined)
    assert.equal(registry.forEvent(press('n', 'KeyN', { ctrlKey: true, altKey: true }), false), undefined)
  })

  it('gives a chord named twice in the file to the first command, so a key never does two things', () => {
    const registry = app()
    registry.setOverrides({ 'view.sidebar': ['Ctrl+K'], 'view.terminal': ['Ctrl+K', 'Ctrl+Alt+T'] })
    assert.deepEqual(registry.keysOf('view.sidebar'), ['Ctrl+K'])
    assert.deepEqual(registry.keysOf('view.terminal'), ['Ctrl+Alt+T'])
    assert.deepEqual(registry.conflicts(), [])
  })

  it('tells what changed from the shipped shortcuts, and tells views to draw them again', () => {
    const registry = app()
    let heard = 0
    const stop = registry.subscribe(() => void heard++)
    const version = registry.version
    registry.setOverrides({ 'view.terminal': ['Ctrl+J'], 'view.sidebar': ['ctrl+b', 'Ctrl+Shift+S'] })
    assert.equal(heard, 1)
    assert.ok(registry.version > version)
    assert.ok(registry.isChanged('view.terminal'))
    assert.ok(registry.isChanged('view.bottomPanel'), 'it lost Ctrl+J')
    assert.ok(!registry.isChanged('view.sidebar'), 'the same chords written another way')
    assert.ok(!registry.isChanged('session.go1') && !registry.isChanged('edit.copy'), 'nothing to change, nothing changed')
    stop()
    registry.setOverrides({})
    assert.equal(heard, 1)
  })
})

describe('changing a shortcut', () => {
  /** The registry with `bindings` applied, and what each command has. */
  const after = (registry: CommandRegistry, bindings: Keybindings) => {
    registry.setOverrides(bindings)
    return keys(registry)
  }

  it('says what a chord would do for a command before anything changes', () => {
    const registry = app()
    assert.deepEqual(chordUse(registry, 'view.terminal', chord('Ctrl+Alt+T')), { kind: 'free' })
    assert.deepEqual(chordUse(registry, 'view.terminal', chord('Ctrl+`')), { kind: 'same' })
    const taken = chordUse(registry, 'view.terminal', chord('Ctrl+J'))
    assert.equal(taken.kind === 'taken' && taken.holder.id, 'view.bottomPanel')
    assert.deepEqual(chordUse(registry, 'view.terminal', chord('Alt+1')), { kind: 'refused', reason: 'Alt+1 is kept for Go to session 1.' })
    assert.equal(chordUse(registry, 'view.terminal', chord('Ctrl+V')).kind, 'refused')
  })

  it('gives a command one new shortcut, taking it from the command that ships with it', () => {
    const registry = app()
    const bindings = assignChord(registry, {}, 'view.terminal', chord('Ctrl+J'))
    assert.deepEqual(bindings, { 'view.terminal': ['Ctrl+J'] })
    assert.equal(after(registry, bindings)['view.bottomPanel'], '')
  })

  it('takes a chord from a command the person gave it to, which goes back to its own when it has none left', () => {
    const registry = app()
    let bindings = assignChord(registry, {}, 'view.terminal', chord('Ctrl+Alt+T'))
    registry.setOverrides(bindings)
    bindings = assignChord(registry, bindings, 'view.bottomPanel', chord('Ctrl+Alt+T'))
    assert.deepEqual(bindings, { 'view.bottomPanel': ['Ctrl+Alt+T'] })
    const now = after(registry, bindings)
    assert.equal(now['view.terminal'], 'Ctrl+`')
    assert.equal(now['view.bottomPanel'], 'Ctrl+Alt+T')
  })

  it('takes only that chord from a command with others the person chose', () => {
    const registry = app()
    registry.setOverrides({ 'view.terminal': ['Ctrl+Alt+T', 'Ctrl+Alt+Y'] })
    const bindings = assignChord(registry, { 'view.terminal': ['Ctrl+Alt+T', 'Ctrl+Alt+Y'] }, 'session.fork', chord('Ctrl+Alt+Y'))
    assert.deepEqual(bindings, { 'view.terminal': ['Ctrl+Alt+T'], 'session.fork': ['Ctrl+Alt+Y'] })
  })

  it('adds a shortcut beside the ones a command has, once, and keeps no entry for what it ships with', () => {
    const registry = app()
    let bindings = addChord(registry, {}, 'view.sidebar', chord('Ctrl+Alt+S'))
    assert.deepEqual(bindings, { 'view.sidebar': ['Ctrl+B', 'Ctrl+Shift+S', 'Ctrl+Alt+S'] })
    registry.setOverrides(bindings)
    bindings = addChord(registry, bindings, 'view.sidebar', chord('Ctrl+Alt+S'))
    assert.deepEqual(bindings['view.sidebar'], ['Ctrl+B', 'Ctrl+Shift+S', 'Ctrl+Alt+S'], 'not twice')
    bindings = assignChord(registry, bindings, 'session.fork', chord('Ctrl+Alt+S'))
    assert.deepEqual(bindings, { 'session.fork': ['Ctrl+Alt+S'] }, 'the sidebar is back on exactly its own, so it needs no entry')
  })

  it('keeps at most four shortcuts for a command, dropping the oldest', () => {
    const registry = app()
    let bindings: Keybindings = {}
    for (const letter of ['A', 'C', 'D', 'E']) {
      bindings = addChord(registry, bindings, 'session.fork', chord(`Ctrl+Alt+${letter}`))
      registry.setOverrides(bindings)
    }
    assert.deepEqual(bindings['session.fork'], ['Ctrl+Alt+A', 'Ctrl+Alt+C', 'Ctrl+Alt+D', 'Ctrl+Alt+E'])
    bindings = addChord(registry, bindings, 'session.fork', chord('Ctrl+Alt+F'))
    assert.deepEqual(bindings['session.fork'], ['Ctrl+Alt+C', 'Ctrl+Alt+D', 'Ctrl+Alt+E', 'Ctrl+Alt+F'])
  })

  it('removes a command\'s shortcuts, which hands back none it took', () => {
    const registry = app()
    assert.deepEqual(removeChords(registry, {}, 'view.sidebar'), { 'view.sidebar': [] })
    assert.deepEqual(removeChords(registry, {}, 'session.fork'), {}, 'one that ships with none needs no entry')
    const bindings = removeChords(registry, { 'view.terminal': ['Ctrl+J'] }, 'view.terminal')
    assert.deepEqual(bindings, { 'view.terminal': [] })
    assert.equal(after(registry, bindings)['view.bottomPanel'], 'Ctrl+J', 'the chord it took goes back to the one that ships with it')
  })

  it('puts a command back on its own shortcuts, taking them back from where the person moved them', () => {
    const registry = app()
    const moved: Keybindings = { 'view.terminal': ['Ctrl+J'], 'session.fork': ['Ctrl+Shift+S', 'Ctrl+Alt+K'] }
    registry.setOverrides(moved)
    assert.deepEqual(resetChords(registry, moved, 'view.terminal'), { 'session.fork': ['Ctrl+Shift+S', 'Ctrl+Alt+K'] })
    assert.deepEqual(resetChords(registry, moved, 'view.bottomPanel'), { 'session.fork': ['Ctrl+Shift+S', 'Ctrl+Alt+K'] }, 'Ctrl+J comes back from the terminal, which goes back to its own')
    const bindings = resetChords(registry, moved, 'view.sidebar')
    assert.deepEqual(bindings, { 'view.terminal': ['Ctrl+J'], 'session.fork': ['Ctrl+Alt+K'] })
    assert.equal(after(registry, bindings)['view.sidebar'], 'Ctrl+B Ctrl+Shift+S')
  })
})

describe('the list of shortcuts', () => {
  it('lists each command by menu with the keys it has now, ready to change, and the keys that stay as they are', () => {
    const registry = app()
    registry.setOverrides({ 'view.terminal': ['Ctrl+J'] })
    const sections = shortcutSections(registry, ['File', 'Edit', 'View', 'Session'])
    assert.deepEqual(
      sections.map((section) => section.group),
      ['Edit', 'View', 'Session'],
    )
    const view = sections.find((section) => section.group === 'View')!.rows
    assert.deepEqual(
      view.map((row) => [row.title, row.keys.join(' '), row.changed, Boolean(row.fixed)]),
      [
        ['Toggle sidebar', 'Ctrl+B Ctrl+Shift+S', false, false],
        ['Toggle bottom panel', '', true, false],
        ['Show terminal', 'Ctrl+J', true, false],
        ['Go to tab 1 to 9', 'Ctrl+1 Ctrl+9', false, true],
      ],
    )
    const session = sections.find((section) => section.group === 'Session')!.rows
    assert.deepEqual(
      session.map((row) => row.title),
      ['Fork session', 'Go to session 1 to 9', 'Stop the agent (press twice)'],
      'a command with no shortcut can be given one; hidden ones are not listed one by one',
    )
    const copy = sections.find((section) => section.group === 'Edit')!.rows[0]
    assert.equal(copy.title, 'Copy')
    assert.deepEqual(copy.keys, ['Ctrl+C'])
    assert.ok(copy.fixed)
  })

  it('finds rows by name or by keys, however the keys are typed', () => {
    const sections = shortcutSections(app(), ['View', 'Session'])
    const titles = (query: string) => filterSections(sections, query).flatMap((section) => section.rows.map((row) => row.title))
    assert.deepEqual(titles('terminal'), ['Show terminal'])
    assert.deepEqual(titles('ctrl j'), ['Toggle bottom panel'])
    assert.deepEqual(titles('Ctrl + Shift + S'), ['Toggle sidebar'])
    assert.deepEqual(titles('ESC'), ['Stop the agent (press twice)'])
    assert.deepEqual(titles('nothing like this'), [])
    assert.equal(titles('  ').length, 7, 'white space alone finds everything')
    const kept = filterSections(sections, 'ctrl j', 'view.terminal').flatMap((section) => section.rows.map((row) => row.title))
    assert.deepEqual(kept, ['Toggle bottom panel', 'Show terminal'], 'the row being changed stays, whatever its keys are now')
  })

  it('finds the rows a pressed shortcut belongs to, ranges included', () => {
    const sections = shortcutSections(app(), ['View', 'Session', 'Edit'])
    const titles = (text: string, keep?: string) => filterByChord(sections, chord(text), keep).flatMap((section) => section.rows.map((row) => row.title))
    assert.deepEqual(titles('Ctrl+Shift+S'), ['Toggle sidebar'], 'the second shortcut of a command counts too')
    assert.deepEqual(titles('ctrl+j'), ['Toggle bottom panel'])
    assert.deepEqual(titles('Ctrl+Shift+J'), [], 'an exact chord: Shift makes another one')
    assert.deepEqual(titles('Ctrl+5'), ['Go to tab 1 to 9'])
    assert.deepEqual(titles('Alt+9'), ['Go to session 1 to 9'])
    assert.deepEqual(titles('Ctrl+Alt+5'), [], 'a range holds only its own modifiers')
    assert.deepEqual(titles('Ctrl+C'), ['Copy'], 'the keys a field handles are found as well')
    assert.deepEqual(titles('Ctrl+Q', 'session.fork'), ['Fork session'], 'the row being changed stays')
    const searched = (query: string) => filterSections(sections, query).flatMap((section) => section.rows.map((row) => row.title))
    assert.deepEqual(searched('"Ctrl+5"'), ['Go to tab 1 to 9'], 'a shortcut in quotes, as pressing the keys writes it, is found exactly')
    assert.deepEqual(searched('"Ctrl+J"'), ['Toggle bottom panel'])
    assert.deepEqual(searched('"no such chord+"'), [], 'quotes around text that is no shortcut search for the text')
  })
})
