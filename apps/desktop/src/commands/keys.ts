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
