/**
 * The messages between the main process and the banner (computer-overlay.ts). Alone in a module, with nothing to
 * import, because the banner's preload script is sandboxed and can load nothing but Electron.
 */
export const OVERLAY_CHANNELS = {
  /** main to page: the OverlayState to draw. */
  state: 'computer-overlay:state',
  /** page to main: draw me, I am ready. */
  ready: 'computer-overlay:ready',
  /** page to main: the Stop button was pressed. */
  stop: 'computer-overlay:stop',
  /** page to main: the width of what is drawn, in pixels, so the window can be as wide as the banner. */
  size: 'computer-overlay:size',
} as const
