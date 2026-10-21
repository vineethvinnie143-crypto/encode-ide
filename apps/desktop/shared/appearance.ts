/**
 * How eNCode looks. Stored with the settings, applied by the renderer as
 * data attributes on <html> (see src/theme/tokens.css) and by the main
 * process as the native theme and window colour. No runtime dependencies,
 * so both tsconfig projects and the unit tests can use it.
 */

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Accent = 'blue' | 'cyan' | 'jade' | 'amber'
export type Contrast = 'standard' | 'high'
export type Density = 'comfortable' | 'compact'
/** system follows Windows' animation setting; reduce always cuts motion; full never does. */
export type Motion = 'system' | 'reduce' | 'full'

export interface Appearance {
  mode: ThemeMode
  accent: Accent
  contrast: Contrast
  density: Density
  motion: Motion
}

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']
export const ACCENTS: readonly Accent[] = ['blue', 'cyan', 'jade', 'amber']
export const CONTRASTS: readonly Contrast[] = ['standard', 'high']
export const DENSITIES: readonly Density[] = ['comfortable', 'compact']
export const MOTIONS: readonly Motion[] = ['system', 'reduce', 'full']

/** Dark Graphite with the Signal blue accent: eNCode as it has always looked. */
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'dark',
  accent: 'blue',
  contrast: 'standard',
  density: 'comfortable',
  motion: 'system',
}

/** --chrome of each theme: the window shows it before the first frame, so a light theme never flashes dark. */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: '#0b0c10',
  light: '#edeff3',
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** A valid Appearance from anything: unknown fields are dropped, bad values fall back to `base`. */
export function normalizeAppearance(value: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const input = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    mode: oneOf(input.mode, THEME_MODES, base.mode),
    accent: oneOf(input.accent, ACCENTS, base.accent),
    contrast: oneOf(input.contrast, CONTRASTS, base.contrast),
    density: oneOf(input.density, DENSITIES, base.density),
    motion: oneOf(input.motion, MOTIONS, base.motion),
  }
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
    a.motion === b.motion
  )
}

/**
 * The appearance as page URL parameters. The main process adds them to the
 * renderer's URL so the first frame is drawn in the right theme, before the
 * settings arrive over IPC.
 */
export function appearanceParams(appearance: Appearance): Record<keyof Appearance, string> {
  return { ...appearance }
}

/** Reads what appearanceParams wrote; anything missing or unknown falls back to the default. */
export function appearanceFromParams(params: { get(name: string): string | null }): Appearance {
  return normalizeAppearance({
    mode: params.get('mode'),
    accent: params.get('accent'),
    contrast: params.get('contrast'),
    density: params.get('density'),
    motion: params.get('motion'),
  })
}
