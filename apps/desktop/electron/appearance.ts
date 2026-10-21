import { nativeTheme, type BrowserWindow } from 'electron'
import { WINDOW_BACKGROUND, type Appearance } from '../shared/appearance'

/** The window colour for the theme Electron is using now. */
export function windowBackground(): string {
  return WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
}

/**
 * Points Electron's native theme at the user's choice, which also sets what
 * prefers-color-scheme reports to the renderer, and repaints the window
 * behind the page to match.
 */
export function applyNativeAppearance(appearance: Appearance, win: BrowserWindow | null): void {
  nativeTheme.themeSource = appearance.mode
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground())
}

/** With mode System, follows Windows switching between light and dark while eNCode runs. */
export function followSystemTheme(getWindow: () => BrowserWindow | null): void {
  nativeTheme.on('updated', () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground())
  })
}
