/**
 * One registry of commands behind the menus, the shortcuts and the command
 * palette, so a command has one title, one shortcut and one implementation.
 * Free of React and the DOM for unit tests.
 */
import { matchesChord, parseChord, worksWhileTyping, type Chord, type KeyEventLike } from './keys'

export interface Command {
  id: string
  title: string
  /** A title that depends on state, such as Pin or Unpin; menus show it instead of `title`. */
  label?: () => string
  /** The menu it belongs to: File, Edit, View, Session or Help. */
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

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private bindings: Binding[] = []

  /** Adds or replaces commands by id. */
  register(...commands: Command[]): void {
    for (const command of commands) this.commands.set(command.id, command)
    this.bindings = [...this.commands.values()].flatMap((command) =>
      (command.keys ?? []).flatMap((text) => {
        const chord = parseChord(text)
        return chord ? [{ command, chord }] : []
      }),
    )
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
    const command = this.commands.get(id)
    return command?.keys?.[0] ?? command?.hint
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
      const name = `${chord.ctrl ? 'Ctrl+' : ''}${chord.alt ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}${chord.meta ? 'Meta+' : ''}${chord.key}`
      const ids = seen.get(name) ?? []
      if (!ids.includes(command.id)) seen.set(name, [...ids, command.id])
    }
    return [...seen].filter(([, ids]) => ids.length > 1).map(([name, ids]) => `${name}: ${ids.join(', ')}`)
  }
}
