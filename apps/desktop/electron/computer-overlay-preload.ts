/**
 * The banner's preload script (see computer-overlay.ts). It gives the page four calls and nothing else: say that it is
 * ready, say how wide it is, say that Stop was pressed, and hear what to draw. Sandboxed, so it imports only Electron
 * and a module with no imports of its own.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_CHANNELS } from './services/computer-overlay-channels'

contextBridge.exposeInMainWorld('encodeOverlay', {
  stop: (): void => ipcRenderer.send(OVERLAY_CHANNELS.stop),
  ready: (): void => ipcRenderer.send(OVERLAY_CHANNELS.ready),
  size: (width: number): void => ipcRenderer.send(OVERLAY_CHANNELS.size, width),
  onState: (callback: (state: unknown) => void): void => {
    ipcRenderer.on(OVERLAY_CHANNELS.state, (_event, state: unknown) => callback(state))
  },
})
