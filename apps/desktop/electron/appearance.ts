import { nativeTheme, type BrowserWindow } from 'electron'
import { activeTheme, CAPTION_SYMBOL, TITLE_BAR_HEIGHT, WINDOW_BACKGROUND, WINDOW_BORDER, type Appearance } from '../shared/appearance'
import { themeWindow, type CustomTheme } from '../shared/themes'

const currentTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
/** The person's own theme in use: its title bar colour is the window's. */
let custom: CustomTheme | null = null

/** The window colour for the theme Electron is using now. */
export function windowBackground(): string {
  return custom ? themeWindow(custom).background : WINDOW_BACKGROUND[currentTheme()]
}

/**
 * The colour of the line Windows 11 draws around the window, which would otherwise be the user's accent
 * colour. Undefined elsewhere: the option and the call exist on Windows only.
 */
export function windowBorder(): string | undefined {
  return process.platform === 'win32' ? (custom ? themeWindow(custom).background : WINDOW_BORDER[currentTheme()]) : undefined
}

/**
 * Windows draws the window buttons itself (minimise, maximise, close, with snap layouts), over the title bar.
 * ENCODE_NATIVE_CAPTIONS=1 asks for the same on other systems, which is how the title bar's layout for them is tried.
 */
export const NATIVE_CAPTIONS = process.platform === 'win32' || process.env.ENCODE_NATIVE_CAPTIONS === '1'

export function captionOverlay(): { color: string; symbolColor: string; height: number } {
  if (custom) {
    const colors = themeWindow(custom)
    return { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT }
  }
  const theme = currentTheme()
  return { color: WINDOW_BACKGROUND[theme], symbolColor: CAPTION_SYMBOL[theme], height: TITLE_BAR_HEIGHT }
}

/** The window, its border and its native buttons in the colours of the theme in use. */
function paint(win: BrowserWindow): void {
  win.setBackgroundColor(windowBackground())
  const border = windowBorder()
  if (border) win.setAccentColor(border)
  if (NATIVE_CAPTIONS) win.setTitleBarOverlay(captionOverlay())
}

/**
 * Points Electron's native theme at the user's choice, which also sets what
 * prefers-color-scheme reports to the renderer, and repaints the window
 * behind the page to match.
 */
export function applyNativeAppearance(appearance: Appearance, win: BrowserWindow | null): void {
  custom = activeTheme(appearance)
  nativeTheme.themeSource = custom?.base ?? appearance.mode
  if (win && !win.isDestroyed()) paint(win)
}

/** With mode System, follows Windows switching between light and dark while eNCode runs. */
export function followSystemTheme(getWindow: () => BrowserWindow | null): void {
  nativeTheme.on('updated', () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) paint(win)
  })
}
