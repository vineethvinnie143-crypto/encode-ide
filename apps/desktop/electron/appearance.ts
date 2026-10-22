import { nativeTheme, type BrowserWindow } from 'electron'
import { CAPTION_SYMBOL, TITLE_BAR_HEIGHT, WINDOW_BACKGROUND, type Appearance } from '../shared/appearance'

const currentTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

/** The window colour for the theme Electron is using now. */
export function windowBackground(): string {
  return WINDOW_BACKGROUND[currentTheme()]
}

/**
 * Windows draws the window buttons itself (minimise, maximise, close, with snap layouts), over the title bar.
 * ENCODE_NATIVE_CAPTIONS=1 asks for the same on other systems, which is how the title bar's layout for them is tried.
 */
export const NATIVE_CAPTIONS = process.platform === 'win32' || process.env.ENCODE_NATIVE_CAPTIONS === '1'

export function captionOverlay(): { color: string; symbolColor: string; height: number } {
  const theme = currentTheme()
  return { color: WINDOW_BACKGROUND[theme], symbolColor: CAPTION_SYMBOL[theme], height: TITLE_BAR_HEIGHT }
}

/** The window and its native buttons in the colours of the theme in use. */
function paint(win: BrowserWindow): void {
  win.setBackgroundColor(windowBackground())
  if (NATIVE_CAPTIONS) win.setTitleBarOverlay(captionOverlay())
}

/**
 * Points Electron's native theme at the user's choice, which also sets what
 * prefers-color-scheme reports to the renderer, and repaints the window
 * behind the page to match.
 */
export function applyNativeAppearance(appearance: Appearance, win: BrowserWindow | null): void {
  nativeTheme.themeSource = appearance.mode
  if (win && !win.isDestroyed()) paint(win)
}

/** With mode System, follows Windows switching between light and dark while eNCode runs. */
export function followSystemTheme(getWindow: () => BrowserWindow | null): void {
  nativeTheme.on('updated', () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) paint(win)
  })
}
