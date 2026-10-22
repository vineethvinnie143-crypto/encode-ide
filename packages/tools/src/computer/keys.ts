/**
 * Key combinations for the `key` action, as people write them: "ctrl+s", "alt+f4", "enter", or several
 * in a row, "ctrl+a delete". Parsed here into a closed list of names the backend maps to key codes, so
 * a typo is an error the model can read rather than a key that is silently different.
 *
 * The Windows key and the combinations that leave the window (task switching, the Start menu, the task
 * manager) are refused: they act on the whole desktop, outside the one application the user allowed.
 */
import type { KeyCombo } from './contract'

type Modifier = KeyCombo['modifiers'][number]

const MODIFIERS: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
}

const WINDOWS_KEY = new Set(['win', 'windows', 'super', 'meta', 'cmd', 'command'])

const NAMED: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  bksp: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  page_up: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  page_down: 'pagedown',
  pgdn: 'pagedown',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  space: 'space',
  spacebar: 'space',
  capslock: 'capslock',
  numlock: 'numlock',
  scrolllock: 'scrolllock',
  printscreen: 'printscreen',
  prtsc: 'printscreen',
  pause: 'pause',
  menu: 'menu',
  apps: 'menu',
  minus: 'minus',
  '-': 'minus',
  equals: 'equals',
  equal: 'equals',
  '=': 'equals',
  plus: 'equals',
  '+': 'equals',
  comma: 'comma',
  ',': 'comma',
  period: 'period',
  '.': 'period',
  slash: 'slash',
  '/': 'slash',
  semicolon: 'semicolon',
  ';': 'semicolon',
  quote: 'quote',
  "'": 'quote',
  lbracket: 'lbracket',
  '[': 'lbracket',
  rbracket: 'rbracket',
  ']': 'rbracket',
  backslash: 'backslash',
  '\\': 'backslash',
  backtick: 'backtick',
  '`': 'backtick',
  numpadadd: 'numpadadd',
  numpadsubtract: 'numpadsubtract',
  numpadmultiply: 'numpadmultiply',
  numpaddivide: 'numpaddivide',
  numpaddecimal: 'numpaddecimal',
  numpadenter: 'numpadenter',
}

/** Every key name the backend understands. */
export const KEY_NAMES: readonly string[] = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `numpad${index}`),
  ...new Set(Object.values(NAMED)),
]

const MAX_COMBOS = 20

export type KeysResult = { ok: true; combos: KeyCombo[] } | { ok: false; error: string }

function keyName(token: string): string | undefined {
  const lower = token.toLowerCase()
  if (NAMED[lower]) return NAMED[lower]
  if (/^[a-z0-9]$/.test(lower)) return lower
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower
  if (/^numpad[0-9]$/.test(lower)) return lower
  return undefined
}

/** Combinations that act on the desktop, not on the application the user allowed. */
function leavesTheWindow(modifiers: readonly Modifier[], key: string): string | undefined {
  const has = (modifier: Modifier) => modifiers.includes(modifier)
  if (key === 'tab' && has('alt')) return 'switches to another window'
  if (key === 'escape' && has('alt')) return 'switches to another window'
  if (key === 'escape' && has('ctrl')) return 'opens the Start menu or the task manager'
  if (key === 'delete' && has('ctrl') && has('alt')) return 'opens the security screen'
  return undefined
}

/** "ctrl+s" into its modifier words and key word; "ctrl++" and a lone "+" mean the plus key. */
function splitCombo(word: string): { modifiers: string[]; key: string } {
  if (word === '+') return { modifiers: [], key: '+' }
  if (word.endsWith('++')) return { modifiers: word.slice(0, -2).split('+').filter(Boolean), key: '+' }
  const parts = word.split('+')
  const key = parts.pop() ?? ''
  return { modifiers: parts.filter(Boolean), key }
}

const NO_WINDOWS_KEY = 'the Windows key is not available: it acts on the whole desktop, outside the application you may use.'

export function parseKeys(text: string): KeysResult {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { ok: false, error: 'give the keys to press, for example "ctrl+s" or "enter".' }
  if (words.length > MAX_COMBOS) return { ok: false, error: `press at most ${MAX_COMBOS} key combinations in one call.` }

  const combos: KeyCombo[] = []
  for (const word of words) {
    const { modifiers: modifierWords, key: keyWord } = splitCombo(word)
    const modifiers: Modifier[] = []
    for (const part of modifierWords) {
      const lower = part.toLowerCase()
      if (WINDOWS_KEY.has(lower)) return { ok: false, error: NO_WINDOWS_KEY }
      const modifier = MODIFIERS[lower]
      if (!modifier) return { ok: false, error: `"${part}" is not a modifier in "${word}". Use ctrl, alt or shift, then the key: "ctrl+shift+t".` }
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
    }
    if (!keyWord) return { ok: false, error: `"${word}" has no key after the modifiers.` }
    if (WINDOWS_KEY.has(keyWord.toLowerCase())) return { ok: false, error: NO_WINDOWS_KEY }
    const key = keyName(keyWord)
    if (!key) {
      if (MODIFIERS[keyWord.toLowerCase()]) return { ok: false, error: `"${word}" ends with a modifier. Add the key to press, for example "${word}+a".` }
      return {
        ok: false,
        error: `"${keyWord}" is not a key name. Use a letter or digit, f1 to f24, or a name such as enter, tab, escape, backspace, delete, home, end, pageup, pagedown, up, down, left, right, space.`,
      }
    }
    const away = leavesTheWindow(modifiers, key)
    if (away) return { ok: false, error: `"${word}" ${away}. Use the focus action to change windows.` }
    combos.push({ modifiers, key })
  }
  return { ok: true, combos }
}

export function describeCombos(combos: readonly KeyCombo[]): string {
  return combos
    .map((combo) => [...combo.modifiers, combo.key].map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))).join('+'))
    .join(' ')
}
