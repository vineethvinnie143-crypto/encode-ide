/**
 * One registry of commands behind the menus, the shortcuts and the command
 * palette, so a command has one title, one shortcut and one implementation.
 * Free of React and the DOM for unit tests.
 */
import { chordId, chordProblem, formatChord, matchesChord, parseChord, sameChords, worksWhileTyping, type Chord, type KeyEventLike } from './keys'

export interface Command {
  id: string
  title: string
  /** A title that depends on state, such as Pin or Unpin; menus show it instead of `title`. */
  label?: () => string
  /** The menu it belongs to: File, Edit, View, Go, Session or Help. */
  group: string
  /** Bound shortcuts. The first is the one menus and tooltips show. */
  keys?: string[]
  /** A shortcut shown but not bound here, because a text field or the editor handles it (Ctrl+C). */
  hint?: string
  /** Leave it out of menus and lists (one of a numbered family, for example). */
  hidden?: boolean
  /** More words the command palette finds it by. */
  keywords?: string
  /** False leaves it out of the command palette, where it means nothing (Copy, or the palette itself). */
  palette?: boolean
  /** Still works while a dialog is open: quitting, zoom and full screen. */
  global?: boolean
  enabled?: () => boolean
  run: () => void | Promise<void>
}

interface Binding {
  command: Command
  chord: Chord
}

/** A command whose shortcut the person can change: one they see and that eNCode binds (not Copy, which a field handles). */
export const isRebindable = (command: Command): boolean => !command.hidden && !command.hint

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private bindings: Binding[] = []
  /** The person's own shortcuts by command id; see setOverrides. */
  private overrides: Readonly<Record<string, readonly string[]>> = {}
  /** The shortcuts each command has now, by id. */
  private effective = new Map<string, readonly string[]>()
  private readonly listeners = new Set<() => void>()
  /** Bumped whenever a shortcut changes, for views that show shortcuts. */
  version = 0

  /** Adds or replaces commands by id. */
  register(...commands: Command[]): void {
    for (const command of commands) this.commands.set(command.id, command)
    this.rebind()
  }

  /**
   * The person's own shortcuts, which replace a command's (an empty list leaves it without one). A chord the person
   * gave one command is taken from any command that has it by default, so a shortcut always does one thing. A chord
   * that cannot be a shortcut (Ctrl+C, see chordProblem), or that belongs to a command the person cannot change
   * (Alt+1 goes to session 1), is ignored, whatever the settings file says.
   */
  setOverrides(overrides: Readonly<Record<string, readonly string[]>>): void {
    this.overrides = overrides
    this.rebind()
  }

  /** Calls `listener` whenever a shortcut changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The shortcuts a command has now: the person's, or its own less any the person gave another command. */
  keysOf(id: string): readonly string[] {
    return this.effective.get(id) ?? []
  }

  /** True when a command the person can change has other shortcuts than it ships with. */
  isChanged(id: string): boolean {
    const command = this.commands.get(id)
    return Boolean(command && isRebindable(command) && !sameChords(this.keysOf(id), command.keys ?? []))
  }

  /** The command that has a chord now, if any. */
  commandWith(chord: Chord): Command | undefined {
    const id = chordId(chord)
    return this.bindings.find((binding) => chordId(binding.chord) === id)?.command
  }

  private rebind(): void {
    const commands = [...this.commands.values()]
    const parsed = (texts: readonly string[] | undefined) => (texts ?? []).flatMap((text) => parseChord(text) ?? [])
    const fixed = new Set(commands.filter((command) => !isRebindable(command)).flatMap((command) => parsed(command.keys).map(chordId)))
    const chosen = (command: Command): Chord[] | undefined => {
      if (!isRebindable(command) || !Object.hasOwn(this.overrides, command.id)) return undefined
      return parsed(this.overrides[command.id]).filter((chord) => !chordProblem(chord) && !fixed.has(chordId(chord)))
    }
    // Each chord the person chose goes to the first command they gave it to.
    const claimed = new Map<string, Command>()
    for (const command of commands) {
      for (const chord of chosen(command) ?? []) if (!claimed.has(chordId(chord))) claimed.set(chordId(chord), command)
    }
    this.effective = new Map()
    this.bindings = []
    for (const command of commands) {
      const own = chosen(command)
      const entries = own
        ? own.map((chord) => ({ chord, text: formatChord(chord) }))
        : (command.keys ?? []).flatMap((text) => {
            const chord = parseChord(text)
            return chord ? [{ chord, text }] : []
          })
      const seen = new Set<string>()
      const keys: string[] = []
      for (const { chord, text } of entries) {
        const id = chordId(chord)
        const holder = claimed.get(id)
        if (seen.has(id) || (holder && holder !== command)) continue
        seen.add(id)
        this.bindings.push({ command, chord })
        keys.push(text)
      }
      this.effective.set(command.id, keys)
    }
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  all(): Command[] {
    return [...this.commands.values()]
  }

  isEnabled(id: string): boolean {
    const command = this.commands.get(id)
    return Boolean(command) && (command?.enabled?.() ?? true)
  }

  /** The command's title as menus show it. */
  titleOf(id: string): string {
    const command = this.commands.get(id)
    return command ? (command.label?.() ?? command.title) : id
  }

  /** The shortcut to show for a command, if it has one. */
  shortcut(id: string): string | undefined {
    return this.keysOf(id)[0] ?? this.commands.get(id)?.hint
  }

  /**
   * The enabled command a key event triggers, or undefined. While the user
   * types in a field, only chords with Ctrl, Alt or a function key count, so
   * plain keys keep typing.
   */
  forEvent(event: KeyEventLike, typing: boolean, modalOpen = false): Command | undefined {
    for (const { command, chord } of this.bindings) {
      if (typing && !worksWhileTyping(chord)) continue
      if (modalOpen && !command.global) continue
      if (matchesChord(event, chord) && (command.enabled?.() ?? true)) return command
    }
    return undefined
  }

  /** Runs a command if it exists and is enabled; true when it ran. */
  run(id: string): boolean {
    const command = this.commands.get(id)
    if (!command || !(command.enabled?.() ?? true)) return false
    void command.run()
    return true
  }

  /** Shortcuts bound to more than one command, as "Ctrl+B: a, b". Used by a test to keep the map clean. */
  conflicts(): string[] {
    const seen = new Map<string, string[]>()
    for (const { command, chord } of this.bindings) {
      const name = chordId(chord)
      const ids = seen.get(name) ?? []
      if (!ids.includes(command.id)) seen.set(name, [...ids, command.id])
    }
    return [...seen].filter(([, ids]) => ids.length > 1).map(([name, ids]) => `${name}: ${ids.join(', ')}`)
  }
}
