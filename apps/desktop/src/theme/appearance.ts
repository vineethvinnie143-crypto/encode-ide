/**
 * Applies an Appearance to the page as data attributes on <html>, which
 * tokens.css turns into colours, row heights and motion, and as the CSS
 * variables for fonts and sizes. With mode System it follows Windows
 * switching between light and dark.
 */
import { activeTheme, appearanceFromParams, fontVariables, resolveTheme, type Appearance } from '@shared/appearance'
import { THEME_VARIABLES, themeVariables } from '@shared/themes'

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
let current: Appearance | null = null

export function applyAppearance(appearance: Appearance): void {
  current = appearance
  const root = document.documentElement
  const theme = activeTheme(appearance)
  // The person's own theme decides light or dark, and its colours go over the built-in ones of that base.
  root.dataset.theme = theme?.base ?? resolveTheme(appearance.mode, darkScheme.matches)
  if (theme) {
    root.dataset.custom = theme.id
    for (const [name, value] of Object.entries(themeVariables(theme, appearance.contrast === 'high'))) root.style.setProperty(name, value)
  } else {
    delete root.dataset.custom
    for (const name of THEME_VARIABLES) root.style.removeProperty(name)
  }
  root.dataset.accent = appearance.accent
  root.dataset.contrast = appearance.contrast
  root.dataset.density = appearance.density
  root.dataset.motion = appearance.motion
  for (const [name, value] of Object.entries(fontVariables(appearance))) root.style.setProperty(name, value)
}

darkScheme.addEventListener('change', () => {
  if (current?.mode === 'system' && !activeTheme(current)) applyAppearance(current)
})

/** The appearance the main process put in the page URL, for the first frame. */
export function initialAppearance(): Appearance {
  return appearanceFromParams(new URLSearchParams(window.location.search))
}
