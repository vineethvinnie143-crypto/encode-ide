/**
 * A small Chrome DevTools Protocol client for the editor's browser tests:
 * launches a Chromium-based browser (headless), opens a page and offers the
 * handful of calls the tests need. Node 22's built-in WebSocket does the
 * transport; nothing is installed.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The browser to test in: ENCODE_BROWSER, else the first Chromium-based one found. */
export function findBrowser() {
  if (process.env.ENCODE_BROWSER) return process.env.ENCODE_BROWSER
  const candidates = []
  const playwright = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  try {
    for (const entry of fs.readdirSync(playwright)) {
      if (entry.startsWith('chromium-')) candidates.push(path.join(playwright, entry, 'chrome-linux', 'chrome'))
    }
  } catch {
    /* no playwright browsers here */
  }
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  )
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('No Chromium-based browser found. Set ENCODE_BROWSER to its executable.')
  return found
}

export async function launch({ width = 1200, height = 800 } = {}) {
  const executable = findBrowser()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-browser-test-'))
  const port = 9300 + Math.floor(Math.random() * 500)
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      '--font-render-hinting=none',
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let target
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(100)
  }
  if (!target) {
    child.kill()
    throw new Error(`Could not reach ${executable} on port ${port}`)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const events = []
  const waiters = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`))
      else resolve(message.result)
      return
    }
    if (message.method) {
      events.push(message)
      for (const waiter of waiters.splice(0)) waiter(message)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const messageId = ++id
      pending.set(messageId, { resolve, reject })
      ws.send(JSON.stringify({ id: messageId, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  // A page in a headless browser has no focus of its own; without this its focus and blur events never fire.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const errors = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    }
    if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'warning')) {
      errors.push(`console.${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
  })

  const modifiers = (options = {}) => (options.alt ? 1 : 0) | (options.ctrl ? 2 : 0) | (options.meta ? 4 : 0) | (options.shift ? 8 : 0)

  const page = {
    errors,
    send,
    async goto(url) {
      const loaded = new Promise((resolve) => {
        const check = (message) => {
          if (message.method === 'Page.loadEventFired') resolve()
          else waiters.push(check)
        }
        waiters.push(check)
      })
      await send('Page.navigate', { url })
      await loaded
    },
    /** Evaluates an expression (or a function called with args) in the page and returns its value. */
    async eval(expression, ...args) {
      const source = typeof expression === 'function' ? `(${expression})(...${JSON.stringify(args)})` : expression
      const result = await send('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      }
      return result.result.value
    },
    async insertText(text) {
      await send('Input.insertText', { text })
    },
    /** Presses and releases a key. `text` is what the key types, if anything. */
    async key(key, options = {}) {
      const known = SYMBOLS[key]
      const code = options.code ?? known?.code ?? (key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : '') : key)
      // A character typed with Shift held, on a US keyboard: capital letters and the shifted symbols.
      const shifted = options.shift || (options.text && (known?.shift || (/[A-Z]/.test(key) && key.length === 1)))
      const common = {
        key,
        code,
        modifiers: modifiers({ ...options, shift: shifted }),
        windowsVirtualKeyCode: options.keyCode ?? known?.keyCode ?? keyCodeOf(key),
      }
      await send('Input.dispatchKeyEvent', { type: options.text ? 'keyDown' : 'rawKeyDown', ...common, text: options.text, unmodifiedText: options.text })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    },
    /** A native editing command through the keyboard path, such as "copy", "cut" or "paste". */
    async command(name) {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: name === 'paste' ? 'v' : name === 'cut' ? 'x' : 'c',
        code: name === 'paste' ? 'KeyV' : name === 'cut' ? 'KeyX' : 'KeyC',
        modifiers: 2,
        windowsVirtualKeyCode: name === 'paste' ? 86 : name === 'cut' ? 88 : 67,
        commands: [name],
      })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
    },
    /** Sets the IME's composition string, as the system's input method does while it is open. */
    async ime(text, start = text.length, end = text.length) {
      await send('Input.imeSetComposition', { text, selectionStart: start, selectionEnd: end })
    },
    async mouse(type, x, y, options = {}) {
      // A move has no button of its own; the buttons held are given with `buttons` (a drag holds the left one).
      const button = type === 'mouseMoved' ? 'none' : (options.button ?? 'left')
      const held = type === 'mousePressed' ? { left: 1, right: 2, middle: 4 }[button] : 0
      await send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button,
        buttons: options.buttons ?? held,
        clickCount: options.count ?? (type === 'mouseMoved' ? 0 : 1),
        modifiers: modifiers(options),
      })
    },
    /** A click; `count` 2 and 3 make the double and triple click. */
    async click(x, y, options = {}) {
      await page.mouse('mouseMoved', x, y, options)
      for (let n = 1; n <= (options.count ?? 1); n++) {
        await page.mouse('mousePressed', x, y, { ...options, count: n })
        await page.mouse('mouseReleased', x, y, { ...options, count: n })
      }
    },
    async drag(from, to, options = {}) {
      await page.mouse('mouseMoved', from.x, from.y, options)
      await page.mouse('mousePressed', from.x, from.y, options)
      const steps = 6
      for (let step = 1; step <= steps; step++) {
        await page.mouse('mouseMoved', from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, { ...options, buttons: 1 })
      }
      await page.mouse('mouseReleased', to.x, to.y, options)
    },
    async wheel(x, y, deltaY, deltaX = 0) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    },
    async screenshot(file, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip })
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
    },
    /** Waits for two frames, which is when the editor has drawn what it was asked to. */
    async frames(count = 2) {
      await page.eval(`new Promise((resolve) => { let n = ${count}; const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick) })`)
    },
    async close() {
      try {
        await send('Browser.close')
      } catch {
        /* already gone */
      }
      ws.close()
      child.kill()
      try {
        fs.rmSync(profile, { recursive: true, force: true })
      } catch {
        /* the browser may still hold files for a moment */
      }
    },
  }
  return page
}

/** Symbols on a US keyboard: the key's code, its virtual key code and whether Shift types it. */
const SYMBOLS = {
  ' ': { code: 'Space', keyCode: 32 },
  '!': { code: 'Digit1', keyCode: 49, shift: true },
  '@': { code: 'Digit2', keyCode: 50, shift: true },
  '#': { code: 'Digit3', keyCode: 51, shift: true },
  $: { code: 'Digit4', keyCode: 52, shift: true },
  '%': { code: 'Digit5', keyCode: 53, shift: true },
  '^': { code: 'Digit6', keyCode: 54, shift: true },
  '&': { code: 'Digit7', keyCode: 55, shift: true },
  '*': { code: 'Digit8', keyCode: 56, shift: true },
  '(': { code: 'Digit9', keyCode: 57, shift: true },
  ')': { code: 'Digit0', keyCode: 48, shift: true },
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189, shift: true },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187, shift: true },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219, shift: true },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221, shift: true },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220, shift: true },
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186, shift: true },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222, shift: true },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188, shift: true },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190, shift: true },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191, shift: true },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192, shift: true },
}

const KEY_CODES = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  F3: 114,
}

function keyCodeOf(key) {
  if (KEY_CODES[key]) return KEY_CODES[key]
  if (key.length === 1) return key.toUpperCase().charCodeAt(0)
  return 0
}
