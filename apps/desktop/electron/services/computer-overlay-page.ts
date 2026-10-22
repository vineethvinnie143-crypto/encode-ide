/**
 * The banner shown while the agent uses the computer: a small page and where to put it. It is a window of its own
 * (computer-overlay.ts), always in front and never taking the keyboard, so the person can see at a glance that the
 * agent is at work and stop it with one click. Pure, so the page and its rules are unit tested.
 *
 * The page holds one script, allowed by the hash of its text in the page's Content-Security-Policy, and nothing else
 * can run in it. The script only draws what the main process sends and passes the Stop click back.
 */
import { createHash } from 'node:crypto'
import type { OverlayState } from './computer-control'

export { OVERLAY_CHANNELS } from './computer-overlay-channels'

export const OVERLAY_HEIGHT = 44
export const OVERLAY_MIN_WIDTH = 220
export const OVERLAY_MAX_WIDTH = 640
/** Space between the banner and the bottom of the screen's work area. */
export const OVERLAY_MARGIN = 18

const ELLIPSIS = String.fromCodePoint(0x2026)

/** What the banner says for each state. */
export const OVERLAY_TEXT: Record<OverlayState['mode'], string> = {
  using: 'eNCode is using your computer',
  waiting: 'eNCode is waiting for you',
  stopping: `Stopping${ELLIPSIS}`,
}

const STYLE = `
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; -webkit-user-select: none; cursor: default; }
body { display: flex; align-items: center; justify-content: center; font: 13px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; letter-spacing: 0.005em; }
#pill { display: inline-flex; align-items: center; gap: 12px; height: ${OVERLAY_HEIGHT - 2}px; box-sizing: border-box; padding: 0 6px 0 16px; border-radius: 999px; background: rgb(22 22 26 / 0.96); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1); color: rgb(255 255 255 / 0.93); white-space: nowrap; }
#dot { width: 8px; height: 8px; border-radius: 50%; background: #4f8cff; flex: none; animation: pulse 1.8s ease-out infinite; }
body[data-mode="waiting"] #dot { background: #e0a73a; animation: none; }
body[data-mode="stopping"] #dot { background: #8a8a93; animation: none; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgb(79 140 255 / 0.55); } 70%, 100% { box-shadow: 0 0 0 7px rgb(79 140 255 / 0); } }
@media (prefers-reduced-motion: reduce) { #dot { animation: none; } }
#hint { color: rgb(255 255 255 / 0.5); font-size: 12px; }
#hint[hidden] { display: none; }
#stop { appearance: none; border: 0; margin: 0; height: 28px; padding: 0 14px; border-radius: 999px; background: rgb(255 255 255 / 0.12); color: inherit; font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer; }
#stop:hover:not(:disabled) { background: rgb(255 255 255 / 0.22); }
#stop:focus-visible { outline: 2px solid #4f8cff; outline-offset: 1px; }
#stop:disabled { opacity: 0.5; cursor: default; }
`.trim()

/** The only script the page runs. It reads `window.encodeOverlay`, which the banner's preload script provides. */
const SCRIPT = `
(function () {
  var bridge = window.encodeOverlay;
  var pill = document.getElementById('pill');
  var text = document.getElementById('text');
  var hint = document.getElementById('hint');
  var stop = document.getElementById('stop');
  var TEXT = ${JSON.stringify(OVERLAY_TEXT)};
  stop.addEventListener('click', function () { bridge.stop(); });
  function render(state) {
    document.body.setAttribute('data-mode', state.mode);
    text.textContent = TEXT[state.mode] || TEXT.using;
    hint.textContent = state.shortcut || '';
    hint.hidden = !state.shortcut;
    stop.disabled = state.mode === 'stopping';
    bridge.size(Math.ceil(pill.getBoundingClientRect().width));
  }
  bridge.onState(render);
  bridge.ready();
})();
`.trim()

/** The text of the page, with the policy that lets exactly this script run. */
export function overlayPage(): string {
  const hash = createHash('sha256').update(SCRIPT, 'utf8').digest('base64')
  const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'`
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<title>eNCode</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body data-mode="using">',
    '<div id="pill" role="status" aria-live="polite"><span id="dot"></span><span id="text"></span><span id="hint" hidden></span><button id="stop" type="button">Stop</button></div>',
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}

export const overlayUrl = (): string => `data:text/html;charset=utf-8,${encodeURIComponent(overlayPage())}`

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

/** The window for a banner `contentWidth` wide: centred at the bottom of the work area, clear of the taskbar. */
export function overlayBounds(workArea: Rectangle, contentWidth: number): Rectangle {
  const width = Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_MIN_WIDTH, Math.round(Number.isFinite(contentWidth) ? contentWidth : OVERLAY_MIN_WIDTH))) + 2
  const fitted = Math.min(width, workArea.width)
  return {
    x: Math.round(workArea.x + (workArea.width - fitted) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - OVERLAY_MARGIN),
    width: fitted,
    height: OVERLAY_HEIGHT,
  }
}
