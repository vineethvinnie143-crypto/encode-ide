/**
 * Key bindings: combos written as "Mod-Shift-k" and the keyboard events
 * that match them. Pure, so it runs in Node. A binding names a view command;
 * several bindings may share a combo and are tried in order until one
 * handles the key.
 */

export interface KeyEventLike {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
  getModifierState?(name: string): boolean
}

export interface KeyBinding {
  /** "Mod-Shift-k": modifiers Mod, Ctrl, Alt, Shift and Meta, then the key. Mod is Ctrl, or Cmd on macOS. */
  readonly key: string
  /** The combo to use on macOS instead of `key`. */
  readonly mac?: string
  /** A view command's name. */
  readonly command: string
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** What a punctuation or digit key types on a US keyboard, by physical key: shortcuts must not move with the layout. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Esc: 'Escape',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Del: 'Delete',
  Return: 'Enter',
}

function canonicalKey(key: string): string {
  const alias = KEY_ALIASES[key]
  if (alias) return alias
  return key.length === 1 ? key.toLowerCase() : key
}

/** The canonical id of a combo, such as "Ctrl-Shift-k"; modifiers in a fixed order. */
export function parseCombo(spec: string, mac: boolean): string {
  const parts = spec.split(/-(?=.)/)
  const key = canonicalKey(parts.pop()!)
  const mods = new Set<string>()
  for (const part of parts) {
    const name = part.toLowerCase()
    if (name === 'mod') mods.add(mac ? 'Meta' : 'Ctrl')
    else if (name === 'ctrl' || name === 'control') mods.add('Ctrl')
    else if (name === 'alt' || name === 'option') mods.add('Alt')
    else if (name === 'shift') mods.add('Shift')
    else if (name === 'meta' || name === 'cmd' || name === 'command') mods.add('Meta')
    else throw new Error(`Unknown modifier "${part}" in key binding "${spec}"`)
  }
  return [...MODIFIER_ORDER.filter((mod) => mods.has(mod)), key].join('-')
}

/**
 * The combo a keyboard event stands for, or null when it is not one: text
 * being composed, a bare modifier key, or a character typed with AltGr.
 */
export function comboOf(event: KeyEventLike): string | null {
  if (event.isComposing || event.keyCode === 229) return null
  const key = event.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'AltGraph' || key === 'Dead' || key === 'Process') {
    return null
  }
  // AltGr reports Ctrl+Alt on Windows; what it types is text, not a shortcut.
  if (key.length === 1 && event.getModifierState?.('AltGraph')) return null
  const ctrl = event.ctrlKey
  const meta = event.metaKey
  const alt = event.altKey
  const shift = event.shiftKey

  let name: string
  if (ctrl || meta || alt) {
    // Shortcuts follow the physical key for punctuation and for letters of other scripts.
    const fromCode = CODE_KEYS[event.code]
    if (fromCode) name = fromCode
    else if (/^Digit\d$/.test(event.code)) name = event.code.slice(5)
    else if (/^Key[A-Z]$/.test(event.code) && !/^[a-z]$/i.test(key)) name = event.code.slice(3).toLowerCase()
    else name = canonicalKey(key)
  } else {
    name = canonicalKey(key)
  }
  // Shift that only produced the character (such as "!" or "A") is not a modifier of the combo,
  // unless a command chord is held, where Shift is part of the shortcut.
  const typesCharacter = name.length === 1 && !ctrl && !meta && !alt
  const mods = [ctrl && 'Ctrl', alt && 'Alt', shift && !typesCharacter && 'Shift', meta && 'Meta'].filter(Boolean)
  return [...mods, name].join('-')
}

/** Combo ids to the commands bound to them, in the order they are tried. */
export class Keymap {
  private readonly table = new Map<string, string[]>()

  constructor(
    bindings: readonly KeyBinding[],
    readonly mac: boolean,
  ) {
    for (const binding of bindings) {
      const id = parseCombo(mac && binding.mac ? binding.mac : binding.key, mac)
      const commands = this.table.get(id)
      if (!commands) this.table.set(id, [binding.command])
      else if (!commands.includes(binding.command)) commands.push(binding.command)
    }
  }

  /** The commands to try for an event, in order. */
  lookup(event: KeyEventLike): readonly string[] {
    const id = comboOf(event)
    return (id && this.table.get(id)) || []
  }

  /** The commands bound to a combo spelled like a binding. */
  commandsFor(spec: string): readonly string[] {
    return this.table.get(parseCombo(spec, this.mac)) ?? []
  }

  /** The combo to show next to a command, as the user would read it ("Ctrl+F"). */
  labelFor(command: string, bindings: readonly KeyBinding[]): string | null {
    const binding = bindings.find((entry) => entry.command === command)
    if (!binding) return null
    const spec = this.mac && binding.mac ? binding.mac : binding.key
    return parseCombo(spec, this.mac)
      .split('-')
      .map((part) => (this.mac ? MAC_SYMBOLS[part] : part) ?? part)
      .join(this.mac ? '' : '+')
  }
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }

/** Whether the platform is macOS, where Cmd takes the place of Ctrl in shortcuts. */
export function isMac(platform: string | undefined): boolean {
  return /^(mac|iphone|ipad)/i.test(platform ?? '')
}

/** The editor's bindings. Commands are named in `commands.ts`. */
export const defaultBindings: readonly KeyBinding[] = [
  { key: 'ArrowLeft', command: 'cursorCharLeft' },
  { key: 'Shift-ArrowLeft', command: 'selectCharLeft' },
  { key: 'ArrowRight', command: 'cursorCharRight' },
  { key: 'Shift-ArrowRight', command: 'selectCharRight' },
  { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', command: 'cursorWordLeft' },
  { key: 'Mod-Shift-ArrowLeft', mac: 'Alt-Shift-ArrowLeft', command: 'selectWordLeft' },
  { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', command: 'cursorWordRight' },
  { key: 'Mod-Shift-ArrowRight', mac: 'Alt-Shift-ArrowRight', command: 'selectWordRight' },
  { key: 'ArrowUp', command: 'cursorLineUp' },
  { key: 'Shift-ArrowUp', command: 'selectLineUp' },
  { key: 'ArrowDown', command: 'cursorLineDown' },
  { key: 'Shift-ArrowDown', command: 'selectLineDown' },
  { key: 'Home', mac: 'Meta-ArrowLeft', command: 'cursorLineStart' },
  { key: 'Shift-Home', mac: 'Meta-Shift-ArrowLeft', command: 'selectLineStart' },
  { key: 'End', mac: 'Meta-ArrowRight', command: 'cursorLineEnd' },
  { key: 'Shift-End', mac: 'Meta-Shift-ArrowRight', command: 'selectLineEnd' },
  { key: 'Mod-Home', mac: 'Meta-ArrowUp', command: 'cursorDocStart' },
  { key: 'Mod-Shift-Home', mac: 'Meta-Shift-ArrowUp', command: 'selectDocStart' },
  { key: 'Mod-End', mac: 'Meta-ArrowDown', command: 'cursorDocEnd' },
  { key: 'Mod-Shift-End', mac: 'Meta-Shift-ArrowDown', command: 'selectDocEnd' },
  { key: 'PageUp', command: 'cursorPageUp' },
  { key: 'Shift-PageUp', command: 'selectPageUp' },
  { key: 'PageDown', command: 'cursorPageDown' },
  { key: 'Shift-PageDown', command: 'selectPageDown' },
  { key: 'Ctrl-ArrowUp', command: 'scrollLineUp' },
  { key: 'Ctrl-ArrowDown', command: 'scrollLineDown' },
  { key: 'Mod-Alt-ArrowUp', mac: 'Ctrl-Alt-ArrowUp', command: 'addCursorAbove' },
  { key: 'Mod-Alt-ArrowDown', mac: 'Ctrl-Alt-ArrowDown', command: 'addCursorBelow' },
  { key: 'Alt-ArrowUp', command: 'moveLineUp' },
  { key: 'Alt-ArrowDown', command: 'moveLineDown' },
  { key: 'Shift-Alt-ArrowUp', command: 'copyLineUp' },
  { key: 'Shift-Alt-ArrowDown', command: 'copyLineDown' },

  { key: 'Mod-a', command: 'selectAll' },
  { key: 'Mod-l', command: 'selectLine' },
  { key: 'Mod-d', command: 'selectNextOccurrence' },
  { key: 'Mod-Shift-l', command: 'selectAllOccurrences' },
  { key: 'Mod-Shift-\\', command: 'jumpToBracket' },

  { key: 'Enter', command: 'insertNewlineAndIndent' },
  { key: 'Shift-Enter', command: 'insertNewlineAndIndent' },
  { key: 'Mod-Enter', command: 'insertLineAfter' },
  { key: 'Mod-Shift-Enter', command: 'insertLineBefore' },
  { key: 'Backspace', command: 'deleteCharBackward' },
  { key: 'Shift-Backspace', command: 'deleteCharBackward' },
  { key: 'Delete', command: 'deleteCharForward' },
  { key: 'Mod-Backspace', mac: 'Alt-Backspace', command: 'deleteWordBackward' },
  { key: 'Mod-Delete', mac: 'Alt-Delete', command: 'deleteWordForward' },
  { key: 'Mod-Shift-k', command: 'deleteLine' },
  { key: 'Tab', command: 'insertTab' },
  { key: 'Shift-Tab', command: 'indentLess' },
  { key: 'Mod-]', command: 'indentMore' },
  { key: 'Mod-[', command: 'indentLess' },
  { key: 'Mod-/', command: 'toggleLineComment' },
  { key: 'Shift-Alt-a', command: 'toggleBlockComment' },
  { key: 'Mod-z', command: 'undo' },
  { key: 'Mod-y', mac: 'Meta-Shift-z', command: 'redo' },
  { key: 'Mod-Shift-z', command: 'redo' },

  { key: 'Mod-f', command: 'openFind' },
  { key: 'Mod-h', mac: 'Meta-Alt-f', command: 'openReplace' },
  { key: 'F3', mac: 'Meta-g', command: 'findNext' },
  { key: 'Shift-F3', mac: 'Meta-Shift-g', command: 'findPrevious' },
  { key: 'Alt-Enter', command: 'selectAllMatches' },
  { key: 'Mod-g', mac: 'Ctrl-g', command: 'gotoLine' },
  { key: 'Escape', command: 'closeFind' },
  { key: 'Escape', command: 'collapseSelection' },
]
