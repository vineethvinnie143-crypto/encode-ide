import type { ForgeApi } from '@shared/types'

/**
 * Typed handle on the preload bridge. Fails loudly if the renderer is opened
 * outside Electron (e.g. the raw Vite dev URL in a normal browser).
 */
export const api: ForgeApi = (() => {
  const bridge = (window as Window & { eNCode?: ForgeApi }).eNCode
  if (!bridge) {
    throw new Error('eNCode bridge is unavailable — run the app through Electron, not a plain browser tab.')
  }
  return bridge
})()
