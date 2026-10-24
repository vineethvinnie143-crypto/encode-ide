/**
 * Colour themes of the person's own (Settings > Appearance): a name, the built-in theme it starts from, and seventeen
 * colours, from which every colour token of tokens.css is worked out. A theme can be saved to a file and read back.
 * No runtime dependencies, so both tsconfig projects and the unit tests can use it.
 */

export type ThemeBase = 'light' | 'dark'

export type ThemeColor =
  | 'chrome'
  | 'sidebar'
  | 'canvas'
  | 'surface'
  | 'border'
  | 'text'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'bubble'
  | 'keyword'
  | 'function'
  | 'string'
  | 'number'
  | 'type'
  | 'comment'

export interface CustomTheme {
  /** "theme-" and up to 32 letters, digits and hyphens. */
  id: string
  name: string
  base: ThemeBase
  /** Every colour, as #rrggbb. */
  colors: Record<ThemeColor, string>
}

export type ThemeGroup = 'Surfaces' | 'Text and lines' | 'Accent and meaning' | 'Code'

/** The colours the editor lists, in its order, with what each one paints. */
export const THEME_COLORS: readonly { key: ThemeColor; label: string; hint: string; group: ThemeGroup }[] = [
  { key: 'chrome', label: 'Title bar', hint: 'The title bar, the icon strip and the window behind them.', group: 'Surfaces' },
  { key: 'sidebar', label: 'Sidebar', hint: 'The sessions list and the Settings sections.', group: 'Surfaces' },
  { key: 'canvas', label: 'Background', hint: 'The thread, the editor and the side panel.', group: 'Surfaces' },
  { key: 'surface', label: 'Cards and fields', hint: 'Cards, tool rows, the message box, menus and dialogs, a little lighter each.', group: 'Surfaces' },
  { key: 'text', label: 'Text', hint: 'Secondary and quiet text are this colour toward the background.', group: 'Text and lines' },
  { key: 'border', label: 'Lines', hint: 'Borders and dividers; fainter and stronger lines follow it.', group: 'Text and lines' },
  { key: 'accent', label: 'Accent', hint: 'Links, focus, selection and the Send button.', group: 'Accent and meaning' },
  { key: 'bubble', label: 'Your messages', hint: 'The bubble around what you send.', group: 'Accent and meaning' },
  { key: 'success', label: 'Success', hint: 'Passed checks, added lines.', group: 'Accent and meaning' },
  { key: 'warning', label: 'Warning', hint: 'Warnings and what needs a look.', group: 'Accent and meaning' },
  { key: 'danger', label: 'Danger', hint: 'Errors, removed lines, delete.', group: 'Accent and meaning' },
  { key: 'keyword', label: 'Keywords', hint: 'if, return, const, and tags in markup.', group: 'Code' },
  { key: 'function', label: 'Functions', hint: 'Function names and keys.', group: 'Code' },
  { key: 'string', label: 'Strings', hint: 'Text in quotes.', group: 'Code' },
  { key: 'number', label: 'Numbers', hint: 'Numbers and true or false.', group: 'Code' },
  { key: 'type', label: 'Types', hint: 'Types, classes and attributes.', group: 'Code' },
  { key: 'comment', label: 'Comments', hint: 'Comments.', group: 'Code' },
]

/** The built-in themes as these colours, with the Signal blue accent: the values of tokens.css. */
export const BUILT_IN_COLORS: Readonly<Record<ThemeBase, Readonly<Record<ThemeColor, string>>>> = {
  dark: {
    chrome: '#0b0c10',
    sidebar: '#0d0f13',
    canvas: '#0f1116',
    surface: '#151820',
    border: '#2a2f3b',
    text: '#eceff4',
    accent: '#6b98ff',
    success: '#3ccb7f',
    warning: '#f5b54a',
    danger: '#ff6b6b',
    bubble: '#1d2a48',
    keyword: '#ff8fb1',
    function: '#7fd1ff',
    string: '#9be38f',
    number: '#f7b267',
    type: '#c5a3ff',
    comment: '#7c859a',
  },
  light: {
    chrome: '#edeff3',
    sidebar: '#f4f5f8',
    canvas: '#ffffff',
    surface: '#f7f8fa',
    border: '#e0e3e9',
    text: '#11141a',
    accent: '#2f5fe0',
    success: '#1a8f52',
    warning: '#9a5b00',
    danger: '#d64545',
    bubble: '#e8eeff',
    keyword: '#c2185b',
    function: '#0b6bcb',
    string: '#2e7d32',
    number: '#b45309',
    type: '#6d28d9',
    comment: '#6e7687',
  },
}

/** The accents of the built-in choices, by theme (tokens.css, data-accent). */
export const ACCENT_COLORS: Readonly<Record<ThemeBase, Readonly<Record<'blue' | 'cyan' | 'jade' | 'amber', string>>>> = {
  dark: { blue: '#6b98ff', cyan: '#5ccff2', jade: '#4edba0', amber: '#f7be5c' },
  light: { blue: '#2f5fe0', cyan: '#0b6e8f', jade: '#0f7a51', amber: '#8f5200' },
}

export const MAX_THEMES = 12
export const MAX_THEME_NAME = 40
/** The largest theme file read. */
export const MAX_THEME_FILE_BYTES = 64 * 1024
export const THEME_FILE_VERSION = 1

const HEX = /^#[0-9a-f]{6}$/i
const ID = /^theme-[a-z0-9-]{1,32}$/
const KEYS = THEME_COLORS.map((color) => color.key)

// ------------------------------------------------------------ colour arithmetic

type Rgb = [number, number, number]

function rgbOf(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function hexOf([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((part) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('')}`
}

/** `a` moved toward `b` by `amount`, 0 to 1. */
export function mix(a: string, b: string, amount: number): string {
  const [from, to] = [rgbOf(a), rgbOf(b)]
  return hexOf([0, 1, 2].map((index) => from[index]! + (to[index]! - from[index]!) * amount) as Rgb)
}

function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgbOf(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** The WCAG contrast of two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

/** A fill for buttons with white text on it: the accent, darkened until the text reads (4.5:1), at most 70% of the way to black. */
function fillFor(accent: string): string {
  let fill = accent
  for (let step = 1; step <= 14 && contrastRatio('#ffffff', fill) < 4.5; step++) fill = mix(accent, '#000000', step * 0.05)
  return fill
}

// ------------------------------------------------------------ themes

/** A new theme from a built-in one with one of its accents. */
export function newTheme(id: string, name: string, base: ThemeBase, accent: string = BUILT_IN_COLORS[base].accent): CustomTheme {
  return { id, name, base, colors: { ...BUILT_IN_COLORS[base], accent } }
}

function cleanName(value: unknown): string {
  // Letters, marks, digits, spaces and punctuation; no control or direction characters.
  const name = typeof value === 'string' ? value.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_THEME_NAME) : ''
  return name || 'My theme'
}

/** A theme from anything: null unless its id and base are good; a colour that is missing or not #rrggbb is the base's. */
export function normalizeTheme(value: unknown): CustomTheme | null {
  if (value === null || typeof value !== 'object') return null
  const input = value as { id?: unknown; name?: unknown; base?: unknown; colors?: unknown }
  if (typeof input.id !== 'string' || !ID.test(input.id)) return null
  if (input.base !== 'light' && input.base !== 'dark') return null
  const given = input.colors !== null && typeof input.colors === 'object' ? (input.colors as Record<string, unknown>) : {}
  const colors = { ...BUILT_IN_COLORS[input.base] }
  for (const key of KEYS) {
    const color = given[key]
    if (typeof color === 'string' && HEX.test(color)) colors[key] = color.toLowerCase()
  }
  return { id: input.id, name: cleanName(input.name), base: input.base, colors }
}

/** At most MAX_THEMES good themes, each id once. */
export function normalizeThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const themes: CustomTheme[] = []
  for (const item of value) {
    const theme = normalizeTheme(item)
    if (!theme || seen.has(theme.id)) continue
    seen.add(theme.id)
    themes.push(theme)
    if (themes.length >= MAX_THEMES) break
  }
  return themes
}

export function sameTheme(a: CustomTheme, b: CustomTheme): boolean {
  return a.id === b.id && a.name === b.name && a.base === b.base && KEYS.every((key) => a.colors[key] === b.colors[key])
}

/**
 * The CSS variables a theme sets on <html>, over the built-in theme of its base: the seventeen colours, and the
 * steps between them (a lighter card, a fainter line, quieter text) at the built-in theme's distances. High
 * contrast moves the quieter text and the lines toward the text, as tokens.css does.
 */
export function themeVariables(theme: CustomTheme, highContrast = false): Record<string, string> {
  const c = theme.colors
  const dark = theme.base === 'dark'
  // Fitted to the built-in themes: each step reads against the background about as the built-in one does.
  const [text2, text3] = highContrast ? (dark ? [0.16, 0.29] : [0.15, 0.27]) : dark ? [0.27, 0.42] : [0.28, 0.39]
  const fill = fillFor(c.accent)
  const line = highContrast ? mix(c.border, c.text, dark ? 0.08 : 0.12) : c.border
  return {
    '--chrome': c.chrome,
    '--sidebar': c.sidebar,
    '--canvas': c.canvas,
    '--surface-1': c.surface,
    '--surface-2': dark ? mix(c.surface, c.text, 0.025) : mix(c.surface, '#ffffff', 0.6),
    '--surface-3': dark ? mix(c.surface, c.text, 0.05) : mix(c.surface, '#ffffff', 0.8),
    '--border-subtle': highContrast ? c.border : mix(c.border, c.canvas, 0.42),
    '--border': line,
    '--border-strong': mix(line, c.text, dark ? 0.06 : 0.1),
    '--text-1': c.text,
    '--text-2': mix(c.text, c.canvas, text2),
    '--text-3': mix(c.text, c.canvas, text3),
    '--text-disabled': mix(c.text, c.canvas, dark ? 0.62 : 0.64),
    '--on-accent': '#ffffff',
    '--accent': c.accent,
    '--accent-fill': fill,
    '--accent-fill-hover': mix(fill, dark ? '#ffffff' : '#000000', 0.08),
    '--bubble': c.bubble,
    '--bubble-text': c.text,
    '--bubble-border': mix(c.bubble, c.text, 0.1),
    '--success': c.success,
    '--warning': c.warning,
    '--danger': c.danger,
    '--syn-keyword': c.keyword,
    '--syn-fn': c.function,
    '--syn-string': c.string,
    '--syn-number': c.number,
    '--syn-type': c.type,
    '--syn-comment': c.comment,
  }
}

/** Every variable themeVariables sets, to take them off again. */
export const THEME_VARIABLES: readonly string[] = Object.keys(themeVariables(newTheme('theme-x', 'x', 'dark')))

/** What reads poorly in a theme: text on its surfaces and white text on its buttons, under 4.5:1. */
export function contrastProblems(theme: CustomTheme): { label: string; ratio: number }[] {
  const vars = themeVariables(theme)
  const checks: [string, string, string][] = [
    ['Text on the background', vars['--text-1']!, vars['--canvas']!],
    ['Text on cards', vars['--text-1']!, vars['--surface-3']!],
    ['Secondary text on the background', vars['--text-2']!, vars['--canvas']!],
    ['Quiet text on cards', vars['--text-3']!, vars['--surface-1']!],
    ['Button text', '#ffffff', vars['--accent-fill']!],
  ]
  return checks.map(([label, a, b]) => ({ label, ratio: contrastRatio(a, b) })).filter((check) => check.ratio < 4.5)
}

/** The window behind the page and its native buttons, in a theme's colours. */
export function themeWindow(theme: CustomTheme): { background: string; symbol: string } {
  return { background: theme.colors.chrome, symbol: mix(theme.colors.text, theme.colors.chrome, 0.12) }
}

// ------------------------------------------------------------ files

/** A theme as a file to share: its name, base and colours, without its id. */
export function themeFile(theme: CustomTheme): string {
  return `${JSON.stringify({ eNCodeTheme: THEME_FILE_VERSION, name: theme.name, base: theme.base, colors: theme.colors }, null, 2)}\n`
}

/** A theme read from a file, under a new id; throws with what is wrong in words a person can act on. */
export function themeFromFile(text: string, id: string): CustomTheme {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not a theme: it is not JSON.')
  }
  const input = parsed !== null && typeof parsed === 'object' ? (parsed as { eNCodeTheme?: unknown; name?: unknown; base?: unknown; colors?: unknown }) : {}
  if (input.eNCodeTheme !== THEME_FILE_VERSION) throw new Error('That file is not an eNCode theme.')
  const theme = normalizeTheme({ id, name: input.name, base: input.base, colors: input.colors })
  if (!theme) throw new Error('The theme in that file says neither light nor dark.')
  return theme
}
