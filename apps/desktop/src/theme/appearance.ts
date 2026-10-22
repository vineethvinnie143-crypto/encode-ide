/**
 * Applies an Appearance to the page as data attributes on <html>, which
 * tokens.css turns into colours, row heights and motion, and as the CSS
 * variables for fonts and sizes. With mode System it follows Windows
 * switching between light and dark.
 */
import { appearanceFromParams, fontVariables, resolveTheme, type Appearance } from '@shared/appearance'

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
let current: Appearance | null = null

export function applyAppearance(appearance: Appearance): void {
  current = appearance
  const root = document.documentElement
  root.dataset.theme = resolveTheme(appearance.mode, darkScheme.matches)
  root.dataset.accent = appearance.accent
  root.dataset.contrast = appearance.contrast
  root.dataset.density = appearance.density
  root.dataset.motion = appearance.motion
  for (const [name, value] of Object.entries(fontVariables(appearance))) root.style.setProperty(name, value)
}

darkScheme.addEventListener('change', () => {
  if (current?.mode === 'system') applyAppearance(current)
})

/** The appearance the main process put in the page URL, for the first frame. */
export function initialAppearance(): Appearance {
  return appearanceFromParams(new URLSearchParams(window.location.search))
}
