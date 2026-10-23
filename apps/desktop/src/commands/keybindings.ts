/**
 * Changing a command's shortcut (Help > Keyboard shortcuts): what a chord would do there, and the person's
 * keybindings after giving a command a chord, adding one, taking its shortcuts away, or putting back the ones it
 * ships with. Pure, over the registry, so the rules are tested.
 */
import { MAX_CHORDS, type Keybindings } from '@shared/keybindings'
import { chordId, chordKey, chordProblem, formatChord, parseChord, sameChords, type Chord } from './keys'
import { isRebindable, type Command, type CommandRegistry } from './registry'

/** What giving a chord to a command would do. */
export type ChordUse =
  /** It cannot be a shortcut, or not this one: why. */
  | { kind: 'refused'; reason: string }
  /** The command has it already. */
  | { kind: 'same' }
  /** Another command has it, and would lose it. */
  | { kind: 'taken'; holder: Command }
  | { kind: 'free' }

export function chordUse(registry: CommandRegistry, id: string, chord: Chord): ChordUse {
  const problem = chordProblem(chord)
  if (problem) return { kind: 'refused', reason: problem }
  const holder = registry.commandWith(chord)
  if (!holder) return { kind: 'free' }
  if (holder.id === id) return { kind: 'same' }
  if (!isRebindable(holder)) return { kind: 'refused', reason: `${formatChord(chord)} is kept for ${registry.titleOf(holder.id)}.` }
  return { kind: 'taken', holder }
}

/** Keybindings with `keys` as command `id`'s shortcuts, and no entry for it when those are the ones it ships with. */
function withKeys(registry: CommandRegistry, keybindings: Keybindings, id: string, keys: readonly string[]): Keybindings {
  const { [id]: _replaced, ...others } = keybindings
  return sameChords(keys, registry.get(id)?.keys ?? []) ? others : { ...others, [id]: [...keys] }
}

/**
 * Keybindings with `chords` taken from every command but `id` that the person gave them to. A command left with none
 * of the shortcuts the person chose for it goes back to its own.
 */
function takeChords(registry: CommandRegistry, keybindings: Keybindings, id: string, chords: readonly Chord[]): Keybindings {
  const taken = new Set(chords.map(chordId))
  let next = keybindings
  for (const [other, keys] of Object.entries(keybindings)) {
    const kept = keys.filter((text) => !taken.has(chordKey(text)))
    if (other === id || kept.length === keys.length) continue
    if (kept.length) next = withKeys(registry, next, other, kept)
    else {
      const { [other]: _emptied, ...rest } = next
      next = rest
    }
  }
  return next
}

/** The keybindings after giving `chord` to command `id` as its one shortcut, taken from any command that has it. */
export function assignChord(registry: CommandRegistry, keybindings: Keybindings, id: string, chord: Chord): Keybindings {
  return withKeys(registry, takeChords(registry, keybindings, id, [chord]), id, [formatChord(chord)])
}

/** The keybindings after giving `chord` to command `id` beside the shortcuts it has, taken from any command that has it. */
export function addChord(registry: CommandRegistry, keybindings: Keybindings, id: string, chord: Chord): Keybindings {
  const keys = [...registry.keysOf(id).filter((text) => chordKey(text) !== chordId(chord)), formatChord(chord)]
  return withKeys(registry, takeChords(registry, keybindings, id, [chord]), id, keys.slice(-MAX_CHORDS))
}

/** The keybindings with command `id` left without a shortcut. */
export function removeChords(registry: CommandRegistry, keybindings: Keybindings, id: string): Keybindings {
  return withKeys(registry, keybindings, id, [])
}

/** The keybindings with command `id` back on the shortcuts it ships with, taken back from any command that has them. */
export function resetChords(registry: CommandRegistry, keybindings: Keybindings, id: string): Keybindings {
  const shipped = (registry.get(id)?.keys ?? []).flatMap((text) => parseChord(text) ?? [])
  const { [id]: _reset, ...others } = takeChords(registry, keybindings, id, shipped)
  return others
}

export interface ShortcutRow {
  /** The command the row changes, or the name of a row that stays as it is. */
  id: string
  title: string
  keys: readonly string[]
  /** Two keys that stand for the run between them: Alt+1 to Alt+9. */
  range?: boolean
  /** Why the row cannot change, for one that cannot. */
  fixed?: string
  /** Other shortcuts than the command ships with. */
  changed: boolean
}

export interface ShortcutSection {
  group: string
  rows: ShortcutRow[]
}

const fixedRow = (id: string, title: string, keys: string[], fixed: string, range = false): ShortcutRow => ({ id, title, keys, fixed, changed: false, ...(range ? { range } : {}) })

/** Keys eNCode reads outside the command list, shown with the menu they belong to. */
const EXTRA_ROWS: Record<string, ShortcutRow[]> = {
  View: [fixedRow('fixed.tabs', 'Go to tab 1 to 9', ['Ctrl+1', 'Ctrl+9'], 'These follow the order of the tabs.', true)],
  Session: [
    fixedRow('fixed.sessions', 'Go to session 1 to 9', ['Alt+1', 'Alt+9'], 'These follow the order of the session list.', true),
    fixedRow('fixed.stop', 'Stop the agent (press twice)', ['Esc'], 'Esc works in the message box and on the thread.'),
  ],
}

/**
 * Every shortcut by menu: each command the person can see, with the keys it has now (or none, ready to be given
 * one), and the keys that stay as they are, such as Copy, which every field handles.
 */
export function shortcutSections(registry: CommandRegistry, groups: readonly string[]): ShortcutSection[] {
  return groups
    .map((group) => {
      const rows = registry
        .all()
        .filter((command) => command.group === group && !command.hidden)
        .map((command): ShortcutRow => {
          const title = registry.titleOf(command.id)
          if (command.hint) return fixedRow(command.id, title, [command.hint], 'The field you type in handles this one.')
          return { id: command.id, title, keys: registry.keysOf(command.id), changed: registry.isChanged(command.id) }
        })
      return { group, rows: [...rows, ...(EXTRA_ROWS[group] ?? [])] }
    })
    .filter((section) => section.rows.length)
}

/** Text and keys folded so "ctrl j", "Ctrl+J" and "ctrl+j" all find Ctrl+J. */
const searchable = (text: string) => text.toLowerCase().replace(/\s*\+\s*|\s+/g, '+')

/**
 * The rows whose title or keys hold what was typed, and row `keep`, which a new shortcut must not hide while it is
 * changed. A shortcut in quotes, as pressing the keys writes it ("Ctrl+J"), finds only the rows with that one.
 */
export function filterSections(sections: readonly ShortcutSection[], query: string, keep?: string | null): ShortcutSection[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...sections]
  const quoted = /^"(.+)"$/.exec(query.trim())
  const exact = quoted ? parseChord(quoted[1]) : null
  if (exact) return filterByChord(sections, exact, keep)
  const keysNeedle = searchable(needle)
  const matches = (row: ShortcutRow) =>
    row.id === keep || row.title.toLowerCase().includes(needle) || row.keys.some((key) => searchable(key).includes(keysNeedle))
  return sections.map((section) => ({ group: section.group, rows: section.rows.filter(matches) })).filter((section) => section.rows.length)
}

/**
 * The rows a pressed shortcut belongs to: those with that chord, or with a range that holds it (Alt+5 is one of Alt+1
 * to Alt+9), and row `keep`, as above.
 */
export function filterByChord(sections: readonly ShortcutSection[], chord: Chord, keep?: string | null): ShortcutSection[] {
  const id = chordId(chord)
  const inRange = (row: ShortcutRow) => {
    if (!row.range || row.keys.length !== 2 || chord.key.length !== 1) return false
    const [from, to] = row.keys.map(parseChord)
    return Boolean(from && to && from.key.length === 1 && to.key.length === 1 && chordId({ ...from, key: chord.key }) === id && from.key <= chord.key && chord.key <= to.key)
  }
  const matches = (row: ShortcutRow) => row.id === keep || row.keys.some((key) => chordKey(key) === id) || inRange(row)
  return sections.map((section) => ({ group: section.group, rows: section.rows.filter(matches) })).filter((section) => section.rows.length)
}
