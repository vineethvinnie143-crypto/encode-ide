# 0010. A sandboxed renderer that only the app's page can use

- Status: Accepted
- Date: 2026-10-21

## Context

The preload bridge (`window.eNCode`) can read and write workspace files, run commands and
start agents. Anything that can call it effectively has code execution. Forge had three gaps:

- The renderer ran with `sandbox: false`.
- IPC handlers accepted calls from any frame.
- `VITE_DEV_SERVER_URL` was honored by packaged builds, so an environment variable could
  point an installed app at another page that then held the full bridge.

## Decision

- **Sandboxed renderer.** The main window's renderer runs with `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false` and no webview tag. The preload only
  bridges IPC and needs no Node.
- **One trusted page.** Every IPC handler is registered through `handle()` in
  `electron/ipc.ts`, which checks the sender before running anything. The sender must be:
  - the top frame of the main window (not a child frame);
  - on the bundled `app://renderer/` page, or on the dev server's origin in an unpackaged
    build.

  Anything else is refused with an error that names the channel.
- **Dev server in development only.** `VITE_DEV_SERVER_URL` is ignored when the app is
  packaged, and the dev server is matched by origin, not by prefix.
- **Navigation stays home.** Navigation away from the app's page is cancelled. `window.open`
  is denied, and http(s) links open in the system browser.
- **CSP.** The renderer's Content-Security-Policy allows scripts only from the app itself,
  with no inline script and no eval. Model output passes through the hand-written markdown
  renderer, which escapes everything and emits only an allow-list of tags, and of link
  protocols (http, https, mailto).
- **Browser panel.** It is an iframe on another origin. It gets no preload and cannot call
  IPC.

## Consequences

- A page in the browser panel, or a page the window is navigated to, gets nothing from the
  main process.
- New IPC must go through `handle()`, never `ipcMain.handle` or `ipcMain.on` directly.
- Still open, and tracked in the threat model:
  - IPC arguments are type-checked by TypeScript only, not validated at runtime.
  - The CSP's `connect-src` is broader than a packaged build needs.
  - Electron fuses (RunAsNode, Node options, inspect arguments, asar integrity) are not set
    until packaging work in M6.
