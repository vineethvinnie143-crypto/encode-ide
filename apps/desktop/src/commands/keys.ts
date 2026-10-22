/**
 * Keyboard chords: "Ctrl+Shift+P" parsed once, then compared with key events.
 * Pure, so the layout rules below are unit tested.
 *
 * Letters follow the keyboard layout (Ctrl+Z is the key labelled Z), except
 * on layouts without Latin letters, where Ctrl and a letter key fall back to
 * its position. Digits and punctuation go by position, so Shift does not turn
 * Ctrl+Shift+] into "}". A character typed with AltGr (Ctrl+Alt on Windows),
 * such as ó or @, never matches a chord, so typing it stays typing.
 */

export interface Chord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** Lower-case key name: a, 1, [, f11, tab, enter, escape, space, arrowup, num1, + … */
  key: string
}

export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Keys identified by position. */
const BY_CODE: Record<string, string> = {
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Equal: '=',
  Minus: '-',
  NumpadAdd: '+',
  NumpadSubtract: '-',
}
for (let digit = 0; digit <= 9; digit++) {
  BY_CODE[`Digit${digit}`] = String(digit)
  // Alt with numpad digits types characters on Windows, so they never match Alt+1.
  BY_CODE[`Numpad${digit}`] = `num${digit}`
}

const NAMES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  plus: '+',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
}

/** Parses "Ctrl+Shift+P", "Alt+1", "F11", "Ctrl+=" or "Ctrl++". Null for text it cannot read. */
export function parseChord(text: string): Chord | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.endsWith('++') ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed.split('+')
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const raw of parts) {
    const part = raw.trim().toLowerCase()
    if (!part) return null
    if (part === 'ctrl' || part === 'control') chord.ctrl = true
    else if (part === 'shift') chord.shift = true
    else if (part === 'alt' || part === 'option') chord.alt = true
    else if (part === 'meta' || part === 'cmd' || part === 'win') chord.meta = true
    else if (chord.key) return null
    else chord.key = NAMES[part] ?? part
  }
  return chord.key ? chord : null
}

/** The key an event stands for, named the way parseChord names keys. */
export function eventKey(event: KeyEventLike): string {
  const { key, code } = event
  if (key === ' ') return 'space'
  if (key.length !== 1) return key.toLowerCase()
  const lower = key.toLowerCase()
  if (/^[a-z]$/.test(lower)) return lower
  // AltGr reports Ctrl+Alt: whatever it typed is text, not a shortcut.
  if (event.ctrlKey && event.altKey) return lower
  if (/^Key[A-Z]$/.test(code) && (event.ctrlKey || event.metaKey)) return code.slice(3).toLowerCase()
  return BY_CODE[code] ?? lower
}

export function matchesChord(event: KeyEventLike, chord: Chord): boolean {
  return (
    event.ctrlKey === chord.ctrl &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.metaKey === chord.meta &&
    eventKey(event) === chord.key
  )
}

/** True for chords that are safe to act on while the user types: any with Ctrl, Alt or Meta, and function keys. */
export function worksWhileTyping(chord: Chord): boolean {
  return chord.ctrl || chord.alt || chord.meta || /^f\d{1,2}$/.test(chord.key)
}

/** One name for a chord however it was written ("ctrl+shift+p" and "Ctrl+Shift+P" alike), to compare chords by. */
export function chordId(chord: Chord): string {
  return `${chord.ctrl ? 'Ctrl+' : ''}${chord.alt ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}${chord.meta ? 'Meta+' : ''}${chord.key}`
}

/** The same for chord text; text that is not a chord stands for itself. */
export function chordKey(text: string): string {
  const chord = parseChord(text)
  return chord ? chordId(chord) : text
}

/** True when two lists name the same chords in the same order. */
export function sameChords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((text, index) => chordKey(text) === chordKey(b[index]))
}

const SHOWN: Record<string, string> = {
  escape: 'Esc',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  '+': 'Plus',
}

/** A chord written the way eNCode shows shortcuts: "Ctrl+Shift+K", "Alt+Up", "Shift+F3", "Ctrl+Plus". */
export function formatChord(chord: Chord): string {
  const { key } = chord
  const name = SHOWN[key] ?? (key.length === 1 ? key.toUpperCase() : /^num\d$/.test(key) ? `Num${key.slice(3)}` : key.charAt(0).toUpperCase() + key.slice(1))
  return `${chord.ctrl ? 'Ctrl+' : ''}${chord.alt ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}${chord.meta ? 'Meta+' : ''}${name}`
}

const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'altgraph', 'os', 'capslock', 'numlock', 'scrolllock', 'fn', 'dead', 'unidentified', 'process'])

/** The chord a key press makes, or null while only modifiers are down (or for a key that names nothing). */
export function chordOfEvent(event: KeyEventLike): Chord | null {
  const key = eventKey(event)
  if (!key || MODIFIER_KEYS.has(key)) return null
  return { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, key }
}

/** Chords that stay Windows', every text field's, or the computer tool's, and what each does there. */
const RESERVED: Record<string, string> = {
  'Alt+f4': 'Alt+F4 closes the window.',
  'Ctrl+Alt+delete': 'Windows keeps Ctrl+Alt+Delete.',
  'Ctrl+Shift+escape': 'Windows keeps Ctrl+Shift+Esc for the Task Manager.',
  'Ctrl+Alt+escape': 'Ctrl+Alt+Esc stops the agent using the computer, from anywhere.',
  'Ctrl+escape': 'Windows keeps Ctrl+Esc for the Start menu.',
  'Shift+f10': 'Shift+F10 opens the menu for what has the focus.',
  'Ctrl+c': 'Ctrl+C copies, in every field.',
  'Ctrl+x': 'Ctrl+X cuts, in every field.',
  'Ctrl+v': 'Ctrl+V pastes, in every field.',
  'Ctrl+z': 'Ctrl+Z undoes, in every field.',
  'Ctrl+y': 'Ctrl+Y redoes, in every field.',
  'Ctrl+Shift+z': 'Ctrl+Shift+Z redoes, in every field.',
  'Ctrl+a': 'Ctrl+A selects all, in every field.',
  'Ctrl+enter': 'Ctrl+Enter sends from the message box, a comment and a commit message.',
}

/** Keys that, with Ctrl and maybe Shift, move or delete by words in every text field. */
const TEXT_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown', 'backspace', 'delete', 'insert'])
/** Named keys a shortcut can use besides those: the rest (media keys, Print Screen) are the system's. */
const NAMED_KEYS = new Set([...TEXT_KEYS, 'escape', 'enter', 'tab', 'space'])

/** Why a chord cannot be a shortcut, or null when it can. */
export function chordProblem(chord: Chord): string | null {
  const { key } = chord
  if (chord.meta) return 'Shortcuts with the Windows key belong to Windows.'
  if (chord.ctrl && chord.alt && [...key].length === 1 && !/^[a-z0-9]$/.test(key)) return `Ctrl+Alt with ${key} types characters on many keyboards. Use a letter or a digit.`
  const functionKey = /^f([1-9]|1\d|2[0-4])$/.test(key)
  // Settings keep chords as ASCII text (see shared/keybindings), so other keys are refused here rather than lost there.
  if (!functionKey && !NAMED_KEYS.has(key) && !/^num\d$/.test(key) && !/^[\x21-\x7e]$/.test(key)) {
    return 'That key cannot be part of a shortcut. Try a letter, a digit or a function key.'
  }
  if (!chord.ctrl && !chord.alt && !functionKey) return 'Add Ctrl or Alt, or use a function key, so typing stays typing.'
  const reserved = RESERVED[chordId(chord)]
  if (reserved) return reserved
  if (chord.ctrl && !chord.alt && TEXT_KEYS.has(key)) return `${formatChord(chord)} moves or deletes by words, in every field.`
  if (chord.alt && !chord.ctrl && /^(num\d|tab|space|escape)$/.test(key)) return `Windows keeps ${formatChord(chord)}.`
  return null
}
