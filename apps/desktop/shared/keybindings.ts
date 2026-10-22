/**
 * The shortcuts the person chose (Help > Keyboard shortcuts), kept in Settings by command id: the chords that replace
 * the command's own, or [] for none. Shared by the main process, which keeps only well-formed entries, and the
 * renderer, whose command registry applies them and refuses a chord that cannot be a shortcut.
 */
export type Keybindings = Record<string, string[]>

/** More entries than eNCode has commands is a broken file, not a choice. */
export const MAX_KEYBINDINGS = 300
/** At most this many shortcuts for one command. */
export const MAX_CHORDS = 4

/** A command id: "edit.find", "session.go1". The dot keeps out names such as __proto__. */
const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/
/** A chord as eNCode writes one: "Ctrl+Shift+K", "Shift+F3", "Ctrl+`". */
const CHORD_TEXT = /^[\x21-\x7e]{1,40}$/

/** Keybindings as saved: well-formed command ids, each with a few well-formed chords, once each. */
export function cleanKeybindings(value: unknown): Keybindings {
  const clean: Keybindings = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean
  for (const [id, chords] of Object.entries(value).slice(0, MAX_KEYBINDINGS)) {
    if (!COMMAND_ID.test(id) || !Array.isArray(chords)) continue
    clean[id] = [...new Set(chords.filter((chord): chord is string => typeof chord === 'string' && CHORD_TEXT.test(chord)))].slice(0, MAX_CHORDS)
  }
  return clean
}
