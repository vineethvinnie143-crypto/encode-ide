import { normalizeThemes, sameTheme, type CustomTheme } from './themes'

/**
 * How eNCode looks. Stored with the settings, applied by the renderer as
 * data attributes and CSS variables on <html> (see src/theme/tokens.css) and
 * by the main process as the native theme and window colour. No runtime
 * dependencies, so both tsconfig projects and the unit tests can use it.
 */

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Accent = 'blue' | 'cyan' | 'jade' | 'amber'
export type Contrast = 'standard' | 'high'
export type Density = 'comfortable' | 'compact'
/** system follows Windows' animation setting; reduce always cuts motion; full never does. */
export type Motion = 'system' | 'reduce' | 'full'

/** The built-in font choices. Anything else is the family name of a font installed on the PC. */
export const FONT_SYSTEM = '@system'
export const FONT_ENCODE = '@encode'

export interface Appearance {
  mode: ThemeMode
  accent: Accent
  contrast: Contrast
  density: Density
  motion: Motion
  /** The interface font: FONT_SYSTEM (Windows' own, as in Codex), FONT_ENCODE (Inter) or an installed family. */
  uiFont: string
  /** The code font: FONT_SYSTEM (Consolas), FONT_ENCODE (JetBrains Mono) or an installed family. */
  codeFont: string
  /** Size of interface text in px; the size of the thread's text, from which smaller text is derived. */
  uiSize: number
  /** Size of code in replies, diffs and tool output in px. */
  codeSize: number
  /** The id of the person's own theme in use, which then decides light or dark and the accent; '' for the built-in theme. */
  theme: string
  /** The person's own themes (shared/themes.ts). */
  themes: CustomTheme[]
}

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']
export const ACCENTS: readonly Accent[] = ['blue', 'cyan', 'jade', 'amber']
export const CONTRASTS: readonly Contrast[] = ['standard', 'high']
export const DENSITIES: readonly Density[] = ['comfortable', 'compact']
export const MOTIONS: readonly Motion[] = ['system', 'reduce', 'full']

export const UI_SIZES: readonly number[] = [12, 13, 14, 15, 16]
export const CODE_SIZES: readonly number[] = [11, 12, 13, 14, 15, 16]

/**
 * Dark Graphite with the Signal blue accent, in Windows' own fonts at Codex's sizes (14 px text,
 * 12 px code). Inter and JetBrains Mono stay one setting away.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'dark',
  accent: 'blue',
  contrast: 'standard',
  density: 'comfortable',
  motion: 'system',
  uiFont: FONT_SYSTEM,
  codeFont: FONT_SYSTEM,
  uiSize: 14,
  codeSize: 12,
  theme: '',
  themes: [],
}

/** --chrome of each theme: the window shows it before the first frame, so a light theme never flashes dark. */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0b0c10',
  light: '#edeff3',
}

/**
 * The 1 px line Windows 11 draws around a window. Left to the system it takes the user's accent colour (a pink
 * or green hairline around a dark window), so eNCode paints it in the colour of the chrome it borders: the
 * window then ends in its own edge, with no line of another colour.
 */
export const WINDOW_BORDER: Record<ResolvedTheme, string> = {
  dark: WINDOW_BACKGROUND.dark,
  light: WINDOW_BACKGROUND.light,
}

/** The glyphs of the native window buttons (Windows draws them over the title bar), chosen to stand out from `WINDOW_BACKGROUND`. */
export const CAPTION_SYMBOL: Record<ResolvedTheme, string> = {
  dark: '#d3d8e2',
  light: '#3a4152',
}

/** The title bar's height in px, which is also the height of the native window buttons. `.titlebar` in 01-titlebar.css says the same. */
export const TITLE_BAR_HEIGHT = 44

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** An installed font's family name: letters, digits, spaces and a few marks; nothing that could leave a CSS string. */
const FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} ._()+&,'-]{0,63}$/u

/** A built-in choice or a plausible family name; anything else falls back. */
export function normalizeFont(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  if (name === FONT_SYSTEM || name === FONT_ENCODE) return name
  return FAMILY.test(name) ? name : fallback
}

/** A whole number of px from `allowed` (or between its ends); a number or the text of one, as page URLs carry it. */
export function normalizeSize(value: unknown, allowed: readonly number[], fallback: number): number {
  const size = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof size !== 'number' || !Number.isInteger(size)) return fallback
  return size >= allowed[0] && size <= allowed[allowed.length - 1] ? size : fallback
}

/** A valid Appearance from anything: unknown fields are dropped, bad values fall back to `base`. */
export function normalizeAppearance(value: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const input = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const themes = input.themes === undefined ? base.themes : normalizeThemes(input.themes)
  const theme = typeof input.theme === 'string' ? input.theme : base.theme
  return {
    mode: oneOf(input.mode, THEME_MODES, base.mode),
    accent: oneOf(input.accent, ACCENTS, base.accent),
    contrast: oneOf(input.contrast, CONTRASTS, base.contrast),
    density: oneOf(input.density, DENSITIES, base.density),
    motion: oneOf(input.motion, MOTIONS, base.motion),
    uiFont: normalizeFont(input.uiFont, base.uiFont),
    codeFont: normalizeFont(input.codeFont, base.codeFont),
    uiSize: normalizeSize(input.uiSize, UI_SIZES, base.uiSize),
    codeSize: normalizeSize(input.codeSize, CODE_SIZES, base.codeSize),
    theme: themes.some((candidate) => candidate.id === theme) ? theme : '',
    themes,
  }
}

/** The person's own theme in use, if any. */
export function activeTheme(appearance: Pick<Appearance, 'theme' | 'themes'>): CustomTheme | null {
  return (appearance.theme && appearance.themes.find((theme) => theme.id === appearance.theme)) || null
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}

export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return (
    a.mode === b.mode &&
    a.accent === b.accent &&
    a.contrast === b.contrast &&
    a.density === b.density &&
    a.motion === b.motion &&
    a.uiFont === b.uiFont &&
    a.codeFont === b.codeFont &&
    a.uiSize === b.uiSize &&
    a.codeSize === b.codeSize &&
    a.theme === b.theme &&
    a.themes.length === b.themes.length &&
    a.themes.every((theme, index) => sameTheme(theme, b.themes[index]!))
  )
}

const UI_FALLBACK = "system-ui, 'Segoe UI', sans-serif"
const CODE_FALLBACK = "Consolas, ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', monospace"

/** The font-family list for interface text. A family name is quoted; the name has no quote or backslash in it. */
export function uiFontStack(font: string): string {
  if (font === FONT_ENCODE) return `'Inter', ${UI_FALLBACK}`
  if (font === FONT_SYSTEM) return UI_FALLBACK
  return `"${font}", ${UI_FALLBACK}`
}

/** The font-family list for code. */
export function codeFontStack(font: string): string {
  if (font === FONT_ENCODE) return `'JetBrains Mono', ${CODE_FALLBACK}`
  if (font === FONT_SYSTEM) return CODE_FALLBACK
  return `"${font}", ${CODE_FALLBACK}`
}

/**
 * The CSS variables an Appearance sets on <html>. Text sizes in the stylesheets are written for Inter
 * at 14 px, so `--ui-delta` moves every size by the change from 14 px, and `--ui-small` also gives
 * text under 14 px one more pixel in Windows' font, which sets about 8% narrower than Inter at the
 * same size (Codex's 14 px rows are as wide as eNCode's 13 px Inter rows).
 */
export function fontVariables(appearance: Appearance): Record<string, string> {
  const delta = appearance.uiSize - 14
  const boost = appearance.uiFont === FONT_SYSTEM ? 1 : 0
  return {
    '--font-ui': uiFontStack(appearance.uiFont),
    '--font-mono': codeFontStack(appearance.codeFont),
    '--ui-delta': `${delta}px`,
    '--ui-small': `${delta + boost}px`,
    '--code-size': `${appearance.codeSize}px`,
  }
}

/**
 * The appearance as page URL parameters. The main process adds them to the
 * renderer's URL so the first frame is drawn in the right theme and fonts,
 * before the settings arrive over IPC.
 */
export function appearanceParams(appearance: Appearance): Record<keyof Appearance, string> {
  // Only the theme in use: the first frame needs no other, and the rest arrive with the settings.
  const theme = activeTheme(appearance)
  return { ...appearance, uiSize: String(appearance.uiSize), codeSize: String(appearance.codeSize), theme: theme?.id ?? '', themes: theme ? JSON.stringify([theme]) : '' }
}

function themesParam(text: string | null): unknown {
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

/** Reads what appearanceParams wrote; anything missing or unknown falls back to the default. */
export function appearanceFromParams(params: { get(name: string): string | null }): Appearance {
  return normalizeAppearance({
    mode: params.get('mode'),
    accent: params.get('accent'),
    contrast: params.get('contrast'),
    density: params.get('density'),
    motion: params.get('motion'),
    uiFont: params.get('uiFont'),
    codeFont: params.get('codeFont'),
    uiSize: params.get('uiSize'),
    codeSize: params.get('codeSize'),
    theme: params.get('theme') ?? '',
    themes: themesParam(params.get('themes')),
  })
}
