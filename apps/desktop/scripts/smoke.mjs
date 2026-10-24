/**
 * End-to-end smoke test driven over the Chrome DevTools Protocol.
 *
 * pnpm e2e (scripts/e2e.mjs) runs it in a throwaway sandbox. By hand:
 *
 *   1. start Electron:  .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
 *   2. run:             node scripts/smoke.mjs <workspace-to-open>
 *
 * ENCODE_DEBUG_PORT and ENCODE_FAKE_PROVIDER_PORT override the ports (9222, 8787). ENCODE_SMOKE_VERBOSE=1 lets the
 * fake provider print what it is asked.
 *
 * Exercises the in-house editor (what it draws, typing, save and undo round-trip, find,
 * quick open), the offline demo agent, then a real streaming provider via
 * scripts/fake-provider.mjs including approvals, diffs and command execution, and
 * last the appearance settings, capturing dark and light at 1280 x 800 and 1920 x 1080.
 * Screenshots land in ./screenshots.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect, findPage, sleep } from './cdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.ENCODE_DEBUG_PORT || '9222'
const providerPort = Number(process.env.ENCODE_FAKE_PROVIDER_PORT || 8787)
if (!process.argv[2]) {
  // The smoke edits the workspace it opens, so it never defaults to the fixture in the repository.
  console.error('usage: node scripts/smoke.mjs <copy-of-test/fixtures/demo-project>')
  process.exit(2)
}
const demoPath = path.resolve(process.argv[2]).replace(/\\/g, '/')
const shotsDir = path.join(root, 'screenshots')
await fs.mkdir(shotsDir, { recursive: true })

const { target, ws, send, evaluate, waitFor, errors } = await connect(port)

/** Thrown when the parts ENCODE_SMOKE_ONLY asked for have passed: the run ends there. */
class SmokePartsDone extends Error {}
console.log('[smoke] target:', target.url)

/**
 * Evaluates in the Browser tab's page, a DevTools target of its own (a webview), that has loaded `url`. A page that
 * did not load has no target at that address.
 */
async function evaluateInFrame(url, expression, timeoutMs = 10000) {
  const started = Date.now()
  let seen = []
  while (Date.now() - started < timeoutMs) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    seen = targets.filter((target) => target.type === 'webview' || target.type === 'iframe').map((target) => target.url)
    const frame = targets.find((target) => (target.type === 'webview' || target.type === 'iframe') && target.url === url && target.webSocketDebuggerUrl)
    if (frame) {
      try {
        return await evaluateOn(frame.webSocketDebuggerUrl, expression)
      } catch (error) {
        // A page's target is listed as soon as it starts loading, before it has a context to run in, and a load can
        // replace the context under a call: both mean the page is not there yet.
        if (!/Cannot find default execution context|Execution context was destroyed|closed before it answered/.test(error.message)) throw error
      }
    }
    await sleep(250)
  }
  throw new Error(`The Browser tab did not show ${url}. Frames: ${seen.join(', ') || 'none'}`)
}

/**
 * Evaluates in a DevTools target of its own, over a socket of its own. A target that goes away before it answers,
 * or never answers, is an error rather than a hang.
 */
async function evaluateOn(webSocketDebuggerUrl, expression, timeoutMs = 30000) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let timer
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The target did not answer within ${timeoutMs} ms`)), timeoutMs)
      socket.addEventListener('close', () => reject(new Error('The target closed before it answered')), { once: true })
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== 1) return
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result?.result?.value)
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, userGesture: true } }))
    })
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(path.join(shotsDir, name), Buffer.from(data, 'base64'))
  console.log('[smoke] screenshot', name)
}

async function click(selector, text) {
  return evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const node = ${text ? `nodes.find((item) => (item.textContent || '').includes(${JSON.stringify(text)}))` : 'nodes[0]'}
    if (!node) return false
    node.click()
    return true
  })()`)
}

async function typeInto(selector, value) {
  return evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function selectOption(selector, value) {
  return evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
}

/** The lines the editor has drawn, top to bottom. They are pooled, so DOM order is not line order. */
const RENDERED_LINES = `[...document.querySelectorAll('.enc-line')]
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map((line) => line.textContent)`

const KEY_CODES = { Backspace: 8, End: 35, Home: 36, Insert: 45, Delete: 46, Escape: 27, Enter: 13, Tab: 9, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, F2: 113, F8: 119, F12: 123, '.': 190, '[': 219, ']': 221, '\\': 220 }
/** Keys whose `key` is not their name. */
const KEY_VALUES = { Space: ' ' }
/** Keys whose physical key is not `Key` and their letter. */
const CODE_NAMES = { '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash' }

/** A key chord through the browser's own input path, to whatever has focus. */
async function pressKey(key, { ctrl = false, shift = false, alt = false } = {}) {
  const common = {
    key: KEY_VALUES[key] ?? key,
    code: CODE_NAMES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    modifiers: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0),
    windowsVirtualKeyCode: KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0),
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** Opens the Settings page (the rail's Settings button) on a section, by its title in the page's navigation. */
async function openSettings(section) {
  if (!(await evaluate("!!document.querySelector('.settings-page')"))) {
    if (!(await click('.rail-btn[aria-label="Settings"]'))) throw new Error('Settings button not found')
    await waitFor("!!document.querySelector('.settings-page .settings-nav-item')", 8000, 'the Settings page')
  }
  if (!section) return
  if (!(await click('.settings-nav-item', section))) throw new Error(`no ${section} in the Settings navigation`)
  await waitFor(`document.querySelector('.settings-heading')?.textContent === ${JSON.stringify(section)}`, 6000, `Settings > ${section}`)
}

/** Back to the app from the Settings page. */
async function closeSettings() {
  if (!(await click('.settings-back'))) throw new Error('no way back from the Settings page')
  await waitFor("!document.querySelector('.settings-page')", 4000, 'the Settings page closed')
}

/** A setting kept as it is made: true once the main process has it. */
async function settingIs(expression, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(`window.eNCode.settings.get().then((settings) => Boolean(${expression}))`)) return
    await sleep(100)
  }
  throw new Error(`${label}: not saved`)
}

async function focusEditor() {
  if (!(await evaluate("(() => { const input = document.querySelector('.enc-input'); input?.focus(); return Boolean(input) })()"))) {
    throw new Error('The editor is not on screen')
  }
}

/**
 * Waits for the agent to finish, approving every approval card on the way.
 * Returns the approval cards it saw ({ title, reason, review, detail }).
 * options.keyboard approves with Enter; options.whileWaiting runs once, while the first card shows;
 * options.deny(card) answers a card with Deny instead.
 */
async function driveAgent(label, timeoutMs = 120000, options = {}) {
  const approvals = []
  const deadline = Date.now() + timeoutMs
  let status = ''
  while (Date.now() < deadline) {
    status = await evaluate("document.querySelector('.chat-panel')?.dataset.status ?? ''")
    if (status === 'done') return approvals
    if (status === 'error') {
      const detail = await evaluate(
        "[...document.querySelectorAll('.problem-card .problem-text')].map((node) => node.textContent).join('\\n')",
      )
      throw new Error(`${label} agent errored: ${detail}`)
    }
    const card = await evaluate(`(() => {
      const card = document.querySelector('.approval-card')
      if (!card) return null
      return {
        title: card.querySelector('.approval-head')?.textContent ?? '',
        reason: card.querySelector('.approval-reason')?.textContent ?? '',
        review: card.querySelector('.approval-review')?.textContent ?? '',
        detail: card.querySelector('.approval-detail, .approval-prose')?.textContent ?? '',
      }
    })()`)
    if (card) {
      approvals.push(card)
      await sleep(250)
      await screenshot(`${label}-approval-${approvals.length}.png`)
      if (options.whileWaiting && approvals.length === 1) await options.whileWaiting()
      if (options.deny?.(card)) {
        await click('.approval-card .btn', 'Deny')
      } else if (options.keyboard) {
        // Enter approves while nothing is being typed.
        await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
      } else {
        await click('.approval-card .btn.primary')
      }
      await sleep(350)
      continue
    }
    await sleep(300)
  }
  throw new Error(`${label} agent did not finish (status=${status})`)
}

let provider = null

async function ensureFakeProvider() {
  try {
    const response = await fetch(`http://127.0.0.1:${providerPort}/health`)
    if (response.ok) return
  } catch {
    /* not running */
  }
  provider = spawn(process.execPath, [path.join(root, 'scripts', 'fake-provider.mjs')], {
    env: { ...process.env, FAKE_PROVIDER_PORT: String(providerPort) },
    // ENCODE_SMOKE_VERBOSE=1 shows what the fake provider was asked, which is what a failing phase needs.
    stdio: process.env.ENCODE_SMOKE_VERBOSE ? 'inherit' : 'ignore',
    windowsHide: true,
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${providerPort}/health`)
      if (response.ok) {
        console.log('[smoke] fake provider started')
        return
      }
    } catch {
      /* keep waiting */
    }
    await sleep(250)
  }
  throw new Error('Fake provider failed to start')
}

/**
 * Stores a key for the mock profile through the real IPC and safeStorage, and
 * checks it reaches neither the renderer nor, unsealed, the disk. Returns it.
 */
async function checkKeyStorage() {
  const secret = `sk-smoke-${Date.now().toString(36)}`
  const settings = await evaluate(`window.eNCode.settings.setProfileKey('local-mock', ${JSON.stringify(secret)})`)
  const profile = settings.profiles.find((entry) => entry.id === 'local-mock')
  console.log('[smoke] key storage:', JSON.stringify(settings.keyStorage))
  if (!profile?.hasApiKey) throw new Error('The key was not stored')
  if (JSON.stringify(settings).includes(secret)) throw new Error('Settings handed the key to the renderer')

  const profileDir = process.env.ENCODE_USER_DATA_DIR
  if (!profileDir) {
    console.log('[smoke] note: ENCODE_USER_DATA_DIR is not set, so the settings file was not inspected')
    return secret
  }
  const disk = await fs.readFile(path.join(profileDir, 'eNCode-settings.json'), 'utf8')
  const stored = JSON.parse(disk).profiles.find((entry) => entry.id === 'local-mock')?.apiKeyEnc
  if (disk.includes(secret) || disk.includes('plain:')) throw new Error('The settings file holds a readable key')
  if (settings.keyStorage.mode === 'keychain' && !stored?.startsWith('enc:')) {
    throw new Error('The keychain is available but the key was not sealed on disk')
  }
  if (settings.keyStorage.mode === 'session' && stored !== undefined) {
    throw new Error('Without a keychain the key must stay out of the settings file')
  }
  return secret
}

/**
 * The session file of the earlier build, which e2e.mjs seeds in the profile, comes into the session
 * store at the first start, with its transcript, and is set aside so it is not imported twice.
 */
async function checkLegacyImport() {
  const profileDir = process.env.ENCODE_USER_DATA_DIR
  if (!profileDir) {
    console.log('[smoke] note: ENCODE_USER_DATA_DIR is not set, so the import of earlier sessions was not checked')
    return
  }
  const sessions = await evaluate('window.eNCode.agent.sessions()')
  const earlier = sessions.find((session) => session.id === 'legacy-smoke')
  if (!earlier || earlier.title !== 'An earlier session' || earlier.entryCount !== 2) {
    throw new Error(`The session of the earlier build was not imported: ${JSON.stringify(earlier)}`)
  }
  const history = await evaluate("window.eNCode.agent.history('legacy-smoke')")
  if (history.entries.map((entry) => entry.kind).join() !== 'user,assistant' || history.entries[1].text !== 'It adds two numbers.') {
    throw new Error('The imported session lost its transcript')
  }
  const files = await fs.readdir(profileDir)
  if (files.includes('eNCode-sessions.json') || !files.includes('eNCode-sessions.json.migrated')) {
    throw new Error('The session file of the earlier build was not set aside after the import')
  }
  console.log('[smoke] earlier sessions imported:', JSON.stringify({ title: earlier.title, entries: earlier.entryCount }))
}

/**
 * What the model was sent in its latest request: Claude Code's tool names, and the project's
 * instructions (ENCODE.md) as a reminder in the conversation rather than in the system prompt.
 */
async function checkRequestContract(marker) {
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const offered = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task']
  const missing = offered.filter((name) => !request.tools.includes(name))
  if (missing.length) throw new Error(`The model was not offered ${missing.join(', ')}; it was offered ${request.tools.join(', ')}`)
  const legacy = request.tools.filter((name) => ['run_command', 'write_file', 'read_file', 'pwsh', 'web_fetch'].includes(name))
  if (legacy.length) throw new Error(`The model was offered tools of the earlier build: ${legacy.join(', ')}`)
  const text = (message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  const system = request.messages.filter((message) => message.role === 'system').map(text).join('\n')
  const users = request.messages.filter((message) => message.role === 'user').map(text).join('\n')
  if (!users.includes(marker)) throw new Error('The project instructions (ENCODE.md) did not reach the model')
  if (system.includes(marker)) throw new Error('The project instructions are in the system prompt, which must stay the same from turn to turn')
  if (!users.includes('<system-reminder>')) throw new Error('The environment did not reach the model as a reminder')
  console.log('[smoke] request contract:', JSON.stringify({ tools: request.tools.length, instructions: true }))
}

/** Sessions are plain files that only the user can read, and a key never rests in them. */
async function checkSessionFiles(secret) {
  const profileDir = process.env.ENCODE_USER_DATA_DIR
  if (!profileDir) return
  const dir = path.join(profileDir, 'sessions')
  const names = await fs.readdir(dir)
  const logs = names.filter((name) => name.endsWith('.jsonl'))
  if (!logs.length) throw new Error('No session log was written')
  let ran = false
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8')
    if (text.includes(secret)) throw new Error(`${name} holds the API key`)
    if (text.includes('provider-command-ok')) ran = true
    if (process.platform !== 'win32' && (await fs.stat(path.join(dir, name))).mode & 0o077) throw new Error(`${name} can be read by other users`)
  }
  if (process.platform !== 'win32' && (await fs.stat(dir)).mode & 0o077) throw new Error('The sessions folder can be read by other users')
  if (!ran) throw new Error('The command the agent ran is not in any session log')
  console.log('[smoke] session logs:', JSON.stringify({ logs: logs.length }))
}

/**
 * A new install: "Connect a model" shows by itself and is not dismissed by a stray click. The free models need the
 * internet, so only their form is looked at; a key of one's own is connected to the local provider, the way a person
 * would connect any server, and the model menu and the Roles settings are walked through.
 */
async function runFirstStartChecks() {
  console.log('[smoke] --- first start ---')
  await ensureFakeProvider()
  await waitFor("!!document.querySelector('.connect-dialog .connect-option')", 15000, 'the connect dialog on a first start')
  const first = await evaluate('window.eNCode.settings.get()')
  if (first.setupDone !== false) throw new Error(`a new install should not be set up yet: ${JSON.stringify({ setupDone: first.setupDone })}`)
  const choices = await evaluate("[...document.querySelectorAll('.connect-option')].map((node) => node.dataset.choice)")
  if (choices.join() !== 'free,own,demo') throw new Error(`the connect dialog offers ${choices.join()}`)
  await screenshot('01-launch.png')

  // A click beside the dialog does not dismiss it.
  await evaluate("document.querySelector('.ui-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
  await sleep(150)
  if (!(await evaluate("!!document.querySelector('.connect-dialog')"))) throw new Error('a click beside the first-start dialog closed it')

  // The free models: the form, a warning for a key of the wrong kind, and back out with Escape.
  if (!(await click('.connect-option[data-choice="free"]'))) throw new Error('no free-models choice')
  await waitFor("!!document.querySelector('.connect-dialog .key-field input')", 4000, 'the key field')
  await typeInto('.connect-dialog .key-field input', 'sk-proj-not-an-openrouter-key')
  await waitFor("/start with sk-or-/.test(document.querySelector('.connect-dialog')?.textContent ?? '')", 4000, 'the warning for a key of the wrong kind')
  if (!(await evaluate("document.querySelector('.connect-dialog a[href=\"https://openrouter.ai/keys\"]') !== null"))) throw new Error('the free-models form does not say where to get a key')
  if (await evaluate("document.querySelector('.ui-dialog-foot .btn.primary').disabled")) throw new Error('Connect should be possible once a key is typed')
  await pressKey('Escape')
  await waitFor("!!document.querySelector('.connect-option[data-choice=\"demo\"]')", 4000, 'Escape goes back to the choices')
  await screenshot('01-connect.png')

  // A key of one's own, for a server that is not in the list: the local provider.
  if (!(await click('.connect-option[data-choice="own"]'))) throw new Error('no own-key choice')
  await waitFor("!!document.querySelector('#connect-provider')", 4000, 'the provider list')
  if (!(await selectOption('#connect-provider', 'custom'))) throw new Error('no provider list')
  await waitFor("!!document.querySelector('#connect-url')", 4000, 'the address field of a custom provider')
  if (!(await evaluate("document.querySelector('.ui-dialog-foot .btn.primary').disabled"))) throw new Error('Continue should wait for an address and a key')
  await typeInto('#connect-url', `http://127.0.0.1:${providerPort}/v1`)
  await typeInto('.connect-dialog .key-field input', 'smoke-first-start-key')
  await sleep(150)
  await screenshot('01-connect-key.png')
  if (!(await click('.ui-dialog-foot .btn.primary'))) throw new Error('no Continue button')
  await waitFor("!!document.querySelector('.connect-models .connect-model')", 20000, 'the model list of the provider')
  const listed = await evaluate("[...document.querySelectorAll('.connect-model')].map((node) => node.textContent)")
  if (listed.length !== 1 || !listed[0].includes('Mock model') || !listed[0].includes('mock-model')) throw new Error(`the provider lists ${JSON.stringify(listed)}`)
  if (!listed[0].includes('Free')) throw new Error('a model on this computer should be marked free')
  if (!(await evaluate("document.querySelector('.ui-dialog-foot .btn.primary').disabled"))) throw new Error('Use this model should wait for a choice')
  if (!(await click('.connect-model', 'Mock model'))) throw new Error('no model to choose')
  await screenshot('01-connect-models.png')
  if (!(await click('.ui-dialog-foot .btn.primary'))) throw new Error('no Use this model button')
  // The model is asked for a tool call, the way the agent will use it.
  await waitFor("!document.querySelector('.connect-dialog')", 60000, 'the connect dialog closing after the model answered')

  const set = await evaluate('window.eNCode.settings.get()')
  const connection = set.profiles.find((profile) => profile.baseUrl.includes(`:${providerPort}`))
  if (!connection) throw new Error('the connection was not stored')
  if (!set.setupDone) throw new Error('the setup was not finished')
  if (connection.model !== 'mock-model' || !connection.hasApiKey) throw new Error(`the connection is ${JSON.stringify(connection)}`)
  if (JSON.stringify(set.roles.main) !== JSON.stringify([`${connection.id}:mock-model`]) || set.activeProfileId !== connection.id) {
    throw new Error(`the main model is ${JSON.stringify(set.roles)} on ${set.activeProfileId}`)
  }
  if (set.freeOnly !== true) throw new Error('a model on this computer should leave "only free models" on')
  const authorization = (await (await fetch(`http://127.0.0.1:${providerPort}/__last-authorization`)).json()).authorization
  if (authorization !== 'Bearer smoke-first-start-key') throw new Error(`the provider received ${authorization}`)
  const chip = await evaluate("document.querySelector('.model-chip')?.textContent ?? ''")
  if (!chip.includes('mock-model')) throw new Error(`the model chip reads "${chip}"`)
  console.log('[smoke] connected:', JSON.stringify({ id: connection.id, main: set.roles.main }))

  // The model menu: what is in use, search, the offline demo, and the way back to the connect dialog and the Roles.
  if (!(await click('.model-chip'))) throw new Error('no model chip')
  await waitFor("!!document.querySelector('.model-picker .model-picker-item')", 8000, 'the model menu')
  const groups = await evaluate("[...document.querySelectorAll('.model-picker-heading')].map((node) => node.textContent.trim())")
  if (groups[0] !== 'In use') throw new Error(`the model menu starts with ${JSON.stringify(groups)}`)
  const inUse = await evaluate("document.querySelector('.model-picker-item.is-selected')?.dataset.ref")
  if (inUse !== `${connection.id}:mock-model`) throw new Error(`the model in use is ${inUse}`)
  await typeInto('.model-picker-search input', 'no such model anywhere')
  await waitFor("/No model matches/.test(document.querySelector('.model-picker-empty')?.textContent ?? '')", 4000, 'an empty search')
  await typeInto('.model-picker-search input', 'mock')
  await waitFor("document.querySelectorAll('.model-picker-item').length === 1", 4000, 'a search that finds only the model')
  await typeInto('.model-picker-search input', '')
  await screenshot('01-model-menu.png')
  if (!(await click('.model-picker-item[data-ref="demo"]'))) throw new Error('no offline demo in the model menu')
  await waitFor("document.querySelector('.model-chip')?.textContent.includes('Demo')", 8000, 'the demo chosen')
  const demoSettings = await evaluate('window.eNCode.settings.get()')
  if (demoSettings.roles.main !== undefined || demoSettings.profiles.find((profile) => profile.id === demoSettings.activeProfileId)?.kind !== 'demo') {
    throw new Error(`the demo was not chosen: ${JSON.stringify({ roles: demoSettings.roles, active: demoSettings.activeProfileId })}`)
  }

  await click('.model-chip')
  await waitFor("!!document.querySelector('.model-picker-footer')", 8000, 'the model menu')
  if (!(await click('.model-picker-link', 'Connect a model'))) throw new Error('no way to connect another model')
  await waitFor("!!document.querySelector('.connect-dialog .connect-option')", 4000, 'the connect dialog from the model menu')
  if (!(await click('.ui-dialog-foot .btn', 'Cancel'))) throw new Error('no Cancel in the connect dialog')
  await waitFor("!document.querySelector('.connect-dialog')", 4000, 'Cancel closing the dialog')

  await click('.model-chip')
  await waitFor("!!document.querySelector('.model-picker-footer')", 8000, 'the model menu')
  if (!(await click('.model-picker-link', 'Roles'))) throw new Error('no way to the Roles settings')
  await waitFor("!!document.querySelector('.settings-page .settings-roles')", 8000, 'the Roles settings')
  const roles = await evaluate("[...document.querySelectorAll('.role-row')].map((node) => node.dataset.role)")
  if (roles.join() !== 'main,explore,planner,reviewer,summarizer,utility,inline') throw new Error(`the Roles settings list ${roles.join()}`)
  await waitFor("document.querySelectorAll('[data-section=\"status\"] .status-row').length >= 1", 30000, 'the connections report')
  const report = await evaluate("document.querySelector('[data-section=\"status\"]').textContent")
  if (!report.includes('Custom')) throw new Error(`the connections report reads "${report}"`)
  if ((await evaluate("document.querySelector('#free-only').getAttribute('aria-checked')")) !== 'true') throw new Error('"Only use free models" should be on')
  await screenshot('01-roles.png')
  await closeSettings()

  // Back to a plain install for the checks that follow.
  const keep = demoSettings.profiles.filter((profile) => profile.id !== connection.id)
  await evaluate(`window.eNCode.settings.save({ profiles: ${JSON.stringify(keep)}, roles: {}, activeProfileId: ${JSON.stringify(demoSettings.activeProfileId)} })`)
}

/** The test provider as the model of every role, with the gates the checks turn on one at a time switched off. */
async function useTestProvider() {
  await ensureFakeProvider()
  const current = await evaluate('window.eNCode.settings.get()')
  const profiles = current.profiles.filter((profile) => profile.id !== 'local-mock')
  profiles.push({
    id: 'local-mock',
    name: 'Local mock provider',
    kind: 'custom',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    model: 'mock-model',
  })
  await evaluate(`window.eNCode.settings.save({
    profiles: ${JSON.stringify(profiles)},
    activeProfileId: 'local-mock',
    policy: 'workspace-write',
    maxSteps: 12,
    // Off until runCheckGateChecks: a check asks to run npm test after every code edit, which the other steps do not expect.
    checkGate: 'off',
    // Off until runReviewGateChecks: the mock model needs the full guide, so the Reviewer would read every change.
    reviewWork: 'off',
    // Off until runSecondLookChecks and runConventionsChecks: each would take a model call the other steps do not expect.
    askAgain: 'off',
    learnConventions: 'off',
    // Off until runSmallerModelChecks: the mock model is no strong one, so its first change in a request would wait for a plan.
    helpSmaller: 'off',
    offerStronger: 'off'
  })`)
}

async function runProviderPhase() {
  console.log('[smoke] --- provider phase (local OpenAI-compatible server) ---')
  await ensureFakeProvider()

  await evaluate('window.eNCode.agent.reset()')
  await evaluate("window.eNCode.workspace.delete('provider-check.txt').catch(() => null)")
  // Project instructions: the next conversation starts with them.
  const marker = `smoke-instructions-${Date.now().toString(36)}`
  await evaluate(`window.eNCode.workspace.write('ENCODE.md', ${JSON.stringify(`# Smoke project\n\nAlways mention ${marker}.\n`)})`)
  await useTestProvider()
  const secret = await checkKeyStorage()

  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after provider config')

  await typeInto('.composer-input', 'Create provider-check.txt, then run echo to verify the shell.')
  await sleep(350)
  await click('.composer-send')

  // Workspace Write: the write runs unasked, the command asks and the card shows the exact command.
  const approvals = await driveAgent('10-provider', 120000, { keyboard: true })
  console.log('[smoke] provider approvals:', JSON.stringify(approvals))
  if (approvals.length !== 1) throw new Error(`Expected 1 approval prompt (the command), saw ${approvals.length}`)
  if (!approvals[0].detail.includes('echo provider-command-ok')) {
    throw new Error('The command approval card does not show the command')
  }

  await openWorkLogs()
  await evaluate(`(() => {
    document.querySelectorAll('.tool-row:not(.tool-group)').forEach((row) => {
      if (!row.querySelector('.tool-row-body')) row.querySelector('.tool-row-toggle')?.click()
    })
    return true
  })()`)
  await sleep(400)

  const fileContent = await evaluate(
    "window.eNCode.workspace.read('provider-check.txt').then((file) => file.content, (error) => 'ERR: ' + error.message)",
  )
  const stats = await evaluate(`(() => ({
    tools: document.querySelectorAll('.tool-row').length,
    diffs: document.querySelectorAll('.diff-view').length,
    commandOutput: document.body.textContent.includes('provider-command-ok'),
    completion: document.body.textContent.includes('Provider path verified'),
  }))()`)

  console.log('[smoke] provider file:', JSON.stringify(fileContent), 'stats:', JSON.stringify(stats))
  if (!String(fileContent).includes('hello from a real provider stream')) {
    throw new Error('provider-check.txt was not written with the streamed content')
  }
  if (stats.diffs < 1) throw new Error('No diff rendered for the provider-driven write')
  if (!stats.tools || !stats.commandOutput) throw new Error('Bash output missing')
  if (!stats.completion) throw new Error('completion summary missing')

  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-authorization`)).json()
  if (seen.authorization !== `Bearer ${secret}`) throw new Error('The stored key did not reach the provider')
  await checkRequestContract(marker)
  await checkSessionFiles(secret)

  const statsText = await evaluate("document.querySelector('.composer-stats')?.textContent ?? ''")
  console.log('[smoke] usage stats:', JSON.stringify(statsText.trim()))
  if (!statsText.includes('cache hit')) console.log('[smoke] note: no usage frame from provider')

  await screenshot('11-provider-agent.png')

  // A follow-up in the same session. The finished task's completion call needs a result too,
  // or a strict provider (the fake one included) refuses the whole transcript.
  await sendPrompt('[scenario:follow-up] One more thing.')
  await driveAgent('11-follow-up')

  // Session manager: create, rename, remove and persisted history.
  const sessionCheck = await evaluate(`(async () => {
    const sessions = await window.eNCode.agent.sessions()
    const first = sessions[0]
    const history = await window.eNCode.agent.history(first.id)
    const created = await window.eNCode.agent.createSession()
    await window.eNCode.agent.rename(created.id, 'smoke session')
    const renamed = (await window.eNCode.agent.sessions()).find((session) => session.id === created.id)
    const forked = await window.eNCode.agent.fork(created.id)
    const afterFork = await window.eNCode.agent.sessions()
    await window.eNCode.agent.remove(created.id)
    await window.eNCode.agent.remove(forked.id)
    const after = await window.eNCode.agent.sessions()
    return {
      count: sessions.length,
      entries: history.entries.length,
      renamed: renamed ? renamed.title : null,
      forked: Boolean(forked.id),
      after: after.length,
    }
  })()`)
  console.log('[smoke] sessions:', JSON.stringify(sessionCheck))
  if (!sessionCheck.count || sessionCheck.entries < 1) throw new Error('session history was not persisted')
  if (sessionCheck.renamed !== 'smoke session') throw new Error('session rename failed')
  if (!sessionCheck.forked) throw new Error('session fork failed')
  if (sessionCheck.after >= sessionCheck.count + 1) throw new Error('session remove failed')

  // Goals: set, read back, clear.
  const goalCheck = await evaluate(`(async () => {
    const sessions = await window.eNCode.agent.sessions()
    const id = sessions[0].id
    const now = Date.now()
    await window.eNCode.agent.setGoal(id, { text: 'smoke goal', status: 'active', rounds: 0, createdAt: now, updatedAt: now })
    const goal = await window.eNCode.agent.goal(id)
    await window.eNCode.agent.setGoal(id, { ...goal, status: 'complete' })
    const completed = await window.eNCode.agent.goal(id)
    await window.eNCode.agent.setGoal(id, null)
    const cleared = await window.eNCode.agent.goal(id)
    return { text: goal && goal.text, status: completed && completed.status, cleared: cleared === null }
  })()`)
  console.log('[smoke] goal:', JSON.stringify(goalCheck))
  if (goalCheck.text !== 'smoke goal') throw new Error('goal create failed')
  if (goalCheck.status !== 'complete') throw new Error('goal update failed')
  if (!goalCheck.cleared) throw new Error('goal delete failed')

  // Todos, schedules, skills and jobs surfaces.
  const featureCheck = await evaluate(`(async () => {
    const sessions = await window.eNCode.agent.sessions()
    const id = sessions[0].id
    await window.eNCode.agent.setTodos(id, [{ id: 't1', text: 'write tests', status: 'in_progress' }])
    const todos = await window.eNCode.agent.todos(id)
    await window.eNCode.agent.setTodos(id, [])

    const schedule = await window.eNCode.schedules.create({ prompt: 'smoke schedule', sessionId: id, afterSeconds: 3600 })
    const schedules = await window.eNCode.schedules.list()
    await window.eNCode.schedules.remove(schedule.id)
    const remaining = await window.eNCode.schedules.list()

    const skill = await window.eNCode.skills.create('smoke-skill', 'created by the smoke test')
    const skills = await window.eNCode.skills.list()
    const skillText = await window.eNCode.skills.read('smoke-skill')

    const jobs = await window.eNCode.jobs.list()
    const plan = await window.eNCode.agent.plan(id)

    return {
      todoCount: todos.length,
      todoStatus: todos[0] && todos[0].status,
      scheduled: schedules.length,
      remaining: remaining.length,
      skill: skill.name,
      skillListed: skills.some((entry) => entry.name === 'smoke-skill'),
      skillText: skillText.includes('smoke-skill'),
      jobsArray: Array.isArray(jobs),
      planNull: plan === null,
    }
  })()`)
  console.log('[smoke] features:', JSON.stringify(featureCheck))
  if (featureCheck.todoCount !== 1 || featureCheck.todoStatus !== 'in_progress') throw new Error('TodoWrite surface failed')
  if (featureCheck.scheduled < 1 || featureCheck.remaining !== featureCheck.scheduled - 1) {
    throw new Error('schedule create/remove failed')
  }
  if (!featureCheck.skillListed || !featureCheck.skillText) throw new Error('skill create/read failed')
  if (!featureCheck.jobsArray || !featureCheck.planNull) throw new Error('jobs/plan surface failed')

  await runMentionChecks()
  await runWideLineChecks()
  await runRemoteChecks()
  await runCheckGateChecks()
  await runReviewGateChecks()
  await runSecondLookChecks()
  await runConventionsChecks()
  await runSmallerModelChecks()
  await runModelTestChecks()
  await runStopChecks()
  await runAttachChecks()
  await runSteerChecks()
  await runEffortChecks()
  await runSubagentChecks()
  await runParityChecks()
  await runProblemChecks()
  await runWebChecks()
  await runAgentBrowserChecks()
  await runSideChatChecks()
  await runSearchChecks()
  await runPermissionChecks()
  await runAutoReviewChecks()
  await runRewindChecks()
  await runMcpChecks()
  await runLanguageServerChecks()
  await runInlineSuggestionChecks()
  await runEditorIssueChecks()
  await runComputerChecks()
  await runCompactionChecks()
  await runNamingChecks()
  // After a request of its own (naming), since the checks before reset their sessions: Usage has something to count.
  await runMoreSettingsChecks()
}

async function providerStats() {
  return (await fetch(`http://127.0.0.1:${providerPort}/__stats`)).json()
}

/** The ghost text the editor draws now, its first line and the rows below it joined, or null when there is none. */
const GHOST_TEXT = `(() => {
  const inline = document.querySelector('.code-editor .enc-inlay-ghost')
  if (!inline) return null
  return [inline.dataset.label ?? '', ...[...document.querySelectorAll('.code-editor .enc-ghost-line')].map((row) => row.textContent)].join('\\n')
})()`

/**
 * Suggestions as you type (ADR 0087), against the test provider. Once typing pauses the editor asks the model of the
 * Inline suggestions role, which follows the main model here, and draws its answer faded at the cursor without
 * making it text. Tab takes it as one step for Ctrl+Z, Ctrl+Right takes a word, Esc puts it away, and Alt+\\ asks at
 * once, the answer kept for the place asking nothing again. A credential in the file is not sent, a file of secrets
 * sends nothing, and turned off in Settings > Editor nothing is asked.
 */
async function runInlineSuggestionChecks() {
  console.log('[smoke] --- suggestions as you type ---')
  const source = "export function add(a: number, b: number): number {\n  return\n}\n\nconst client_secret = 'ghost-check-value-0123'\n"
  await evaluate(`window.eNCode.workspace.write('src/ghost-check.ts', ${JSON.stringify(source)})`)
  await quickOpen('src/ghost-check.ts', 'export function add(a: number, b: number): number {')
  const asked = async () => (await providerStats()).inlineRequests ?? 0
  const lastInline = async () => (await fetch(`http://127.0.0.1:${providerPort}/__last-inline`)).json()
  const ghostIs = (text, label) =>
    waitFor(`${GHOST_TEXT} === ${JSON.stringify(text)}`, 8000, label).catch(async (error) => {
      const footer = await evaluate("document.querySelector('.editor-footer-ghost')?.title ?? null")
      throw new Error(`${error.message}: drawn ${JSON.stringify(await evaluate(GHOST_TEXT))}, asked ${await asked()} times, footer ${JSON.stringify(footer)}`)
    })
  const lineIs = (text, label) => waitFor(`${RENDERED_LINES}.includes(${JSON.stringify(text)})`, 6000, label)

  // On by default with a model of one's own: the footer says so.
  const footer = await evaluate("document.querySelector('.editor-footer-ghost')?.title ?? ''")
  if (!footer.startsWith('Suggestions as you type are on.')) throw new Error(`The footer does not say suggestions are on: ${JSON.stringify(footer)}`)

  // A space after return, then a pause: the sum is drawn after the cursor and is not in the text.
  const before = await asked()
  await clickAt(await wordSpot('  return', 'return'))
  await pressKey('End')
  await send('Input.insertText', { text: ' ' })
  await ghostIs('a + b', 'the suggestion after return')
  if ((await evaluate(RENDERED_LINES)).some((line) => line.includes('a + b'))) throw new Error('The suggestion is in the text before it is taken')
  const sent = await lastInline()
  console.log('[smoke] inline request:', JSON.stringify({ model: sent.model, tools: sent.tools.length, maxTokens: sent.maxTokens, chars: sent.user.length }))
  if (!sent.user.includes('  return <cursor/>')) throw new Error(`The request does not mark the cursor: ${JSON.stringify(sent.user)}`)
  if (sent.user.includes('ghost-check-value-0123')) throw new Error('A credential in the file went with the suggestion request')
  if (sent.tools.length) throw new Error('The suggestion request offered tools')
  if ((await asked()) - before !== 1) throw new Error(`One pause should ask once, asked ${(await asked()) - before} times`)
  await screenshot('56-ghost-text.png')

  // Tab takes it; Ctrl+Z takes it back in one step.
  await pressKey('Tab')
  await lineIs('  return a + b', 'Tab takes the suggestion')
  if ((await evaluate(GHOST_TEXT)) !== null) throw new Error('The suggestion is still drawn after Tab took it')
  await pressKey('z', { ctrl: true })
  await lineIs('  return ', 'Ctrl+Z takes the suggestion back in one step')

  // Alt+\\ at the same place: the answer kept for it is drawn without asking again; Esc puts it away.
  const kept = await asked()
  await pressKey('\\', { alt: true })
  await ghostIs('a + b', 'Alt+\\ draws the kept suggestion')
  if ((await asked()) !== kept) throw new Error('The suggestion kept for this place was asked for again')
  await pressKey('Escape')
  await waitFor(`${GHOST_TEXT} === null`, 4000, 'Esc puts the suggestion away')
  await sleep(700)
  if ((await evaluate(GHOST_TEXT)) !== null) throw new Error('The suggestion came back after Esc')

  // Ctrl+Right takes a word, and the rest stays drawn.
  await pressKey('\\', { alt: true })
  await ghostIs('a + b', 'Alt+\\ again')
  await pressKey('ArrowRight', { ctrl: true })
  await lineIs('  return a', 'Ctrl+Right takes a word')
  await ghostIs(' + b', 'the rest of the suggestion after a word is taken')
  await pressKey('Escape')
  await pressKey('z', { ctrl: true })
  await lineIs('  return ', 'Ctrl+Z takes the word back')

  // In an empty line a suggestion may run over lines: the first drawn at the cursor, the others as rows below.
  await clickAt(await wordSpot('}', '}'))
  await pressKey('ArrowDown')
  await send('Input.insertText', { text: ' ' })
  await ghostIs('// ghost check\n return a + b', 'a suggestion of two lines')
  await pressKey('Escape')
  await pressKey('z', { ctrl: true })

  // A file of secrets sends nothing.
  await evaluate(`window.eNCode.workspace.write('secrets.json', ${JSON.stringify('{\n  "token": "abc"\n}\n')})`)
  await quickOpen('secrets.json', '"token": "abc"')
  const secrets = await asked()
  await clickAt(await wordSpot('"token": "abc"', 'token'))
  await pressKey('End')
  await send('Input.insertText', { text: ',' })
  await sleep(1500)
  if ((await asked()) !== secrets) throw new Error('A file of secrets was sent for a suggestion')
  if ((await evaluate(GHOST_TEXT)) !== null) throw new Error('A suggestion was drawn in a file of secrets')
  await pressKey('z', { ctrl: true })

  // Off in Settings > Editor: nothing is asked, and the footer shows no button for them.
  await openSettings('Editor')
  if (!(await click('[role="radiogroup"][aria-label="Suggest code as you type"] [role="radio"]', 'Off'))) throw new Error('No Off for suggestions as you type in Settings > Editor')
  await settingIs("settings.inlineSuggest === 'off'", 'suggestions as you type off')
  await closeSettings()
  await quickOpen('src/ghost-check.ts', 'export function add(a: number, b: number): number {')
  await waitFor("!document.querySelector('.editor-footer-ghost')", 4000, 'the footer drops the suggestions button')
  const off = await asked()
  await clickAt(await wordSpot('  return', 'return'))
  await pressKey('End')
  await send('Input.insertText', { text: 'x' })
  await sleep(1500)
  if ((await asked()) !== off || (await evaluate(GHOST_TEXT)) !== null) throw new Error('Turned off, a suggestion was still asked for')
  await pressKey('z', { ctrl: true })
  await openSettings('Editor')
  await click('[role="radiogroup"][aria-label="Suggest code as you type"] [role="radio"]', 'Auto')
  await settingIs("settings.inlineSuggest === 'auto'", 'suggestions as you type back to Auto')
  await closeSettings()
  console.log(`[smoke] suggestions as you type: ${(await asked()) - before} requests`)
}

/**
 * Report editor issue (ADR 0088): from the editor's own menu, what was recorded of the file is replayed and found
 * sound; a file with a credential in it goes only with its words replaced; the report written holds the trace with
 * the file's words replaced, what the person said, and nothing of the file's path or text.
 */
async function runEditorIssueChecks() {
  console.log('[smoke] --- report editor issue ---')
  await quickOpen('src/ghost-check.ts', 'export function add(a: number, b: number): number {')
  await clickAt(await wordSpot('  return', 'return'))
  await pressKey('End')
  await send('Input.insertText', { text: ' a - b' })
  await pressKey('Escape')
  await pressKey('Enter')
  await send('Input.insertText', { text: '// edited for the report' })
  await pressKey('z', { ctrl: true })

  await evaluate(`(() => {
    const scroller = document.querySelector('.code-editor .enc-scroller')
    const rect = scroller.getBoundingClientRect()
    scroller.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 140, clientY: rect.top + 40 }))
  })()`)
  await waitFor("[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.includes('Report editor issue'))", 6000, 'Report editor issue in the editor menu')
  await click('[role=menuitem]', 'Report editor issue')
  await waitFor("!!document.querySelector('.editor-issue-dialog')", 6000, 'the report dialog')
  const facts = () => evaluate("[...document.querySelectorAll('.editor-issue-dialog .install-server-facts dd')].map((node) => node.textContent)")
  await waitFor("[...document.querySelectorAll('.editor-issue-dialog .install-server-facts dd')].map((node) => node.textContent)[2] === 'No problem found'", 10000, 'the record replayed without a problem').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await facts())}`)
  })
  const [name, recorded] = await facts()
  if (name !== 'ghost-check.ts' || !/^\d+ steps over /.test(recorded)) throw new Error(`The report dialog does not say what it holds: ${JSON.stringify(await facts())}`)
  await screenshot('57-editor-issue.png')

  // With its words kept, a file with a credential in it is refused, in words.
  await click('#editor-issue-scramble')
  await waitFor("document.querySelector('#editor-issue-scramble')?.getAttribute('aria-checked') === 'false'", 4000, 'the words kept')
  await click('.editor-issue-dialog .ui-dialog-foot .btn', 'Save report')
  await waitFor("(document.querySelector('.report-refused')?.textContent ?? '').includes('looks like a key or a password')", 6000, 'a file with a credential kept as it is is refused')

  // Words replaced, with what went wrong: written where the test said.
  await click('#editor-issue-scramble')
  await typeInto('#editor-issue-description', 'Undo after Enter put the cursor back one line too far')
  await click('.editor-issue-dialog .ui-dialog-foot .btn', 'Save report')
  await waitFor("!document.querySelector('.editor-issue-dialog')", 6000, 'the dialog closes once the report is saved')
  await waitFor("[...document.querySelectorAll('.ui-toast, .toast')].some((node) => node.textContent.includes('Saved the editor report'))", 6000, 'a note that the report was saved')
  const file = process.env.ENCODE_EDITOR_ISSUE_FILE
  if (!file) throw new Error('ENCODE_EDITOR_ISSUE_FILE is not set (pnpm e2e sets it)')
  const text = await fs.readFile(file, 'utf8')
  const issue = JSON.parse(text)
  if (issue.kind !== 'encode-editor-issue' || issue.scrambled !== true || issue.extension !== '.ts' || issue.language !== 'typescript') throw new Error(`The report does not say what it is: ${text.slice(0, 400)}`)
  if (issue.description !== 'Undo after Enter put the cursor back one line too far') throw new Error(`The report does not hold what was said: ${issue.description}`)
  if (issue.problems.length) throw new Error(`The report found problems: ${JSON.stringify(issue.problems)}`)
  const origins = issue.trace.steps.filter((step) => step.changes).map((step) => step.origin)
  if (!origins.includes('input.type') || !origins.includes('undo')) throw new Error(`The trace does not hold the typing and the undo: ${JSON.stringify(origins)}`)
  for (const word of ['ghost-check', 'client_secret', 'ghost-check-value-0123', 'edited for the report', 'number']) {
    if (text.includes(word)) throw new Error(`The report holds "${word}" though the words were to be replaced`)
  }
  console.log(`[smoke] editor report: ${issue.trace.steps.length} steps, ${(text.length / 1024).toFixed(1)} KB`)
}

/** Once its first turn is over a session is named by the model in a few words, and the name is kept. */
async function runNamingChecks() {
  console.log('[smoke] --- naming ---')
  const before = await providerStats()
  await key({ key: 'n', ctrlKey: true })
  await waitFor("document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === 'New session'", 6000, 'Ctrl+N opens a new session')
  await sendPrompt('[scenario:follow-up] Name this session.')
  await driveAgent('16-naming')
  for (let attempt = 0; attempt < 40 && (await providerStats()).titleRequests === before.titleRequests; attempt++) await sleep(250)
  const after = await providerStats()
  if (after.titleRequests - before.titleRequests !== 1) throw new Error('The agent did not ask the model, once, to name the session')
  await waitFor("document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === 'Provider path check'", 8000, 'the model names the session, without its quotes or full stop')
  const titles = await evaluate('window.eNCode.agent.sessions().then((sessions) => sessions.map((session) => session.title))')
  if (!titles.includes('Provider path check')) throw new Error('The name the model gave is not kept with the session')
  console.log('[smoke] session named:', JSON.stringify({ before: before.titleRequests, after: after.titleRequests }))
}

async function notices() {
  return evaluate(`window.eNCode.agent.history().then((history) =>
    history.entries.filter((entry) => entry.kind === 'notice').map((entry) => entry.text))`)
}

async function runCompactionChecks() {
  console.log('[smoke] --- compaction ---')
  // The provider refuses the second request as too long; eNCode summarizes and sends it once more.
  await evaluate('window.eNCode.agent.reset()')
  const before = await providerStats()
  await sendPrompt('[scenario:overflow] Look around, then finish.')
  await driveAgent('16-compaction')
  const after = await providerStats()
  const automatic = await notices()
  console.log('[smoke] automatic compaction:', JSON.stringify({ before, after, notices: automatic }))
  if (after.overflowRefusals - before.overflowRefusals !== 1) throw new Error('Expected the provider to refuse one prompt as too long')
  if (after.summaryRequests - before.summaryRequests !== 1) throw new Error('Compaction did not ask the model for a summary')
  if (!automatic.some((text) => text.startsWith('Compacted') && text.includes('into a summary'))) {
    throw new Error('No notice tells the user the conversation was compacted')
  }
  if (!(await evaluate("document.body.textContent.includes('Compaction verified')"))) {
    throw new Error('The run did not finish after compaction')
  }

  // Compacting by hand, then carrying on: the provider must accept the compacted transcript.
  const [session] = await evaluate('window.eNCode.agent.sessions()')
  const manual = await evaluate(`window.eNCode.agent.compact(${JSON.stringify(session.id)})`)
  console.log('[smoke] manual compaction:', JSON.stringify(manual))
  if (!manual.removed) throw new Error('Manual compaction removed nothing')
  await sendPrompt('[scenario:follow-up] Carry on after compacting.')
  await driveAgent('16-after-compaction')
  const final = await providerStats()
  if (final.invalidTranscripts) throw new Error(`The provider refused ${final.invalidTranscripts} malformed transcripts`)
}

async function runWebChecks() {
  console.log('[smoke] --- WebFetch ---')
  // A new site asks once per session; localhost then fails the address check, so nothing is fetched.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:web-check] Fetch two pages from one site.')
  const approvals = await driveAgent('15-web')
  console.log('[smoke] web approvals:', JSON.stringify(approvals))
  if (approvals.length !== 1 || approvals[0].title !== 'Fetch localhost') {
    throw new Error('Expected one approval for the first fetch from localhost')
  }
  if (!approvals[0].reason.includes('until the session ends')) throw new Error('The web approval does not explain itself')
  const fetches = (await toolOutputs()).filter((entry) => entry.name === 'WebFetch')
  console.log('[smoke] web fetches:', JSON.stringify(fetches.map((entry) => entry.output.slice(0, 120))))
  if (fetches.length !== 2 || !fetches.every((entry) => entry.output.includes('private or special-purpose network address'))) {
    throw new Error('WebFetch reached a private address')
  }
}

/**
 * The Browser tool (ADR 0103) in the chat's own tab, a page of this computer that opens without asking: the agent types
 * a name, picks a size and presses Greet, whose confirm dialog answers itself; the secret field is refused, the link to
 * another site is held back, the link on the same host is followed, and the console holds the page's error and the
 * dialog. The tab shows in the side panel as the agent's, and is not saved with the person's tabs.
 */
async function runAgentBrowserChecks() {
  console.log('[smoke] --- the agent’s browser ---')
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:browser-check] Check the greeter app in the browser.')
  const approvals = await driveAgent('15-browser', 120000)
  if (approvals.length) throw new Error(`A page on this computer should open without asking: ${JSON.stringify(approvals)}`)
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const results = request.messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
  const browser = results.slice(-8)
  console.log('[smoke] browser results:', JSON.stringify(browser.map((text) => text.slice(0, 160))))
  const expect = (index, pattern, what) => {
    if (!pattern.test(browser[index] ?? '')) throw new Error(`${what}: ${JSON.stringify((browser[index] ?? '').slice(0, 600))}`)
  }
  expect(0, /Greeter at http:\/\/127\.0\.0\.1:\d+\/__browser\/app \(200\)[\s\S]*e1 textbox "Name"[\s\S]*e2 combobox "Size" = "Small"[\s\S]*e3 button "Greet"[\s\S]*e6 password "Secret"/, 'The outline does not list the page as it is')
  expect(0, /smoke: a console error/, 'The console error is not in the first answer')
  expect(1, /e1 textbox "Name" = "Ada"/, 'Typing did not reach the name field')
  expect(2, /e2 combobox "Size" = "Large"/, 'The size was not chosen')
  expect(3, /Hello, Ada \(l\)/, 'Greet did not run, or its confirm did not answer itself')
  expect(4, /never types one/, 'The secret field was typed into')
  expect(5, /Held back: the page went to https:\/\/example\.com\/elsewhere/, 'The link to another site was followed')
  expect(6, /Second page at http:\/\/127\.0\.0\.1:\d+\/__browser\/next/, 'The link on the same host was not followed')
  expect(7, /confirm dialog: "Greet them\?"/, 'The console does not hold the dialog')
  if (/hunter2/.test(browser.join('\n'))) throw new Error('The password reached the page or the model')

  const tab = await evaluate(`(() => {
    const pane = [...document.querySelectorAll('.side-panel .panel-pane')].find((node) => node.querySelector('.browser-agent-chip'))
    return pane ? { address: pane.querySelector('.browser-address input')?.value ?? '', active: pane.classList.contains('is-active'), webview: pane.querySelector('webview')?.getAttribute('partition') ?? '' } : null
  })()`)
  console.log('[smoke] agent tab:', JSON.stringify(tab))
  if (!tab || !tab.active || !/^encode-agent-[a-f0-9]{16}$/.test(tab.webview) || !tab.address.includes('/__browser/next')) throw new Error('The agent’s tab is not in the side panel on its page')
  await screenshot('ui-dark-agent-browser.png')
  const saved = await evaluate("JSON.parse(localStorage.getItem('eNCode.panels.v1') ?? '{}')")
  if (JSON.stringify(saved).includes('__browser')) throw new Error('The agent’s tab was saved with the person’s tabs')
  // Closed again, so the panel checks find the tabs they expect.
  if (!(await click('.side-panel .panel-tab.is-active .panel-tab-close'))) throw new Error('The agent’s tab has no close button')
  await waitFor("!document.querySelector('.browser-agent-chip')", 4000, 'the agent’s tab closes')
}

/**
 * A side chat (ADR 0104): /side opens a copy of the chat in a side tab, asks there in Ask mode, and nothing goes back to
 * the chat; the sidebar does not list it; closing the tab deletes it.
 */
async function runSideChatChecks() {
  console.log('[smoke] --- side chat ---')
  // The chat open now is the one used last.
  const chat = await evaluate('window.eNCode.agent.sessions().then((list) => list[0] ? { id: list[0].id, title: list[0].title } : null)')
  const history = () => evaluate(`window.eNCode.agent.history(${JSON.stringify(chat.id)}).then((history) => history.entries.map((entry) => ({ kind: entry.kind, text: entry.text ?? '' })))`)
  let entries = await history()
  if (!entries.some((entry) => entry.kind === 'user')) {
    await sendPrompt('[scenario:side-check] Remember the word pelican.')
    await driveAgent('15b-side-parent', 30000)
    entries = await history()
  }
  const asked = entries.find((entry) => entry.kind === 'user').text.slice(0, 40)
  await sendPrompt('/side [scenario:side-check] What did the chat above write?')
  await waitFor("document.querySelector('.side-panel .panel-pane.is-active .side-chat .msg-assistant')?.textContent?.includes('Side answer')", 30000, 'the side chat answers')
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const sent = JSON.stringify(request.messages)
  if (!sent.includes('This is a side chat')) throw new Error('The side chat’s model was not told it is one')
  if (!sent.includes(JSON.stringify(asked).slice(1, -1))) throw new Error('The side chat did not get a copy of the conversation')
  const shown = await evaluate(`(() => {
    const pane = document.querySelector('.side-panel .panel-pane.is-active .side-chat')
    return { bubbles: pane?.querySelectorAll('.chat-user-bubble').length ?? 0, of: pane?.querySelector('.side-chat-of')?.textContent ?? '' }
  })()`)
  console.log('[smoke] side chat:', JSON.stringify(shown))
  if (shown.bubbles !== 1) throw new Error(`The side chat shows the chat's messages too, or not its own: ${JSON.stringify(shown)}`)
  if (!shown.of.includes(chat.title)) throw new Error(`The side chat is not of the chat open now: ${JSON.stringify(shown)}`)
  await screenshot('ui-dark-side-chat.png')
  const after = (await history()).length
  if (after !== entries.length) throw new Error(`The side chat added to the chat: ${entries.length} entries before, ${after} after`)
  const listed = await evaluate("window.eNCode.agent.sessions().then((list) => list.filter((session) => session.sideOf || session.title === 'Side chat').length)")
  if (listed) throw new Error('The sidebar lists the side chat')
  if (JSON.stringify(await evaluate("JSON.parse(localStorage.getItem('eNCode.panels.v1') ?? '{}')")).includes('"chat"')) throw new Error('The side chat was saved with the tabs')
  if (!(await click('.side-panel .panel-tab.is-active .panel-tab-close'))) throw new Error('The side chat has no close button')
  await waitFor("!document.querySelector('.side-chat')", 4000, 'the side chat closes')
}

/**
 * The web search provider is chosen in Settings > Agent. A search asks first and names the provider's own host, a change of
 * provider applies to the next search, and a key is sealed on disk and never comes back to the page. Nothing here reaches a
 * search service: every search is refused at the approval, and the test button is pressed while no key is stored.
 */
async function runSearchChecks() {
  console.log('[smoke] --- web search ---')
  const card = () =>
    evaluate(`(() => {
      const card = document.querySelector('.approval-card')
      return card ? { title: card.querySelector('.approval-head')?.textContent ?? '', reason: card.querySelector('.approval-reason')?.textContent ?? '' } : null
    })()`)
  const askedBy = async (label, host) => {
    await sendPrompt('[scenario:search-check] Look something up.')
    await waitFor("!!document.querySelector('.approval-card')", 60000, `the search asks (${label})`)
    const asking = await card()
    console.log(`[smoke] search approval (${label}):`, JSON.stringify(asking))
    if (!asking.title.includes('Search the web for eNCode search check')) throw new Error(`The approval does not say what is searched: ${JSON.stringify(asking)}`)
    if (!asking.reason.includes(`Approving allows ${host} until the session ends`)) throw new Error(`The approval should name ${host}: ${JSON.stringify(asking.reason)}`)
    if (!(await click('.approval-card .btn', 'Deny'))) throw new Error('The approval card offers no Deny')
    await waitFor("!document.querySelector('.approval-card')", 8000, 'the card goes')
    const more = await driveAgent(`15-search-${label}`)
    if (more.length) throw new Error(`A refused search should not ask again: ${JSON.stringify(more)}`)
  }

  await evaluate('window.eNCode.agent.reset()')
  const initial = await evaluate('window.eNCode.settings.get()')
  if (initial.searchProvider !== 'duckduckgo' || initial.searchKeys.length) throw new Error(`A new install searches with DuckDuckGo and holds no search key: ${JSON.stringify([initial.searchProvider, initial.searchKeys])}`)
  await askedBy('duckduckgo', 'html.duckduckgo.com')

  // Settings > Agent: pick Brave Search. Its key field shows, and the test says there is no key without sending anything.
  await openSettings('Agent')
  await waitFor("!!document.querySelector('input[name=\"search-provider\"]')", 4000, 'the search providers')
  const options = await evaluate(`[...document.querySelectorAll('.policy-option')].filter((node) => node.querySelector('input[name="search-provider"]')).map((node) => node.querySelector('.policy-option-label')?.textContent ?? '')`)
  console.log('[smoke] search providers:', JSON.stringify(options))
  if (options.join('|') !== 'DuckDuckGo|Brave Search Needs a key|Tavily Needs a key|Exa Needs a key') throw new Error(`The search providers read ${JSON.stringify(options)}`)
  if (await evaluate("!!document.querySelector('.search-key')")) throw new Error('DuckDuckGo needs no key, so no key field should show')
  if (!(await click('input[name="search-provider"][value="brave"]'))) throw new Error('Brave Search is not offered')
  await waitFor("!!document.querySelector('.search-key .key-field')", 4000, 'the key field of Brave Search')
  const field = await evaluate(`({ label: document.querySelector('.search-key .key-field-label')?.textContent, note: document.querySelector('.search-key .key-field-note')?.textContent, link: document.querySelector('.search-link a')?.href })`)
  // Where there is no keychain the note says the key stays in memory; where there is one it says whom the key goes to.
  const noteOk = /sent only to Brave Search/.test(field.note) || /Kept in memory until eNCode closes/.test(field.note)
  if (field.label !== 'Brave Search API key' || !noteOk || field.link !== 'https://brave.com/search/api/') throw new Error(`The key field reads ${JSON.stringify(field)}`)
  if (!(await click('.search-test .btn', 'Test search'))) throw new Error('No Test search button')
  await waitFor("!!document.querySelector('.settings-web-search [role=\"status\"].error-text')", 20000, 'the test to answer')
  const noKey = await evaluate("document.querySelector('.settings-web-search [role=\"status\"]').textContent")
  if (noKey !== 'There is no API key for Brave Search. Paste one above, then press Test search.') throw new Error(`The test without a key says ${JSON.stringify(noKey)}`)
  await evaluate("document.querySelector('.settings-web-search [role=\"status\"]')?.scrollIntoView({ block: 'end' })")
  await sleep(250)
  await screenshot('15-search-settings.png')

  // Type a key and save it: the page learns only that one is stored, and the disk holds it sealed. The provider was
  // kept when it was picked.
  const secret = `brave-smoke-${Date.now().toString(36)}`
  if (!(await typeInto('.search-key .text-input', secret))) throw new Error('No key field')
  await waitFor("!!document.querySelector('.search-test .btn.primary')", 4000, 'a Save key button once a key is typed')
  if (!(await click('.search-test .btn.primary', 'Save key'))) throw new Error('No Save key button')
  await settingIs("settings.searchKeys.includes('brave')", 'the Brave Search key', 8000)
  await waitFor("!document.querySelector('.search-test .btn.primary')", 4000, 'the field emptied once the key is stored')
  await closeSettings()
  const saved = await evaluate('window.eNCode.settings.get()')
  if (saved.searchProvider !== 'brave' || saved.searchKeys.join() !== 'brave') throw new Error(`Brave Search was not saved with its key: ${JSON.stringify([saved.searchProvider, saved.searchKeys])}`)
  if (JSON.stringify(saved).includes(secret)) throw new Error('Settings handed the search key to the page')
  const profileDir = process.env.ENCODE_USER_DATA_DIR
  if (profileDir) {
    const disk = await fs.readFile(path.join(profileDir, 'eNCode-settings.json'), 'utf8')
    if (disk.includes(secret)) throw new Error('The settings file holds a readable search key')
    const sealed = JSON.parse(disk).searchKeysEnc?.brave
    if (saved.keyStorage.mode === 'keychain' && !sealed?.startsWith('enc:')) throw new Error('The keychain is available but the search key was not sealed on disk')
    if (saved.keyStorage.mode === 'session' && sealed !== undefined) throw new Error('Without a keychain the search key must stay out of the settings file')
  }

  // The change applies to the next search, with no restart; and another provider is another host.
  await askedBy('brave', 'api.search.brave.com')
  await evaluate("window.eNCode.settings.save({ searchProvider: 'tavily' })")
  await askedBy('tavily', 'api.tavily.com')

  // Tidy up: back to the default, and the key removed.
  await evaluate("window.eNCode.settings.save({ searchProvider: 'duckduckgo' })")
  const after = await evaluate("window.eNCode.settings.setSearchKey('brave', '')")
  if (after.searchKeys.length) throw new Error(`The key was not removed: ${JSON.stringify(after.searchKeys)}`)
  await evaluate('window.eNCode.agent.reset()')
  console.log('[smoke] web search: ok')
}

/**
 * "Always allow" on an approval saves a rule for the command and trusts the folder with it, so the same command runs
 * without asking and another still asks. The folder's own settings then wait for review, are read on the Permissions
 * tab and approved there; a rule is added and removed by hand; trust is taken back.
 */
async function runPermissionChecks() {
  console.log('[smoke] --- permissions ---')
  const localFile = path.join(demoPath, '.encode', 'settings.local.json')
  const projectFile = path.join(demoPath, '.encode', 'settings.json')
  await evaluate('window.eNCode.agent.reset()')
  const first = await evaluate('window.eNCode.permissions.report()')
  if (!first || first.trusted || first.broken) throw new Error(`The demo folder should start untrusted and readable: ${JSON.stringify(first)}`)

  await sendPrompt('[scenario:always-allow] Run a command twice, then another one.')
  await waitFor("!!document.querySelector('.approval-card')", 60000, 'the first command asks')
  if (!(await click('.approval-card .btn', 'Always allow'))) throw new Error('The approval card offers no Always allow')
  await waitFor("!!document.querySelector('.approval-always')", 4000, 'the Always allow choices')
  const choices = await evaluate(`({
    rules: document.querySelector('.approval-always-rules')?.textContent,
    scope: document.querySelector('.approval-scope input:checked')?.value,
    trust: document.querySelector('.approval-trust input')?.checked ?? null,
    note: document.querySelector('.approval-always-note')?.textContent,
  })`)
  console.log('[smoke] always allow choices:', JSON.stringify(choices))
  if (choices.rules !== 'Bash(echo always-allow-ok)') throw new Error('The card does not show the rule it would save')
  if (choices.scope !== 'local') throw new Error('The rule should go to the private settings by default')
  if (choices.trust !== true) throw new Error('A folder with no settings of its own should be offered trust with the rule, ticked')
  if (!/applies at once/.test(choices.note)) throw new Error(`The note does not say the rule applies at once: ${choices.note}`)
  await screenshot('17-always-allow.png')
  await click('.approval-always .btn.primary')
  await waitFor("!document.querySelector('.approval-always')", 8000, 'the card goes')
  const asked = await driveAgent('17-always-allow')
  console.log('[smoke] approvals after always allow:', JSON.stringify(asked.map((card) => card.detail)))
  if (asked.length !== 1 || !asked[0].detail.includes('echo another-command-ok')) throw new Error('Only the different command should have asked')
  const saved = JSON.parse(await fs.readFile(localFile, 'utf8'))
  if (JSON.stringify(saved.permissions?.allow) !== JSON.stringify(['Bash(echo always-allow-ok)'])) throw new Error(`The rule was not saved: ${JSON.stringify(saved)}`)
  const outputs = (await toolOutputs()).filter((entry) => entry.name === 'Bash').map((entry) => entry.output.trim())
  if (outputs.filter((output) => output.includes('always-allow-ok')).length !== 2) throw new Error(`Both runs of the command should have happened: ${JSON.stringify(outputs)}`)
  const trusted = await evaluate('window.eNCode.permissions.report()')
  if (!trusted.trusted || !trusted.configApproved) throw new Error('Trusting the folder with the rule should leave it trusted and approved')

  // The folder's own settings arrive (a pull, say): they wait for review, and a banner says so.
  await fs.mkdir(path.dirname(projectFile), { recursive: true })
  await fs.writeFile(projectFile, JSON.stringify({ permissions: { allow: ['Bash(echo from-folder)'] } }))
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await waitFor("!!document.querySelector('.trust-banner')", 8000, 'the banner for settings that changed')
  const banner = await evaluate("document.querySelector('.trust-banner')?.textContent ?? ''")
  if (!/changed since you approved/.test(banner)) throw new Error(`The banner says ${JSON.stringify(banner)}`)
  await screenshot('17-trust-banner.png')
  await click('.trust-banner .btn')
  await waitFor("!!document.querySelector('.settings-permissions .perm-folder')", 8000, 'the Permissions tab')
  const chip = () => evaluate("document.querySelector('.perm-folder .ui-chip')?.textContent ?? ''")
  if ((await chip()) !== 'Settings changed') throw new Error(`The folder reads ${JSON.stringify(await chip())}`)
  const waiting = await evaluate("document.querySelector('.perm-waiting pre')?.textContent ?? ''")
  if (!waiting.includes('Bash(echo from-folder)')) throw new Error('The settings that wait are not shown')
  const mine = await evaluate("[...document.querySelectorAll('.perm-rule')].map((row) => [row.querySelector('.perm-rule-text').textContent, row.classList.contains('is-waiting')])")
  console.log('[smoke] rules while waiting:', JSON.stringify(mine))
  // The folder's settings are one thing to approve, so the rule saved earlier waits with the one that arrived.
  if (!mine.some(([text, held]) => text === 'Bash(echo always-allow-ok)' && held)) throw new Error('The saved rule should be listed, and wait with the rest of the folder’s settings')
  if (!mine.some(([text, held]) => text === 'Bash(echo from-folder)' && held)) throw new Error('The folder’s own rule should be listed and waiting')
  await screenshot('17-permissions.png')

  await click('.perm-folder-actions .btn', 'Approve these settings')
  await waitFor("document.querySelector('.perm-folder .ui-chip')?.textContent === 'Trusted'", 8000, 'the settings are approved')
  if (await evaluate("!!document.querySelector('.perm-rule.is-waiting') || !!document.querySelector('.perm-waiting')")) throw new Error('Nothing should wait after the approval')

  // A rule by hand, then removed.
  await typeInto('.perm-add-text', 'Read(./secret.txt)')
  await click('.perm-add .ui-segment', 'Never allow')
  await click('.perm-add .btn.primary')
  await waitFor("[...document.querySelectorAll('.perm-rule-text')].some((node) => node.textContent === 'Read(./secret.txt)')", 8000, 'the rule is added')
  const denied = await evaluate("document.querySelector('.perm-group')?.querySelector('.perm-group-title')?.textContent ?? ''")
  if (denied !== 'Never allow') throw new Error(`Denials should be listed first, not ${JSON.stringify(denied)}`)
  const secret = JSON.parse(await fs.readFile(localFile, 'utf8'))
  if (JSON.stringify(secret.permissions?.deny) !== JSON.stringify(['Read(./secret.txt)'])) throw new Error('The rule was not written to the private settings')
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.perm-rule')].find((item) => item.querySelector('.perm-rule-text').textContent === 'Read(./secret.txt)')
    row.querySelector('button').click()
  })()`)
  await waitFor("![...document.querySelectorAll('.perm-rule-text')].some((node) => node.textContent === 'Read(./secret.txt)')", 8000, 'the rule is removed')

  // Trust is taken back, and the agent can no longer use what the folder grants.
  await click('.perm-folder-actions .btn', 'Stop trusting this folder')
  await waitFor("document.querySelector('.perm-folder .ui-chip')?.textContent === 'Not trusted'", 8000, 'trust is taken back')
  await closeSettings()
  await fs.rm(path.join(demoPath, '.encode'), { recursive: true, force: true })
  console.log('[smoke] permissions: ok')
}

/**
 * Auto review. A command the assessor cannot prove read-only goes to the Reviewer, a second model call that sees the
 * request and the command and nothing else: it approves the first, declines the second, and passes the third to the
 * person. The fixed checks keep a force-push for the person without asking the Reviewer. The steps say who looked.
 */
async function runAutoReviewChecks() {
  console.log('[smoke] --- auto review ---')
  const notes = ['review-approved.txt', 'review-declined.txt', 'review-asked.txt']
  const exists = (name) => fs.access(path.join(demoPath, name)).then(() => true, () => false)
  const clean = () => Promise.all(notes.map((name) => fs.rm(path.join(demoPath, name), { force: true })))
  await clean()
  await evaluate('window.eNCode.agent.reset()')
  await evaluate("window.eNCode.settings.save({ policy: 'auto-review' })")
  const before = await providerStats()
  try {
    await sendPrompt('[scenario:auto-review] Write three notes, then publish.')
    const cards = await driveAgent('18-auto-review', 120000, { deny: (card) => card.detail.includes('git push') })
    console.log('[smoke] auto review cards:', JSON.stringify(cards))
    // Two questions reach the person: the Reviewer's doubt about the third note, and the fixed checks' stop on the force-push.
    if (cards.length !== 2) throw new Error(`Expected 2 approval cards, saw ${cards.length}: ${JSON.stringify(cards)}`)
    if (!cards[0].detail.includes('review-asked.txt') || !/^The Reviewer leaves this to you: It writes a file you did not mention\.$/.test(cards[0].review)) {
      throw new Error(`The Reviewer's question reads ${JSON.stringify(cards[0])}`)
    }
    if (!cards[1].detail.includes('git push --force') || !/^Auto review leaves this to you: /.test(cards[1].review)) {
      throw new Error(`The fixed checks' question reads ${JSON.stringify(cards[1])}`)
    }

    // The files say what ran: the approved note and the one the person approved, not the declined one.
    if (!(await exists('review-approved.txt')) || !(await exists('review-asked.txt'))) throw new Error('The approved commands did not run')
    if (await exists('review-declined.txt')) throw new Error('The command the Reviewer declined ran')

    const steps = await evaluate(`window.eNCode.agent.history().then((history) =>
      history.entries.filter((entry) => entry.kind === 'tool').map((entry) => ({
        state: entry.tool.state,
        review: entry.tool.review ?? null,
        output: entry.tool.output ?? '',
      })))`)
    console.log('[smoke] auto review steps:', JSON.stringify(steps.map((step) => [step.state, step.review?.by, step.review?.verdict])))
    const outline = steps.map((step) => `${step.state}:${step.review?.by}:${step.review?.verdict}`)
    const expected = ['done:reviewer:approved', 'rejected:reviewer:declined', 'done:reviewer:asked', 'rejected:floor:asked']
    if (JSON.stringify(outline) !== JSON.stringify(expected)) throw new Error(`The steps went ${JSON.stringify(outline)}, not ${JSON.stringify(expected)}`)
    if (steps[0].review.risk !== 'low' || !steps[1].output.startsWith('Declined by the Reviewer: Nothing you asked for needs this file.')) {
      throw new Error(`The Reviewer's verdicts read ${JSON.stringify(steps.slice(0, 2))}`)
    }

    // The Reviewer was asked three times, never about the force-push, and saw the request and one action, with no tools.
    const after = await providerStats()
    if (after.reviewerRequests - before.reviewerRequests !== 3) throw new Error(`The Reviewer was asked ${after.reviewerRequests - before.reviewerRequests} times, not 3`)
    const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-reviewer`)).json()
    if (seen.tools.length || seen.messages !== 2) throw new Error(`The Reviewer was given ${JSON.stringify({ tools: seen.tools.length, messages: seen.messages })}`)
    if (!seen.system.startsWith('You are the Reviewer for a coding agent.') || !seen.user.includes('[scenario:auto-review] Write three notes, then publish.')) {
      throw new Error(`The Reviewer's request reads ${JSON.stringify(seen)}`)
    }
    if (seen.user.includes('Contents of') || seen.user.includes('<environment>')) throw new Error('The Reviewer was given more than the request and the action')

    // The work log shows who looked: a mark on the approved step, the reason under the declined one.
    await openWorkLogs()
    await evaluate(`(() => {
      document.querySelectorAll('.tool-row:not(.tool-group)').forEach((row) => {
        if (!row.querySelector('.tool-row-body')) row.querySelector('.tool-row-toggle')?.click()
      })
      return true
    })()`)
    await sleep(400)
    const log = await evaluate(`(() => ({
      approvedMarks: document.querySelectorAll('.tool-row-mark.is-ok').length,
      notes: [...document.querySelectorAll('.step-note')].map((note) => note.textContent),
    }))()`)
    console.log('[smoke] auto review notes:', JSON.stringify(log))
    if (log.approvedMarks !== 1) throw new Error(`The approved step should carry one mark, not ${log.approvedMarks}`)
    for (const text of ['Approved by the Reviewer (low risk): It writes a note in the project, as you asked.', 'Declined by the Reviewer (medium risk): Nothing you asked for needs this file.']) {
      if (!log.notes.includes(text)) throw new Error(`The work log does not say "${text}": ${JSON.stringify(log.notes)}`)
    }
    await screenshot('18-auto-review.png')
  } finally {
    await evaluate("window.eNCode.settings.save({ policy: 'workspace-write' })")
    await evaluate('window.eNCode.agent.reset()')
    await clean()
  }
  console.log('[smoke] auto review: ok')
}

/**
 * Hooks and rewind. The folder's hooks wait for trust; once it is trusted they log what the agent does and a guard refuses
 * a command before it can ask. The Rewind dialog then puts one request's changes back (files only), brings them back
 * with Undo, leaves alone a file the person changed since, and last goes back in the conversation too.
 */
async function runRewindChecks() {
  console.log('[smoke] --- hooks and rewind ---')
  const utilsFile = path.join(demoPath, 'src', 'utils.ts')
  const createdFile = path.join(demoPath, 'rewind-new.txt')
  const noteFile = path.join(demoPath, 'untrusted-note.txt')
  const logFile = path.join(demoPath, 'hook-log.txt')
  const original = await fs.readFile(utilsFile, 'utf8')
  // A Windows PowerShell would write UTF-16: take the zero bytes out so the lines can be compared.
  const read = async (file) => {
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    return text === null ? null : text.split(String.fromCharCode(0)).join('')
  }
  const logged = async () => ((await read(logFile)) ?? '').split(/\r?\n/).filter(Boolean)
  const expectFile = async (file, expected, what) => {
    const text = await read(file)
    if (text !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(text)}`)
  }
  const openRewind = async (index) => {
    if (!(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.turn-user')][${index}]?.querySelector('button[aria-label="Rewind to before this request"]')
      if (!button) return false
      button.click()
      return true
    })()`))) throw new Error(`The request ${index + 1} has no Rewind button`)
    await waitFor("!!document.querySelector('.rewind-dialog') && !document.querySelector('.rewind-loading')", 10000, 'the Rewind dialog has its plan')
  }
  const rows = () => evaluate(`[...document.querySelectorAll('.rewind-file')].map((row) => [
    row.querySelector('.rewind-file-path').textContent,
    row.querySelector('.rewind-file-action').lastChild.textContent,
    row.classList.contains('is-conflict'),
  ]).sort((a, b) => a[0].localeCompare(b[0]))`)
  const choose = (value) => evaluate(`(() => { const input = document.querySelector('input[name="rewind-choice"][value="${value}"]'); input?.click(); return Boolean(input) })()`)
  const applyDialog = async () => {
    if (!(await click('.rewind-dialog .ui-dialog-foot .btn.primary'))) throw new Error('The Rewind dialog has no primary button')
    await waitFor("!document.querySelector('.rewind-dialog')", 10000, 'the Rewind dialog closes')
  }
  const toastIs = (text) => waitFor(`[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === ${JSON.stringify(text)})`, 8000, `the notice "${text}"`)

  await evaluate('window.eNCode.agent.reset()')
  await fs.mkdir(path.join(demoPath, '.encode'), { recursive: true })
  await fs.writeFile(
    path.join(demoPath, '.encode', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "blocked by the guard hook" 1>&2; exit 2' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt >> hook-log.txt' }] }],
        PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'echo changed >> hook-log.txt' }] }],
      },
    }),
  )

  // Not trusted yet: the folder's hooks are only read, so the request runs without the log or the guard.
  const before = await evaluate('window.eNCode.permissions.report()')
  if (before.trusted || before.hooks.length) throw new Error(`Hooks of an untrusted folder should not apply: ${JSON.stringify(before.hooks)}`)
  if (!before.waiting.some((item) => item.text.includes('PreToolUse'))) throw new Error('The hooks that wait should be readable before they are approved')
  await sendPrompt('[scenario:hooks-untrusted] Write a note.')
  const first = await driveAgent('18-hooks-untrusted')
  if (first.length) throw new Error(`Writing a file should not ask: ${JSON.stringify(first)}`)
  await expectFile(noteFile, 'written before the folder was trusted\n', 'the first request wrote its note')
  if ((await read(logFile)) !== null) throw new Error('A hook of an untrusted folder ran')

  const trust = await evaluate("window.eNCode.permissions.act({ type: 'trust' })")
  if (!trust.ok || trust.report.hooks.length !== 3) throw new Error(`Trusting the folder should bring its three hooks in force: ${JSON.stringify(trust)}`)
  // The banner that said the settings wait reads the folder again when the window is back in front.
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await waitFor("!document.querySelector('.trust-banner')", 8000, 'the banner goes once the folder is trusted')

  // Trusted: the prompt and each change of a file are logged, and the guard refuses the command without asking.
  await sendPrompt('[scenario:hooks-check] Change add, add a file and run a command.')
  const second = await driveAgent('18-hooks-check')
  if (second.length) throw new Error(`The guard should refuse the command before it asks: ${JSON.stringify(second)}`)
  const log = await logged()
  console.log('[smoke] hook log:', JSON.stringify(log))
  if (JSON.stringify(log) !== JSON.stringify(['prompt', 'changed', 'changed'])) throw new Error(`The hooks logged ${JSON.stringify(log)}`)
  const guarded = (await toolOutputs()).filter((entry) => entry.name === 'Bash')
  if (guarded.length !== 1 || guarded[0].state !== 'rejected' || !guarded[0].output.includes('blocked by the guard hook')) {
    throw new Error(`The command should have been refused with the guard's words: ${JSON.stringify(guarded)}`)
  }
  const changedUtils = await read(utilsFile)
  if (!changedUtils.includes('return b + a')) throw new Error('The agent did not change src/utils.ts')
  await expectFile(createdFile, 'created by the hooks check\n', 'the agent created a file')

  await runTurnReportCheck({ original, read })
  await runTurnReviewChecks({ utilsFile, createdFile, original, changedUtils, read, expectFile, toastIs })

  // Undo on the latest change card opens the dialog on the files alone. It lists what this request changed, and nothing
  // of the first request, whose card offers no Undo.
  const undoButtons = await evaluate(`[...document.querySelectorAll('.turn .result-card')].map((card) => [...card.querySelectorAll('button')].some((node) => node.textContent === 'Undo'))`)
  if (JSON.stringify(undoButtons) !== JSON.stringify([false, true])) throw new Error(`Only the latest change card should offer Undo: ${JSON.stringify(undoButtons)}`)
  if (!(await evaluate(`(() => {
    const button = [...document.querySelectorAll('.turn .result-card button')].find((node) => node.textContent === 'Undo')
    button?.click()
    return Boolean(button)
  })()`))) throw new Error('The latest change card has no Undo')
  await waitFor("!!document.querySelector('.rewind-dialog') && !document.querySelector('.rewind-loading')", 10000, 'the Rewind dialog has its plan')
  const plan = await rows()
  console.log('[smoke] rewind plan:', JSON.stringify(plan))
  if (JSON.stringify(plan) !== JSON.stringify([['rewind-new.txt', 'Delete', false], ['src/utils.ts', 'Put back', false]])) throw new Error(`The plan lists ${JSON.stringify(plan)}`)
  if (!(await evaluate("document.querySelector('input[name=\"rewind-choice\"][value=\"code\"]')?.checked"))) throw new Error('Undo should start on "Code only"')
  await screenshot('18-rewind-dialog.png')
  await applyDialog()
  await toastIs('Put back 1 file and deleted 1 file.')
  await expectFile(utilsFile, original, 'src/utils.ts is as it was')
  if ((await read(createdFile)) !== null) throw new Error('The file the agent created should be gone')
  await expectFile(noteFile, 'written before the folder was trusted\n', 'the first request is left as it was')
  if ((await evaluate("document.querySelectorAll('.turn-user').length")) !== 2) throw new Error('A rewind of the files alone should keep the conversation')

  // Undo brings both back.
  if (!(await click('.toast-action', 'Undo'))) throw new Error('The notice offers no Undo')
  await waitFor("!!document.querySelector('.rewind-dialog') && !document.querySelector('.rewind-loading') && document.querySelectorAll('.rewind-file').length === 2", 10000, 'the dialog for undoing')
  await applyDialog()
  await toastIs('Brought back 2 files.')
  if (!(await read(utilsFile)).includes('return b + a')) throw new Error('Undo did not bring back the change to src/utils.ts')
  await expectFile(createdFile, 'created by the hooks check\n', 'Undo brought back the file')

  // A file the person changed since is left alone unless they say otherwise; the rest still goes back.
  await fs.writeFile(utilsFile, `${changedUtils}// my own edit\n`)
  await openRewind(1)
  await choose('code')
  const clash = await rows()
  console.log('[smoke] rewind plan after an edit:', JSON.stringify(clash))
  if (JSON.stringify(clash) !== JSON.stringify([['rewind-new.txt', 'Delete', false], ['src/utils.ts', 'Put back', true]])) throw new Error(`The plan lists ${JSON.stringify(clash)}`)
  if ((await evaluate("document.querySelector('.rewind-overwrite input')?.checked")) !== false) throw new Error('Overwriting a file the person changed must start unticked')
  await screenshot('18-rewind-conflict.png')
  await applyDialog()
  await waitFor("[...document.querySelectorAll('.toast-text')].some((node) => node.textContent.startsWith('Deleted 1 file. 1 file left alone (src/utils.ts: '))", 8000, 'the notice about the file left alone')
  if (!(await read(utilsFile)).includes('// my own edit')) throw new Error('The person’s own edit was overwritten')
  if ((await read(createdFile)) !== null) throw new Error('The file the agent created should be gone')

  // Both: the files go back, overwriting the edit when told to, and so does the conversation, with the request to edit.
  await openRewind(1)
  if (!(await evaluate("document.querySelector('input[name=\"rewind-choice\"][value=\"both\"]')?.checked"))) throw new Error('"Code and conversation" should be the first choice')
  await evaluate("document.querySelector('.rewind-overwrite input')?.click()")
  await applyDialog()
  await toastIs('Put back 1 file. Went back in the conversation.')
  await expectFile(utilsFile, original, 'src/utils.ts is as it was, with the edit overwritten')
  await waitFor("document.querySelectorAll('.turn-user').length === 1", 8000, 'the conversation goes back to the first request')
  const draft = await evaluate("document.querySelector('.composer-input')?.value ?? ''")
  if (!draft.includes('[scenario:hooks-check]')) throw new Error(`The request should be back in the composer, not ${JSON.stringify(draft)}`)
  await expectFile(noteFile, 'written before the folder was trusted\n', 'the first request is still as it was')
  const kept = await evaluate('window.eNCode.agent.history().then((history) => history.entries.filter((entry) => entry.kind === "user").map((entry) => entry.text))')
  if (kept.length !== 1 || !kept[0].includes('[scenario:hooks-untrusted]')) throw new Error(`The conversation should hold the first request only: ${JSON.stringify(kept)}`)

  await evaluate("window.eNCode.permissions.act({ type: 'revoke' })")
  await typeInto('.composer-input', '')
  for (const file of [noteFile, logFile, createdFile]) await fs.rm(file, { force: true })
  await fs.rm(path.join(demoPath, '.encode'), { recursive: true, force: true })
  console.log('[smoke] hooks and rewind: ok')
}

/**
 * The Review tab's Turn view, in a folder without git: the change card's "Review changes" opens what the request
 * changed. One change is reverted on its own and the file the request created is deleted; the notices' Undo brings each
 * back, so the files end as the agent left them and the rewind that follows finds nothing of the person's in its way.
 */
/**
 * Report a problem with a request (ADR 0092): the request just run saves with its steps and what the tools answered,
 * src/utils.ts as it was before the request changed it, and the project folder taken out of every path.
 */
async function runTurnReportCheck({ original, read }) {
  const file = process.env.ENCODE_TURN_REPORT_FILE
  if (!file) throw new Error('ENCODE_TURN_REPORT_FILE is not set (pnpm e2e sets it)')
  await fs.rm(file, { force: true })
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.turn-user')][1]?.querySelector('button[aria-label="Report a problem with this request"]')
    button?.click()
    return Boolean(button)
  })()`)
  if (!opened) throw new Error('The request has no Report button')
  await waitFor("!!document.querySelector('.turn-report-dialog')", 6000, 'the report dialog')
  const named = await evaluate("document.querySelector('.turn-report-dialog .install-server-facts dd')?.textContent ?? ''")
  if (!named.startsWith('[scenario:hooks-check]')) throw new Error(`The dialog names the request ${JSON.stringify(named)}`)
  // The picture shows the dialog once it has faded in.
  await waitFor("document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)", 4000, 'the dialog has opened')
  await screenshot('18-turn-report.png')
  await click('#turn-report-scramble')
  await waitFor("document.querySelector('#turn-report-scramble')?.getAttribute('aria-checked') === 'false'", 4000, 'the words kept')
  await typeInto('#turn-report-description', 'It ran a command the guard refuses')
  await click('.turn-report-dialog .ui-dialog-foot .btn', 'Save report')
  await waitFor("!document.querySelector('.turn-report-dialog')", 10000, 'the dialog closes once the report is saved')
  await waitFor("[...document.querySelectorAll('.ui-toast, .toast')].some((node) => node.textContent.includes('Saved the report to'))", 6000, 'a note that the report was saved')
  const text = await read(file)
  const report = JSON.parse(text ?? 'null')
  if (report?.kind !== 'encode-turn-report' || report.scrambled !== false) throw new Error(`The report does not say what it is: ${String(text).slice(0, 400)}`)
  if (report.description !== 'It ran a command the guard refuses' || !report.prompt.startsWith('[scenario:hooks-check]')) throw new Error(`The report does not hold the request: ${String(text).slice(0, 400)}`)
  const utils = report.files.find((entry) => entry.path === 'src/utils.ts')
  if (utils?.text !== original) throw new Error(`The report should hold src/utils.ts as it was before the request: ${JSON.stringify(report.files.map((entry) => entry.path))}`)
  if (!report.results.some((result) => result.tool === 'Bash' && !result.ok)) throw new Error(`The report should hold the refused command: ${JSON.stringify(report.results)}`)
  const forms = [demoPath, demoPath.replace(/\\/g, '/'), JSON.stringify(demoPath).slice(1, -1)].map((form) => form.toLowerCase())
  if (forms.some((form) => text.toLowerCase().includes(form))) throw new Error('The report names the project folder')
  console.log(`[smoke] turn report: ${report.steps.length} steps, ${report.files.length} files, ${(text.length / 1024).toFixed(1)} KB`)
}

async function runTurnReviewChecks({ utilsFile, createdFile, original, changedUtils, read, expectFile, toastIs }) {
  console.log('[smoke] --- review of a turn ---')
  const heads = "document.querySelectorAll('.review-pane .rv-file-head:not(.is-pinned)').length"
  const opened = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.turn')].at(-1)?.querySelector('.result-card')
    const button = card ? [...card.querySelectorAll('button')].find((node) => node.textContent === 'Review changes') : null
    button?.click()
    return Boolean(button)
  })()`)
  if (!opened) throw new Error('The change card has no "Review changes"')
  await waitFor("document.querySelector('.side-panel .panel-tab.is-active .panel-tab-title')?.textContent === 'Review'", 6000, 'the Review tab opens')
  await waitFor(`${heads} === 2`, 15000, 'the two files the request changed')
  const listed = await evaluate(`({
    scope: document.querySelector('.review-pane .rv-scope')?.textContent ?? '',
    request: document.querySelector('.review-pane .rv-turn-chip .rv-chip-text')?.textContent ?? '',
    files: [...document.querySelectorAll('.review-pane .rv-file-head:not(.is-pinned) .rv-path')].map((node) => node.textContent),
    hunks: document.querySelectorAll('.review-pane .rv-hunk-head').length,
    added: [...document.querySelectorAll('.review-pane .rv-line.is-add')].map((node) => node.textContent),
  })`)
  console.log('[smoke] turn review shows:', JSON.stringify(listed))
  if (listed.scope !== 'Agent turn' || !listed.request.startsWith('[scenario:hooks-check]')) throw new Error(`The Turn view is not on the request: ${JSON.stringify(listed)}`)
  if (JSON.stringify(listed.files) !== JSON.stringify(['rewind-new.txt', 'src/utils.ts']) || listed.hunks !== 2) throw new Error(`The Turn view lists ${JSON.stringify(listed)}`)
  if (!listed.added.some((text) => text.includes('return b + a')) || !listed.added.some((text) => text.includes('created by the hooks check'))) throw new Error('The added lines are not shown')
  await sleep(300)
  await screenshot('18-turn-review.png')

  // The change to src/utils.ts, reverted on its own, then brought back.
  const reverted = await evaluate(`(() => {
    let inFile = false
    for (const row of document.querySelectorAll('.review-pane .rv-canvas > .rv-row')) {
      const head = row.querySelector('.rv-file-head')
      if (head) inFile = head.querySelector('.rv-path')?.textContent === 'src/utils.ts'
      const chip = inFile ? [...row.querySelectorAll('.rv-hunk-head .rv-chip')].find((node) => node.textContent === 'Revert') : null
      if (chip) {
        chip.click()
        return true
      }
    }
    return false
  })()`)
  if (!reverted) throw new Error('The change in src/utils.ts has no Revert')
  await toastIs('Reverted a change in utils.ts')
  await expectFile(utilsFile, original, 'the one change is reverted')
  await waitFor(`${heads} === 1`, 10000, 'only the created file is left to review')
  if (!(await click('.toast-action', 'Undo'))) throw new Error('The notice offers no Undo')
  await toastIs('Undid: reverted a change in utils.ts')
  await expectFile(utilsFile, changedUtils, 'Undo brings the change back')
  await waitFor(`${heads} === 2`, 10000, 'the change is back in the review')

  // The created file, deleted from the review, then brought back.
  if (!(await click('.review-pane .rv-file-head:not(.is-pinned) button[aria-label="Delete this file"]'))) throw new Error('The created file has no "Delete this file"')
  await toastIs('Deleted rewind-new.txt')
  if ((await read(createdFile)) !== null) throw new Error('The created file should be gone')
  await waitFor(`${heads} === 1`, 10000, 'only src/utils.ts is left to review')
  if (!(await click('.toast-action', 'Undo'))) throw new Error('The notice offers no Undo')
  await toastIs('Undid: deleted rewind-new.txt')
  await expectFile(createdFile, 'created by the hooks check\n', 'Undo brings the created file back')
  await waitFor(`${heads} === 2`, 10000, 'both files are back in the review')

  // Leave the side panel as it was found.
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.review-pane')", 4000, 'the Review tab closed')
  // The card showed one request; opened again by the person, the tab is back on the scope they chose.
  await key({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true })
  await waitFor("document.querySelector('.review-pane .rv-scope')?.textContent === 'Unstaged'", 6000, 'the Review tab opens on Unstaged again')
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.review-pane')", 4000, 'the Review tab closed again')
  console.log('[smoke] review of a turn: reverted a change and a created file from the Review tab, and undid both')
}

/**
 * MCP servers. The person's own server and the project's are set up in files. Looking at the folder (the banner) starts
 * nothing; the MCP screen starts the person's own server and shows the project's waiting, and the approval needs the
 * folder trusted first. An approved server's tools reach the agent, which asks before each tool and can be told "Always
 * allow" for one tool alone. An entry that changes is stopped until it is approved again, and a server whose file goes
 * is stopped.
 */
async function runMcpChecks() {
  console.log('[smoke] --- mcp servers ---')
  const home = process.env.ENCODE_HOME
  if (!home) {
    console.log('[smoke] mcp: skipped, because ENCODE_HOME is not set and the smoke will not write to your real home folder')
    return
  }
  const server = path.join(root, 'scripts', 'fake-mcp-server.mjs')
  const projectFile = path.join(demoPath, '.mcp.json')
  const userFile = path.join(home, '.encode', 'mcp.json')
  const markers = path.join(path.dirname(demoPath), 'mcp-markers')
  await fs.mkdir(markers, { recursive: true })
  const markerOf = (name) => path.join(markers, `${name}.log`)
  const entry = (name, note) => ({ command: process.execPath, args: [server, `--note=${note}`, `--marker=${markerOf(name)}`] })
  const lines = async (name) => ((await fs.readFile(markerOf(name), 'utf8').catch(() => '')) || '').split(/\r?\n/).filter(Boolean)
  const until = async (check, what, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await sleep(200)
    }
  }
  const cards = () =>
    evaluate(`[...document.querySelectorAll('.mcp-card')].map((card) => ({
      name: card.querySelector('.mcp-name')?.textContent ?? '',
      state: card.querySelector('.mcp-card-top')?.lastElementChild?.textContent ?? '',
      detail: card.querySelector('.mcp-detail')?.textContent ?? '',
      approval: card.querySelector('.mcp-approval')?.textContent ?? '',
      tools: [...card.querySelectorAll('.mcp-tools code')].map((node) => node.textContent),
      buttons: [...card.querySelectorAll('.mcp-actions .btn:not(.mcp-remove)')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
    }))`)
  const card = async (name) => (await cards()).find((item) => item.name === name)
  const cardIs = (name, state) => until(async () => (await card(name))?.state === state, `${name} to read ${state}`)
  const clickIn = (name, text) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.mcp-card')].find((item) => item.querySelector('.mcp-name')?.textContent === ${JSON.stringify(name)})
      const button = [...(card?.querySelectorAll('.btn') ?? [])].find((item) => item.textContent.includes(${JSON.stringify(text)}))
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)

  await evaluate("window.eNCode.permissions.act({ type: 'revoke' })")
  await fs.mkdir(path.dirname(userFile), { recursive: true })
  await fs.writeFile(userFile, JSON.stringify({ mcpServers: { mine: entry('mine', 'user') } }))
  await fs.writeFile(projectFile, JSON.stringify({ mcpServers: { fake: entry('fake', 'v1') } }))

  // Looking starts nothing: the banner names the project's server, and the person's own is not running.
  const looked = await evaluate('window.eNCode.mcp.report({ start: false })')
  const standing = Object.fromEntries(looked.servers.map((item) => [item.name, item.state]))
  if (standing.mine !== 'stopped' || standing.fake !== 'needs-approval') throw new Error(`A look at the folder should find ${JSON.stringify({ mine: 'stopped', fake: 'needs-approval' })}, not ${JSON.stringify(standing)}`)
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await waitFor("!!document.querySelector('.trust-banner')", 8000, 'the banner for the server that waits')
  const banner = await evaluate("document.querySelector('.trust-banner')?.textContent ?? ''")
  if (!/asks to run an MCP server \(fake\)/.test(banner)) throw new Error(`The banner says ${JSON.stringify(banner)}`)
  await screenshot('19-mcp-banner.png')
  if ((await lines('mine')).length || (await lines('fake')).length) throw new Error('Looking at the folder started a server')

  // The MCP screen: the person's own server starts, the project's waits, and approving it needs the folder trusted.
  await click('.trust-banner .btn', 'Review')
  await waitFor("!!document.querySelector('.settings-mcp .mcp-card')", 8000, 'the MCP screen')
  await cardIs('mine', 'Connected')
  await cardIs('fake', 'Needs approval')
  const waiting = await card('fake')
  console.log('[smoke] mcp cards:', JSON.stringify(await cards()))
  if (!/Trust this folder first/.test(waiting.approval)) throw new Error(`The approval card should say the folder needs trust first: ${JSON.stringify(waiting.approval)}`)
  if (!/run this command on your computer/.test(waiting.approval)) throw new Error(`The approval card should say what approving lets happen: ${JSON.stringify(waiting.approval)}`)
  if (!waiting.buttons.some((button) => button.text === 'Approve and start' && button.disabled)) throw new Error(`Approving should wait for trust: ${JSON.stringify(waiting.buttons)}`)
  await screenshot('19-mcp-screen.png')
  if ((await lines('mine')).join() !== 'started') throw new Error(`The person's own server should have started once: ${JSON.stringify(await lines('mine'))}`)
  if ((await lines('fake')).length) throw new Error('The project’s server started before it was approved')

  // Trust the folder in Permissions, come back, approve exactly what the card showed.
  await click('.mcp-card .link-btn', 'Open Permissions')
  await waitFor("!!document.querySelector('.settings-permissions .perm-folder')", 8000, 'the Permissions tab')
  await click('.perm-folder-actions .btn', 'Trust this folder')
  await waitFor("document.querySelector('.perm-folder .ui-chip')?.textContent === 'Trusted'", 8000, 'the folder is trusted')
  await openSettings('MCP servers')
  await waitFor("!!document.querySelector('.settings-mcp .mcp-card')", 8000, 'the MCP screen again')
  await until(async () => (await card('fake'))?.buttons.some((button) => button.text === 'Approve and start' && !button.disabled), 'the approval to be possible')
  if ((await card('fake')).approval.includes('Trust this folder first')) throw new Error('The card still asks for trust')
  if (!(await clickIn('fake', 'Approve and start'))) throw new Error('Could not press Approve and start')
  await cardIs('fake', 'Connected')
  const approved = await card('fake')
  if (JSON.stringify(approved.buttons.map((button) => button.text)) !== JSON.stringify(['Restart', 'Turn off', 'Take back approval'])) throw new Error(`An approved server offers ${JSON.stringify(approved.buttons)}`)
  await evaluate("document.querySelector('.mcp-card[aria-label=\"MCP server fake\"] .mcp-details')?.setAttribute('open', '')")
  const tools = (await card('fake')).tools
  if (JSON.stringify(tools) !== JSON.stringify(['mcp__fake__echo', 'mcp__fake__add'])) throw new Error(`The server's tools are ${JSON.stringify(tools)}`)
  await screenshot('19-mcp-approved.png')
  if ((await lines('fake')).join() !== 'started') throw new Error(`The project's server should have started once, after the approval: ${JSON.stringify(await lines('fake'))}`)

  // Turn the person's own server off and on again; its file stays as it was and the choice is kept in the settings.
  if (!(await clickIn('mine', 'Turn off'))) throw new Error('Could not turn the server off')
  await cardIs('mine', 'Turned off')
  const settingsFile = path.join(home, '.encode', 'settings.json')
  const off = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
  if (JSON.stringify(off.disabledMcpjsonServers) !== JSON.stringify(['mine'])) throw new Error(`The choice was not saved: ${JSON.stringify(off)}`)
  await until(async () => (await lines('mine')).join() === 'started,stopped', 'the server to be stopped in an orderly way')
  if (!(await clickIn('mine', 'Turn on'))) throw new Error('Could not turn the server on')
  await cardIs('mine', 'Connected')

  await closeSettings()
  if (await evaluate("!!document.querySelector('.trust-banner')")) throw new Error('The banner should be gone once nothing waits')

  // The agent gets the tools of both servers, and what the servers say about themselves, as outside notes.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:mcp-check] Use the fake server.')
  await waitFor("!!document.querySelector('.approval-card')", 60000, 'the first tool of the server asks')
  const asking = await evaluate("document.querySelector('.approval-card')?.textContent ?? ''")
  console.log('[smoke] mcp approval card:', JSON.stringify(asking.slice(0, 240)))
  if (!asking.includes('echo') || !asking.includes('fake')) throw new Error('The approval card should name the server and its tool')
  if (!(await click('.approval-card .btn', 'Always allow'))) throw new Error('The approval card offers no Always allow')
  await waitFor("!!document.querySelector('.approval-always')", 4000, 'the Always allow choices')
  const choices = await evaluate("({ rules: document.querySelector('.approval-always-rules')?.textContent, scope: document.querySelector('.approval-scope input:checked')?.value })")
  console.log('[smoke] mcp always allow choices:', JSON.stringify(choices))
  if (choices.rules !== 'mcp__fake__echo') throw new Error(`The card should offer a rule for this tool alone: ${JSON.stringify(choices.rules)}`)
  await click('.approval-always .btn.primary')
  await waitFor("!document.querySelector('.approval-always')", 8000, 'the card goes')
  const asked = await driveAgent('19-mcp')
  console.log('[smoke] mcp approvals after always allow:', JSON.stringify(asked.map((item) => item.detail || item.title)))
  if (asked.length !== 1 || !JSON.stringify(asked[0]).includes('add')) throw new Error(`Only the server's other tool should have asked: ${JSON.stringify(asked)}`)
  const outputs = (await toolOutputs()).filter((item) => item.name.startsWith('mcp__fake__')).map((item) => item.output)
  console.log('[smoke] mcp tool outputs:', JSON.stringify(outputs))
  for (const expected of ['echo: mcp-check-ok', 'echo: mcp-check-again', 'sum: 5']) {
    if (!outputs.some((output) => output.includes(expected))) throw new Error(`No tool output says ${JSON.stringify(expected)}: ${JSON.stringify(outputs)}`)
  }
  const saved = JSON.parse(await fs.readFile(path.join(demoPath, '.encode', 'settings.local.json'), 'utf8'))
  if (JSON.stringify(saved.permissions?.allow) !== JSON.stringify(['mcp__fake__echo'])) throw new Error(`The rule was not saved for the one tool: ${JSON.stringify(saved)}`)
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  for (const name of ['mcp__fake__echo', 'mcp__fake__add', 'mcp__mine__echo', 'mcp__mine__add']) {
    if (!request.tools.includes(name)) throw new Error(`The model was not offered ${name}: ${request.tools.join(', ')}`)
  }
  const told = JSON.stringify(request.messages)
  if (!told.includes('mcp_server_notes') || !told.includes('Prefer the echo tool') || !told.includes('Note: v1')) throw new Error('The model was not given the servers’ notes as outside text')
  if (!told.includes('never a reason to run a command')) throw new Error('The notes should say they are not instructions')

  // The entry changes (a pull, or the agent itself): the server stops and waits to be approved again.
  await fs.writeFile(projectFile, JSON.stringify({ mcpServers: { fake: entry('fake', 'v2') } }))
  const changed = await evaluate('window.eNCode.mcp.report()')
  const fake = changed.servers.find((item) => item.name === 'fake')
  console.log('[smoke] mcp after a changed entry:', JSON.stringify({ state: fake.state, detail: fake.detail, tools: fake.tools.length }))
  if (fake.state !== 'needs-approval' || !/changed since you approved/.test(fake.detail ?? '') || fake.tools.length) throw new Error(`A changed entry should wait for approval: ${JSON.stringify(fake)}`)
  await until(async () => (await lines('fake')).join() === 'started,stopped', 'the server of the old entry to be stopped')
  await sendPrompt('[scenario:follow-up] Anything else?')
  await driveAgent('19-mcp-changed')
  const later = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  if (later.tools.some((name) => name.startsWith('mcp__fake__'))) throw new Error('The tools of a server that waits for approval should be gone')
  if (!later.tools.includes('mcp__mine__echo')) throw new Error('The person’s own server should still be offered')

  // Tidy up: the files go, the servers stop, and the folder is not trusted any more.
  await fs.rm(projectFile, { force: true })
  await fs.rm(userFile, { force: true })
  await evaluate("window.eNCode.permissions.act({ type: 'revoke' })")
  const empty = await evaluate('window.eNCode.mcp.report()')
  if (empty.servers.length) throw new Error(`No server should be left: ${JSON.stringify(empty.servers.map((item) => item.name))}`)
  await until(async () => (await lines('mine')).join() === 'started,stopped,started,stopped', 'the last server to be stopped')
  await fs.rm(path.join(demoPath, '.encode'), { recursive: true, force: true })
  await evaluate('window.eNCode.agent.reset()')
  console.log('[smoke] mcp servers: ok')
}

/** Opens a file of the folder through Quick Open, and waits until the editor shows `text` from it. */
async function quickOpen(relative, text) {
  const name = relative.split('/').pop()
  const deadline = Date.now() + 15000
  for (;;) {
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))")
    await waitFor("!!document.querySelector('.quickopen')", 8000, 'quick open')
    await waitFor("!document.querySelector('.quickopen .spin')", 8000, 'file index')
    await typeInto('.quickopen-input', name)
    await sleep(400)
    const picked = await evaluate(`(() => {
      const item = [...document.querySelectorAll('.quickopen-item')].find((node) => node.textContent.includes(${JSON.stringify(relative)}))
      if (!item) return false
      item.click()
      return true
    })()`)
    if (picked) break
    // A file written a moment ago may not be in the index yet.
    await pressKey('Escape')
    if (Date.now() > deadline) throw new Error(`Quick Open does not find ${relative}`)
    await sleep(500)
  }
  await waitFor(`${RENDERED_LINES}.join('\\n').includes(${JSON.stringify(text)})`, 15000, `${relative} open`)
}

/** What the editor shows of the open file's problems: its marks, the footer's counts and word on its server. */
const EDITOR_MARKS = `(() => ({
  // Marks are drawn as boxes over the text; boxes not in use are hidden, not removed.
  errors: [...document.querySelectorAll('.enc-squiggle-error')].filter((box) => box.style.display !== 'none').length,
  warnings: [...document.querySelectorAll('.enc-squiggle-warning')].filter((box) => box.style.display !== 'none').length,
  gutter: document.querySelectorAll('.enc-gutter-num.enc-gutter-error').length,
  counts: document.querySelector('.editor-footer-count')?.getAttribute('title') ?? '',
  server: document.querySelector('.editor-footer .editor-footer-button:not(.editor-footer-ghost)')?.textContent ?? '',
}))()`

/**
 * Language servers. A test server stands in for typescript-language-server, put in the project's node_modules/.bin
 * the way npm installs one, so it may start only once the folder is trusted. The editor marks what it reports as the
 * text changes, the footer counts it, a mark tells its message when pointed at, and Settings > Language servers and
 * the diagnostics report say the server runs. The agent hears what its edit broke, and the error gate sends it back
 * to fix the error before it may finish.
 */
async function runLanguageServerChecks() {
  console.log('[smoke] --- language servers ---')
  const modules = path.join(demoPath, 'node_modules')
  const bin = path.join(modules, '.bin')
  const serverDir = path.join(modules, 'fake-ts-server')
  const marker = path.join(serverDir, 'marker.log')
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(serverDir, { recursive: true })
  // The package's script: the smoke's server, told where to note what it is given.
  const script = pathToFileURL(path.join(root, 'scripts', 'fake-language-server.mjs')).href
  await fs.writeFile(path.join(serverDir, 'cli.mjs'), `process.argv.push(${JSON.stringify(`--marker=${marker}`)})\nawait import(${JSON.stringify(script)})\n`)
  if (process.platform === 'win32') {
    // What npm writes: eNCode reads the script out of it and starts that with Node, never through cmd.exe.
    await fs.writeFile(path.join(bin, 'typescript-language-server.cmd'), '@ECHO off\r\nnode "%~dp0\\..\\fake-ts-server\\cli.mjs" %*\r\n')
  } else {
    const shim = path.join(bin, 'typescript-language-server')
    await fs.writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/../fake-ts-server/cli.mjs" "$@"\n`)
    await fs.chmod(shim, 0o755)
  }
  const marks = 'export const marks = 1\nconst broken = ERROR\n// WARN: tidy this up\n'
  await evaluate(`window.eNCode.workspace.write('src/lsp-marks.ts', ${JSON.stringify(marks)})`)
  const markerLines = async () => (await fs.readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean)

  const wasTrusted = (await evaluate('window.eNCode.permissions.report()')).trusted
  if (wasTrusted) await evaluate("window.eNCode.permissions.act({ type: 'revoke' })")

  // Not trusted: the file opens without marks, the footer says why, and the project's server is not started.
  await quickOpen('src/lsp-marks.ts', 'const broken = ERROR')
  await waitFor(`${EDITOR_MARKS}.server.includes('folder not trusted')`, 8000, 'the footer says the folder is not trusted')
  await sleep(600)
  const untrusted = await evaluate(EDITOR_MARKS)
  if (untrusted.errors || (await markerLines()).length) throw new Error(`A server ran in a folder that is not trusted: ${JSON.stringify(untrusted)}`)

  // Trusted: the open file gets its server at once, the server found in the project.
  const trust = await evaluate("window.eNCode.permissions.act({ type: 'trust' })")
  if (!trust.ok) throw new Error(`Trusting the folder failed: ${JSON.stringify(trust)}`)
  await waitFor(`(() => { const now = ${EDITOR_MARKS}; return now.errors === 1 && now.warnings === 1 && now.gutter === 1 })()`, 20000, 'the marks of the language server').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(EDITOR_MARKS))}, server: ${(await markerLines()).join(', ')}`)
  })
  await waitFor(`${EDITOR_MARKS}.counts.startsWith('1 error and 1 warning')`, 8000, 'the footer counts the problems')
  const shown = await evaluate(EDITOR_MARKS)
  console.log('[smoke] editor marks:', JSON.stringify(shown))
  if (shown.server !== 'TypeScript and JavaScript') throw new Error(`The footer should name the running server: ${JSON.stringify(shown.server)}`)
  if (!(await markerLines()).includes('open lsp-marks.ts')) throw new Error(`The server was not given the open file: ${(await markerLines()).join(', ')}`)

  // Pointing at a mark tells what it is.
  const spot = await evaluate(`(() => {
    const rect = [...document.querySelectorAll('.enc-squiggle-error')].find((box) => box.style.display !== 'none')?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  if (!spot) throw new Error('No error mark to point at')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y })
  await waitFor("!!document.querySelector('.mark-card .mark-card-message')", 6000, 'the card of the mark')
  const card = await evaluate("document.querySelector('.mark-card')?.textContent ?? ''")
  if (!card.includes('Something is wrong here') || !card.includes('fake-ts(E1)')) throw new Error(`The card should say the message and where it is from: ${JSON.stringify(card)}`)
  await screenshot('20-editor-marks.png')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await waitFor("!document.querySelector('.mark-card')", 6000, 'the card goes when the pointer leaves')

  // Typing: the marks follow the unsaved text, and undo takes them back.
  await focusEditor()
  await pressKey('End', { ctrl: true })
  await send('Input.insertText', { text: ' ERROR' })
  await waitFor(`${EDITOR_MARKS}.errors === 2`, 10000, 'a mark for the error typed')
  if (!(await evaluate(EDITOR_MARKS)).counts.startsWith('2 errors')) throw new Error('The footer does not count the error typed')
  await pressKey('z', { ctrl: true })
  await waitFor(`${EDITOR_MARKS}.errors === 1 && !document.querySelector('.editor-tab.is-dirty')`, 10000, 'the marks after undo')

  await runEditorAssistChecks(markerLines)
  await runEditorChangeChecks(markerLines)
  await runEditorSymbolChecks(markerLines)
  await runEditorStructureChecks(markerLines)
  await runEditorHintsChecks(markerLines)
  await runWrapChecks()
  await runInputChecks()
  await runRandomEditChecks()
  await runLargeFileChecks()

  // Settings > Language servers: the server runs, found in the project, with the open file.
  await openSettings('Language servers')
  await waitFor(`/^Running/.test(document.querySelector('.lsp-server[data-server="typescript"] .lsp-server-state')?.textContent ?? '')`, 8000, 'the server runs in Settings')
  // The count is read when the screen opens and when the window gets focus; a file let go a moment ago may still be in it.
  await until(
    async () => {
      await evaluate("window.dispatchEvent(new Event('focus'))")
      await sleep(250)
      return (await evaluate(`document.querySelector('.lsp-server[data-server="typescript"] .lsp-server-state')?.textContent ?? ''`)).includes('1 file')
    },
    10000,
    'the server counting the one file open',
  ).catch(() => null)
  const row = await evaluate(`(() => {
    const row = document.querySelector('.lsp-server[data-server="typescript"]')
    return { state: row?.querySelector('.lsp-server-state')?.textContent ?? '', detail: row?.querySelector('.lsp-server-detail')?.textContent ?? '', title: document.querySelector('.lsp-state-title')?.textContent ?? '', first: document.querySelector('.lsp-server')?.dataset.server ?? '' }
  })()`)
  console.log('[smoke] language servers screen:', JSON.stringify(row))
  if (!row.state.includes('1 file') || !/the project/.test(row.detail) || row.first !== 'typescript' || !/1 server running/.test(row.title)) {
    const tabs = await evaluate(`[...document.querySelectorAll('.editor-tab .tab-label')].map((node) => node.textContent)`)
    throw new Error(`Settings > Language servers does not say how the server stands: ${JSON.stringify({ ...row, tabs, server: (await markerLines()).slice(-12) })}`)
  }
  await screenshot('ui-dark-settings-language-servers.png')
  await closeSettings()
  // After the screen above, which counts the one server running.
  await runWebLanguageChecks()
  await runInstallOfferChecks()

  // The agent: told what its edit broke, sent back once when it wants to finish, and it fixes the file.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:lsp-gate] Add a gate module.')
  await driveAgent('20-lsp-gate')
  const said = await notices()
  if (!said.some((text) => /still report errors in the files the agent changed/.test(text))) throw new Error(`No notice that the agent was sent back: ${JSON.stringify(said)}`)
  const written = await fs.readFile(path.join(demoPath, 'src', 'lsp-gate.ts'), 'utf8')
  if (written.includes('ERROR')) throw new Error('The agent finished with the error in place')
  const last = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const told = last.messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))).join('\n')
  for (const words of ['The language servers found errors after your changes:\nsrc/lsp-gate.ts: 1 error', 'Before you finish: your changes this turn left errors', 'The language servers checked your changes again:\nsrc/lsp-gate.ts: the errors reported before are fixed.']) {
    if (!told.includes(words)) throw new Error(`The model was not told: ${JSON.stringify(words)}`)
  }
  await screenshot('20-lsp-gate.png')

  // The diagnostics report says how the servers stand, with their last log lines.
  const file = process.env.ENCODE_DIAGNOSTICS_FILE
  if (file) {
    await evaluate('window.eNCode.app.exportDiagnostics()')
    const report = await fs.readFile(file, 'utf8')
    if (!/Language servers in the open folder\n {2}on\n {2}TypeScript and JavaScript: running/.test(report)) throw new Error(`The diagnostics report does not say how the servers stand:\n${report.slice(report.indexOf('Language servers in'), report.indexOf('Language servers in') + 400)}`)
    // The About check makes the report again: it starts from no file.
    await fs.rm(file, { force: true })
  }

  // Tidy up: the tab closes, the folder's trust goes back to how it was, and the server stops with it.
  await click('.editor-tab.is-active .tab-close')
  if (!wasTrusted) await evaluate("window.eNCode.permissions.act({ type: 'revoke' })")
  if (!wasTrusted) await until(async () => (await markerLines()).includes('exit'), 10000, 'the server to stop once the folder is not trusted')
  await evaluate("window.eNCode.workspace.delete('src/lsp-marks.ts').catch(() => null)")
  await evaluate("window.eNCode.workspace.delete('src/lsp-gate.ts').catch(() => null)")
  await fs.rm(modules, { recursive: true, force: true })
  await evaluate('window.eNCode.agent.reset()')
  console.log('[smoke] language servers: ok')
}

/**
 * eNCode's own JSON, CSS and HTML server (ADR 0085), the real one, started from the app's own files with its Node.js:
 * package.json is checked against eNCode's schema, a CSS slip is named with the likely property, and the server is
 * shown as eNCode's in the footer.
 */
async function runWebLanguageChecks() {
  console.log('[smoke] --- JSON, CSS and HTML ---')
  const marks = async (want, label) =>
    waitFor(`(() => { const now = ${EDITOR_MARKS}; return now.warnings === ${want} && now.server.startsWith('JSON, CSS and HTML') })()`, 20000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(EDITOR_MARKS))}`)
    })
  await evaluate(`window.eNCode.workspace.write('web-check/package.json', ${JSON.stringify('{\n  "name": "web-check",\n  "type": "esm"\n}\n')})`)
  await quickOpen('web-check/package.json', '"type": "esm"')
  await marks(1, 'the schema check of package.json')
  const counts = await evaluate(EDITOR_MARKS)
  await evaluate(`window.eNCode.workspace.write('web-check/site.css', ${JSON.stringify('a {\n  colr: red;\n  display: flex;\n}\n')})`)
  await quickOpen('web-check/site.css', 'colr: red')
  await marks(1, 'the unknown CSS property')
  await screenshot('25-web-languages.png')
  for (const name of ['site.css', 'package.json']) {
    if (!(await click(`.editor-tab[title$="web-check/${name}"] .tab-close, .editor-tab[title$="web-check\\\\${name}"] .tab-close`))) throw new Error(`no tab for web-check/${name}`)
    await evaluate(`window.eNCode.workspace.delete('web-check/${name}').catch(() => null)`)
  }
  console.log(`[smoke] JSON, CSS and HTML: ok (${JSON.stringify(counts)})`)
}

/**
 * One-click installs (ADR 0083), offline: a YAML file whose server is missing gets the offer above it, Install… opens
 * the dialog with what would be downloaded (read through the main and agent processes from eNCode's own list), Cancel
 * closes it without installing, and Not now hides the offer for YAML on this computer. Settings offers Install… too.
 */
async function runInstallOfferChecks() {
  console.log('[smoke] --- language server installs ---')
  await evaluate("window.eNCode.workspace.write('lsp-offer.yaml', 'name: demo\\n')")
  await quickOpen('lsp-offer.yaml', 'name: demo')
  const footerText = "document.querySelector('.editor-footer .editor-footer-button:not(.editor-footer-ghost)')?.textContent ?? ''"
  await waitFor(`(${footerText}).startsWith('YAML')`, 10000, 'the footer to name the YAML server')
  const footer = await evaluate(footerText)
  if (footer !== 'YAML: not installed') {
    console.log(`[smoke] a YAML server is already on this computer (${footer}); the offer is not shown`)
  } else {
    await waitFor("!!document.querySelector('.editor-offer')", 8000, 'the offer to install the YAML server')
    if (!(await click('.editor-offer .btn', 'Install'))) throw new Error('no Install button on the offer')
    await waitFor("document.querySelectorAll('.install-server-steps li').length === 3", 15000, 'the install dialog to say what it would do')
    const dialog = await evaluate(`(() => ({
      title: document.querySelector('.install-server-dialog .ui-dialog-title')?.textContent ?? '',
      steps: [...document.querySelectorAll('.install-server-steps li')].map((node) => node.textContent),
      facts: document.querySelector('.install-server-facts')?.textContent ?? '',
    }))()`)
    console.log('[smoke] install dialog:', JSON.stringify(dialog))
    if (!/yaml-language-server 2\.0\.0/.test(dialog.steps[0] ?? '') || !/hash eNCode was built with/.test(dialog.steps[0] ?? '') || !/tools/.test(dialog.facts)) {
      throw new Error(`The install dialog does not say what it would do: ${JSON.stringify(dialog)}`)
    }
    await screenshot('ui-dark-install-server.png')
    if (!(await click('.install-server-dialog .btn', 'Cancel'))) throw new Error('no Cancel in the install dialog')
    await waitFor("!document.querySelector('.install-server-dialog')", 4000, 'the install dialog to close')
    // Settings offers it as well, for the files this folder has.
    await openSettings('Language servers')
    await waitFor(`[...document.querySelectorAll('.lsp-server[data-server="yaml"] .btn')].some((node) => node.textContent.includes('Install'))`, 8000, 'Install… for YAML in Settings')
    await closeSettings()
    if (!(await click('.editor-offer .btn', 'Not now'))) throw new Error('no Not now on the offer')
    await waitFor("!document.querySelector('.editor-offer')", 4000, 'the offer to go after Not now')
    const kept = await evaluate("localStorage.getItem('encode.code.declinedInstalls')")
    if (!kept?.includes('"yaml"')) throw new Error(`Not now was not kept: ${kept}`)
    await evaluate("localStorage.removeItem('encode.code.declinedInstalls')")
  }
  await click('.editor-tab.is-active .tab-close')
  await evaluate("window.eNCode.workspace.delete('lsp-offer.yaml').catch(() => null)")

  // A folder of FiveM resources: Settings offers FiveM's natives under the Lua server, from Cfx.re's pinned packages.
  await evaluate(`window.eNCode.workspace.write('fxmanifest.lua', ${JSON.stringify("fx_version 'cerulean'\ngame 'gta5'\n")})`)
  await openSettings('Language servers')
  const nativesButton = `[...document.querySelectorAll('.lsp-library[data-library="fivem-natives"] .btn')].some((node) => node.textContent.includes('Install'))`
  await waitFor(nativesButton, 10000, 'Install… for FiveM natives under the Lua server')
  if (!(await click('.lsp-library[data-library="fivem-natives"] .btn', 'Install'))) throw new Error('no Install for the FiveM natives')
  await waitFor("document.querySelectorAll('.install-server-steps li').length === 3", 15000, 'the natives install dialog to say what it would do')
  const natives = await evaluate(`(() => ({
    title: document.querySelector('.install-server-dialog .ui-dialog-title')?.textContent ?? '',
    steps: [...document.querySelectorAll('.install-server-steps li')].map((node) => node.textContent),
  }))()`)
  console.log('[smoke] natives dialog:', JSON.stringify(natives))
  if (natives.title !== "Install FiveM's natives for Lua" || !/@citizenfx\/client 2\.0\.37850-1 and @citizenfx\/server 2\.0\.37850-1/.test(natives.steps[0] ?? '') || !/Nothing in them is run/.test(natives.steps[1] ?? '')) {
    throw new Error(`The natives install dialog does not say what it would do: ${JSON.stringify(natives)}`)
  }
  if (!(await click('.install-server-dialog .btn', 'Cancel'))) throw new Error('no Cancel in the natives install dialog')
  await waitFor("!document.querySelector('.install-server-dialog')", 4000, 'the natives install dialog to close')
  await closeSettings()
  await evaluate("window.eNCode.workspace.delete('fxmanifest.lua').catch(() => null)")
  console.log('[smoke] language server installs: ok')
}

/** The middle of the first `word` on the editor's drawn line that holds `lineText`, on screen. */
async function wordSpot(lineText, word) {
  // Where the word is once the view has settled, and only if a click there reaches its line: right after a jump the
  // view may still scroll, or a peek or a bar may be going away, and a click on a spot that moves goes elsewhere.
  const found = await evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const measure = () => {
      const line = [...document.querySelectorAll('.code-editor .enc-line')].find((node) => !node.closest('.enc-zone') && node.textContent.includes(${JSON.stringify(lineText)}))
      const at = line ? line.textContent.indexOf(${JSON.stringify(word)}) : -1
      if (at < 0) return null
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let offset = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent.length
        if (at < offset + length) {
          const range = document.createRange()
          range.setStart(node, at - offset)
          range.setEnd(node, Math.min(length, at - offset + ${word.length}))
          const rect = range.getBoundingClientRect()
          return { line, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
        offset += length
      }
      return null
    }
    let last = null
    let hit = ''
    const started = performance.now()
    while (performance.now() - started < 4000) {
      const spot = measure()
      if (spot) {
        const over = document.elementFromPoint(spot.x, spot.y)
        hit = over ? over.className || over.tagName : 'nothing'
        const steady = last && Math.abs(last.x - spot.x) < 0.5 && Math.abs(last.y - spot.y) < 0.5
        // What the editor's own pointer handling leaves alone (a peek, a widget, a button) does not count.
        const reaches = !!over?.closest('.code-editor') && !over.closest('.enc-zone, .enc-widgets, button, input, textarea')
        if (steady && reaches) return { x: spot.x, y: spot.y }
      }
      last = spot
      await frame()
      await frame()
    }
    return { missing: !last, hit }
  })()`)
  if (!found || found.missing) throw new Error(`"${word}" is not on screen in "${lineText}": ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  if (found.hit !== undefined) throw new Error(`"${word}" in "${lineText}" cannot be clicked: ${found.hit} is over it`)
  return found
}

/** A click of the mouse's main button; `command` holds Ctrl (Cmd on macOS) down. */
async function clickAt(spot, { command = false } = {}) {
  const modifiers = command ? (process.platform === 'darwin' ? 4 : 2) : 0
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1, modifiers })
}

/** Waits for the footer to put the cursor on `line` (and `column`, when given). */
async function cursorAt(line, column, label) {
  const want = column === undefined ? `Ln ${line},` : `Ln ${line}, Col ${column}`
  await waitFor(`(document.querySelector('.editor-footer-side')?.textContent ?? '').includes(${JSON.stringify(want)})`, 8000, label).catch(async (error) => {
    throw new Error(`${error.message}: the footer says ${JSON.stringify(await evaluate("document.querySelector('.editor-footer-side')?.textContent ?? ''"))}`)
  })
}

/** The suggestion list as shown: its rows' labels (without their details), the selected one and the details pane's text. */
const SUGGESTIONS = `(() => {
  const widget = document.querySelector('.suggest-widget')
  if (!widget) return null
  const labelOf = (row) => {
    const label = row?.querySelector('.sw-label')
    const text = label?.textContent ?? ''
    const detail = label?.querySelector('.sw-label-detail')?.textContent ?? ''
    return detail && text.endsWith(detail) ? text.slice(0, -detail.length) : text
  }
  return {
    labels: [...widget.querySelectorAll('.sw-row')].map(labelOf),
    selected: labelOf(widget.querySelector('.sw-row.is-selected')),
    details: widget.querySelector('.sw-details')?.textContent ?? '',
  }
})()`

/**
 * What the language servers add to typing and moving about, against the test server: the symbol's documentation on
 * hover, its other places marked, F12 and Ctrl+click to its definition with Back and Forward, Shift+F12's peek of
 * its references, suggestions as a word is typed with Enter to take one, the parameters of a call as it is typed,
 * a snippet from Ctrl+Space with its stops, and an item that brings its import once taken.
 */
async function runEditorAssistChecks(markerLines) {
  console.log('[smoke] --- editor assist ---')
  const source = 'export function scaleBy(value: number, factor: number): number {\n  return value * factor\n}\n\nexport const scaled = scaleBy(2, 3)\n'
  await evaluate(`window.eNCode.workspace.write('src/lsp-assist.ts', ${JSON.stringify(source)})`)
  await quickOpen('src/lsp-assist.ts', 'export const scaled = scaleBy(2, 3)')
  await until(async () => (await markerLines()).includes('open lsp-assist.ts'), 10000, 'the server to be given the file')
  const call = 'export const scaled = scaleBy(2, 3)'

  // Hover: what the server says of the symbol, its code drawn as code.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  const usage = await wordSpot(call, 'scaleBy')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: usage.x, y: usage.y })
  await waitFor("(document.querySelector('.mark-card .mark-card-docs')?.textContent ?? '').includes('function scaleBy(value: number, factor: number): number')", 8000, 'the documentation on hover')
  const hoverDocs = await evaluate("({ code: !!document.querySelector('.mark-card .mark-card-docs pre'), text: document.querySelector('.mark-card .mark-card-docs')?.textContent ?? '' })")
  if (!hoverDocs.code || !hoverDocs.text.includes('Defined on line 1.')) throw new Error(`The hover does not show the server's answer as written: ${JSON.stringify(hoverDocs)}`)
  await screenshot('21-editor-hover.png')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await waitFor("!document.querySelector('.mark-card')", 6000, 'the hover goes when the pointer leaves')

  // The cursor on the symbol marks its other places in the file.
  await clickAt(usage)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(5, undefined, 'the cursor on the call')
  const symbolMarks = "[...document.querySelectorAll('.code-editor .enc-mark-symbol')].filter((box) => box.style.display !== 'none' && !box.closest('.enc-zone')).length"
  await waitFor(`${symbolMarks} === 2`, 8000, 'the places of the symbol marked').catch(async (error) => {
    throw new Error(`${error.message}: ${await evaluate(symbolMarks)} marked`)
  })

  // F12 to the definition, Back and Forward.
  await pressKey('F12')
  await cursorAt(1, 17, 'F12 goes to the definition')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(5, undefined, 'Alt+Left goes back to the call')
  await pressKey('ArrowRight', { alt: true })
  await cursorAt(1, 17, 'Alt+Right goes forward to the definition')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(5, undefined, 'and back again')

  // Ctrl+click goes to the definition too.
  await clickAt(await wordSpot(call, 'scaleBy'), { command: true })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(1, 17, 'Ctrl+click goes to the definition')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(5, undefined, 'back from the definition Ctrl+click went to')

  // Shift+F12: the references in a peek under the line, the file shown beside the list; Esc closes it.
  await pressKey('F12', { shift: true })
  await waitFor("document.querySelectorAll('.peek .peek-row').length === 2 && document.activeElement?.classList.contains('peek-list')", 8000, 'the peek of the references, with the keys')
  const peekMarked = "[...document.querySelectorAll('.peek-preview .enc-mark-peek')].filter((box) => box.style.display !== 'none').length"
  await waitFor(`${peekMarked} === 1`, 6000, 'the place marked in the preview')
  const peek = await evaluate(`(() => ({
    title: document.querySelector('.peek-title')?.textContent ?? '',
    count: document.querySelector('.peek-count')?.textContent ?? '',
    rows: [...document.querySelectorAll('.peek-row')].map((row) => row.textContent),
  }))()`)
  console.log('[smoke] peek:', JSON.stringify(peek))
  if (peek.title !== 'References' || peek.count !== '2 places' || !peek.rows[0].startsWith('1') || !peek.rows[0].includes('scaleBy') || !peek.rows[1].startsWith('5')) {
    throw new Error(`The peek does not show the references: ${JSON.stringify(peek)}`)
  }
  await screenshot('21-editor-peek.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.peek')", 6000, 'Esc closes the peek')
  await cursorAt(5, undefined, 'the cursor stays where it was')
  // Enter on a place goes there.
  await pressKey('F12', { shift: true })
  await waitFor("!!document.querySelector('.peek .peek-row.is-selected') && document.activeElement?.classList.contains('peek-list')", 8000, 'the peek again')
  await pressKey('Enter')
  await waitFor("!document.querySelector('.peek')", 6000, 'Enter closes the peek')
  await cursorAt(1, 17, 'Enter goes to the place')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(5, undefined, 'back from the place')

  // Suggestions as a word is typed; Enter takes the selected one.
  await focusEditor()
  await pressKey('End', { ctrl: true })
  await send('Input.insertText', { text: 'scaleB' })
  await waitFor(`${SUGGESTIONS}?.selected === 'scaleBy'`, 8000, 'the suggestions as a word is typed').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(SUGGESTIONS))}`)
  })
  await screenshot('21-editor-suggest.png')
  await pressKey('Enter')
  await waitFor(`!document.querySelector('.suggest-widget') && ${RENDERED_LINES}.includes('scaleBy')`, 6000, 'Enter takes the suggestion')

  // The parameters of the call, the one being typed set apart.
  await send('Input.insertText', { text: '(' })
  await waitFor("document.querySelector('.signature-card .sig-active')?.textContent === 'value: number'", 8000, 'the parameters of the call')
  await send('Input.insertText', { text: '2,' })
  await waitFor("document.querySelector('.signature-card .sig-active')?.textContent === 'factor: number'", 8000, 'the next parameter after a comma')
  await screenshot('21-editor-signature.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.signature-card')", 6000, 'Esc closes the parameters')

  // Ctrl+Space, then a snippet: its placeholder selected to type over, Tab to where it ends.
  await pressKey('End')
  await pressKey('Enter')
  await pressKey('Space', { ctrl: true })
  await waitFor(`(${SUGGESTIONS}?.labels.length ?? 0) > 3`, 8000, 'Ctrl+Space lists the suggestions')
  await send('Input.insertText', { text: 'lo' })
  await waitFor(`${SUGGESTIONS}?.selected === 'log'`, 8000, 'the snippet in the list').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(SUGGESTIONS))}`)
  })
  await pressKey('Enter')
  await waitFor(`${RENDERED_LINES}.includes('console.log(value)')`, 6000, 'the snippet inserted')
  await send('Input.insertText', { text: '42' })
  await waitFor(`${RENDERED_LINES}.includes('console.log(42)')`, 6000, 'typing replaces the placeholder')
  await sleep(300)
  await pressKey('Tab')
  await cursorAt(7, 16, 'Tab goes to where the snippet ends')

  // An item the server fills in when it is chosen: its documentation in the details, its import once taken.
  await pressKey('Enter')
  await send('Input.insertText', { text: 'gree' })
  await waitFor(`${SUGGESTIONS}?.selected === 'greet'`, 8000, 'the item to fill in')
  await pressKey('Space', { ctrl: true })
  await waitFor(`(${SUGGESTIONS}?.details ?? '').includes('Says hello to someone')`, 8000, 'the details of the item').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(SUGGESTIONS))}`)
  })
  await screenshot('21-editor-suggest-details.png')
  // The details stay open for the next list until asked again; the smoke leaves them as they were.
  await pressKey('Space', { ctrl: true })
  await waitFor(`${SUGGESTIONS} !== null && !document.querySelector('.sw-details')`, 6000, 'the details closed again')
  await pressKey('Enter')
  await waitFor(`${RENDERED_LINES}[0] === "import { greet } from './greet'" && ${RENDERED_LINES}.includes('greet')`, 8000, 'the import the item brings').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  })
  // An item taken while the server is still filling it in, and typed after at once: its import still comes, above,
  // with the typing where it was.
  await pressKey('Enter')
  await send('Input.insertText', { text: 'farew' })
  await waitFor(`${SUGGESTIONS}?.selected === 'farewell'`, 8000, 'the item filled in slowly')
  await pressKey('Enter')
  await send('Input.insertText', { text: ' // bye' })
  await waitFor(`${RENDERED_LINES}[0] === "import { farewell } from './farewell'" && ${RENDERED_LINES}[1] === "import { greet } from './greet'" && ${RENDERED_LINES}.includes('farewell // bye')`, 8000, 'the import that came after the typing').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  })

  // Tidy up: kept, closed, and the server lets the file go.
  await pressKey('s', { ctrl: true })
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 8000, 'the file saved')
  const typed = await fs.readFile(path.join(demoPath, 'src', 'lsp-assist.ts'), 'utf8')
  for (const line of ["import { farewell } from './farewell'", "import { greet } from './greet'", 'scaleBy(2,', 'console.log(42)', 'greet', 'farewell // bye']) {
    if (!typed.split('\n').some((text) => text.startsWith(line))) throw new Error(`The file does not have "${line}":\n${typed}`)
  }
  await click('.editor-tab.is-active .tab-close')
  await until(async () => (await markerLines()).includes('close lsp-assist.ts'), 10000, 'the server to let the file go')
  await evaluate("window.eNCode.workspace.delete('src/lsp-assist.ts').catch(() => null)")
  console.log('[smoke] editor assist: ok')
}

/** The active tab's file name and the cursor's line, as the footer says. */
const EDITOR_PLACE = `(() => ({
  file: document.querySelector('.editor-tab.is-active .tab-label')?.textContent ?? '',
  line: Number(/Ln (\\d+)/.exec(document.querySelector('.editor-footer-side')?.textContent ?? '')?.[1] ?? 0),
}))()`

/** The open menu's rows: their labels, which are disabled, the section headers and the active one. */
const ACTION_MENU = `(() => {
  const menu = document.querySelector('.code-actions-menu')
  if (!menu) return null
  return {
    label: menu.getAttribute('aria-label'),
    groups: [...menu.querySelectorAll('.ui-menu-group')].map((node) => node.textContent),
    items: [...menu.querySelectorAll('.ui-menu-item')].map((node) => ({ label: node.querySelector('.ui-menu-label')?.textContent ?? '', disabled: node.classList.contains('is-disabled'), active: node.classList.contains('is-active') })),
  }
})()`

/**
 * What the language servers change on request, against the test server: F8 and the Problems panel, the lightbulb and
 * Ctrl+.'s fixes (one resolved when chosen), F2's rename across the folder with its preview, a refused name and
 * Undo for the whole change, a refactoring that runs as the server's command, organizing the imports, formatting the
 * file (one undo step), as `;` is typed and on save.
 */
async function runEditorChangeChecks(markerLines) {
  console.log('[smoke] --- editor changes ---')
  const shape = [
    "import { zeta } from './zeta'",
    "import { alpha } from './alpha'",
    'export function widthOfBox(box: { width: number }): number {',
    '\treturn box.width   ',
    '}',
    'export const total = widthOfBox({ width: 2 }) + ERROR',
    'export const size = 2',
    '',
  ].join('\n')
  const use = "import { widthOfBox } from './lsp-shape'\nexport const doubled = widthOfBox({ width: 4 }) * 2\n"
  await evaluate(`window.eNCode.workspace.write('src/lsp-shape-use.ts', ${JSON.stringify(use)})`)
  await evaluate(`window.eNCode.workspace.write('src/lsp-shape.ts', ${JSON.stringify(shape)})`)
  const read = (name) => fs.readFile(path.join(demoPath, 'src', name), 'utf8')
  await quickOpen('src/lsp-shape.ts', 'export const size = 2')
  await until(async () => (await markerLines()).includes('open lsp-shape.ts'), 10000, 'the server to be given the file')
  await waitFor(`${EDITOR_MARKS}.errors === 1`, 10000, 'the ERROR marked')
  const place = () => evaluate(EDITOR_PLACE)
  const placeIs = async (file, line, label) => {
    await until(async () => {
      const now = await place()
      return now.file.includes(file) && now.line === line
    }, 8000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await place())}`)
    })
  }

  // F8: the next problem, its message beside it; on into the next file with problems, round, and back with Shift+F8.
  await focusEditor()
  await pressKey('Home', { ctrl: true })
  await pressKey('F8')
  await placeIs('lsp-shape.ts', 6, 'F8 goes to the problem in the file')
  await waitFor("(document.querySelector('.mark-card')?.textContent ?? '').includes('Something is wrong here')", 6000, 'the message of the problem F8 went to')
  await screenshot('22-editor-next-problem.png')
  await pressKey('F8')
  await placeIs('lsp-marks.ts', 2, 'F8 goes on to the next file with problems')
  await pressKey('F8')
  await placeIs('lsp-marks.ts', 3, 'F8 to the warning')
  await pressKey('F8', { shift: true })
  await placeIs('lsp-marks.ts', 2, 'Shift+F8 back to the error')
  await pressKey('F8', { shift: true })
  await placeIs('lsp-shape.ts', 6, 'Shift+F8 round to the last file')
  // Escape puts the message away; the pointer is off the text, so nothing brings it back.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await waitFor("!!document.querySelector('.mark-card')", 6000, 'the message of the problem Shift+F8 went to')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.mark-card')", 4000, 'Escape closes the message')

  // The Problems panel: every file's problems, a filter, a row that opens its place.
  await pressKey('y', { ctrl: true, shift: true })
  await waitFor("document.querySelectorAll('.problems-pane .pp-row').length === 3", 8000, 'the Problems panel lists the problems').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate("[...document.querySelectorAll('.problems-pane .pp-file, .problems-pane .pp-row')].map((node) => node.textContent)"))}`)
  })
  const problemFiles = await evaluate("[...document.querySelectorAll('.problems-pane .pp-file .pp-name')].map((node) => node.textContent)")
  if (problemFiles.join() !== 'lsp-marks.ts,lsp-shape.ts') throw new Error(`The Problems panel should group by file in path order: ${JSON.stringify(problemFiles)}`)
  await screenshot('22-problems-panel.png')
  await typeInto('.pp-filter input', 'better')
  await waitFor("document.querySelectorAll('.problems-pane .pp-row').length === 1", 6000, 'the filter keeps the warning')
  await click('.problems-pane .pp-row')
  await placeIs('lsp-marks.ts', 3, 'a row opens its place')
  await typeInto('.pp-filter input', '')
  await pressKey('j', { ctrl: true })
  await waitFor("!!document.querySelector('.bottom-panel.is-closed') || !document.querySelector('.bottom-panel')", 6000, 'Ctrl+J hides the bottom panel')

  // The lightbulb on a line with a fixable problem; Ctrl+. lists the fixes and refactorings, the preferred fix first.
  await quickOpen('src/lsp-shape.ts', 'export const size = 2')
  await focusEditor()
  await pressKey('Home', { ctrl: true })
  for (let step = 0; step < 5; step++) await pressKey('ArrowDown')
  await pressKey('Home')
  await cursorAt(6, 1, 'the cursor at the start of the line with the problem')
  await waitFor("!!document.querySelector('.code-editor .code-bulb')", 8000, 'the lightbulb')
  await screenshot('22-editor-lightbulb.png')
  await pressKey('.', { ctrl: true })
  await waitFor(`${ACTION_MENU}?.items.length === 4`, 8000, 'the fixes and refactorings').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(ACTION_MENU))}`)
  })
  const menu = await evaluate(ACTION_MENU)
  console.log('[smoke] quick fix menu:', JSON.stringify(menu))
  const labels = menu.items.map((item) => item.label)
  if (menu.groups.join() !== 'Quick fixes,Refactor' || labels.join() !== 'Replace ERROR with 0,Add a note about ERROR,Extract to constant,Move to a new file' || !menu.items[0].active || !menu.items[3].disabled) {
    throw new Error(`The quick fix menu is not as the server offers it: ${JSON.stringify(menu)}`)
  }
  await screenshot('22-editor-quick-fix.png')
  // The preferred fix comes without its edit: the server fills it in when it is chosen.
  await pressKey('Enter')
  await waitFor(`${EDITOR_MARKS}.errors === 0 && ${RENDERED_LINES}.includes('export const total = widthOfBox({ width: 2 }) + 0')`, 8000, 'the fix made')
  if (!(await read('lsp-shape.ts')).includes('+ 0\n')) throw new Error('The fix is not on disk: the file had no unsaved changes, so it is written')
  if (await evaluate("!!document.querySelector('.editor-tab.is-dirty')")) throw new Error('The fixed file shows unsaved changes')
  await waitFor("!document.querySelector('.code-editor .code-bulb')", 6000, 'the lightbulb goes with the problem')

  // F2 on a name: the box with it selected; a name the server refuses keeps the box, with its reason.
  const call = 'export const total = widthOfBox({ width: 2 }) + 0'
  await clickAt(await wordSpot(call, 'widthOfBox'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await pressKey('F2')
  await waitFor("document.querySelector('.rename-box .rename-input')?.value === 'widthOfBox' && document.activeElement?.classList.contains('rename-input')", 8000, 'the rename box').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate("({ value: document.querySelector('.rename-box .rename-input')?.value ?? null, focus: document.activeElement?.className ?? null, tag: document.activeElement?.tagName })"))}`)
  })
  await send('Input.insertText', { text: '1bad' })
  await pressKey('Enter')
  await waitFor(`(document.querySelector('.rename-hint.is-error')?.textContent ?? '') === "'1bad' is not a valid name."`, 8000, 'the reason a name is refused').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate("document.querySelector('.rename-box')?.textContent ?? null"))}`)
  })
  await pressKey('a', { ctrl: true })
  await send('Input.insertText', { text: 'measureBox' })
  await waitFor("!document.querySelector('.rename-hint.is-error')", 4000, 'typing another name puts the reason away')
  await screenshot('22-editor-rename.png')
  // Shift+Enter shows what would change in every file, the one not open included.
  await pressKey('Enter', { shift: true })
  await waitFor("document.querySelectorAll('.change-preview .cp-file').length === 2", 8000, 'the preview of the rename')
  const preview = await evaluate(`(() => ({
    title: document.querySelector('.ui-dialog-title')?.textContent ?? '',
    description: document.querySelector('.ui-dialog-description')?.textContent ?? '',
    files: [...document.querySelectorAll('.change-preview .cp-file')].map((node) => ({ path: node.querySelector('.cp-path')?.textContent, lines: [...node.querySelectorAll('.cp-after')].map((line) => line.textContent) })),
  }))()`)
  console.log('[smoke] rename preview:', JSON.stringify(preview))
  if (preview.title !== 'Rename to measureBox' || preview.description !== '4 changes in 2 files' || preview.files.map((file) => file.path).join() !== 'src/lsp-shape-use.ts,src/lsp-shape.ts' || !preview.files[0].lines.some((line) => line.includes('measureBox({ width: 4 })'))) {
    throw new Error(`The preview does not show the rename: ${JSON.stringify(preview)}`)
  }
  if (!(await read('lsp-shape-use.ts')).includes('widthOfBox')) throw new Error('A preview changed a file')
  await screenshot('22-editor-rename-preview.png')
  await click('.ui-dialog .btn', 'Apply')
  await waitFor("!document.querySelector('.change-preview')", 8000, 'the preview closes once applied')
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === 'Rename to measureBox: 4 places in 2 files.')`, 8000, 'the notice of the rename')
  await waitFor(`${RENDERED_LINES}.includes('export const total = measureBox({ width: 2 }) + 0')`, 6000, 'the rename in the editor')
  for (const name of ['lsp-shape.ts', 'lsp-shape-use.ts']) if (!(await read(name)).includes('measureBox(') || (await read(name)).includes('widthOfBox')) throw new Error(`${name} is not renamed on disk`)
  if (await evaluate("!!document.querySelector('.editor-tab.is-dirty')")) throw new Error('The renamed file shows unsaved changes')
  // Undo on the notice takes the whole change back, in both files.
  if (!(await click('.toast-action', 'Undo'))) throw new Error('The notice of the rename offers no Undo')
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === 'Took back the change: Rename to measureBox.')`, 8000, 'the notice of the undo')
  await waitFor(`${RENDERED_LINES}.includes(${JSON.stringify(call)})`, 6000, 'the rename taken back in the editor')
  for (const name of ['lsp-shape.ts', 'lsp-shape-use.ts']) if ((await read(name)).includes('measureBox')) throw new Error(`${name} still has the rename on disk`)
  // And at once with Enter.
  await clickAt(await wordSpot(call, 'widthOfBox'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await pressKey('F2')
  await waitFor("document.activeElement?.classList.contains('rename-input')", 8000, 'the rename box again')
  await send('Input.insertText', { text: 'measureBox' })
  await pressKey('Enter')
  await waitFor(`${RENDERED_LINES}.includes('export const total = measureBox({ width: 2 }) + 0') && !document.querySelector('.rename-box')`, 8000, 'Enter renames')
  if (!(await read('lsp-shape-use.ts')).includes('measureBox(')) throw new Error('The file that is not open is not renamed')

  // A refactoring that runs as the server's command, which asks eNCode to make its edit.
  await focusEditor()
  await pressKey('End', { ctrl: true })
  await pressKey('ArrowUp')
  await pressKey('End')
  await pressKey('ArrowLeft', { shift: true })
  await pressKey('r', { ctrl: true, shift: true })
  await waitFor(`${ACTION_MENU}?.label === 'Refactorings' && ${ACTION_MENU}.items[0]?.label === 'Extract to constant'`, 8000, 'the refactorings for the selection').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(ACTION_MENU))}`)
  })
  await pressKey('Enter')
  await waitFor(`${RENDERED_LINES}.includes('const extracted = 2') && ${RENDERED_LINES}.includes('export const size = extracted')`, 8000, 'the command made its edit').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  })
  if (!(await read('lsp-shape.ts')).includes('const extracted = 2\n')) throw new Error("The command's edit is not on disk")

  // Shift+Alt+O sorts the imports.
  await pressKey('o', { shift: true, alt: true })
  await waitFor(`${RENDERED_LINES}[0] === "import { alpha } from './alpha'" && ${RENDERED_LINES}[1] === "import { zeta } from './zeta'"`, 8000, 'the imports sorted').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  })

  // Shift+Alt+F formats the file as one step of the undo history; Ctrl+Z takes it back.
  const trailing = `${RENDERED_LINES}.some((line) => line.startsWith('\\treturn box.width') && line.endsWith('   '))`
  if (!(await evaluate(trailing))) throw new Error(`The line to format is not there: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  await pressKey('f', { shift: true, alt: true })
  await waitFor(`!${trailing} && !!document.querySelector('.editor-tab.is-dirty')`, 8000, 'the file formatted')
  await pressKey('z', { ctrl: true })
  await waitFor(`${trailing} && !document.querySelector('.editor-tab.is-dirty')`, 8000, 'Ctrl+Z takes the formatting back at once')

  // As `;` is typed, and on save, once they are turned on in Settings > Language servers.
  const formatting = async (on) => {
    await openSettings('Language servers')
    for (const id of ['format-on-type', 'format-on-save']) {
      if ((await evaluate(`document.querySelector('#${id}')?.getAttribute('aria-checked')`)) !== String(on)) await click(`#${id}`)
    }
    await settingIs(`${on ? '' : '!'}settings.formatOnType && ${on ? '' : '!'}settings.formatOnSave`, `formatting turned ${on ? 'on' : 'off'}`)
    await closeSettings()
  }
  await formatting(true)
  await focusEditor()
  await pressKey('End', { ctrl: true })
  await send('Input.insertText', { text: 'let spaced = 1   ;' })
  await waitFor(`${RENDERED_LINES}.includes('let spaced = 1;')`, 8000, 'the line formatted as ; is typed').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(RENDERED_LINES))}`)
  })
  await pressKey('s', { ctrl: true })
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 8000, 'saved')
  const saved = await read('lsp-shape.ts')
  if (/[ \t]+\n/.test(saved) || !saved.includes('let spaced = 1;') || !saved.includes('measureBox')) throw new Error(`The file was not formatted on save:\n${saved}`)
  await formatting(false)

  // Tidy up.
  await click('.editor-tab.is-active .tab-close')
  await until(async () => (await markerLines()).includes('close lsp-shape.ts'), 10000, 'the server to let the file go')
  await evaluate("window.eNCode.workspace.delete('src/lsp-shape.ts').catch(() => null)")
  await evaluate("window.eNCode.workspace.delete('src/lsp-shape-use.ts').catch(() => null)")
  console.log('[smoke] editor changes: ok')
}

/** The breadcrumbs as drawn: each part's label, `›` for the part that lists what the last one holds. */
const CRUMBS = "[...document.querySelectorAll('.breadcrumbs .bc-part')].map((part) => part.querySelector('.bc-label')?.textContent ?? '›')"
/** The outline's rows, and the one the cursor is in. */
const OUTLINE = `(() => ({
  rows: [...document.querySelectorAll('.outline-pane .outline-row .outline-name')].map((node) => node.textContent),
  current: document.querySelector('.outline-pane .outline-row.is-current .outline-name')?.textContent ?? '',
}))()`
/** Go to file's rows: the name of each, and the folder or symbol it is in. */
const QUICK_ROWS = "[...document.querySelectorAll('.quickopen-item')].map((row) => [row.querySelector('.qo-name')?.textContent ?? '', row.querySelector('.qo-dir')?.textContent ?? ''])"
/** The call hierarchy's rows, as name@level, and its title. */
const CALLS = `(() => ({
  title: document.querySelector('.calls-peek .peek-title')?.textContent ?? '',
  rows: [...document.querySelectorAll('.calls-peek .calls-row')].map((row) => row.querySelector('.calls-name').textContent + '@' + row.getAttribute('aria-level')),
  selected: document.querySelector('.calls-peek .calls-row.is-selected .calls-name')?.textContent ?? '',
}))()`

/**
 * Finding one's way by symbols, against the test server: the breadcrumbs follow the cursor and list what is beside
 * each part (by mouse and from Ctrl+Shift+.), the outline beside the text (follow, click, filter, collapse, keys),
 * Go to symbol in the file (Ctrl+Shift+O, previewing as it moves, Esc putting the cursor back) and in the folder
 * (Ctrl+Alt+T, into a file not open), a line from Go to file, and the call hierarchy (Shift+Alt+H) both ways, a
 * level opened from the keys.
 */
async function runEditorSymbolChecks(markerLines) {
  console.log('[smoke] --- editor symbols ---')
  const shapes = [
    'export class Shape {',
    '  constructor(private side: number) {}',
    '  area(): number {',
    '    return this.side * this.side',
    '  }',
    '  describe(): string {',
    '    return `area ${this.area()}`',
    '  }',
    '}',
    '',
    'export function report(shape: Shape): string {',
    '  return shape.describe() + shape.area()',
    '}',
    '',
    'export const LIMIT = 10',
    '',
  ].join('\n')
  const use = "import { report, Shape } from './lsp-symbols'\nexport function printAll(): void {\n  console.log(report(new Shape(2)))\n}\n"
  await evaluate(`window.eNCode.workspace.write('src/lsp-symbols-use.ts', ${JSON.stringify(use)})`)
  await evaluate(`window.eNCode.workspace.write('src/lsp-symbols.ts', ${JSON.stringify(shapes)})`)
  await quickOpen('src/lsp-symbols.ts', 'export const LIMIT = 10')
  await until(async () => (await markerLines()).includes('open lsp-symbols.ts'), 10000, 'the server to be given the file')
  const crumbsAre = (want, label) =>
    waitFor(`JSON.stringify(${CRUMBS}) === ${JSON.stringify(JSON.stringify(want))}`, 8000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(CRUMBS))}`)
    })

  // The breadcrumbs: the folders, the file and the symbols the cursor is in, following it.
  await clickAt(await wordSpot('return this.side * this.side', 'side'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(4, undefined, 'the cursor in area')
  await crumbsAre(['src', 'lsp-symbols.ts', 'Shape', 'area'], 'the breadcrumbs follow the cursor into area')
  await screenshot('24-editor-breadcrumbs.png')

  // A symbol's list holds the ones beside it, the current one checked; choosing one goes there.
  await click('.breadcrumbs .bc-item', 'area')
  await waitFor("document.querySelectorAll('.bc-menu .ui-menu-item').length === 2", 6000, 'the list of what is beside area')
  const listed = await evaluate("[...document.querySelectorAll('.bc-menu .ui-menu-item')].map((item) => [item.querySelector('.ui-menu-label')?.textContent, item.getAttribute('aria-checked')])")
  if (JSON.stringify(listed) !== JSON.stringify([['area', 'true'], ['describe', 'false']])) throw new Error(`The breadcrumbs list ${JSON.stringify(listed)}`)
  await sleep(300)
  await screenshot('24-editor-breadcrumbs-menu.png')
  await click('.bc-menu .ui-menu-item', 'describe')
  await cursorAt(6, 3, 'the breadcrumbs go to describe')
  await crumbsAre(['src', 'lsp-symbols.ts', 'Shape', 'describe'], 'the breadcrumbs say describe')

  // The file's list holds the files beside it, the file checked.
  await click('.breadcrumbs .bc-part.is-file .bc-item')
  await waitFor("[...document.querySelectorAll('.bc-menu .ui-menu-label')].some((node) => node.textContent === 'lsp-symbols-use.ts')", 8000, 'the files beside the file')
  const checked = await evaluate("document.querySelector('.bc-menu .ui-menu-item[aria-checked=\"true\"] .ui-menu-label')?.textContent ?? ''")
  if (checked !== 'lsp-symbols.ts') throw new Error(`The file's list checks ${JSON.stringify(checked)}`)
  await pressKey('Escape')
  await waitFor("!document.querySelector('.bc-menu')", 4000, 'Esc closes the list')

  // Ctrl+Shift+.: the keys to the breadcrumbs, the current symbol's list open on it.
  await focusEditor()
  await pressKey('.', { ctrl: true, shift: true })
  await waitFor("(document.querySelector('.bc-menu .ui-menu-item.is-active .ui-menu-label')?.textContent ?? '') === 'describe'", 6000, 'Ctrl+Shift+. opens the list on describe')
  await pressKey('ArrowUp')
  await pressKey('Enter')
  await cursorAt(3, 3, 'Up and Enter in the list go to area')

  // The outline beside the text: the file's tree, the symbol the cursor is in marked.
  await focusEditor()
  await pressKey('k', { ctrl: true })
  await waitFor("!!document.querySelector('.palette-input')", 4000, 'the palette')
  await typeInto('.palette-input', 'Show outline')
  await waitFor("(document.querySelector('.palette-row.is-active .palette-title')?.textContent ?? '') === 'Show outline'", 4000, 'Show outline in the palette')
  await paletteKey('Enter')
  const outlineIs = (rows, current, label) =>
    waitFor(`(() => { const now = ${OUTLINE}; return JSON.stringify(now.rows) === ${JSON.stringify(JSON.stringify(rows))} && now.current === ${JSON.stringify(current)} })()`, 8000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(OUTLINE))}`)
    })
  await outlineIs(['Shape', 'area', 'describe', 'report', 'LIMIT'], 'area', 'the outline, with area marked')
  await screenshot('24-editor-outline.png')
  await click('.outline-pane .outline-row', 'report')
  await cursorAt(11, 17, 'a row of the outline goes to its symbol')
  await outlineIs(['Shape', 'area', 'describe', 'report', 'LIMIT'], 'report', 'the outline follows to report')
  await typeInto('.outline-filter input', 'desc')
  await outlineIs(['Shape', 'describe'], '', 'the filter keeps describe and what it is in')
  await typeInto('.outline-filter input', '')
  await click('.outline-pane [aria-label="Collapse all"]')
  await outlineIs(['Shape', 'report', 'LIMIT'], 'report', 'Collapse all')
  await evaluate("document.querySelector('.outline-pane .outline-row')?.focus()")
  await pressKey('ArrowRight')
  await outlineIs(['Shape', 'area', 'describe', 'report', 'LIMIT'], 'report', 'Right opens Shape')
  await pressKey('ArrowDown')
  await pressKey('Enter')
  await cursorAt(3, 3, 'Down and Enter in the outline go to area')
  await click('.outline-pane [aria-label="Hide the outline"]')
  await waitFor("!document.querySelector('.outline-pane')", 4000, 'the outline hides')

  // Ctrl+Shift+O: the file's symbols. Moving onto one shows it; Esc puts the cursor back.
  await focusEditor()
  await pressKey('o', { ctrl: true, shift: true })
  await waitFor("document.querySelector('.quickopen-input')?.value === '@' && document.activeElement?.classList.contains('quickopen-input')", 4000, 'Ctrl+Shift+O opens Go to symbol, with the keys')
  await waitFor(`${QUICK_ROWS}.length === 5`, 8000, 'the file has five symbols').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(QUICK_ROWS))}`)
  })
  await typeInto('.quickopen-input', '@desc')
  await waitFor(`JSON.stringify(${QUICK_ROWS}) === ${JSON.stringify(JSON.stringify([['describe', 'Shape']]))}`, 6000, 'the query finds describe in Shape')
  await cursorAt(6, 3, 'the symbol shown as the list moves')
  await screenshot('24-go-to-symbol.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.quickopen')", 4000, 'Go to symbol closes')
  await cursorAt(3, 3, 'Esc puts the cursor back')
  await pressKey('o', { ctrl: true, shift: true })
  await waitFor(`${QUICK_ROWS}.length === 5 && document.activeElement?.classList.contains('quickopen-input')`, 8000, 'Go to symbol again')
  await typeInto('.quickopen-input', '@desc')
  await waitFor(`${QUICK_ROWS}.length === 1`, 6000, 'describe found again')
  await pressKey('Enter')
  await cursorAt(6, 3, 'Enter goes to describe')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(3, 3, 'Back returns to where Go to symbol started')

  // Ctrl+Alt+T: the folder's symbols, into a file not open.
  await pressKey('t', { ctrl: true, alt: true })
  await waitFor("document.querySelector('.quickopen-input')?.value === '#' && document.activeElement?.classList.contains('quickopen-input')", 4000, 'Ctrl+Alt+T opens Go to symbol in the folder, with the keys')
  await typeInto('.quickopen-input', '#printAll')
  await waitFor(`${QUICK_ROWS}.some(([name, where]) => name === 'printAll' && where === 'src/lsp-symbols-use.ts')`, 10000, 'the folder search finds printAll').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(QUICK_ROWS))}`)
  })
  await screenshot('24-folder-symbols.png')
  await pressKey('Enter')
  const place = () => evaluate(EDITOR_PLACE)
  await until(async () => {
    const now = await place()
    return now.file.includes('lsp-symbols-use.ts') && now.line === 2
  }, 10000, 'the folder symbol opens its file at it').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await place())}`)
  })
  await crumbsAre(['src', 'lsp-symbols-use.ts', 'printAll'], 'the breadcrumbs of the other file')
  await pressKey('ArrowLeft', { alt: true })
  await until(async () => (await place()).file.includes('lsp-symbols.ts') && !(await place()).file.includes('-use'), 10000, 'Back to the first file')
  await cursorAt(3, 3, 'Back to area')

  // ":" in Go to file: a line and column of the file shown.
  await pressKey('p', { ctrl: true })
  await waitFor("document.activeElement?.classList.contains('quickopen-input')", 4000, 'Go to file, with the keys')
  await typeInto('.quickopen-input', ':12:5')
  await waitFor(`(${QUICK_ROWS}[0]?.[0] ?? '') === 'Go to line 12, column 5'`, 4000, 'the line offered')
  await pressKey('Enter')
  await cursorAt(12, 5, ':12:5 goes to line 12, column 5')

  // Shift+Alt+H: who calls area, its callers' calls shown in their file; Enter goes to one.
  await clickAt(await wordSpot('area(): number', 'area'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(3, undefined, 'the cursor on area')
  await pressKey('h', { shift: true, alt: true })
  const callsAre = (title, rows, label) =>
    waitFor(`(() => { const now = ${CALLS}; return now.title === ${JSON.stringify(title)} && JSON.stringify(now.rows) === ${JSON.stringify(JSON.stringify(rows))} })()`, 10000, label).catch(async (error) => {
      // Where the cursor and the keys were, what the editor said, and what the server was asked: a miss names its cause.
      const around = await evaluate(`({ footer: document.querySelector('.editor-footer-side')?.textContent ?? '', focus: document.activeElement?.className ?? '', notices: [...document.querySelectorAll('.toast, .editor-message, [role=status]')].map((node) => node.textContent).filter(Boolean).slice(-3) })`)
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(CALLS))} ${JSON.stringify(around)}; the server last heard: ${JSON.stringify((await markerLines()).slice(-6))}`)
    })
  await callsAre('Callers of area', ['area@1', 'describe@2', 'report@2'], 'the callers of area')
  await waitFor("document.activeElement?.classList.contains('calls-list')", 4000, 'the call hierarchy has the keys')
  await pressKey('ArrowDown')
  await waitFor(`${CALLS}.selected === 'describe'`, 4000, 'describe selected')
  const callMarks = "[...document.querySelectorAll('.calls-peek .peek-preview .enc-mark-peek')].filter((box) => box.style.display !== 'none').length"
  await waitFor(`${callMarks} === 1`, 6000, 'the call marked in the preview')
  await screenshot('24-call-hierarchy.png')
  await pressKey('Enter')
  await waitFor("!document.querySelector('.calls-peek')", 4000, 'Enter closes the call hierarchy')
  await cursorAt(7, 25, 'Enter goes to the call in describe')
  await pressKey('ArrowLeft', { alt: true })
  await cursorAt(3, undefined, 'Back to area')

  // And the other way: what report calls, a level further opened with Right.
  await clickAt(await wordSpot('export function report(', 'report'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(11, undefined, 'the cursor on report')
  await pressKey('h', { shift: true, alt: true })
  await callsAre('Callers of report', ['report@1', 'printAll@2'], 'the callers of report, in a file not open')
  await click('.calls-peek .calls-switch-item', 'Calls')
  await callsAre('Calls from report', ['report@1', 'area@2', 'describe@2'], 'what report calls')
  await pressKey('ArrowDown')
  await pressKey('ArrowDown')
  await pressKey('ArrowRight')
  await callsAre('Calls from report', ['report@1', 'area@2', 'describe@2', 'area@3'], 'what describe calls, opened from the keys')
  await screenshot('24-call-hierarchy-calls.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.calls-peek') && !!document.activeElement?.closest('.code-editor')", 4000, 'Esc closes the call hierarchy and gives the keys back')

  // Tidy up.
  for (const name of ['lsp-symbols-use.ts', 'lsp-symbols.ts']) {
    if (await evaluate(`[...document.querySelectorAll('.editor-tab')].some((tab) => tab.querySelector('.tab-label')?.textContent === ${JSON.stringify(name)})`)) {
      await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === ${JSON.stringify(name)})?.querySelector('.tab-close')?.click()`)
    }
  }
  await until(async () => (await markerLines()).includes('close lsp-symbols.ts'), 10000, 'the server to let the file go')
  await evaluate("window.eNCode.workspace.delete('src/lsp-symbols.ts').catch(() => null)")
  await evaluate("window.eNCode.workspace.delete('src/lsp-symbols-use.ts').catch(() => null)")
  console.log('[smoke] editor symbols: ok')
}

/** The line numbers the code editor shows, top to bottom: folded lines are not among them. */
const SHOWN_LINES = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-gutter-num')]
  .filter((node) => node.offsetParent !== null && node.textContent)
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map((node) => Number(node.textContent))`
/** The lines the code editor pins above its text, by number. */
const STICKY_LINES = "[...document.querySelectorAll('.code-editor .enc-sticky:not([hidden]) .enc-sticky-num')].map((node) => Number(node.textContent))"

/** Runs a command from the palette by the title it shows now ("Hide minimap"). */
async function runFromPalette(title) {
  await pressKey('k', { ctrl: true })
  await waitFor("!!document.querySelector('.palette-input')", 4000, 'the palette')
  await typeInto('.palette-input', title)
  await waitFor(`(document.querySelector('.palette-row.is-active .palette-title')?.textContent ?? '') === ${JSON.stringify(title)}`, 4000, `${title} in the palette`)
  await paletteKey('Enter')
  await waitFor("!document.querySelector('.palette-input')", 4000, 'the palette closes')
}

/**
 * The shape of the code in the editor, against the test server: the server's fold ranges (a run of imports, which
 * indentation cannot find), a block folded from its chevron and from the keys with the cursor stepping out of it, the
 * folds kept when another file is shown and back, sticky scroll pinning the class and method the top of the view is
 * in (a click on one goes there), brackets coloured by depth, the minimap (a click scrolls there), and each turned
 * off and on from the View menu's commands.
 */
async function runEditorStructureChecks(markerLines) {
  console.log('[smoke] --- editor structure ---')
  const methods = Array.from({ length: 15 }, (_, index) => [`  method${index}() {`, `    const a = ${index}`, '    const b = a + 1', '    return a + b', '  }']).flat()
  const board = [
    "import { a } from './a'", // 1
    "import { b } from './b'", // 2
    "import { c } from './c'", // 3
    '/*', // 4
    ' * The board and its cells.', // 5
    ' */', // 6
    'export class Board {', // 7
    '  cells = [[1, 2], [3, [4]]]', // 8
    '  fill(value: number) {', // 9
    '    for (const row of this.cells) {', // 10
    '      row.fill(value)', // 11
    '    }', // 12
    '  }', // 13
    ...methods, // 14 to 88: method k from line 14 + 5k, its body to 17 + 5k
    '}', // 89
    '',
  ].join('\n')
  await evaluate(`window.eNCode.workspace.write('src/lsp-structure-other.ts', ${JSON.stringify('export const other = 1\n')})`)
  await evaluate(`window.eNCode.workspace.write('src/lsp-structure.ts', ${JSON.stringify(board)})`)
  await quickOpen('src/lsp-structure.ts', 'export class Board {')
  await until(async () => (await markerLines()).includes('open lsp-structure.ts'), 10000, 'the server to be given the file')
  const shownAre = (want, label) =>
    until(async () => JSON.stringify((await evaluate(SHOWN_LINES)).slice(0, want.length)) === JSON.stringify(want), 8000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(SHOWN_LINES))}`)
    })
  const chevron = (line) =>
    evaluate(`(() => {
      const gutter = document.querySelector('.code-editor > .enc-editor .enc-gutter')?.getBoundingClientRect()
      const row = [...document.querySelectorAll('.code-editor > .enc-editor .enc-gutter-num')].find((node) => node.textContent === ${JSON.stringify(String(line))})
      if (!gutter || !row) return null
      const box = row.getBoundingClientRect()
      return { x: gutter.right - 8, y: box.top + box.height / 2, open: row.classList.contains('enc-fold-open'), closed: row.classList.contains('enc-fold-closed') }
    })()`)

  // The imports fold as the server says: one indentation level has no block to fold there.
  await until(async () => (await chevron(1))?.open === true, 10000, 'the server\'s fold range on the imports').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await chevron(1))}`)
  })
  await clickAt(await chevron(1))
  await shownAre([1, 4, 5, 6, 7], 'the chevron folds the imports')
  if (!(await chevron(1))?.closed) throw new Error('A folded line does not show its chevron closed')
  await screenshot('25-editor-folded.png')

  // From the keys: the block the cursor is in folds, the cursor steps out to its first line, and Ctrl+Shift+] opens it.
  await clickAt(await wordSpot('row.fill(value)', 'fill'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await cursorAt(11, undefined, 'the cursor in the loop')
  await pressKey('[', { ctrl: true, shift: true })
  await cursorAt(10, undefined, 'Ctrl+Shift+[ folds the loop and the cursor leaves its hidden line')
  await until(async () => {
    const shown = await evaluate(SHOWN_LINES)
    return shown.includes(10) && !shown.includes(11) && shown.includes(12)
  }, 6000, 'the loop folded')
  await pressKey('ArrowDown')
  await cursorAt(12, undefined, 'Down steps over the folded line')
  await pressKey('ArrowUp')
  await pressKey(']', { ctrl: true, shift: true })
  await until(async () => (await evaluate(SHOWN_LINES)).includes(11), 6000, 'Ctrl+Shift+] opens the loop')

  // Another file, and back: the imports are still folded.
  await quickOpen('src/lsp-structure-other.ts', 'export const other = 1')
  await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'lsp-structure.ts')?.click()`)
  await waitFor(`${RENDERED_LINES}.join('\\n').includes('export class Board {')`, 8000, 'back to the board')
  await shownAre([1, 4, 5, 6, 7], 'the folds kept while another file was shown')
  await focusEditor()
  await pressKey(']', { ctrl: true, alt: true })
  await shownAre([1, 2, 3, 4], 'Ctrl+Alt+] unfolds everything')

  // Sticky scroll: with method3's body at the top, the class and the method stay pinned above it.
  const lineHeight = await evaluate("document.querySelector('.code-editor > .enc-editor .enc-gutter-num').getBoundingClientRect().height")
  await evaluate(`document.querySelector('.code-editor > .enc-editor .enc-scroller').scrollTop = ${29 * lineHeight}`)
  await until(async () => JSON.stringify(await evaluate(STICKY_LINES)) === JSON.stringify([7, 29]), 6000, 'the class and the method pinned').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(STICKY_LINES))}`)
  })
  const pinned = await evaluate("document.querySelector('.code-editor .enc-sticky-row .enc-sticky-text')?.textContent ?? ''")
  if (pinned !== 'export class Board {') throw new Error(`The first pinned line reads ${JSON.stringify(pinned)}`)
  await screenshot('25-editor-sticky.png')
  const pinnedRow = await evaluate(`(() => {
    const box = document.querySelector('.code-editor .enc-sticky-row .enc-sticky-text').getBoundingClientRect()
    return { x: box.left + 40, y: box.top + box.height / 2 }
  })()`)
  await clickAt(pinnedRow)
  await cursorAt(7, 1, 'a click on the pinned class goes to it')
  await until(async () => (await evaluate(STICKY_LINES)).length === 0, 6000, 'nothing pinned with the class at the top')

  // Brackets by depth: the class's brace is the first colour, the arrays in it the next ones.
  const BRACKETS = `(() => {
    const line = [...document.querySelectorAll('.code-editor > .enc-editor .enc-line')].find((node) => node.textContent.startsWith('  cells'))
    return line ? [...new Set([...line.querySelectorAll('[class*="enc-bracket-"]')].map((node) => [...node.classList].find((name) => name.startsWith('enc-bracket-'))))].sort() : null
  })()`
  await until(async () => JSON.stringify(await evaluate(BRACKETS)) === JSON.stringify(['enc-bracket-1', 'enc-bracket-2', 'enc-bracket-3']), 6000, 'the brackets coloured by depth').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(BRACKETS))}`)
  })
  await runFromPalette('Turn bracket colours off')
  await until(async () => JSON.stringify(await evaluate(BRACKETS)) === '[]', 6000, 'bracket colours off')
  await focusEditor()
  await runFromPalette('Turn bracket colours on')
  await until(async () => (await evaluate(BRACKETS))?.length === 3, 6000, 'bracket colours on again')

  // The minimap, in the side panel at full width: a click on it scrolls the text there.
  await key({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })
  await waitFor("document.querySelector('.side-panel')?.dataset.layout === 'full'", 4000, 'the panel at full width')
  const MINIMAP = `(() => {
    const map = document.querySelector('.code-editor > .enc-editor .enc-minimap')
    if (!map || map.hidden) return null
    const box = map.querySelector('.enc-minimap-canvas').getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + Math.min(box.height - 2, 112), height: box.height }
  })()`
  await until(async () => (await evaluate(MINIMAP))?.height > 0, 6000, 'the minimap beside the text')
  await screenshot('25-editor-minimap.png')
  const scrollTop = () => evaluate("document.querySelector('.code-editor > .enc-editor .enc-scroller').scrollTop")
  const before = await scrollTop()
  await clickAt(await evaluate(MINIMAP))
  await until(async () => (await scrollTop()) > before + 4 * lineHeight, 6000, 'a click on the minimap scrolls the text').catch(async (error) => {
    throw new Error(`${error.message}: ${before} then ${await scrollTop()}`)
  })
  await focusEditor()
  await runFromPalette('Hide minimap')
  await until(async () => (await evaluate(MINIMAP)) === null, 6000, 'the minimap hidden')
  await focusEditor()
  await runFromPalette('Show minimap')
  await until(async () => (await evaluate(MINIMAP)) !== null, 6000, 'the minimap shown again')
  await key({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })
  await waitFor("document.querySelector('.side-panel')?.dataset.layout === 'split'", 4000, 'the panel split again')

  // Folding off: no chevrons, and what was folded opens; on again, the server's ranges are back.
  await focusEditor()
  await pressKey('Home', { ctrl: true })
  await until(async () => (await chevron(1)) !== null, 6000, 'the first line on screen again')
  await clickAt(await chevron(1))
  await shownAre([1, 4], 'the imports folded again')
  await runFromPalette('Turn folding off')
  await until(async () => {
    const first = await chevron(1)
    return first !== null && !first.open && !first.closed
  }, 6000, 'no chevrons with folding off')
  await shownAre([1, 2, 3, 4], 'folding off opens what was folded')
  await focusEditor()
  await runFromPalette('Turn folding on')
  await until(async () => (await chevron(1))?.open === true, 10000, 'the server\'s ranges with folding on again')

  // Tidy up.
  for (const name of ['lsp-structure-other.ts', 'lsp-structure.ts']) {
    await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === ${JSON.stringify(name)})?.querySelector('.tab-close')?.click()`)
  }
  await until(async () => (await markerLines()).includes('close lsp-structure.ts'), 10000, 'the server to let the file go')
  await evaluate("window.eNCode.workspace.delete('src/lsp-structure.ts').catch(() => null)")
  await evaluate("window.eNCode.workspace.delete('src/lsp-structure-other.ts').catch(() => null)")
  console.log('[smoke] editor structure: ok')
}

async function runEditorHintsChecks(markerLines) {
  console.log('[smoke] --- editor hints ---')
  const source = [
    'export function add(left: number, right: number) {', // 1
    '  return left + right', // 2
    '}', // 3
    'export function legacySum(a: number, b: number) {', // 4
    '  return a + b', // 5
    '}', // 6
    'const total = 5', // 7
    'export const sum = add(1, 2) + legacySum(3, total)', // 8
    '',
  ].join('\n')
  await evaluate(`window.eNCode.workspace.write('src/lsp-hints.ts', ${JSON.stringify(source)})`)
  await quickOpen('src/lsp-hints.ts', 'export function add(left: number, right: number) {')
  await until(async () => (await markerLines()).includes('open lsp-hints.ts'), 10000, 'the server to be given the file')
  const INLAYS = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-line')]
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .flatMap((line) => [...line.querySelectorAll('.enc-inlay')].map((hint) => hint.dataset.label))`
  const DEPRECATED = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-line .enc-deprecated')].map((node) => node.textContent)`
  const hintsAre = (want, label) =>
    until(async () => JSON.stringify(await evaluate(INLAYS)) === JSON.stringify(want), 10000, label).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await evaluate(INLAYS))}`)
    })
  const all = [': number', 'left:', 'right:', 'a:', 'b:']

  // The server's hints among the text: a type it worked out and the parameters' names; none of them is text.
  await hintsAre(all, 'the server\'s inlay hints')
  const line8 = await evaluate(`[...document.querySelectorAll('.code-editor > .enc-editor .enc-line')].find((node) => node.textContent.startsWith('export const sum'))?.textContent`)
  if (line8 !== 'export const sum = add(1, 2) + legacySum(3, total)') throw new Error(`The hints changed the line's text: ${JSON.stringify(line8)}`)
  // Semantic colours: the deprecated function struck through where it is declared and where it is called.
  await until(async () => JSON.stringify(await evaluate(DEPRECATED)) === JSON.stringify(['legacySum', 'legacySum']), 10000, 'the deprecated function struck through').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate(DEPRECATED))}`)
  })
  await screenshot('26-editor-hints.png')

  // A call typed: once typing pauses, its hints come.
  await clickAt(await wordSpot('const total = 5', '5'))
  await pressKey('End', { ctrl: true })
  await send('Input.insertText', { text: 'add(7, 8)' })
  await hintsAre([...all, 'left:', 'right:'], 'the hints of a call typed')
  await pressKey('z', { ctrl: true })
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 6000, 'the typing undone')
  await hintsAre(all, 'the hints after undo')

  // Turned off and on from the View menu's commands.
  await focusEditor()
  await runFromPalette('Hide inlay hints')
  await hintsAre([], 'inlay hints hidden')
  await focusEditor()
  await runFromPalette('Show inlay hints')
  await hintsAre(all, 'inlay hints shown again')
  await focusEditor()
  await runFromPalette('Turn semantic colours off')
  await until(async () => (await evaluate(DEPRECATED)).length === 0, 6000, 'semantic colours off')
  await focusEditor()
  await runFromPalette('Turn semantic colours on')
  await until(async () => (await evaluate(DEPRECATED)).length === 2, 10000, 'semantic colours on again')

  // Tidy up.
  await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'lsp-hints.ts')?.querySelector('.tab-close')?.click()`)
  await until(async () => (await markerLines()).includes('close lsp-hints.ts'), 10000, 'the server to let the file go')
  await evaluate("window.eNCode.workspace.delete('src/lsp-hints.ts').catch(() => null)")
  console.log('[smoke] editor hints: ok')
}

/**
 * Word wrap and spaces in the app: Alt+Z wraps a long line into rows that fit, End stops at a row's end before the
 * line's, Show whitespace marks every space and tab, a selection marks its own, and Settings > Editor turns wrapping on.
 */
async function runWrapChecks() {
  console.log('[smoke] --- word wrap and whitespace ---')
  const long = Array.from({ length: 90 }, (_, index) => `word${index}`).join(' ')
  const source = [long, '\tindented with a tab  ', 'short', ''].join('\n')
  await evaluate(`window.eNCode.workspace.write('src/wrap.txt', ${JSON.stringify(source)})`)
  await quickOpen('src/wrap.txt', 'word0 word1')
  const EDITOR = "document.querySelector('.code-editor > .enc-editor')"
  const WRAPPED = `${EDITOR}.classList.contains('enc-wrap')`
  // Rows of the long line as drawn: 0 when it is one row, -1 when it is not drawn.
  const LONG_ROWS = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-line')].find((line) => line.textContent.startsWith('word0 '))?.querySelectorAll('.enc-row').length ?? -1`
  const SIDEWAYS = `(() => { const scroller = ${EDITOR}.querySelector('.enc-scroller'); return scroller.scrollWidth > scroller.clientWidth + 1 })()`
  const MARKS = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-line .enc-ws')].map((node) => node.classList.contains('enc-ws-tab') ? 'tab' : 'space')`
  const FOOTER = "document.querySelector('.editor-footer-side')?.textContent ?? ''"
  const column = async () => Number(/Ln 1, Col (\d+)/.exec(await evaluate(FOOTER))?.[1] ?? 0)
  try {
    if (await evaluate(WRAPPED)) throw new Error('Word wrap is on before it was turned on')
    if (!(await evaluate(SIDEWAYS))) throw new Error('The long line does not run off to the right without word wrap')

    // Alt+Z: the long line in rows that fit the editor, nothing to scroll sideways, its text as it was.
    await focusEditor()
    await pressKey('z', { alt: true })
    await until(async () => (await evaluate(LONG_ROWS)) > 1, 6000, 'the long line wrapped into rows').catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify({ wrapped: await evaluate(WRAPPED), rows: await evaluate(LONG_ROWS) })}`)
    })
    if (await evaluate(SIDEWAYS)) throw new Error('The editor still scrolls sideways with word wrap on')
    if (!(await evaluate(`${RENDERED_LINES}.includes(${JSON.stringify(long)})`))) throw new Error("Wrapping changed the long line's text")
    await screenshot('28-editor-wrap.png')

    // End goes to the end of the row first, then on to the end of the line.
    await focusEditor()
    await pressKey('Home', { ctrl: true })
    await cursorAt(1, 1, 'the cursor at the start of the file')
    await pressKey('End')
    await until(async () => (await column()) > 1, 6000, 'End to the end of the first row')
    const rowEnd = await column()
    if (rowEnd >= long.length + 1) throw new Error(`End went to the end of the line (column ${rowEnd}), not of its first row`)
    await pressKey('End')
    await cursorAt(1, long.length + 1, 'End again to the end of the line')

    // Show whitespace marks every space and tab; hidden again, only a selection's are marked.
    if ((await evaluate(MARKS)).length) throw new Error(`Spaces are marked with nothing selected: ${JSON.stringify(await evaluate(MARKS))}`)
    await focusEditor()
    await runFromPalette('Show whitespace')
    await until(async () => (await evaluate(MARKS)).includes('tab'), 6000, 'every space and tab marked')
    await screenshot('29-editor-whitespace.png')
    await focusEditor()
    await runFromPalette('Hide whitespace')
    await until(async () => (await evaluate(MARKS)).length === 0, 6000, 'the marks gone')
    await focusEditor()
    await pressKey('a', { ctrl: true })
    await until(async () => (await evaluate(MARKS)).length > 3, 6000, 'the spaces in the selection marked')
    await pressKey('ArrowLeft')
    await until(async () => (await evaluate(MARKS)).length === 0, 6000, 'no marks once nothing is selected')

    // Alt+Z turns it off again; Settings > Editor turns it on.
    await pressKey('z', { alt: true })
    await until(async () => !(await evaluate(WRAPPED)) && (await evaluate(LONG_ROWS)) === 0, 6000, 'word wrap off')
    await openSettings('Editor')
    if (!(await click('#word-wrap'))) throw new Error('No word wrap switch in Settings > Editor')
    await waitFor("document.querySelector('#word-wrap')?.getAttribute('aria-checked') === 'true'", 4000, 'the switch on')
    await closeSettings()
    await until(async () => (await evaluate(LONG_ROWS)) > 1, 6000, 'word wrap on from Settings')
    await focusEditor()
    await pressKey('z', { alt: true })
    await until(async () => (await evaluate(LONG_ROWS)) === 0, 6000, 'word wrap off for the checks after these')
  } finally {
    if (await evaluate("!!document.querySelector('.settings-page')").catch(() => false)) await closeSettings().catch(() => null)
    await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'wrap.txt')?.querySelector('.tab-close')?.click()`).catch(() => null)
    await evaluate("window.eNCode.workspace.delete('src/wrap.txt').catch(() => null)").catch(() => null)
  }
  console.log('[smoke] word wrap and whitespace: ok')
}

/**
 * Editor 6 in the app: Windows' own clipboard keys, Ctrl+M for Tab, the screen reader mode from Settings > Editor
 * (the lines around the cursor in the editor's field, notices spoken), and right-to-left text in reading order only
 * inside strings and comments once it is turned on.
 */
async function runInputChecks() {
  console.log('[smoke] --- Windows input, screen readers and right-to-left text ---')
  const hebrew = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
  const source = [`const greeting = "${hebrew}" // ${hebrew}`, 'let first = 1', 'let second = 2', ''].join('\n')
  await evaluate(`window.eNCode.workspace.write('src/input.ts', ${JSON.stringify(source)})`)
  await quickOpen('src/input.ts', 'let first = 1')
  const EDITOR = "document.querySelector('.code-editor > .enc-editor')"
  const TEXT = `${EDITOR}.querySelector('.enc-input')`
  const SAID = `${EDITOR}.querySelector('.enc-announce')?.textContent ?? ''`
  const ISOLATES = `${EDITOR}.querySelectorAll('.enc-line .enc-bidi').length`
  const segment = (setting, label) =>
    evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-setting=${JSON.stringify(setting)}] [role="radio"]')].find((node) => node.textContent === ${JSON.stringify(label)})
      button?.click()
      return Boolean(button)
    })()`)
  try {
    // Shift+Insert pastes what Ctrl+Insert copied, as on any Windows text field.
    await focusEditor()
    await pressKey('Home', { ctrl: true })
    await pressKey('ArrowDown')
    await pressKey('End', { shift: true })
    await pressKey('Insert', { ctrl: true })
    await pressKey('End')
    await pressKey('Enter')
    await pressKey('Insert', { shift: true })
    await until(async () => (await evaluate(RENDERED_LINES)).filter((line) => line === 'let first = 1').length === 2, 6000, 'the line copied with Ctrl+Insert and pasted with Shift+Insert')
    await pressKey('z', { ctrl: true })
    await pressKey('z', { ctrl: true })
    await until(async () => (await evaluate(RENDERED_LINES)).filter((line) => line === 'let first = 1').length === 1, 6000, 'the paste undone')

    // Ctrl+M: Tab leaves the editor, and says so; again: Tab indents.
    await focusEditor()
    await pressKey('m', { ctrl: true })
    await until(async () => (await evaluate(SAID)) === 'Tab now moves the focus.', 4000, 'Ctrl+M said')
    const before = await evaluate(RENDERED_LINES)
    await pressKey('Tab')
    await until(async () => !(await evaluate(`document.activeElement === ${TEXT}`)), 4000, 'Tab moved the focus out of the editor')
    if (JSON.stringify(await evaluate(RENDERED_LINES)) !== JSON.stringify(before)) throw new Error('Tab typed into the editor with Tab moves the focus on')
    await focusEditor()
    await pressKey('m', { ctrl: true })
    await until(async () => (await evaluate(SAID)) === 'Tab now inserts a tab.', 4000, 'Ctrl+M again said')

    // Screen reader mode On: the editor's field holds the lines around the cursor, the cursor in them.
    if (await evaluate(`${TEXT}.value !== ''`)) throw new Error('The editor field holds text with no screen reader')
    await openSettings('Editor')
    if (!(await segment('editor.screenReader', 'On'))) throw new Error('No screen reader mode in Settings > Editor')
    await closeSettings()
    await focusEditor()
    await pressKey('Home', { ctrl: true })
    await pressKey('ArrowDown')
    await until(async () => (await evaluate(`${TEXT}.value`)).includes('let second = 2'), 6000, 'the lines in the editor field')
    const caret = await evaluate(`[${TEXT}.selectionStart, ${TEXT}.value.indexOf('let first')]`)
    if (caret[0] !== caret[1]) throw new Error(`The field's caret is at ${caret[0]}, not at the cursor's line (${caret[1]})`)
    await screenshot('30-editor-screen-reader.png')

    // Right-to-left text: stored order until asked; then the string and the comment read in their own order.
    if (await evaluate(ISOLATES)) throw new Error('Right-to-left text is reordered before it was asked for')
    await openSettings('Editor')
    if (!(await click('#editor-bidi'))) throw new Error('No right-to-left switch in Settings > Editor')
    await waitFor("document.querySelector('#editor-bidi')?.getAttribute('aria-checked') === 'true'", 4000, 'the switch on')
    await closeSettings()
    await until(async () => (await evaluate(ISOLATES)) === 2, 6000, 'the string and the comment in reading order')
    await screenshot('31-editor-right-to-left.png')
  } finally {
    await openSettings('Editor').catch(() => null)
    await segment('editor.screenReader', 'Auto').catch(() => null)
    if (await evaluate("document.querySelector('#editor-bidi')?.getAttribute('aria-checked') === 'true'").catch(() => false)) await click('#editor-bidi').catch(() => null)
    await closeSettings().catch(() => null)
    await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'input.ts')?.querySelector('.tab-close')?.click()`).catch(() => null)
    await evaluate("window.eNCode.workspace.delete('src/input.ts').catch(() => null)").catch(() => null)
  }
  console.log('[smoke] Windows input, screen readers and right-to-left text: ok')
}

/**
 * Random editing in the app, seeded (ENCODE_SMOKE_SEED for another run): keys, typing in several scripts, line moves,
 * undo and redo, saves along the way, in a Lua file with Windows line endings. After it the file on disk is what the
 * editor shows, with Windows line endings throughout; then everything is undone, saved, and the file is byte for byte
 * what it was before the first key.
 */
async function runRandomEditChecks() {
  console.log('[smoke] --- random editing, saved and undone ---')
  const seed = Number(process.env.ENCODE_SMOKE_SEED) || 0x5eed
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const u = (...codes) => String.fromCodePoint(...codes)
  const family = [0x1f468, 0x1f469, 0x1f467].map((code) => u(code)).join(u(0x200d))
  const original = [
    '-- A resource script, edited at random by the smoke',
    'local Config = { speed = 1.5, name = "caf' + u(0xe9) + '" }',
    '',
    'local function greet(player)',
    '\tlocal text = "hello " .. player',
    '\tif #text > 3 then',
    `\t\treturn "${u(0x6f22, 0x5b57)} ${family} ${u(0x1f600)}"`,
    '\tend',
    '\treturn text',
    'end',
    '',
    'RegisterNetEvent("demo:greet", function(id)',
    '  print(greet(id))',
    'end)',
    '',
  ].join('\r\n')
  const relative = 'scripts/random-edit.lua'
  const file = path.join(demoPath, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, original)
  const EDITOR = "document.querySelector('.code-editor > .enc-editor')"
  const SHOWN = `[...${EDITOR}.querySelectorAll('.enc-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((line) => line.textContent)`
  const DIRTY = "!!document.querySelector('.editor-tab.is-dirty')"
  const KEYS = [
    ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'], ['Home'], ['End'], ['ArrowRight', { shift: true }], ['ArrowLeft', { shift: true }],
    ['ArrowDown', { shift: true }], ['End', { shift: true }], ['ArrowRight', { ctrl: true }], ['Backspace'], ['Delete'], ['Backspace', { ctrl: true }],
    ['Enter'], ['Tab'], ['Tab', { shift: true }], ['z', { ctrl: true }], ['y', { ctrl: true }], ['ArrowUp', { alt: true }], ['ArrowDown', { alt: true }],
    ['ArrowDown', { alt: true, shift: true }], ['d', { ctrl: true }], ['Home', { ctrl: true }], ['End', { ctrl: true }],
  ]
  const WORDS = ['local ', 'value', ' = ', '(', ')', '{', '"', 'end', u(0xe9), u(0x5e9, 0x5dc, 0x5d5, 0x5dd), u(0x306b, 0x307b), u(0x1f600), ' -- note']
  const done = []
  try {
    await quickOpen(relative, 'local function greet(player)')
    await focusEditor()
    const steps = Number(process.env.ENCODE_SMOKE_EDIT_STEPS) || 160
    for (let step = 1; step <= steps; step++) {
      const roll = random()
      if (step % 50 === 0) {
        done.push('save')
        await pressKey('s', { ctrl: true })
        await waitFor(`!${DIRTY}`, 8000, `the save at step ${step}`)
      } else if (roll < 0.62) {
        const [key, options] = pick(KEYS)
        // Enter only now and then, so the file stays short enough to be on screen whole.
        if (key === 'Enter' && random() < 0.6) continue
        done.push(`${key}${options ? JSON.stringify(options) : ''}`)
        await pressKey(key, options)
      } else {
        const text = pick(WORDS)
        done.push(JSON.stringify(text))
        await send('Input.insertText', { text })
      }
      if (step % 20 === 0 && !(await evaluate(`document.activeElement === ${EDITOR}.querySelector('.enc-input')`))) {
        throw new Error(`The editor lost the focus by step ${step}`)
      }
    }
    // Saved: the file holds what the editor shows, every line ending a Windows one.
    await pressKey('s', { ctrl: true })
    await waitFor(`!${DIRTY}`, 8000, 'the random edits saved')
    await pressKey('Home', { ctrl: true })
    await sleep(200)
    const saved = await fs.readFile(file, 'utf8')
    if (/(^|[^\r])\n/.test(saved) || /\r(?!\n)/.test(saved)) throw new Error('The saved file mixes line endings')
    const shown = await evaluate(SHOWN)
    if (JSON.stringify(saved.split('\r\n')) !== JSON.stringify(shown)) {
      throw new Error(`The saved file is not what the editor shows:\n${JSON.stringify(saved.split('\r\n'))}\n${JSON.stringify(shown)}`)
    }
    // Everything undone, across the saves: the editor shows the file as it was, and once saved it is that file again.
    let last = ''
    let same = 0
    for (let presses = 0; presses < 600 && same < 4; presses++) {
      await pressKey('z', { ctrl: true })
      await sleep(20)
      const now = JSON.stringify(await evaluate(SHOWN))
      same = now === last ? same + 1 : 0
      last = now
    }
    if (last !== JSON.stringify(original.split('\r\n'))) throw new Error(`Undoing everything does not give the file back:\n${last}`)
    if (await evaluate(DIRTY)) {
      await pressKey('s', { ctrl: true })
      await waitFor(`!${DIRTY}`, 8000, 'the undone file saved')
    }
    const back = await fs.readFile(file)
    if (!back.equals(Buffer.from(original, 'utf8'))) throw new Error(`The file saved after undoing everything is not the file it was (${back.length} bytes, not ${Buffer.byteLength(original)})`)
    await screenshot('32-editor-random-edits.png')
  } catch (error) {
    error.message += `\n  seed ${seed}; steps: ${done.slice(-40).join(' ')}`
    throw error
  } finally {
    await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'random-edit.lua')?.querySelector('.tab-close')?.click()`).catch(() => null)
    await fs.rm(file, { force: true }).catch(() => null)
  }
  console.log(`[smoke] random editing, saved and undone: ok (seed ${seed}, ${done.length} steps)`)
}

/** The most each step with a 100 MB file may take in the app, in milliseconds, on the slowest machine it runs on. */
const LARGE_LIMITS = { open: 15000, end: 4000, colours: 90000, type: 4000, find: 6000, save: 20000, reload: 30000 }

/**
 * A 100 MB file in the app: opened from Quick Open, read through by the highlighting worker (a comment opened on its
 * first line and closed on its last makes every line between a comment, which a guess from the lines above cannot
 * know), shown at its end, typed in, searched, saved, and taken in again when it changes on disk, each in its limit.
 */
async function runLargeFileChecks() {
  console.log('[smoke] --- large file ---')
  const first = '/* A large file: this comment opens here and closes on the last line, so every line between is part of it.'
  const last = "*/ export const last = 'the end of the large file'"
  const lines = [first]
  let size = first.length + 1
  let blocks = 0
  for (; size < 100 * 1024 * 1024; blocks++) {
    const n = blocks
    for (const line of [
      `export function handler${n}(input, options = {}) {`,
      `  const value = input.items.map((item) => item.price * 1.2) // tax ${n}`,
      `  if (!options.quiet) console.log(\`handled \${value.length} items\`, '${n}')`,
      `  return { id: ${n}, total: value.reduce((a, b) => a + b, 0), name: "item-${n}" }`,
      '}',
    ]) {
      lines.push(line)
      size += line.length + 1
    }
  }
  lines.push(last)
  const folder = path.join(demoPath, 'large')
  const file = path.join(folder, 'big-file.js')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(file, lines.join('\n'))
  const bytes = (await fs.stat(file)).size

  // The workers the page starts, as DevTools reports them.
  const workers = []
  const onMessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Target.attachedToTarget' && message.params?.targetInfo?.type === 'worker') workers.push(message.params.targetInfo.url)
  }
  ws.addEventListener('message', onMessage)
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

  const measures = {}
  const within = (name, started) => {
    const ms = Date.now() - started
    measures[name] = ms
    if (ms > LARGE_LIMITS[name]) throw new Error(`${name} took ${ms} ms with a ${Math.round(bytes / 1024 / 1024)} MB file; the limit is ${LARGE_LIMITS[name]} ms`)
  }
  const TEXT_LINES = `[...document.querySelectorAll('.code-editor > .enc-editor .enc-lines .enc-line')]`
  try {
    const opened = Date.now()
    await quickOpen('large/big-file.js', first)
    within('open', opened)
    await until(() => workers.some((url) => /highlight\.worker/.test(url)), 10000, 'the highlighting worker started').catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(workers)}`)
    })
    // The language servers are not given a file this large, and the footer says so.
    await waitFor("[...document.querySelectorAll('.editor-footer-label')].some((node) => node.textContent.endsWith(': file too large'))", 10000, 'the footer saying the file is too large for the servers')

    await focusEditor()
    let started = Date.now()
    await pressKey('End', { ctrl: true })
    await waitFor(`${RENDERED_LINES}.includes(${JSON.stringify(last)})`, LARGE_LIMITS.end + 2000, 'the end of the large file')
    within('end', started)
    // Near the end the lines are drawn as the comment they are in once the worker has read every line above them.
    await waitFor(
      `(() => {
        const lines = ${TEXT_LINES}.filter((line) => line.textContent.startsWith('export function handler'))
        return lines.length > 0 && lines.every((line) => !!line.querySelector('.tok-comment') && !line.querySelector('.tok-keyword'))
      })()`,
      LARGE_LIMITS.colours,
      'the lines near the end coloured as the comment they are in',
    )
    within('colours', opened)
    await screenshot('27-large-file.png')

    started = Date.now()
    await send('Input.insertText', { text: ' // typed at the end' })
    await waitFor(`!!document.querySelector('.editor-tab.is-dirty') && ${RENDERED_LINES}.some((line) => line.endsWith('// typed at the end'))`, LARGE_LIMITS.type + 2000, 'the typing shown')
    within('type', started)

    await pressKey('Home', { ctrl: true })
    await waitFor(`${RENDERED_LINES}.includes(${JSON.stringify(first)})`, 4000, 'back at the top')
    await pressKey('f', { ctrl: true })
    await waitFor("!!document.querySelector('.enc-find')", 6000, 'find widget')
    const target = `export function handler${blocks - 1}(input, options = {}) {`
    started = Date.now()
    await send('Input.insertText', { text: `handler${blocks - 1}(` })
    await waitFor(`${RENDERED_LINES}.includes(${JSON.stringify(target)})`, LARGE_LIMITS.find + 2000, 'the match near the end shown')
    within('find', started)
    await pressKey('Escape')
    await waitFor("!document.querySelector('.enc-find')", 4000, 'find widget closed')

    await focusEditor()
    started = Date.now()
    await pressKey('s', { ctrl: true })
    await waitFor("!document.querySelector('.editor-tab.is-dirty')", LARGE_LIMITS.save + 2000, 'the large file saved')
    within('save', started)
    const saved = (await fs.stat(file)).size
    if (saved !== bytes + ' // typed at the end'.length) throw new Error(`The saved file has ${saved} bytes, not ${bytes + ' // typed at the end'.length}`)

    // Changed on disk by another program: the editor takes the new text in.
    started = Date.now()
    await fs.appendFile(file, '\n// added on disk')
    await focusEditor()
    await until(
      async () => {
        await pressKey('End', { ctrl: true })
        return (await evaluate(RENDERED_LINES)).includes('// added on disk')
      },
      LARGE_LIMITS.reload + 2000,
      'the change on disk taken in',
    )
    within('reload', started)
    if (await evaluate("!!document.querySelector('.editor-tab.is-dirty')")) throw new Error('The large file shows unsaved changes after it was read again')
  } finally {
    await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => null)
    ws.removeEventListener('message', onMessage)
    await evaluate(`[...document.querySelectorAll('.editor-tab')].find((tab) => tab.querySelector('.tab-label')?.textContent === 'big-file.js')?.querySelector('.tab-close')?.click()`).catch(() => null)
    await fs.rm(folder, { recursive: true, force: true })
  }
  console.log(`[smoke] large file (${Math.round(bytes / 1024 / 1024)} MB, ${lines.length} lines):`, JSON.stringify(measures))
}

/** The banner shown while the agent uses the computer is a page of its own, loaded from a data: address. */
async function bannerTargets() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return targets.filter((target) => target.type === 'page' && target.url.startsWith('data:text/html') && target.webSocketDebuggerUrl)
}

async function evaluateInBanner(expression, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    const [banner] = await bannerTargets()
    if (banner) return evaluateOn(banner.webSocketDebuggerUrl, expression)
    if (Date.now() - started > timeoutMs) throw new Error('The computer banner did not appear')
    await sleep(250)
  }
}

/** Waits until no banner page is left; if one stays, says what the page is showing and what else is listed. */
async function waitForBannerToGo(label, timeoutMs = 15000) {
  const started = Date.now()
  while ((await bannerTargets()).length) {
    if (Date.now() - started > timeoutMs) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const shown = await evaluateInBanner(BANNER_STATE, 3000).catch((error) => `unreadable: ${error.message}`)
      throw new Error(`The banner is still up ${timeoutMs} ms after the turn ended (${label}): ${JSON.stringify({ shown, targets: targets.map((t) => ({ type: t.type, title: t.title, url: t.url.slice(0, 40) })) })}`)
    }
    await sleep(250)
  }
}

const BANNER_STATE = `({ mode: document.body.dataset.mode, text: document.getElementById('text').textContent, hint: document.getElementById('hint').textContent, stop: Boolean(document.getElementById('stop')) })`

/** Presses Ctrl+Alt+Esc the way a keyboard does, from outside the app. */
function pressStopShortcut() {
  const script = [
    `Add-Type -Namespace Smoke -Name Keys -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);'`,
    ...[[0x11, 0], [0x12, 0], [0x1b, 0], [0x1b, 2], [0x12, 2], [0x11, 2]].map(([key, flags]) => `[Smoke.Keys]::keybd_event(${key}, 0, ${flags}, [UIntPtr]::Zero)`),
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'inherit', timeout: 60000 })
}

/** A turn that uses the computer waits for the person at a command; the person stops it from the banner, then from the keyboard. */
/** The pages of UI-6b: Usage, Personalization, an agent of your own, the context size, a colour theme, and an MCP server added and removed by form. */
async function runMoreSettingsChecks() {
  console.log('[smoke] --- settings pages ---')
  const home = process.env.ENCODE_HOME
  const toastHas = (text) => `[...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes(${JSON.stringify(text)}))`

  // Usage: the requests this run made were counted, by day and model.
  await openSettings('Usage')
  await waitFor("document.querySelectorAll('[data-setting=\"usage.summary\"] .usage-tile').length >= 3", 8000, 'the usage totals')
  const usage = await evaluate('window.eNCode.agent.usage()')
  if (!usage.some((session) => Object.values(session.days).some((day) => day.requests > 0 && Object.keys(day.models).length > 0))) throw new Error(`No request was counted: ${JSON.stringify(usage).slice(0, 400)}`)
  if (!(await evaluate("!!document.querySelector('[data-setting=\"usage.models\"] .usage-row[data-usage]')"))) throw new Error('The Usage page lists no model')
  await screenshot('settings-usage.png')

  // The context size: kept at once, and sent to the agent.
  await openSettings('Agent')
  if (!(await click('[data-setting="agent.contextCap"] button', '128k'))) throw new Error('No 128k context size')
  await settingIs('settings.contextCap === 128000', 'the context size is kept')
  await click('[data-setting="agent.contextCap"] button', '200k')
  await settingIs('settings.contextCap === 200000', 'the context size is back')

  if (home) {
    // Your instructions: written into ~/.encode/ENCODE.md, which every request reads.
    await openSettings('Personalization')
    await waitFor("!!document.querySelector('.personal-text')", 6000, 'the instructions box')
    await typeInto('.personal-text', 'Prefer pnpm. Answer in short sentences.\n')
    await click('.personal-foot .btn', 'Save')
    await waitFor(toastHas('Saved.'), 6000, 'the instructions saved')
    const written = await fs.readFile(path.join(home, '.encode', 'ENCODE.md'), 'utf8')
    if (!written.startsWith('Prefer pnpm.')) throw new Error(`ENCODE.md holds ${JSON.stringify(written)}`)
    await screenshot('settings-personalization.png')

    // An agent of your own, made from the form and removed again.
    await openSettings('Skills and agents')
    await click('.btn', 'New agent')
    await waitFor("!!document.querySelector('.ui-dialog .form-stack')", 4000, 'the New agent form')
    await typeInto('.ui-dialog .form-stack input', 'smoke-reviewer')
    await typeInto('.ui-dialog .form-stack label:nth-of-type(2) input', 'Reviews a change for the smoke test.')
    await click('.ui-dialog-foot .btn', 'Make the agent')
    await waitFor("!!document.querySelector('.item-row[data-agent=\"smoke-reviewer\"]')", 6000, 'the new agent in the list')
    const agentFile = await fs.readFile(path.join(home, '.encode', 'agents', 'smoke-reviewer.md'), 'utf8')
    if (!agentFile.includes('Reviews a change for the smoke test.')) throw new Error(`The agent file holds ${JSON.stringify(agentFile.slice(0, 200))}`)
    await evaluate("window.eNCode.agents.remove('smoke-reviewer')").catch(() => fs.rm(path.join(home, '.encode', 'agents', 'smoke-reviewer.md'), { force: true }))
    await fs.rm(path.join(home, '.encode', 'ENCODE.md'), { force: true })
  }

  // A colour theme of your own: made from the dark theme, a colour changed, exported and imported back.
  await openSettings('Appearance')
  await click('.theme-new')
  await waitFor("!!document.querySelector('.ui-menu-item')", 4000, 'the New theme menu')
  await click('.ui-menu-item', 'From the dark theme')
  await waitFor("!!document.documentElement.dataset.custom && !!document.querySelector('[data-setting=\"appearance.themeEditor\"]')", 6000, 'the new theme applied, with its editor')
  await evaluate("document.querySelector('.theme-color[title] .theme-hex[aria-label^=\"Accent\"]')?.focus()")
  await typeInto('.theme-hex[aria-label^="Accent"]', '#ff7a90')
  await pressKey('Enter')
  await waitFor("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#ff7a90'", 4000, 'the accent changed at once')
  await waitFor("window.eNCode.settings.get().then((value) => value.appearance.themes[0]?.colors.accent === '#ff7a90')", 4000, 'the theme kept')
  await screenshot('settings-theme.png')
  await click('.theme-foot .btn', 'Export')
  await waitFor(toastHas('Saved My theme'), 6000, 'the theme exported')
  const exported = JSON.parse(await fs.readFile(process.env.ENCODE_THEME_FILE, 'utf8'))
  if (exported.eNCodeTheme !== 1 || exported.colors.accent !== '#ff7a90' || 'id' in exported) throw new Error(`The theme file holds ${JSON.stringify(exported).slice(0, 300)}`)
  await click('.theme-new')
  await waitFor("!!document.querySelector('.ui-menu-item')", 4000, 'the New theme menu')
  await click('.ui-menu-item', 'From a file')
  await waitFor("window.eNCode.settings.get().then((value) => value.appearance.themes.length === 2 && value.appearance.themes[1].name === 'My theme 2')", 6000, 'the theme imported under a free name')
  // Back to eNCode's own colours.
  await click('.theme-card[data-theme-card="built-in"]')
  await waitFor('!document.documentElement.dataset.custom', 4000, 'eNCode’s own colours again')
  const current = await evaluate('window.eNCode.settings.get()')
  await evaluate(`window.eNCode.settings.save({ appearance: ${JSON.stringify({ ...current.appearance, theme: '', themes: [] })} })`)

  // An MCP server added from the form, then removed.
  if (home) {
    await openSettings('MCP servers')
    await click('.mcp-overview .btn', 'Add a server')
    await waitFor("!!document.querySelector('.ui-dialog .mcp-add')", 4000, 'the Add server form')
    await typeInto('.mcp-add input[data-autofocus]', 'smoke-added')
    const server = path.join(root, 'scripts', 'fake-mcp-server.mjs')
    await typeInto('.mcp-add .mcp-add-code', `"${process.execPath}" "${server}" --note=added`)
    await waitFor("document.querySelectorAll('.mcp-add-words code').length === 3", 4000, 'the command shown word by word')
    await click('.ui-dialog-foot .btn', 'Add the server')
    await waitFor("!!document.querySelector('.mcp-card[aria-label=\"MCP server smoke-added\"]')", 8000, 'the added server')
    const userFile = JSON.parse(await fs.readFile(path.join(home, '.encode', 'mcp.json'), 'utf8'))
    if (userFile.mcpServers['smoke-added']?.args?.[1] !== '--note=added') throw new Error(`mcp.json holds ${JSON.stringify(userFile.mcpServers['smoke-added'])}`)
    await screenshot('settings-mcp-added.png')
    await click('.mcp-card[aria-label="MCP server smoke-added"] .mcp-remove')
    await waitFor("!!document.querySelector('.ui-dialog .confirm-body')", 4000, 'the Remove prompt')
    await click('.ui-dialog-foot button', 'Remove the server')
    await waitFor("!document.querySelector('.mcp-card[aria-label=\"MCP server smoke-added\"]')", 8000, 'the server removed')
    const after = JSON.parse(await fs.readFile(path.join(home, '.encode', 'mcp.json'), 'utf8'))
    if ('smoke-added' in after.mcpServers) throw new Error('The removed server is still in mcp.json')
  }
  await closeSettings()
}

async function runComputerChecks() {
  if (process.platform !== 'win32') {
    console.log('[smoke] --- computer use: skipped (Windows only) ---')
    return
  }
  console.log('[smoke] --- computer use ---')
  await evaluate('window.eNCode.agent.reset()')

  // Off until the person turns it on, with the switch in Settings > Agent.
  const initial = await evaluate('window.eNCode.settings.get()')
  if (initial.computerSupported !== true) throw new Error('Windows should offer computer use')
  if (initial.computer !== false) throw new Error('Computer use must be off until the person turns it on')
  await openSettings('Computer use')
  await waitFor("!!document.querySelector('#computer-use')", 4000, 'the computer switch')
  await screenshot('computer-settings.png')
  await click('#computer-use')
  if ((await evaluate("document.querySelector('#computer-use').getAttribute('aria-checked')")) !== 'true') throw new Error('The computer switch did not turn on')
  // Kept as it is switched, with no Save.
  await waitFor('window.eNCode.settings.get().then((value) => value.computer === true)', 8000, 'the computer setting is saved')
  await closeSettings()
  if ((await bannerTargets()).length) throw new Error('A banner is up with nothing using the computer')

  for (const [label, stop] of [
    // The banner closes with the turn, so the click is made after the answer has gone out; a page that is gone cannot answer.
    ['the banner button', () => evaluateInBanner("setTimeout(() => document.getElementById('stop').click(), 50), true")],
    ['Ctrl+Alt+Esc', async () => pressStopShortcut()],
  ]) {
    await sendPrompt('[scenario:computer-check] Look at the desktop, then run a command.')
    // The first use builds the helper that drives windows, which takes a while.
    await waitFor("!!document.querySelector('.approval-card')", 180000, `the command waits for you (${label})`)
    // The card and the banner hear of the wait by two roads, so the banner may be a moment behind the card.
    let banner = await evaluateInBanner(BANNER_STATE)
    for (const started = Date.now(); banner.mode !== 'waiting' && Date.now() - started < 3000; banner = await evaluateInBanner(BANNER_STATE)) await sleep(100)
    console.log(`[smoke] banner (${label}):`, JSON.stringify(banner))
    if (banner.mode !== 'waiting' || banner.text !== 'eNCode is waiting for you' || !banner.stop) throw new Error(`The banner says ${JSON.stringify(banner)} while the agent waits for the person`)
    if (banner.hint !== 'Ctrl+Alt+Esc') throw new Error(`The banner shows no stop key: ${JSON.stringify(banner.hint)}`)
    const rows = await evaluate("[...document.querySelectorAll('.tool-row')].map((row) => row.textContent)")
    if (!rows.some((text) => text.startsWith('Looked at the windows'))) throw new Error(`The work log does not say what the agent looked at: ${JSON.stringify(rows)}`)
    await screenshot('computer-banner.png')
    await stop()
    await waitFor("!document.querySelector('.approval-card')", 15000, `the card goes with the turn (${label})`)
    await waitFor("['idle', 'done'].includes(document.querySelector('.chat-panel')?.dataset.status)", 15000, `the turn ends (${label})`)
    await waitForBannerToGo(label)
    console.log(`[smoke] stopped from ${label}`)
  }

  // Turned off again, so nothing later depends on it.
  await evaluate("window.eNCode.settings.save({ computer: false })")
}

/**
 * The checks before the agent finishes (ADR 0095): after a code change the demo's npm test, found in its package.json,
 * is asked for like any command, runs once allowed, and backs the reply's "all tests pass".
 */
async function runCheckGateChecks() {
  console.log('[smoke] --- checks before the agent finishes ---')
  const utilsFile = path.join(demoPath, 'src', 'utils.ts')
  const original = await fs.readFile(utilsFile, 'utf8')
  await evaluate("window.eNCode.settings.save({ checkGate: 'auto' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:check-gate] Swap the operands of multiply in src/utils.ts')
  const approvals = await driveAgent('15b-check-gate')
  if (approvals.length !== 1 || !approvals[0].title.includes('Check the changes: tests') || !approvals[0].detail.includes('npm test')) {
    throw new Error(`The check should be asked for once, as eNCode's: ${JSON.stringify(approvals)}`)
  }
  const ran = (await toolOutputs()).filter((entry) => entry.name === 'Bash')
  console.log('[smoke] the check:', JSON.stringify(ran))
  if (ran.length !== 1 || ran[0].state !== 'done' || !ran[0].output.includes('ok')) throw new Error('npm test did not run and pass')
  const entries = await evaluate("window.eNCode.agent.history().then((history) => history.entries.map((entry) => ({ kind: entry.kind, text: entry.text ?? '' })))")
  if (!entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('all tests pass'))) throw new Error(`The reply did not reach the person: ${JSON.stringify(entries).slice(0, 400)}`)
  if (entries.some((entry) => entry.kind === 'notice' && /could not confirm|checks failed/.test(entry.text))) throw new Error('A passing check sent the agent back')
  await screenshot('15b-check-gate.png')
  await evaluate("window.eNCode.settings.save({ checkGate: 'off' })")
  await fs.writeFile(utilsFile, original)
}

/**
 * The Reviewer before the agent finishes (ADR 0096): it reads the request, the reply and the change before the person
 * sees the reply, a P1 sends the agent back to fix it, and the reply the person sees is the one after the fix.
 */
async function runReviewGateChecks() {
  console.log('[smoke] --- the Reviewer before the agent finishes ---')
  const averageFile = path.join(demoPath, 'src', 'average.ts')
  const before = await providerStats()
  await evaluate("window.eNCode.settings.save({ reviewWork: 'on' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:review-gate] Add an average function in src/average.ts')
  await driveAgent('15c-review-gate')
  const after = await providerStats()
  if (after.completionReviews - before.completionReviews !== 1) throw new Error(`The Reviewer was asked ${after.completionReviews - before.completionReviews} times, not once`)
  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-completion-review`)).json()
  console.log('[smoke] the Reviewer was asked:', JSON.stringify({ tools: seen.tools.length, user: seen.user.slice(0, 600) }))
  if (seen.tools.length) throw new Error('The Reviewer was given tools')
  if (!/<requests-[0-9a-f]+>[\s\S]*\[scenario:review-gate\] Add an average function/.test(seen.user)) throw new Error('The Reviewer did not see the request')
  if (!/<reply-[0-9a-f]+>\nAdded average in src\/average\.ts\.\n/.test(seen.user)) throw new Error("The Reviewer did not see the agent's reply")
  if (!seen.user.includes('+2 |   return values.reduce((sum, value) => sum + value, 0) / values.length')) throw new Error('The Reviewer did not see the change, numbered')
  const shown = await notices()
  if (!shown.includes("The Reviewer found a problem in the agent's changes, so it goes on to fix it.")) throw new Error(`No notice of the Reviewer: ${JSON.stringify(shown)}`)
  const entries = await evaluate("window.eNCode.agent.history().then((history) => history.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.text ?? ''))")
  if (!entries.at(-1)?.includes('an empty list gives 0')) throw new Error(`The reply after the fix did not reach the person: ${JSON.stringify(entries)}`)
  if (!(await fs.readFile(averageFile, 'utf8')).includes('if (values.length === 0) return 0')) throw new Error('The fix was not written')
  await screenshot('15c-review-gate.png')
  await evaluate("window.eNCode.settings.save({ reviewWork: 'off' })")
  await fs.rm(averageFile, { force: true })
}

/**
 * The second look (ADR 0097): under Full access a recursive delete would run unseen, so the agent's model is asked about
 * it once more with only the request; it does not confirm, the person sees why on the card, and denies it.
 */
async function runSecondLookChecks() {
  console.log('[smoke] --- the second look before a hard-to-undo command ---')
  const legacy = path.join(demoPath, 'src', 'legacy')
  await fs.mkdir(legacy, { recursive: true })
  await fs.writeFile(path.join(legacy, 'old.ts'), 'export const old = 1\n')
  const before = await providerStats()
  await evaluate("window.eNCode.settings.save({ policy: 'full-access', askAgain: 'on' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:second-look] Tidy up the README')
  const approvals = await driveAgent('15d-second-look', 120000, { deny: () => true })
  const after = await providerStats()
  if (after.secondLooks - before.secondLooks !== 1) throw new Error(`The model was asked again ${after.secondLooks - before.secondLooks} times, not once`)
  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-second-look`)).json()
  console.log('[smoke] the second look was asked:', JSON.stringify({ tools: seen.tools.length, user: seen.user.slice(0, 600) }))
  if (seen.tools.length) throw new Error('The second look was given tools')
  if (!/<requests-[0-9a-f]+>\n1\. \[scenario:second-look\] Tidy up the README\n/.test(seen.user)) throw new Error('The second look did not see the request')
  if (!/<command-[0-9a-f]+>\nRemove-Item -Recurse -Force src\/legacy\n/.test(seen.user)) throw new Error('The second look did not see the command')
  if (!seen.user.includes('What makes it hard to undo: it deletes src/legacy and everything in it.')) throw new Error('The second look was not told why')
  console.log('[smoke] the card:', JSON.stringify(approvals))
  if (approvals.length !== 1) throw new Error(`The delete should be asked for once: ${JSON.stringify(approvals)}`)
  if (!approvals[0].reason.includes('This command deletes src/legacy and everything in it.')) throw new Error('The card does not say what makes it hard to undo')
  if (!approvals[0].review.includes('Asked again before it ran, the model did not confirm it: The request is to tidy the README')) throw new Error("The card does not give the model's reason")
  if (!(await fs.stat(path.join(legacy, 'old.ts')).catch(() => null))) throw new Error('The denied delete ran')
  await evaluate("window.eNCode.settings.save({ policy: 'workspace-write', askAgain: 'off' })")
  await fs.rm(legacy, { recursive: true, force: true })
}

/**
 * What a request taught (ADR 0097): a standing rule in the request, and after the answer the Small jobs model's lines
 * for ENCODE.md show below it; the file changes only on Add, under a Conventions heading.
 */
async function runConventionsChecks() {
  console.log('[smoke] --- what a request taught, offered for ENCODE.md ---')
  const file = path.join(demoPath, 'ENCODE.md')
  const original = await fs.readFile(file, 'utf8')
  const before = await providerStats()
  await evaluate("window.eNCode.settings.save({ learnConventions: 'on' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:conventions] From now on, always use pnpm in this repo')
  await driveAgent('15e-conventions')
  await waitFor("!!document.querySelector('.suggestion-card')", 20000, 'the offer below the answer')
  const after = await providerStats()
  if (after.conventionRequests - before.conventionRequests !== 1) throw new Error(`The Small jobs model was asked ${after.conventionRequests - before.conventionRequests} times, not once`)
  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-conventions`)).json()
  console.log('[smoke] the conventions call:', JSON.stringify({ tools: seen.tools.length, user: seen.user.slice(0, 600) }))
  if (seen.tools.length) throw new Error('The conventions call was given tools')
  if (!/<messages-[0-9a-f]+>\n\[scenario:conventions\] From now on, always use pnpm in this repo\n/.test(seen.user)) throw new Error('The conventions call did not see the request')
  if (!/<file-[0-9a-f]+>\n# Smoke project\n/.test(seen.user)) throw new Error('The conventions call did not see ENCODE.md')
  const card = await evaluate("document.querySelector('.suggestion-card')?.textContent ?? ''")
  if (!card.includes('Keep what this request taught in ENCODE.md?') || !card.includes('Use pnpm for installs and scripts, never npm.')) throw new Error(`The card reads ${JSON.stringify(card)}`)
  if ((await fs.readFile(file, 'utf8')) !== original) throw new Error('ENCODE.md changed before Add')
  await screenshot('15e-conventions.png')
  if (!(await click('.suggestion-card .btn.primary'))) throw new Error('The Add button is missing')
  await waitFor("document.querySelector('.suggestion-card')?.dataset.state === 'saved'", 10000, 'the card says the lines were added')
  const now = await fs.readFile(file, 'utf8')
  if (now !== `${original.trimEnd()}\n\n## Conventions\n\n- Use \`pnpm\` for installs and scripts, never \`npm\`.\n`) throw new Error(`ENCODE.md reads ${JSON.stringify(now)}`)
  await fs.writeFile(file, original)
  await evaluate("window.eNCode.settings.save({ learnConventions: 'off' })")
}

async function runSmallerModelChecks() {
  console.log('[smoke] --- help for smaller models, and a stronger model after two setbacks ---')
  const planned = path.join(demoPath, 'src', 'planned.ts')
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'local-mock', helpSmaller: 'auto' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:think-first] Add a planned flag in src/planned.ts')
  await driveAgent('15f-think-first')
  const noticesOf = () => evaluate("window.eNCode.agent.history().then((history) => history.entries.filter((entry) => entry.kind === 'notice').map((entry) => entry.text ?? ''))")
  const notices = await noticesOf()
  if (!notices.some((text) => text.includes('eNCode asked the agent to say what it will change before its first edit.'))) throw new Error(`No notice of the held change: ${JSON.stringify(notices)}`)
  if ((await fs.readFile(planned, 'utf8').catch(() => '')) !== 'export const planned = true\n') throw new Error('src/planned.ts was not written after the plan')
  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const system = seen.messages.filter((message) => message.role === 'system').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n')
  if (!system.includes('# Small, checked steps')) throw new Error('The help for smaller models was not sent')
  const held = seen.messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
  if (!held[0]?.includes('Not run yet. Before the first change of a request')) throw new Error(`The first change was not held: ${JSON.stringify(held)}`)
  const rows = (await toolOutputs()).filter((tool) => tool.name === 'Write')
  if (rows.length !== 1) throw new Error(`The held change should show no row of its own: ${JSON.stringify(rows)}`)
  await screenshot('15f-think-first.png')
  await fs.rm(planned, { force: true })

  await evaluate("window.eNCode.settings.save({ helpSmaller: 'off', offerStronger: 'ask', roles: { planner: ['local-mock:claude-sonnet-4.5'] } })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:stronger] Make add in src/utils.ts return a + b')
  const approvals = await driveAgent('15g-stronger')
  console.log('[smoke] a stronger model asked:', JSON.stringify(approvals.map((card) => card.title)))
  const card = approvals.find((candidate) => candidate.title.includes('take over this request'))
  if (!card || !card.title.includes('Let claude-sonnet-4.5 take over this request?')) throw new Error(`No offer of the stronger model: ${JSON.stringify(approvals)}`)
  if (!/mock-model ran into trouble twice in this request: the same `Edit` call failed twice; and `Edit` failed twice on utils\.ts\./.test(card.detail)) throw new Error(`The offer reads ${JSON.stringify(card.detail)}`)
  const last = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  if (last.model !== 'claude-sonnet-4.5') throw new Error(`The rest of the request went to ${last.model}`)
  const told = await noticesOf()
  if (!told.some((text) => text.includes('claude-sonnet-4.5 does the rest of this request: mock-model ran into trouble twice.'))) throw new Error(`No notice of the take-over: ${JSON.stringify(told)}`)
  await evaluate("window.eNCode.settings.save({ offerStronger: 'off', roles: {} })")
}

/**
 * Test this model (ADR 0101): Roles offers it on a model; the dialog says what it will run before anything starts; the
 * run plays the benchmark's tasks on the mock model, their checks on eNCode's own Node.js; the scores show beside the
 * model in Roles and in the model lists.
 */
async function runModelTestChecks() {
  console.log('[smoke] --- test this model ---')
  const ref = 'local-mock:mock-model'
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'local-mock', roles: {} })")
  await openSettings('Roles')
  const button = `.role-row[data-role="main"] [data-test-model="${ref}"]`
  await waitFor(`!!document.querySelector(${JSON.stringify(button)})`, 6000, 'Test this model beside Main’s model')
  await click(button)
  await waitFor("!!document.querySelector('.model-test-dialog .model-test-skills')", 20000, 'what the test will run')
  const plan = await evaluate(`(() => {
    const dialog = document.querySelector('.model-test-dialog')
    return {
      title: dialog.querySelector('.ui-dialog-title')?.textContent ?? '',
      skills: [...dialog.querySelectorAll('.model-test-skill-name')].map((node) => node.textContent),
      facts: dialog.querySelector('.install-server-facts')?.textContent ?? '',
      cost: dialog.querySelector('.model-test-cost')?.textContent ?? '',
      refused: dialog.querySelector('.install-server-failed')?.textContent ?? '',
      run: [...dialog.querySelectorAll('.ui-dialog-foot .btn')].map((node) => node.textContent),
    }
  })()`)
  console.log('[smoke] test plan:', JSON.stringify(plan))
  if (plan.title !== 'Test mock-model') throw new Error(`The test dialog is titled ${JSON.stringify(plan.title)}`)
  if (plan.skills.join(',') !== 'Writing,Exploring,Reviewing') throw new Error(`The plan names ${JSON.stringify(plan.skills)}`)
  if (!plan.facts.includes('Requests') || !plan.cost.includes('free to call') || plan.refused) throw new Error(`The plan reads ${JSON.stringify(plan)}`)
  if (!plan.run.includes('Run the test')) throw new Error(`No way to start the test: ${JSON.stringify(plan.run)}`)
  await screenshot('58-model-test-plan.png')

  await click('.model-test-dialog .ui-dialog-foot .btn', 'Run the test')
  await waitFor("!!document.querySelector('.model-test-dialog .model-test-progress, .model-test-dialog .model-test-scores')", 20000, 'the test starts')
  await screenshot('58-model-test-running.png')
  await waitFor("!!document.querySelector('.model-test-dialog .model-test-scores')", 300000, 'the test ends')
  const ended = await evaluate(`(() => {
    const dialog = document.querySelector('.model-test-dialog')
    return {
      scores: Object.fromEntries([...dialog.querySelectorAll('.model-test-score')].map((node) => [node.dataset.skill, node.querySelector('.model-test-score-value').textContent])),
      items: [...dialog.querySelectorAll('.model-test-item')].map((node) => ({ id: node.dataset.item, outcome: node.dataset.outcome, reason: node.querySelector('.model-test-item-reason')?.textContent ?? '' })),
      facts: dialog.querySelector('.install-server-facts')?.textContent ?? '',
    }
  })()`)
  console.log('[smoke] test result:', JSON.stringify(ended))
  const outcome = (id) => ended.items.find((item) => item.id === id)
  // The JSON task's check is a node --test run on eNCode's own Node.js: passing it shows the checks run without Node.js installed.
  if (outcome('json-config-edit')?.outcome !== 'passed') throw new Error(`The task the mock does right did not pass: ${JSON.stringify(outcome('json-config-edit'))}`)
  if (outcome('question-no-change')?.outcome !== 'passed' || outcome('trace-event-handler')?.outcome !== 'passed') throw new Error('The questions the mock answers right did not pass')
  const missed = outcome('fix-failing-test')
  if (missed?.outcome !== 'failed' || !missed.reason.startsWith('Not met:') || !missed.reason.includes("the project's tests pass")) throw new Error(`A task the mock gets wrong reads ${JSON.stringify(missed)}`)
  if (ended.scores.writing !== '1/4' || ended.scores.exploring !== '2/2' || !/^[0-2]\/2$/.test(ended.scores.reviewing ?? '')) throw new Error(`The scores are ${JSON.stringify(ended.scores)}`)
  if (!ended.facts.includes('free')) throw new Error(`The cost of a local model reads ${JSON.stringify(ended.facts)}`)
  await screenshot('58-model-test-result.png')
  await click('.model-test-dialog .ui-dialog-foot .btn', 'Done')
  await waitFor("!document.querySelector('.model-test-dialog')", 4000, 'the test dialog closes')

  // The score on the role's own skill, beside the model in Roles and in the list a model is added from.
  await waitFor(`document.querySelector('.role-row[data-role="main"] .role-score')?.dataset.score === '1/4'`, 4000, 'Main’s writing score in Roles')
  await waitFor(`document.querySelector('.role-row[data-role="explore"]') !== null`, 4000, 'the Explore role')
  await click('[data-role-add="explore"]')
  await waitFor(`document.querySelector('.model-picker-item[data-ref="${ref}"] .model-score')?.dataset.score === '2/2'`, 8000, 'Explore’s exploring score in the model list')
  await screenshot('58-model-test-picker.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.model-picker')", 4000, 'the model list closes')
  const kept = await evaluate('window.eNCode.models.testResults()')
  if (kept[ref]?.skills?.writing?.passed !== 1) throw new Error(`The result was not kept: ${JSON.stringify(kept[ref]?.skills)}`)
  await closeSettings()
}

/** The tool entries of the active session, with their outputs. */
async function toolOutputs() {
  return evaluate(`window.eNCode.agent.history().then((history) =>
    history.entries.filter((entry) => entry.kind === 'tool').map((entry) => ({
      name: entry.tool.name,
      state: entry.tool.state,
      output: entry.tool.output ?? '',
    })))`)
}

async function sendPrompt(text) {
  await typeInto('.composer-input', text)
  await sleep(350)
  if (!(await click('.composer-send'))) throw new Error('composer send button not found')
}

/**
 * @ and $ in a message: the pickers write the mention, the file and the skill go to the model with the message, the
 * thread shows only what was typed, and the file counts as read, so the agent edits it without a Read first.
 */
async function runMentionChecks() {
  console.log('[smoke] --- @ and $ mentions ---')
  const utilsFile = path.join(demoPath, 'src', 'utils.ts')
  const original = await fs.readFile(utilsFile, 'utf8')
  await evaluate('window.eNCode.agent.reset()')

  await typeInto('.composer-input', '[scenario:mention-check] Swap the operands in @utils')
  await waitFor(`${pickedOption} === 'utils.ts'`, 8000, '@utils chooses src/utils.ts')
  const folder = await evaluate("document.querySelector('.composer-picker [role=option][aria-selected=true] .palette-detail')?.textContent ?? ''")
  if (folder !== 'src') throw new Error(`the file is shown in "${folder}", not src`)
  await sleep(300)
  await screenshot('ui-dark-mention.png')
  await composerKey({ key: 'Enter' })
  const withFile = '[scenario:mention-check] Swap the operands in @src/utils.ts '
  await waitFor(`document.querySelector('.composer-input').value === ${JSON.stringify(withFile)} && !document.querySelector('.composer-picker')`, 4000, 'the pick writes the file’s path and closes the list')

  await typeInto('.composer-input', `${withFile}following $smoke`)
  await waitFor(`${pickedOption} === '$smoke-skill'`, 8000, '$smoke chooses the skill')
  await composerKey({ key: 'Enter' })
  const typed = `${withFile}following $smoke-skill `
  // The key press that picks also reports the field's old caret: the list must still close.
  await waitFor(`document.querySelector('.composer-input').value === ${JSON.stringify(typed)} && !document.querySelector('.composer-picker')`, 4000, 'the pick writes the skill’s name and closes the list')
  await pressEnterInComposer()

  const approvals = await driveAgent('15-mentions')
  if (approvals.length) throw new Error(`An edit in the folder should not ask: ${JSON.stringify(approvals)}`)
  const edit = (await toolOutputs()).find((entry) => entry.name === 'Edit')
  console.log('[smoke] edit after the mention:', JSON.stringify(edit))
  if (!edit || edit.state !== 'done') throw new Error('The mentioned file did not count as read: the Edit failed')
  if (!(await fs.readFile(utilsFile, 'utf8')).includes('return b + a')) throw new Error('src/utils.ts was not changed')

  const sent = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const userText = sent.messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n')
  if (!userText.includes('<mentioned_files>') || !userText.includes('export function add(a: number, b: number)')) throw new Error('The mentioned file did not go with the message')
  if (!userText.includes('<invoked_skill name="smoke-skill">')) throw new Error('The mentioned skill did not go with the message')
  const shown = await evaluate("document.querySelector('.turn-user')?.textContent ?? ''")
  if (!shown.includes('@src/utils.ts') || !shown.includes('$smoke-skill') || shown.includes('mentioned_files')) throw new Error(`The thread shows the message as ${JSON.stringify(shown)}`)

  await fs.writeFile(utilsFile, original)
  console.log('[smoke] mentions: ok')
}

/**
 * Lines far wider than the thread: with every fold open, the diff, the file read back, the command and its output each
 * scroll in their own box, the reply wraps, and the chat itself never scrolls sideways or grows past its column.
 */
async function runWideLineChecks() {
  console.log('[smoke] --- wide lines ---')
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:wide-lines] Write a long line, change it and print it.')
  await driveAgent('15-wide-lines')
  for (let round = 0; round < 6; round++) {
    const opened = await evaluate(`(() => {
      const closed = [...document.querySelectorAll('.chat-list .worklog-head[aria-expanded=false], .chat-list .tool-row-toggle[aria-expanded=false]')]
      closed.forEach((button) => button.click())
      return closed.length
    })()`)
    if (!opened) break
    await sleep(500)
  }
  const sizes = await evaluate(`(() => {
    const list = document.querySelector('.chat-list')
    const thread = list.querySelector('.thread')
    const boxes = [...list.querySelectorAll('.diff-view, .tool-row-output, .markdown table')]
    return {
      list: { client: list.clientWidth, scroll: list.scrollWidth },
      thread: Math.round(thread.getBoundingClientRect().width),
      boxes: boxes.map((box) => ({ client: box.clientWidth, scroll: box.scrollWidth })),
      steps: list.querySelectorAll('.tool-row').length,
    }
  })()`)
  console.log('[smoke] wide lines:', JSON.stringify(sizes))
  await screenshotSizes('ui-dark-wide-lines')

  if (sizes.steps < 4) throw new Error(`Expected four steps in the thread, found ${sizes.steps}`)
  if (sizes.boxes.filter((box) => box.scroll > box.client + 1).length < 2) throw new Error('The long diff line and the wide table do not each scroll in their own box')
  if (sizes.list.scroll > sizes.list.client + 1) throw new Error(`The chat scrolls sideways: ${sizes.list.scroll} px of content in ${sizes.list.client} px`)
  if (sizes.thread > 784) throw new Error(`The thread grew to ${sizes.thread} px, past its 784 px column`)

  // Copy reply puts the answer on the system clipboard: pasted into the message box, it comes back.
  if (!(await click('.chat-list button[aria-label="Copy reply"]'))) throw new Error('No Copy reply button under the answer')
  await waitFor("!!document.querySelector('.chat-list button[aria-label=\"Copied\"]')", 4000, 'Copy reply says Copied')
  await typeInto('.composer-input', '')
  await evaluate("document.querySelector('.composer-input').focus()")
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 })
  await waitFor("document.querySelector('.composer-input').value.includes('begin_segment00')", 4000, 'the copied reply pastes back')
  await typeInto('.composer-input', '')
  await fs.rm(path.join(demoPath, 'wide.txt'), { force: true })

  // A 1366 x 768 screen with the side panel open: the panels give up width before the thread's column drops under 720 px,
  // while their widths are as shipped. A part that dragged a divider made a width the person's, so it is put back first.
  if (await evaluate("!document.querySelector('.right-wrap.fits') || !document.querySelector('.sidebar-wrap.fits')")) {
    await evaluate("localStorage.removeItem('eNCode.sidepanel.v1'); localStorage.removeItem('eNCode.sidebar.v1')")
    await send('Page.reload')
    await waitFor("!!document.querySelector('.right-wrap.fits') && !!document.querySelector('.sidebar-wrap.fits')", 30000, 'the panels at their shipped widths')
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const small = await evaluate(`(() => ({
    side: Math.round(document.querySelector('.right-wrap:not(.is-hidden):not(.is-full)')?.getBoundingClientRect().width ?? 0),
    sidebar: Math.round(document.querySelector('.sidebar-wrap')?.getBoundingClientRect().width ?? 0),
    main: Math.round(document.querySelector('.app-main').getBoundingClientRect().width),
  }))()`)
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(200)
  console.log('[smoke] 1366 x 768:', JSON.stringify(small))
  if (!small.side) throw new Error('The side panel is not open beside the thread for the 1366 x 768 check')
  if (small.main < 700) throw new Error(`On a 1366 x 768 screen the thread's column is ${small.main} px: the panels took the rest`)
  console.log('[smoke] wide lines and copy: ok')
}

/** Esc twice stops the agent: the first press says what a second does, and the note goes when no second comes. */
async function runStopChecks() {
  console.log('[smoke] --- Esc twice ---')
  const running = "!!document.querySelector('.composer-send.is-stop')"
  const hint = "(document.querySelector('.composer-hint')?.textContent ?? '')"
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:slow-reply] Write a long review.')
  await waitFor(`${running} && document.body.textContent.includes('The parser')`, 20000, 'the long answer streams')
  // While the model writes, the dice rolls beside "Thinking" at the head of the turn's log (ADR 0112).
  const thinking = await evaluate(`(() => {
    const head = document.querySelector('.worklog.is-live .worklog-head')
    const dice = head?.querySelector('.think-dice')
    const cube = dice?.querySelector('.think-dice-cube')
    return head ? { words: head.querySelector('.worklog-label')?.textContent ?? '', clock: head.querySelector('.worklog-clock')?.textContent ?? '', rolling: !!dice?.classList.contains('is-rolling'), animation: cube ? getComputedStyle(cube).animationName : '', faces: dice?.querySelectorAll('.think-dice-face').length ?? 0, size: dice ? Math.round(dice.getBoundingClientRect().width) : 0 } : null
  })()`)
  console.log('[smoke] thinking:', JSON.stringify(thinking))
  if (!thinking || thinking.words !== 'Thinking' || !/^\d+:\d\d$/.test(thinking.clock) || !thinking.rolling || thinking.animation !== 'think-dice-roll' || thinking.faces !== 6 || thinking.size < 14) {
    throw new Error(`The running turn does not show the rolling dice beside "Thinking": ${JSON.stringify(thinking)}`)
  }
  await screenshot('ui-dark-thinking.png')

  await composerKey({ key: 'Escape' })
  await waitFor(`${hint} === 'Press Esc again to stop'`, 2000, 'the first Esc says what a second does')
  await screenshot('ui-dark-stop-hint.png')
  await waitFor(`${hint} === ''`, 4000, 'the note goes when no second Esc comes')
  if (!(await evaluate(running))) throw new Error('One Esc stopped the agent')

  await composerKey({ key: 'Escape' })
  await composerKey({ key: 'Escape' })
  await waitFor(`!${running} && ${hint} === ''`, 10000, 'Esc twice stops the agent')
  if (await evaluate("document.body.textContent.includes('do the work once')")) throw new Error('The answer ran to its end: Esc twice did not stop it')
  const status = await evaluate('window.eNCode.agent.history().then((history) => history.status)')
  if (status !== 'idle') throw new Error(`Esc twice left the agent ${status}`)

  // What was cut off still makes a conversation the provider accepts.
  await sendPrompt('[scenario:follow-up] Carry on after Esc.')
  await driveAgent('15-after-esc')
  console.log('[smoke] Esc twice: ok')
}

/**
 * Pictures and files in the chat box (ADR 0113). A screenshot pasted into the box shows as a thumbnail; a PDF and a
 * text file dropped on it come by name, and a file it cannot take is named in one note. The message shows what came
 * with it. The mock model cannot see pictures: it is sent a note where the picture is, the PDF's text and the file's,
 * and the person is told once that the picture was not shown to it.
 */
async function runAttachChecks() {
  console.log('[smoke] --- pictures and files ---')
  await evaluate('window.eNCode.agent.reset()')
  const tiles = "document.querySelectorAll('.composer-attachments .attachment-picture, .composer-attachments .attachment-chip:not(.is-reading)').length"
  // A screenshot of a large screen on the clipboard, drawn here, pasted into the box.
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 1350
    const context = canvas.getContext('2d')
    context.fillStyle = '#101010'
    context.fillRect(0, 0, 2400, 1350)
    context.fillStyle = '#e04040'
    context.fillRect(200, 200, 900, 500)
    context.fillStyle = '#f2f2f2'
    context.font = '96px sans-serif'
    context.fillText('Error 42', 260, 480)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    const box = document.querySelector('.composer-input')
    box.focus()
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })()`)
  await waitFor("document.querySelector('.composer-attachments .attachment-picture img')?.naturalWidth > 0", 10000, 'the pasted screenshot shows as a thumbnail')
  const title = await evaluate("document.querySelector('.composer-attachments .attachment-picture')?.title ?? ''")
  if (title !== 'Screenshot 1.png, 1568 × 882') throw new Error(`The pasted screenshot is not named and made smaller to send: ${title}`)

  // A PDF and a text file dropped on the box, with a file it cannot take.
  const pdf = (await fs.readFile(path.join(root, '..', '..', 'packages', 'tools', 'src', 'pdf', 'fixtures', 'reportlab.pdf'))).toString('base64')
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(pdf)}), (char) => char.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'report.pdf', { type: 'application/pdf' }))
    data.items.add(new File(['-- the client side\\nlocal ready = true\\n'], 'client.lua', { type: '' }))
    data.items.add(new File([new Uint8Array([77, 90, 0, 1])], 'setup.exe', { type: 'application/x-msdownload' }))
    const card = document.querySelector('.composer-card')
    for (const type of ['dragenter', 'dragover']) card.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    window.__dropped = data
  })()`)
  await waitFor("!!document.querySelector('.composer-card.is-dropping .composer-drop')", 3000, 'a file dragged over the chat box says what a drop does')
  await screenshot('ui-dark-attach-drop.png')
  await evaluate("document.querySelector('.composer-card').dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dropped, bubbles: true, cancelable: true }))")
  await waitFor("!document.querySelector('.composer-drop')", 3000, 'the drop hint goes once the files are dropped')
  await waitFor(`${tiles} === 3`, 10000, 'the dropped PDF and text file join the screenshot')
  await waitFor("[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === 'Not attached: setup.exe is not a picture, a PDF or a text file.')", 5000, 'a note on the file that cannot go')
  await screenshot('ui-dark-attached.png')

  await sendPrompt('[scenario:follow-up] What is wrong in this screenshot?')
  await driveAgent('17-attached')
  const shown = await evaluate(`(() => {
    const message = [...document.querySelectorAll('.turn-user')].at(-1)
    return {
      pictures: message?.querySelectorAll('.bubble-attached img.attached-picture').length ?? 0,
      files: [...(message?.querySelectorAll('.bubble-attached .attachment-name') ?? [])].map((node) => node.textContent),
      words: message?.querySelector('.chat-user-bubble')?.textContent ?? '',
      left: ${tiles},
      told: document.body.textContent.includes('cannot see pictures, so it was told where they are but not shown them'),
    }
  })()`)
  console.log('[smoke] attached:', JSON.stringify(shown))
  if (shown.pictures !== 1 || shown.files.join() !== 'client.lua,report.pdf' || !shown.words.startsWith('[scenario:follow-up] What is wrong') || shown.left !== 0 || !shown.told) {
    throw new Error(`The message does not show what came with it, or the person was not told the model cannot see pictures: ${JSON.stringify(shown)}`)
  }
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const sent = JSON.stringify(request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '')
  const expected = ['<attached_picture name=\\"Screenshot 1.png\\" />', 'A picture is here, but the model in use cannot see pictures.', '--- report.pdf ---\\nPDF report.pdf: 2 pages', '--- client.lua ---\\n-- the client side']
  const missing = expected.filter((part) => !sent.includes(part))
  if (missing.length || sent.includes('image_url')) throw new Error(`The model was not sent what was attached as it should be (missing ${missing.join(' | ') || 'nothing'}): ${sent.slice(0, 600)}`)
  await screenshot('ui-dark-attached-sent.png')
  console.log('[smoke] pictures and files: ok')
}

/**
 * Messages sent while the agent works. By default Enter queues and Ctrl+Enter steers: the Steering row shows until the
 * request takes the message with the command's result, the model reads it, and the thread shows it between the two
 * parts of the turn. With Steer chosen in Settings the keys swap, and a queued message can be steered with its button.
 */
async function runSteerChecks() {
  console.log('[smoke] --- steering a running request ---')
  const steeringRows = "document.querySelectorAll('.queue-row.is-steering').length"
  const queuedRows = "document.querySelectorAll('.queue-row:not(.is-steering)').length"
  const typeAndPress = async (text, init) => {
    await typeInto('.composer-input', text)
    await sleep(250)
    await composerKey({ key: 'Enter', ...init })
  }

  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:steer-check] Run the check.')
  await waitFor("!!document.querySelector('.approval-card')", 30000, 'the command asks first')
  const placeholder = await evaluate("document.querySelector('.composer-input').placeholder")
  if (!placeholder.includes('Ctrl+Enter steers')) throw new Error(`the message box does not say how to steer: ${placeholder}`)
  await typeAndPress('Also say tabs, please.', { ctrlKey: true })
  await waitFor(`${steeringRows} === 1 && ${queuedRows} === 0`, 4000, 'Ctrl+Enter hands the message to the running request')
  if ((await composerValue()) !== '') throw new Error('steering did not clear the message box')
  await screenshot('ui-dark-steering.png')
  await click('.approval-card .btn.primary')
  await driveAgent('16-steer')
  await waitFor("!document.querySelector('.queue-strip')", 4000, 'the Steering row goes once the request took the message')
  await waitFor("document.body.textContent.includes('Steered by: Also say tabs, please. Steer check finished.')", 8000, 'the model read the message')

  const kinds = await evaluate('window.eNCode.agent.history().then((history) => history.entries.map((entry) => entry.kind).join(" "))')
  if (kinds !== 'user assistant tool steer assistant') throw new Error(`the steered turn holds ${kinds}`)
  const sent = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const roles = sent.messages.filter((message) => message.role !== 'system').map((message) => message.role).join(' ')
  if (roles !== 'user assistant tool user') throw new Error(`the provider was sent ${roles}`)
  // One request: the message is a part of the turn, not a turn of its own, and sits between its two parts.
  const thread = await evaluate(`(() => {
    const turns = document.querySelectorAll('.thread > .turn')
    const turn = turns[turns.length - 1]
    const steer = turn?.querySelector('.turn-user.is-steer')
    return {
      turns: turns.length,
      steer: steer?.querySelector('.chat-user-bubble')?.textContent ?? '',
      tag: steer?.querySelector('.msg-steer-tag')?.textContent ?? '',
      logBefore: Boolean(steer?.previousElementSibling?.classList.contains('worklog')),
      answerAfter: steer?.nextElementSibling?.textContent ?? '',
    }
  })()`)
  if (thread.steer !== 'Also say tabs, please.' || thread.tag !== 'Steered' || !thread.logBefore || !thread.answerAfter.includes('Steered by:')) {
    throw new Error(`the thread shows the steered message as ${JSON.stringify(thread)}`)
  }
  await screenshot('ui-dark-steered-turn.png')

  // Steer as the default: Enter steers and Ctrl+Enter queues; a queued message is steered with its button. The choice
  // is in Settings > General and is kept as it is made.
  await openSettings('General')
  await waitFor("!!document.querySelector('[aria-label=\"What Enter does while the agent works\"]')", 4000, 'the follow-up choice')
  await click('[aria-label="What Enter does while the agent works"] .ui-segment', 'Steer')
  await waitFor("window.eNCode.settings.get().then((settings) => settings.followUp === 'steer')", 4000, 'Steer is saved')
  await closeSettings()

  await sendPrompt('[scenario:steer-check] Run it again.')
  await waitFor("!!document.querySelector('.approval-card')", 30000, 'the command asks again')
  if (!(await evaluate("document.querySelector('.composer-input').placeholder")).includes('Ctrl+Enter queues')) throw new Error('the message box does not say Ctrl+Enter queues')
  await typeAndPress('First note.', {})
  await waitFor(`${steeringRows} === 1`, 4000, 'Enter steers when Steer is chosen')
  await typeAndPress('Second note.', { ctrlKey: true })
  await waitFor(`${queuedRows} === 1`, 4000, 'Ctrl+Enter queues when Steer is chosen')
  await click('.queue-row:not(.is-steering) [aria-label^="Steer now"]')
  await waitFor(`${steeringRows} === 2 && ${queuedRows} === 0`, 4000, 'Steer now hands the queued message over')
  await click('.approval-card .btn.primary')
  await driveAgent('16-steer-default')
  await waitFor("document.body.textContent.includes('Steered by: Second note. Steer check finished.')", 8000, 'the model read both, in order')
  const steered = await evaluate("[...document.querySelectorAll('.thread > .turn:last-child .turn-user.is-steer .chat-user-bubble')].map((node) => node.textContent).join(' | ')")
  if (steered !== 'First note. | Second note.') throw new Error(`the thread shows the steered messages as ${steered}`)
  if (await evaluate("!!document.querySelector('.queue-strip')")) throw new Error('a message was left waiting')

  await evaluate("window.eNCode.settings.save({ followUp: 'queue' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload after the steering checks')
  console.log('[smoke] steering: ok')
}

/**
 * Effort: the chip under the message box sets how hard the main model thinks, Ctrl+Shift+M and /effort reach the same
 * choice, each role has its own under Settings, Roles, and the level goes out with the request to a model that has a
 * thinking dial.
 */
async function runEffortChecks() {
  console.log('[smoke] --- effort ---')
  const efforts = async () => JSON.stringify(await evaluate('window.eNCode.settings.get().then((settings) => settings.efforts)'))
  const chip = "(document.querySelector('.effort-chip')?.textContent ?? '')"
  const pick = (label) =>
    evaluate(`(() => {
      const item = [...document.querySelectorAll('.ui-menu [role^="menuitem"]')].find((node) => node.querySelector('.ui-menu-label')?.textContent === ${JSON.stringify(label)})
      item?.click()
      return Boolean(item)
    })()`)

  await evaluate('window.eNCode.agent.reset()')
  await waitFor(`${chip} === 'Effort'`, 8000, 'the effort chip, with the effort left to the model')
  await click('.effort-chip')
  await waitFor(menuOpen('Effort'), 4000, 'the effort menu')
  const levels = await evaluate("[...document.querySelectorAll('.ui-menu [role=menuitemcheckbox] .ui-menu-label')].map((node) => node.textContent).join()")
  if (levels !== 'Model default,Low,Medium,High,Extra high,Max') throw new Error(`the effort menu lists ${levels}`)
  await sleep(250)
  await screenshot('ui-dark-effort-menu.png')
  if (!(await pick('High'))) throw new Error('no High in the effort menu')
  await waitFor(`${chip} === 'High'`, 4000, 'the chip names the level chosen')
  if ((await efforts()) !== '{"main":"high"}') throw new Error(`the efforts are ${await efforts()}`)

  // Ctrl+Shift+M from the message box opens the same menu, with the level in use checked.
  await evaluate("document.querySelector('.composer-input').focus()")
  await composerKey({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })
  await waitFor(menuOpen('Effort'), 4000, 'Ctrl+Shift+M opens the effort menu')
  const checked = await evaluate("document.querySelector('.ui-menu [aria-checked=true] .ui-menu-label')?.textContent ?? ''")
  if (checked !== 'High') throw new Error(`the effort menu checks ${checked}`)
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await waitFor("!document.querySelector('.ui-menu')", 4000, 'Escape closes the effort menu')

  // /effort with a level sets it and says so, and empties the box.
  await typeInto('.composer-input', '/effort low')
  await sleep(250)
  await composerKey({ key: 'Enter' })
  await waitFor(`${chip} === 'Low' && document.querySelector('.composer-input').value === ''`, 4000, '/effort low sets Low')
  await waitFor("[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === 'The model thinks at Low effort.')", 4000, '/effort says what it set')

  // Each role has its own effort, saved with the other settings.
  await click('.effort-chip')
  await waitFor(menuOpen('Effort'), 4000, 'the effort menu again')
  if (!(await pick('Effort for each role…'))) throw new Error('no way from the effort menu to the roles')
  await waitFor("!!document.querySelector('.settings-page .settings-roles .role-effort')", 8000, 'the Roles settings with an effort for each role')
  const shown = await evaluate("[...document.querySelectorAll('.role-row')].map((row) => row.dataset.role + '=' + row.querySelector('.role-effort select').value).join()")
  if (shown !== 'main=low,explore=default,planner=default,reviewer=default,summarizer=default,utility=default,inline=default') throw new Error(`the roles show ${shown}`)
  await selectOption('.role-row[data-role="explore"] .role-effort select', 'max')
  await sleep(250)
  await screenshot('ui-dark-role-efforts.png')
  await until(async () => (await efforts()) === '{"main":"low","explore":"max"}', 4000, 'the effort kept as it is chosen')
  await closeSettings()

  // A model with a thinking dial is sent the main role's level, not Explore's.
  const before = await evaluate('window.eNCode.settings.get().then((settings) => settings.roles)')
  await evaluate("window.eNCode.settings.save({ roles: { main: ['local-mock:gpt-5-mock'] } })")
  await sendPrompt('[scenario:follow-up] Think it over.')
  await driveAgent('16-effort')
  const sent = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  if (sent.model !== 'gpt-5-mock' || sent.effort !== 'low') throw new Error(`the model was sent ${JSON.stringify({ model: sent.model, effort: sent.effort })}`)

  await evaluate(`window.eNCode.settings.save({ roles: ${JSON.stringify(before)}, efforts: {} })`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload after the effort checks')
  console.log('[smoke] effort: ok')
}

/** EnterPlanMode's card in its own words; a PDF read by page; a notebook cell changed, with a row that says so. */
async function runParityChecks() {
  console.log('[smoke] --- plan first, PDFs and notebooks ---')
  // Workspace Write asks before planning; Full Access would plan without a card.
  await evaluate("window.eNCode.settings.save({ agentMode: 'code', policy: 'workspace-write' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:plan-first] Rework the settings page.')
  await waitFor("!!document.querySelector('.approval-card')", 30000, 'the plan-first card')
  const card = await evaluate(`(() => {
    const card = document.querySelector('.approval-card')
    return { title: card.querySelector('.approval-head')?.textContent ?? '', buttons: [...card.querySelectorAll('.btn')].map((button) => button.textContent.trim()) }
  })()`)
  console.log('[smoke] plan-first card:', JSON.stringify(card))
  if (!card.title.includes('Plan before changing anything')) throw new Error(`the plan-first card is titled ${card.title}`)
  // A button's text ends with its key, when it has one ("Plan first Enter").
  for (const word of ['Plan first', 'Go ahead without a plan']) if (!card.buttons.some((text) => text.startsWith(word))) throw new Error(`the plan-first card has no ${word} button`)
  await screenshot('15-plan-first.png')
  await click('.approval-card .btn', 'Go ahead without a plan')
  await driveAgent('15-plan-first')
  if (!(await evaluate("document.body.textContent.includes('Going ahead without a plan, as asked.')"))) throw new Error('the agent did not go on after the person said to')

  const pdf = path.join(demoPath, 'smoke.pdf')
  const notebook = path.join(demoPath, 'smoke.ipynb')
  await fs.copyFile(path.join(root, '..', '..', 'packages', 'tools', 'src', 'pdf', 'fixtures', 'reportlab.pdf'), pdf)
  const cells = [{ cell_type: 'code', execution_count: 1, id: 'a1b2c3d4', metadata: {}, outputs: [], source: ['print(1)'] }]
  await fs.writeFile(notebook, `${JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`)
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:pdf-notebook] Read page 2 of smoke.pdf and fix the notebook.')
  await driveAgent('16-pdf-notebook')
  const outputs = await toolOutputs()
  console.log('[smoke] pdf and notebook:', JSON.stringify(outputs))
  const read = outputs.find((entry) => entry.name === 'Read')
  if (!read || read.state !== 'done' || read.output !== '1 page of 2') throw new Error(`the PDF read shows ${JSON.stringify(read)}`)
  const edit = outputs.find((entry) => entry.name === 'NotebookEdit')
  if (!edit || edit.state !== 'done') throw new Error(`the notebook edit shows ${JSON.stringify(edit)}`)
  const saved = JSON.parse(await fs.readFile(notebook, 'utf8'))
  if ([].concat(saved.cells[0].source).join('') !== 'print(2)' || saved.cells[0].id !== 'a1b2c3d4') throw new Error(`the notebook holds ${JSON.stringify(saved.cells[0])}`)
  await openWorkLogs()
  const rows = await evaluate("[...document.querySelectorAll('.tool-row')].map((row) => row.textContent.replace(/\\s+/g, ' '))")
  if (!rows.some((text) => text.includes('Edited') && text.includes('smoke.ipynb'))) throw new Error(`no row says the notebook was edited: ${JSON.stringify(rows)}`)
  await screenshot('16-pdf-notebook.png')
  await fs.rm(pdf, { force: true })
  await fs.rm(notebook, { force: true })
}

/** The problem card the conversation ends on: its sentence, its buttons, and what its Details fold holds once opened. */
async function problemCard() {
  await click('.problem-card[role=alert] .problem-details-toggle')
  await sleep(300)
  return evaluate(`(() => {
    const card = document.querySelector('.problem-card[role=alert]')
    if (!card) return null
    return {
      text: card.querySelector('.problem-text')?.textContent ?? '',
      buttons: [...card.querySelectorAll('.problem-foot .btn')].map((button) => button.textContent.trim()),
      details: card.querySelector('.problem-details-body pre')?.textContent ?? '',
    }
  })()`)
}

/**
 * Codex-style problems: a request that fails ends on one plain sentence with what can be done about it, the
 * provider's words folded under Details without the key in them, and Retry runs the same request on.
 */
async function runProblemChecks() {
  console.log('[smoke] --- problems in plain words ---')
  const fail = async (mode) => {
    const answer = await fetch(`http://127.0.0.1:${providerPort}/__fail/${mode}`, { method: 'POST' })
    if (!answer.ok) throw new Error(`the fake provider did not take failure mode ${mode}`)
  }
  const raw = /HTTP|[{}]|invalid_api_key|sk-smoke|Error:|undefined/
  try {
    await evaluate('window.eNCode.agent.reset()')
    await fail('auth')
    await sendPrompt('[scenario:retry-check] Say hello.')
    await waitFor("!!document.querySelector('.problem-card[role=alert]')", 60000, 'a problem card for the refused key')
    const refused = await problemCard()
    console.log('[smoke] refused key:', JSON.stringify(refused))
    if (!/did not accept the API key\.$/.test(refused.text) || raw.test(refused.text)) throw new Error(`the refused key reads: ${refused.text}`)
    if (refused.buttons.join('|') !== 'Open Settings|Switch model') throw new Error(`the refused key offers ${JSON.stringify(refused.buttons)}`)
    // The corner notice that said it first gives way to the card, which says it with its buttons.
    await waitFor("![...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('did not accept'))", 5000, 'the key notice gives way to the card')
    // The provider's words, with the key-shaped string taken out (the transport masks it as "sk-…").
    if (!refused.details.includes('HTTP 401: Incorrect API key provided') || refused.details.includes('not-a-real-key')) throw new Error(`its details hold ${refused.details}`)
    await screenshot('17-problem-key.png')

    // A refused key holds its provider back until a key changes; this stands in for entering a new one.
    await evaluate('window.eNCode.models.recheck()')
    await fail('empty')
    await sendPrompt('[scenario:retry-check] Say hello again.')
    await waitFor("document.querySelector('.problem-card[role=alert] .problem-text')?.textContent.includes('empty replies')", 60000, 'a problem card for empty replies')
    const empty = await problemCard()
    console.log('[smoke] empty replies:', JSON.stringify(empty))
    if (raw.test(empty.text) || !empty.buttons[0]?.startsWith('Retry')) throw new Error(`the empty replies card shows ${JSON.stringify(empty)}`)
    const settled = await evaluate("document.querySelectorAll('.problem-card.is-settled').length")
    if (settled < 1) throw new Error('the refused key card kept its buttons after a new request')
    await screenshot('17-problem-retry.png')

    await fail('off')
    if (!(await click('.problem-card[role=alert] .problem-foot .btn', 'Retry'))) throw new Error('no Retry button to press')
    await waitFor("document.body.textContent.includes('Answered after trying again.')", 60000, 'the answer after Retry')
    await waitFor("document.querySelector('.chat-panel')?.dataset.status === 'done'", 30000, 'the retried request finishes')
    const after = await evaluate(`({
      live: document.querySelectorAll('.problem-card[role=alert]').length,
      asked: [...document.querySelectorAll('.turn-user')].filter((node) => node.textContent.includes('Say hello again.')).length,
    })`)
    console.log('[smoke] after Retry:', JSON.stringify(after))
    if (after.live !== 0) throw new Error('a problem card still offers its buttons after Retry worked')
    if (after.asked !== 1) throw new Error(`Retry sent the request ${after.asked} times`)
    await screenshot('17-problem-after-retry.png')
  } finally {
    await fail('off')
    await evaluate('window.eNCode.models.recheck()')
  }
  console.log('[smoke] problems: ok')
}

async function runSubagentChecks() {
  console.log('[smoke] --- subagents ---')

  // A subagent's command asks on the parent's card, under the parent's policy.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:subagent-check] Delegate a shell check to a subagent.')
  const approvals = await driveAgent('13-subagent', 120000, { whileWaiting: queueWhileWaiting })
  console.log('[smoke] subagent approvals:', JSON.stringify(approvals))
  await waitFor("document.body.textContent.includes('Follow-up handled.')", 60000, 'the queued message goes out when the agent is done')
  await waitFor(
    "document.querySelector('.chat-panel')?.dataset.status === 'done' && !document.querySelector('.queue-strip')",
    60000,
    'the queued run finishes',
  )
  if (approvals.length !== 1 || !approvals[0].title.startsWith('Subagent: Run command')) {
    throw new Error('Expected one approval for the subagent command, on the parent card')
  }
  if (!approvals[0].detail.includes('echo subagent-command-ok')) throw new Error('The subagent approval does not show the command')
  const task = (await toolOutputs()).find((entry) => entry.name === 'Task')
  console.log('[smoke] subagent task:', JSON.stringify(task))
  if (!task || task.state !== 'done' || !task.output.includes('Subagent ran the command')) {
    throw new Error('The subagent report did not reach the parent')
  }

  // Stopping the parent while the subagent waits for approval stops both.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:subagent-check] Delegate a shell check to a subagent.')
  await waitFor("!!document.querySelector('.approval-card')", 30000, 'subagent approval card')

  // A session that waits for approval keeps its card: leave it, remove the detour, reload, and it is back.
  const waitingId = await evaluate("localStorage.getItem('eNCode.activeSession')")
  await click('.sb-new')
  await waitFor(
    "document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === 'New session' && !document.querySelector('.approval-card')",
    8000,
    'a new session replaces the waiting one on screen',
  )
  const waitingRows = await evaluate("[...document.querySelectorAll('.session-sidebar .sb-row .meta.warn')].map((node) => node.textContent)")
  if (!waitingRows.includes('Approval')) throw new Error('the waiting session does not show Approval in the sidebar')
  const extraId = await evaluate("localStorage.getItem('eNCode.activeSession')")
  await evaluate(`window.eNCode.agent.remove(${JSON.stringify(extraId)})`)
  await evaluate(`localStorage.setItem('eNCode.activeSession', ${JSON.stringify(waitingId)})`)
  await send('Page.reload')
  await waitFor("!!document.querySelector('.approval-card')", 15000, 'the approval card comes back with the session')
  const restoredReason = await evaluate("document.querySelector('.approval-reason')?.textContent ?? ''")
  if (!restoredReason.includes('Workspace Write')) throw new Error(`the restored card lost its reason: ${restoredReason}`)
  await click('.composer-send.is-stop')
  await waitFor(
    "['idle', 'done'].includes(document.querySelector('.chat-panel')?.dataset.status ?? '') && !document.querySelector('.approval-card')",
    15000,
    'stop while the subagent waits',
  )
  const stopped = await evaluate('window.eNCode.agent.history().then((history) => history.status)')
  console.log('[smoke] subagent stop status:', stopped)
  if (stopped !== 'idle') throw new Error(`Stopping during a subagent approval left the agent ${stopped}`)
  // The stop left the task call without a result; the next request must still be accepted.
  await sendPrompt('[scenario:follow-up] Carry on after the stop.')
  await driveAgent('13-after-stop')

  // A subagent started from Plan mode stays in Plan mode: it cannot write.
  await evaluate('window.eNCode.agent.reset()')
  await evaluate("window.eNCode.workspace.delete('escalation.txt').catch(() => null)")
  await evaluate("window.eNCode.settings.save({ agentMode: 'plan', policy: 'full-access' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after plan mode')
  await sendPrompt('[scenario:plan-escalation] Investigate with a subagent.')
  const planApprovals = await driveAgent('14-plan-subagent')
  const escalation = await evaluate(
    "window.eNCode.workspace.read('escalation.txt').then(() => 'written', () => 'absent')",
  )
  const planTask = (await toolOutputs()).find((entry) => entry.name === 'Task')
  console.log('[smoke] plan mode subagent:', JSON.stringify({ approvals: planApprovals.length, escalation, task: planTask }))
  if (escalation !== 'absent') throw new Error('A subagent wrote a file while the session was in Plan mode')
  await evaluate("window.eNCode.settings.save({ agentMode: 'code', policy: 'workspace-write' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after code mode')

  await runBackgroundAgentCheck()
}

/**
 * A subagent in the background: the turn ends once it is started, its command asks on a card tagged Background while
 * no turn runs, the header and the Jobs tab show it with its type, and its report starts a turn of its own that is no
 * message of the person's.
 */
async function runBackgroundAgentCheck() {
  await evaluate('window.eNCode.agent.reset()')
  const bottomClosed = await evaluate("document.querySelector('.bottom-panel')?.classList.contains('is-closed') ?? true")
  await sendPrompt('[scenario:background-check] Check the shell in the background.')
  await waitFor("document.body.textContent.includes('Started it in the background.')", 60000, 'the turn ends once the subagent is started')
  await waitFor("!!document.querySelector('.approval-card .approval-tag')", 60000, 'the subagent asks on a card tagged Background')
  const card = await evaluate("document.querySelector('.approval-card .approval-detail')?.textContent ?? ''")
  if (!card.includes('echo background-sub-ok')) throw new Error(`the background card does not show the command: ${card}`)
  const chip = await evaluate("document.querySelector('button[title=\"Show what runs in the background\"]')?.textContent ?? ''")
  if (chip !== '1 agent running') throw new Error(`the header says "${chip}" while one subagent runs`)
  await click('button[title="Show what runs in the background"]')
  const agentCard = (state) =>
    `[...document.querySelectorAll('.bottom-panel .job-card[data-kind=agent]')].some((card) => card.querySelector('.job-name')?.textContent === 'Background check' && card.querySelector('.job-badge')?.textContent === 'general-purpose' && card.querySelector('.job-status')?.textContent === '${state}')`
  await waitFor(agentCard('Running'), 8000, 'the Jobs tab shows the subagent running, with its type')
  await sleep(250)
  await screenshot('13-background-agent.png')

  await click('.approval-card .btn.primary')
  await waitFor("document.body.textContent.includes('The background check reported back.')", 60000, 'the report starts a turn of its own')
  await waitFor("document.querySelector('.chat-panel')?.dataset.status === 'done'", 30000, 'the turn of the report ends')
  await waitFor(agentCard('Done'), 8000, 'the Jobs tab shows the subagent done')
  const shown = await evaluate(`({
    asked: document.querySelectorAll('.turn-user').length,
    chip: !!document.querySelector('button[title="Show what runs in the background"]'),
  })`)
  console.log('[smoke] background subagent:', JSON.stringify(shown))
  if (shown.asked !== 1) throw new Error(`the report's turn shows ${shown.asked - 1} messages the person did not send`)
  if (shown.chip) throw new Error('the header still says something runs in the background')
  await screenshot('13-background-agent-reported.png')
  if (bottomClosed) {
    await key({ key: 'j', code: 'KeyJ', ctrlKey: true })
    await waitFor("document.querySelector('.bottom-panel')?.classList.contains('is-closed')", 4000, 'the bottom panel closes again')
  }
}

const DEFAULT_APPEARANCE = {
  mode: 'dark',
  accent: 'mono',
  contrast: 'standard',
  density: 'comfortable',
  motion: 'system',
  uiFont: '@system',
  codeFont: '@system',
  uiSize: 14,
  codeSize: 12,
}
const theme = () => evaluate('document.documentElement.dataset.theme')

/** The window at the two sizes the UI pull requests are reviewed at. */
/** Every file under a folder, by its path. */
async function filesUnder(dir) {
  const found = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await filesUnder(full)))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/**
 * A folder on another machine over SSH (ADR 0111), played by this machine: e2e.mjs names a stand-in ssh that runs the
 * command in a shell with a home of its own. The folder opens there through the dialog, the agent works there with
 * the key put in on this side only, and the folder on this PC comes back with its sessions.
 */
async function runRemoteChecks() {
  const remoteHome = process.env.ENCODE_FAKE_REMOTE_HOME
  if (!remoteHome) {
    console.log('[smoke] folder on another machine: skipped, there is no POSIX shell here to play the machine')
    return
  }
  console.log('[smoke] --- folder on another machine ---')
  const project = path.join(remoteHome, 'project')
  const localRoot = (await evaluate('window.eNCode.workspace.get()'))?.root
  // The key of the test provider: the one the run stored already, or one for this part when it runs on its own.
  const mock = (await evaluate('window.eNCode.settings.get()')).profiles.find((profile) => profile.id === 'local-mock')
  if (!mock?.hasApiKey) await evaluate(`window.eNCode.settings.setProfileKey('local-mock', ${JSON.stringify(`sk-remote-${Date.now().toString(36)}`)})`)

  // Through the project switcher, as a person would.
  await click('.proj-switch')
  await waitFor(menuOpen('Projects'), 4000, 'the project switcher')
  if (!(await click('.ui-menu [role^="menuitem"]', 'Open folder on another machine'))) throw new Error('No Open folder on another machine in the project switcher')
  await waitFor("!!document.querySelector('input[aria-label=\"Machine\"]')", 5000, 'the Open dialog for another machine')
  await typeInto('input[aria-label="Machine"]', 'devbox')
  await typeInto('input[aria-label="Folder on that machine"]', '~/missing')
  await click('.ui-dialog button', 'Connect')
  await waitFor("document.querySelector('.ui-dialog .problem-text')?.textContent.includes('does not exist')", 60000, 'a folder that is not there is refused in words')
  await typeInto('input[aria-label="Folder on that machine"]', '~/project')
  await screenshot('ui-dark-remote-dialog.png')
  await click('.ui-dialog button', 'Connect')
  await waitFor("document.querySelector('.proj-machine')?.textContent.includes('devbox') && document.querySelectorAll('.tree-row').length > 0", 60000, 'the folder open on devbox')
  const shown = await evaluate('window.eNCode.workspace.get()')
  if (shown?.root !== project || !shown.remote?.uri.startsWith('ssh://devbox/')) throw new Error(`The open folder is not the one on devbox: ${JSON.stringify(shown)}`)
  const tree = await evaluate("[...document.querySelectorAll('.tree-row')].map((row) => row.textContent.trim())")
  if (!tree.some((text) => text.includes('README.md'))) throw new Error(`The tree does not show the machine's files: ${tree}`)
  const opened = await evaluate("window.eNCode.workspace.read('README.md')")
  if (!opened.content.includes('On the other machine')) throw new Error('A file of the machine did not read back')
  await screenshot('ui-dark-remote-open.png')

  // The agent works there, through the model this PC reaches: the default scenario writes a file and runs a command.
  await sendPrompt('Check the provider path on the other machine.')
  await driveAgent('16-remote')
  const written = await fs.readFile(path.join(project, 'provider-check.txt'), 'utf8').catch(() => '')
  if (!written.includes('hello from a real provider stream')) throw new Error('The agent did not write its file on the machine')
  // The key reached the provider from this side; the machine only ever held a stand-in for it.
  const { authorization } = await (await fetch(`http://127.0.0.1:${providerPort}/__last-authorization`)).json()
  if (!/^Bearer sk-/.test(authorization ?? '') || authorization.includes('encode-remote-key-')) throw new Error(`The provider was not sent the key: ${authorization}`)
  const secret = authorization.slice('Bearer '.length)
  const leaked = []
  for (const file of await filesUnder(remoteHome)) if ((await fs.readFile(file)).includes(secret)) leaked.push(file)
  if (leaked.length) throw new Error(`The key reached the other machine: ${leaked.join(', ')}`)
  const logs = await filesUnder(path.join(remoteHome, '.encode-server', 'data', 'sessions'))
  if (!logs.length) throw new Error("The machine keeps no session of its own: the agent did not run there")

  // The Browser tool is this PC's browser: while the folder is on the machine, its tab opens nothing on this PC, so the
  // page of this computer that the browser check opens is held, whatever the agent host there decided.
  await sendPrompt('[scenario:browser-check] Check the greeter app in the browser.')
  await driveAgent('16-remote-browser', 120000)
  const request = await (await fetch(`http://127.0.0.1:${providerPort}/__last-request`)).json()
  const results = request.messages.filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
  const first = results.slice(-8)[0] ?? ''
  console.log('[smoke] remote browser:', JSON.stringify(first.slice(0, 240)))
  if (/Greeter at http/.test(results.join('\n')) || !/ERR_BLOCKED_BY_CLIENT|opens nothing on this PC/.test(first)) throw new Error(`The agent’s tab opened a page of this PC while the folder was on another machine: ${JSON.stringify(first.slice(0, 600))}`)
  if (await click('.side-panel .panel-tab.is-active .panel-tab-close')) await waitFor("!document.querySelector('.browser-agent-chip')", 4000, 'the agent’s tab closes')

  // Back to this PC: its folder opens again, with its own sessions, and the machine stays a recent folder.
  await click('.proj-switch')
  await waitFor(menuOpen('Projects'), 4000, 'the project switcher')
  const listed = await evaluate("[...document.querySelectorAll('.ui-menu [role^=\"menuitem\"]')].map((node) => node.textContent)")
  if (!(await click('.ui-menu [role^="menuitem"]', path.basename(localRoot)))) throw new Error(`No ${path.basename(localRoot)} in the project switcher: ${listed}`)
  await waitFor("!document.querySelector('.proj-machine') && document.querySelectorAll('.tree-row').length > 0", 30000, 'the folder on this PC again')
  const back = await evaluate('window.eNCode.workspace.get()')
  if (back?.root !== localRoot || back.remote) throw new Error(`The folder on this PC did not come back: ${JSON.stringify(back)}`)
  const sessions = await evaluate('window.eNCode.agent.sessions()')
  if (sessions.some((session) => session.projectRoot === project)) throw new Error("This PC's agent lists the machine's sessions")
  const recents = (await evaluate('window.eNCode.settings.get()')).recentWorkspaces
  if (!recents.some((root) => root.startsWith('ssh://devbox/'))) throw new Error(`The machine's folder is not a recent folder: ${recents}`)
  console.log('[smoke] folder on another machine: ok')
}

async function screenshotSizes(name) {
  for (const [width, height] of [
    [1280, 800],
    [1366, 768],
    [1920, 1080],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await screenshot(`${name}-${width}x${height}.png`)
  }
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(200)
}

async function openAppearanceSettings() {
  await openSettings('Appearance')
  await waitFor("!!document.querySelector('.settings-page [data-setting=\"appearance.theme\"]')", 4000, 'appearance settings')
}

const key = (init) =>
  evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})))`)
const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const sidebarTitles = () =>
  evaluate("[...document.querySelectorAll('.session-sidebar .sb-row-main .title')].map((node) => node.textContent)")
const activeTitle = () => evaluate("document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent ?? ''")
const menuOpen = (name) => `!!document.querySelector('.ui-menu[aria-label="${name}"]')`

/** Right-clicks the open session's row and chooses an item from its menu. */
async function chooseFromSessionMenu(item) {
  await evaluate(`(() => {
    const row = document.querySelector('.session-sidebar .sb-row.is-active')
    const box = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }))
  })()`)
  await waitFor(menuOpen('Session'), 4000, 'session context menu')
  if (!(await click('.ui-menu [role^="menuitem"]', item))) throw new Error(`context menu has no ${item}`)
}

const pressEnterInComposer = () =>
  evaluate("document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
/** A key pressed in the message box: the box's own handler sees it first, then the window's shortcuts. */
const composerKey = (init) =>
  evaluate(`document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})))`)
const composerValue = () => evaluate("document.querySelector('.composer-input')?.value ?? ''")
const paletteKey = (name) =>
  evaluate(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`)
/** The title of the row the picker above the message box has chosen. */
const pickedOption = "document.querySelector('.composer-picker [role=option][aria-selected=true] .palette-title')?.textContent ?? ''"

/** While an approval card shows: the card's keys, and a message queued, edited back into the composer and queued again. */
async function queueWhileWaiting() {
  const hint = await evaluate("[...document.querySelectorAll('.approval-actions .ui-kbd')].map((node) => node.textContent).join(' ')")
  if (!hint.includes('Enter') || !hint.includes('Esc')) throw new Error(`the approval card does not show its keys: ${hint}`)
  const radius = await evaluate("getComputedStyle(document.querySelector('.approval-card')).borderTopLeftRadius")
  if (radius !== '14px') throw new Error(`the approval card has a ${radius} radius, not 14px`)
  const text = '[scenario:follow-up] Queued while waiting.'
  await typeInto('.composer-input', text)
  await sleep(250)
  await pressEnterInComposer()
  await waitFor("document.querySelectorAll('.queue-row').length === 1", 4000, 'a message sent while the agent works is queued')
  const queued = await evaluate("document.querySelector('.queue-text')?.textContent ?? ''")
  if (queued !== text) throw new Error(`the queue shows "${queued}"`)
  if ((await evaluate("document.querySelector('.composer-input').value")) !== '') throw new Error('the composer was not cleared by queueing')
  await click('.queue-row [aria-label="Edit queued message"]')
  await waitFor("!document.querySelector('.queue-strip')", 4000, 'editing takes the message out of the queue')
  if ((await evaluate("document.querySelector('.composer-input').value")) !== text) throw new Error('the queued message did not come back to the composer')
  await pressEnterInComposer()
  await waitFor("document.querySelectorAll('.queue-row').length === 1", 4000, 'the edited message is queued again')
  await screenshot('ui-dark-queue.png')
}

/** The composer's menus: Add, and the permissions with their descriptions. */
async function runComposerChecks() {
  console.log('[smoke] --- composer ---')
  const height = await evaluate("document.querySelector('.composer-card').getBoundingClientRect().height")
  const radius = await evaluate("getComputedStyle(document.querySelector('.composer-card')).borderTopLeftRadius")
  if (radius !== '18px') throw new Error(`the composer has a ${radius} radius, not 18px`)
  console.log('[smoke] composer card height:', height)
  const sendSize = await evaluate("(() => { const box = document.querySelector('.composer-send').getBoundingClientRect(); return [box.width, box.height] })()")
  if (sendSize[0] !== 32 || sendSize[1] !== 32) throw new Error(`Send is ${sendSize} px, not 32 x 32`)

  await click('.composer-plus')
  await waitFor(menuOpen('Add'), 4000, 'Add menu')
  const add = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  if (!add.includes('Plan mode') || !add.includes('Compact the conversation')) throw new Error(`the Add menu is missing items: ${add}`)
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await waitFor("!document.querySelector('.ui-menu')", 4000, 'Escape closes the Add menu')

  await click('.policy-chip')
  await waitFor(menuOpen('Permissions'), 4000, 'Permissions menu')
  const policies = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  for (const label of ['Read Only', 'Workspace Write', 'Auto review', 'Full access']) {
    if (!policies.includes(label)) throw new Error(`the Permissions menu is missing ${label}: ${policies}`)
  }
  const described = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-description')].length")
  if (described < 4) throw new Error('the permission choices do not describe themselves')
  await click('.ui-menu [role^="menuitem"]', 'Auto review')
  await waitFor("window.eNCode.settings.get().then((settings) => settings.policy === 'auto-review')", 4000, 'Auto review is chosen')
  await evaluate("window.eNCode.settings.save({ policy: 'workspace-write' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload after the composer checks')
  console.log('[smoke] composer checks passed')
}

/**
 * Ctrl+K from the message box: the palette finds actions and settings pages by their words, runs the pick, starts
 * with it next time and gives focus back on Esc; the sidebar's Search opens it too. Then the message box's slash
 * commands (the list, /status, an unknown command, Esc) and Alt+M for the model list.
 */
async function runPaletteChecks() {
  console.log('[smoke] --- palette and slash commands ---')
  const titles = () => evaluate("[...document.querySelectorAll('.palette .palette-row .palette-title')].map((node) => node.textContent)")
  const activeRow = "document.querySelector('.palette-row.is-active .palette-title')?.textContent ?? ''"
  const facts = () =>
    evaluate("Object.fromEntries([...document.querySelectorAll('.status-facts > div')].map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]))")

  // Ctrl+K works while typing in the message box, and the palette's field takes the keys.
  await evaluate("document.querySelector('.composer-input').focus()")
  await composerKey({ key: 'k', code: 'KeyK', ctrlKey: true })
  await waitFor("!!document.querySelector('.palette') && document.activeElement?.classList.contains('palette-input')", 4000, 'Ctrl+K opens the palette with its field focused')
  const groups = await evaluate("[...document.querySelectorAll('.palette .palette-group')].map((node) => node.textContent)")
  if (!groups.includes('Actions') || !groups.includes('Settings')) throw new Error(`the palette lists ${groups}`)
  await sleep(300)
  await screenshot('ui-dark-palette.png')

  // Found by their words: the theme command names the theme it would switch to, next to the Appearance page.
  await typeInto('.palette-input', 'theme')
  await waitFor(`${activeRow} !== ''`, 4000, 'results for "theme"')
  const themed = await titles()
  if (!themed.includes('Switch to light theme') || !themed.includes('Appearance')) throw new Error(`"theme" finds ${themed}`)

  // Enter runs the pick once the palette is gone: here the session's status.
  await typeInto('.palette-input', 'status')
  await waitFor(`${activeRow} === 'Session status'`, 4000, '"status" finds Session status first')
  await paletteKey('Enter')
  await waitFor("!document.querySelector('.palette') && !!document.querySelector('.status-dialog .status-facts')", 4000, 'Enter runs the command: the status opens')
  const status = await facts()
  console.log('[smoke] status:', JSON.stringify(status))
  for (const label of ['Session', 'Folder', 'Model', 'Mode', 'Permissions', 'Context', 'Usage']) {
    if (!(label in status)) throw new Error(`the status has no ${label}: ${JSON.stringify(status)}`)
  }
  if (status.Permissions !== 'Workspace Write' || status.Mode !== 'Code') throw new Error('the status does not show the session’s permissions and mode')
  if (status.Folder.split(/[\\/]/).pop() !== path.basename(demoPath)) throw new Error(`the status shows the folder ${status.Folder}`)
  if (!/^\d+% of \d+k tokens$/.test(status.Context)) throw new Error(`the status shows the context as ${status.Context}`)
  await sleep(300)
  await screenshot('ui-dark-status.png')
  await key({ key: 'Escape' })
  await waitFor("!document.querySelector('.status-dialog')", 4000, 'Escape closes the status')

  // Ctrl+Shift+P opens it too, starting with the last pick; the arrows move, and Esc gives focus back.
  await evaluate("document.querySelector('.composer-input').focus()")
  await composerKey({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
  await waitFor("!!document.querySelector('.palette')", 4000, 'Ctrl+Shift+P opens the palette')
  const recent = await evaluate("(() => { const group = document.querySelector('.palette [role=group]'); return group ? [group.getAttribute('aria-label'), group.querySelector('.palette-title')?.textContent] : null })()")
  if (JSON.stringify(recent) !== JSON.stringify(['Recent', 'Session status'])) throw new Error(`the palette does not start with the last pick: ${JSON.stringify(recent)}`)
  await paletteKey('ArrowDown')
  await waitFor("document.querySelector('.palette-row.is-active')?.dataset.row === '1'", 2000, 'ArrowDown moves to the next row')
  await typeInto('.palette-input', 'qzxq')
  await waitFor("document.querySelector('.palette-empty')?.textContent === 'Nothing matches “qzxq”.'", 2000, 'the palette says when nothing matches')
  await paletteKey('Escape')
  await waitFor("!document.querySelector('.palette') && document.activeElement?.classList.contains('composer-input')", 4000, 'Esc closes the palette and gives focus back to the message box')

  // The sidebar's Search opens it, and a settings page is found by its words.
  if (!(await click('.session-sidebar [aria-label="Search"]'))) throw new Error('the sidebar has no Search')
  await waitFor("!!document.querySelector('.palette')", 4000, 'Search in the sidebar opens the palette')
  await typeInto('.palette-input', 'isolation')
  await waitFor(`${activeRow} === 'Sandbox'`, 4000, '"isolation" finds the Sandbox settings')
  await paletteKey('Enter')
  await waitFor("document.querySelector('.settings-heading')?.textContent === 'Sandbox'", 6000, 'the settings open on that page')
  await closeSettings()

  // Slash commands: / lists them, more letters narrow the list, Enter runs the chosen one and empties the box.
  await typeInto('.composer-input', '/')
  await waitFor("document.querySelectorAll('.composer-picker [role=option]').length >= 20", 4000, '/ lists the commands')
  if ((await evaluate(pickedOption)) !== '/plan') throw new Error(`the commands start with ${await evaluate(pickedOption)}`)
  await sleep(300)
  await screenshot('ui-dark-slash.png')
  await typeInto('.composer-input', '/sta')
  await waitFor(`${pickedOption} === '/status'`, 4000, '/sta chooses /status')
  await composerKey({ key: 'Enter' })
  await waitFor("!!document.querySelector('.status-dialog') && document.querySelector('.composer-input').value === ''", 4000, 'Enter runs /status and empties the box')
  await key({ key: 'Escape' })
  await waitFor("!document.querySelector('.status-dialog')", 4000, 'Escape closes the status again')

  // A word that is no command is not sent at the first Enter.
  await typeInto('.composer-input', '/qzxq')
  await waitFor("document.querySelector('.composer-picker .picker-note')?.textContent === 'No command matches “/qzxq”.'", 4000, 'the list says when no command matches')
  await composerKey({ key: 'Enter' })
  await waitFor("[...document.querySelectorAll('.toast-text')].some((node) => node.textContent === '/qzxq is not a command. Press Enter again to send it as a message.')", 4000, 'the first Enter on an unknown command explains')
  if ((await composerValue()) !== '/qzxq') throw new Error('an unknown command left the message box')

  // Esc closes the list and keeps what was typed.
  await typeInto('.composer-input', '/')
  await waitFor("!!document.querySelector('.composer-picker')", 4000, 'the command list again')
  await composerKey({ key: 'Escape' })
  await waitFor("!document.querySelector('.composer-picker')", 4000, 'Esc closes the command list')
  if ((await composerValue()) !== '/') throw new Error('Esc changed what was typed')
  await typeInto('.composer-input', '')

  // Alt+M opens the model list, and Esc closes it.
  await key({ key: 'm', code: 'KeyM', altKey: true })
  await waitFor("!!document.querySelector('.model-picker')", 4000, 'Alt+M opens the model list')
  await evaluate("document.querySelector('.model-picker').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
  await waitFor("!document.querySelector('.model-picker')", 4000, 'Esc closes the model list')
  console.log('[smoke] palette and slash command checks passed')
}

/** A folder as the sidebar compares them: slashes one way, no slash at the end, any case. */
const folderKey = (root) => root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The sidebar row of the session with this title: in one section of the sidebar, or anywhere in it. */
const sessionRow = (title, section = '') =>
  `[...document.querySelectorAll('.session-sidebar ${section && `section[aria-label="${section}"] `}.sb-row')].find((row) => row.querySelector('.sb-row-main')?.title === ${JSON.stringify(title)})`

/** The notices eNCode would have shown on Windows: e2e.mjs has them written to a file, one JSON line each. */
async function windowsNotices() {
  const file = process.env.ENCODE_NOTICES_FILE
  if (!file) return []
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * The Settings page. Ctrl+, opens it over the app, where it was left and on its search; the app stays as it was under
 * it, and an app shortcut leaves it. The search finds one setting and gives it the focus, and each change is kept as it
 * is made: keeping awake, the send key, the notices. Then a chat, a session with no project: Ctrl+Alt+O starts one in
 * the chats folder, listed under Chats and never as a project; Enter and Esc on the page leave the approval under it
 * alone; the notice that the request finished names the chat and holds nothing the agent wrote; and Settings > Archived
 * sessions restores the chat, then deletes it.
 */
async function runSettingsPageChecks() {
  console.log('[smoke] --- settings page ---')
  const heading = "document.querySelector('.settings-heading')?.textContent"
  const projectName = path.basename(demoPath)
  const firstSession = await activeTitle()
  const { chatsFolder } = await evaluate('window.eNCode.settings.get()')
  const noticesKept = Boolean(process.env.ENCODE_NOTICES_FILE)
  if (!noticesKept) console.log('[smoke] ENCODE_NOTICES_FILE is not set: the notices are not read')
  // Back to the session the checks began in, and to the project: a session of the project opens it, and one that
  // belongs to no folder (the imported one) stays in the folder that is open, so the project is picked from the switcher.
  const backInProject = async (label) => {
    if (!(await evaluate(`(() => { const row = ${sessionRow(firstSession)}; row?.querySelector('.sb-row-main').click(); return Boolean(row) })()`))) throw new Error(`no ${firstSession} in the sidebar`)
    await waitFor(`document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === ${JSON.stringify(firstSession)}`, 8000, `${firstSession} open again`)
    if ((await evaluate("document.querySelector('.proj-name')?.textContent")) !== projectName) {
      await click('.proj-switch')
      await waitFor(menuOpen('Projects'), 4000, 'the project switcher')
      const listed = await evaluate("[...document.querySelectorAll('.ui-menu [role^=\"menuitem\"]')].map((node) => node.textContent)")
      if (listed.some((text) => text.includes('Chats'))) throw new Error(`the project switcher lists the chats folder: ${listed}`)
      if (!(await click('.ui-menu [role^="menuitem"]', projectName))) throw new Error(`no ${projectName} in the project switcher: ${listed}`)
    }
    await waitFor(`document.querySelector('.proj-name')?.textContent === ${JSON.stringify(projectName)} && document.querySelectorAll('.tree-row').length > 0`, 15000, label)
    const projects = await evaluate("[...document.querySelectorAll('.session-sidebar section[aria-label=\"Projects\"] .sb-project > .sb-row')].map((node) => node.title)")
    if (projects.some((root) => folderKey(root) === folderKey(chatsFolder))) throw new Error('the chats folder is listed as a project')
  }
  const archiveChat = async (title, label) => {
    if (!(await evaluate(`(() => { const button = ${sessionRow(title, 'Chats')}?.querySelector('[aria-label="Archive"]'); button?.click(); return Boolean(button) })()`))) throw new Error(`no ${title} under Chats`)
    await waitFor(`!${sessionRow(title)}`, 6000, label)
  }

  // Ctrl+, in the message box: the page opens where it was left (the palette opened Sandbox), on its search. The app
  // under it stays mounted, hidden and inert.
  await evaluate("document.querySelector('.composer-input').focus()")
  await composerKey({ key: ',', code: 'Comma', ctrlKey: true })
  await waitFor(`${heading} === 'Sandbox' && document.activeElement?.classList.contains('settings-search-input') === true`, 6000, 'Ctrl+, opens the page where it was left, on its search')
  const under = await evaluate(`({
    inert: document.querySelector('.sheet-work')?.inert === true,
    hidden: getComputedStyle(document.querySelector('.session-sidebar')).visibility === 'hidden',
    tree: document.querySelectorAll('.tree-row').length,
  })`)
  if (!under.inert || !under.hidden || !under.tree) throw new Error(`the app under the page: ${JSON.stringify(under)}`)

  // The arrows go from the search to the sections and on through them.
  await pressKey('ArrowDown')
  await waitFor("document.activeElement?.dataset.section === 'general'", 4000, 'ArrowDown goes from the search to the first section')
  await pressKey('ArrowDown')
  await waitFor("document.activeElement?.dataset.section === 'personalization'", 4000, 'ArrowDown goes to the next section')
  await openSettings('General')
  await sleep(300)
  await screenshot('ui-dark-settings.png')

  // The search finds a setting by the start of its words. Enter goes to the first one found, marks it and gives it the
  // focus; Esc empties the search before it leaves the page.
  await typeInto('.settings-search-input', 'qzxq')
  await waitFor("document.querySelector('.settings-nav-empty')?.textContent === 'No setting matches “qzxq”.'", 4000, 'the search says when nothing matches')
  await typeInto('.settings-search-input', 'keep aw')
  await waitFor("[...document.querySelectorAll('.settings-nav-sub')].map((node) => node.textContent).join() === 'Keep the computer awake while the agent works'", 4000, '"keep aw" finds the one setting')
  await sleep(200)
  await screenshot('ui-dark-settings-search.png')
  await evaluate("document.querySelector('.settings-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await waitFor("!!document.querySelector('[data-setting=\"general.keepAwake\"].is-found') && document.activeElement?.id === 'keep-awake'", 4000, 'Enter goes to the setting, marked, with the focus on it')
  await evaluate("document.querySelector('.settings-search-input').focus()")
  await pressKey('Escape')
  await waitFor("document.querySelector('.settings-search-input')?.value === '' && document.querySelectorAll('.settings-nav-sub').length === 0", 4000, 'the first Esc empties the search')
  if (!(await evaluate("!!document.querySelector('.settings-page')"))) throw new Error('the Esc that emptied the search left the page')

  // Kept as it is switched, with no Save.
  await click('#keep-awake')
  await settingIs('settings.keepAwake === false', 'keeping the computer awake off')
  await click('#keep-awake')
  await settingIs('settings.keepAwake === true', 'keeping the computer awake on')

  // Ctrl+Enter to send: the help and the follow-up choice say so.
  await click('[aria-label="Send messages with"] .ui-segment', 'Ctrl+Enter')
  await settingIs("settings.sendKey === 'ctrl-enter'", 'Ctrl+Enter to send')
  await waitFor("(document.querySelector('[data-setting=\"general.send\"]')?.textContent ?? '').includes('Enter starts a new line, as in an editor')", 4000, 'the help says what Enter does now')
  if (!(await evaluate("!!document.querySelector('[aria-label=\"What Ctrl+Enter does while the agent works\"]')"))) throw new Error('the follow-up choice does not name Ctrl+Enter')

  // Notifications: Test shows one whatever the settings say; Always tells of every finished request.
  await openSettings('Notifications')
  if (!(await click('[data-setting="notifications.test"] .btn', 'Test'))) throw new Error('no Test button')
  await waitFor("(document.querySelector('[data-setting=\"notifications.test\"] [role=status]')?.textContent ?? '').startsWith('Sent.')", 4000, 'the test notice is sent')
  if (noticesKept) await until(async () => (await windowsNotices()).some((notice) => notice.kind === 'test' && notice.title === 'eNCode' && notice.sessionId === ''), 4000, 'the test notice')
  await click('[aria-label="Notice when a request finishes"] .ui-segment', 'Always')
  await settingIs("settings.notifyDone === 'always'", 'a notice for every finished request')
  await sleep(200)
  await screenshot('ui-dark-settings-notifications.png')

  // Esc leaves the page, and the focus goes back to the message box; the Send button names the new keys.
  await pressKey('Escape')
  await waitFor("!document.querySelector('.settings-page') && document.activeElement?.classList.contains('composer-input') === true", 4000, 'Esc leaves the page and gives the focus back to the message box')
  if ((await evaluate("document.querySelector('.composer-send')?.title")) !== 'Send (Ctrl+Enter)') throw new Error('the Send button does not name Ctrl+Enter')

  // An app shortcut works on the page, and goes back to the app to do it.
  await composerKey({ key: ',', code: 'Comma', ctrlKey: true })
  await waitFor("!!document.querySelector('.settings-page')", 4000, 'Ctrl+, opens the page again')
  await key({ key: 'b', ctrlKey: true })
  await waitFor("!document.querySelector('.settings-page') && !document.querySelector('.session-sidebar')", 4000, 'Ctrl+B on the page goes back to the app and hides the sessions')
  await key({ key: 'b', ctrlKey: true })
  await waitFor("!!document.querySelector('.session-sidebar')", 4000, 'Ctrl+B shows the sessions again')

  // Ctrl+Alt+O starts a chat: the chats folder opens as the work folder, the sidebar says Chats, and the chat is listed
  // under Chats. The session open until then belongs to no project, so it is a chat too, listed under Chats and open
  // while the new one is made: the new one is the one open once the open session is another.
  const before = await evaluate("localStorage.getItem('eNCode.activeSession')")
  await key({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })
  await waitFor(`document.querySelector('.proj-name')?.textContent === 'Chats' && document.querySelector('.proj-switch')?.title === ${JSON.stringify(chatsFolder)}`, 15000, 'Ctrl+Alt+O opens the chats folder')
  await waitFor(`localStorage.getItem('eNCode.activeSession') !== ${JSON.stringify(before)} && (document.querySelector('.session-sidebar section[aria-label="Chats"] .sb-row.is-active .title')?.textContent ?? ${JSON.stringify(firstSession)}) !== ${JSON.stringify(firstSession)}`, 6000, 'the new chat is listed under Chats, open')
  const chatId = await evaluate("localStorage.getItem('eNCode.activeSession')")
  const projects = await evaluate("[...document.querySelectorAll('.session-sidebar section[aria-label=\"Projects\"] .sb-project > .sb-row')].map((node) => node.title)")
  if (projects.some((root) => folderKey(root) === folderKey(chatsFolder))) throw new Error('the chats folder is listed as a project')

  // Enter only starts a line now; Ctrl+Enter sends.
  const prompt = 'Leave a note in the chats folder'
  await typeInto('.composer-input', prompt)
  await sleep(200)
  const messages = await count('.chat-list .msg')
  await composerKey({ key: 'Enter' })
  await sleep(500)
  if ((await composerValue()) !== prompt || (await count('.chat-list .msg')) !== messages) throw new Error('Enter sent the message with Ctrl+Enter chosen')
  await composerKey({ key: 'Enter', ctrlKey: true })

  // The page opens while the agent works, and the approval that comes up waits under it: Enter there approves
  // nothing, and the Esc that leaves the page denies nothing.
  await key({ key: ',', code: 'Comma', ctrlKey: true })
  await waitFor("!!document.querySelector('.settings-page')", 4000, 'the page while the agent works')
  const early = await evaluate("!!document.querySelector('.approval-card')")
  await waitFor("!!document.querySelector('.approval-card')", 30000, 'the approval under the page')
  await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await sleep(300)
  if (!(await evaluate("!!document.querySelector('.approval-card')"))) throw new Error('Enter on the Settings page answered the approval under it')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.settings-page')", 4000, 'Esc leaves the page')
  await sleep(300)
  if (!(await evaluate("!!document.querySelector('.approval-card')"))) throw new Error('the Esc that left the Settings page answered the approval')
  console.log('[smoke] the approval came up', early ? 'before the page opened' : 'while the page was open')
  await driveAgent('settings-chat')
  await sleep(300)
  const chatTitle = await activeTitle()
  await screenshot('ui-dark-chat.png')

  // The notice names the chat and says it finished, in eNCode's words only.
  if (noticesKept) {
    const done = () => windowsNotices().then((list) => list.find((notice) => notice.kind === 'done' && notice.sessionId === chatId))
    await until(async () => Boolean(await done()), 10000, 'a notice that the chat finished').catch(async (error) => {
      throw new Error(`${error.message} (chat ${chatId}; the notices: ${JSON.stringify(await windowsNotices())})`)
    })
    const notice = await done()
    if (notice.title !== chatTitle || notice.body !== 'Finished.') throw new Error(`the notice reads ${JSON.stringify(notice)}`)
    if (JSON.stringify(await windowsNotices()).includes('offline demo')) throw new Error('a notice holds what the agent wrote')
  }

  // Archived from the sidebar while the project is open, the chat is under Settings > Archived sessions as a chat.
  // Restore brings it back, and the notice's Open goes to it, in its folder.
  await backInProject('the project open again')
  await archiveChat(chatTitle, 'the archived chat leaves the sidebar')
  await openSettings('Archived sessions')
  const archivedRow = `[...document.querySelectorAll('.archived-row')].find((row) => row.dataset.session === ${JSON.stringify(chatId)})`
  await waitFor(`!!${archivedRow}`, 6000, 'the chat under Archived sessions')
  const meta = await evaluate(`${archivedRow}.querySelector('.archived-meta').textContent`)
  if (!meta.startsWith('Chat · ')) throw new Error(`the archived chat is described as ${meta}`)
  await sleep(200)
  await screenshot('ui-dark-settings-archived.png')
  await evaluate(`${archivedRow}.querySelector('.btn').click()`)
  await waitFor(`!${archivedRow} && [...document.querySelectorAll('.toast-text')].some((node) => node.textContent === ${JSON.stringify(`Restored “${chatTitle}”.`)})`, 6000, 'Restore takes the chat off the list and says so')
  if (!(await click('.toast-action', 'Open'))) throw new Error('the notice of the restore offers no Open')
  await waitFor("!document.querySelector('.settings-page') && document.querySelector('.proj-name')?.textContent === 'Chats' && !!document.querySelector('.session-sidebar section[aria-label=\"Chats\"] .sb-row.is-active')", 15000, 'Open goes to the chat, in its folder')

  // The palette finds a single setting by its words and opens the page on it, marked, with the focus on it.
  await evaluate("document.querySelector('.composer-input').focus()")
  await composerKey({ key: 'k', code: 'KeyK', ctrlKey: true })
  await waitFor("!!document.querySelector('.palette')", 4000, 'the palette')
  await typeInto('.palette-input', 'send messages')
  await waitFor("document.querySelector('.palette-row.is-active .palette-title')?.textContent === 'Send messages with'", 4000, '"send messages" finds the setting')
  await paletteKey('Enter')
  await waitFor(`${heading} === 'General' && !!document.querySelector('[data-setting="general.send"].is-found') && !!document.activeElement?.closest('[data-setting="general.send"]')`, 6000, 'the page opens on the setting, marked, with the focus on it')

  // Back as the checks that follow expect: Enter sends, notices in the background, the project open, and the chat
  // archived again and then deleted from the page.
  await click('[aria-label="Send messages with"] .ui-segment', 'Enter')
  await settingIs("settings.sendKey === 'enter'", 'Enter to send')
  await openSettings('Notifications')
  await click('[aria-label="Notice when a request finishes"] .ui-segment', 'In the background')
  await settingIs("settings.notifyDone === 'background'", 'notices in the background')
  await closeSettings()
  if ((await evaluate("document.querySelector('.composer-send')?.title")) !== 'Send (Enter)') throw new Error('the Send button does not name Enter again')
  await backInProject('the project open once more')
  await archiveChat(chatTitle, 'the chat archived again')
  await openSettings('Archived sessions')
  await waitFor(`!!${archivedRow}`, 6000, 'the chat under Archived sessions again')
  await evaluate(`${archivedRow}.querySelector('[aria-label="Delete…"]').click()`)
  await waitFor("!!document.querySelector('.ui-dialog .confirm-body')", 4000, 'Delete asks first')
  await click('.ui-dialog-foot .btn.danger')
  await waitFor(`!document.querySelector('.ui-dialog') && !${archivedRow}`, 6000, 'Delete removes the chat')
  await closeSettings()
  if ((await activeTitle()) !== firstSession) throw new Error(`the open session is ${await activeTitle()}, not ${firstSession}`)
  console.log('[smoke] settings page checks passed')
}

/** Opens every folded work log ("Worked for 2m 14s"), so its steps are in the page. */
async function openWorkLogs() {
  await evaluate(`(() => {
    document.querySelectorAll('.worklog-head[aria-expanded="false"]').forEach((head) => head.click())
    return true
  })()`)
  await sleep(250)
}

/**
 * The session view after the demo run: a finished turn folds to "Worked for ...", opens on a click,
 * shows its result card, and the thread is 736 px of content in a wide window.
 */
async function runSessionViewChecks() {
  console.log('[smoke] --- session view ---')
  const head = await evaluate(`(() => {
    const node = document.querySelector('.worklog-head')
    return node ? { text: node.textContent, open: node.getAttribute('aria-expanded') } : null
  })()`)
  console.log('[smoke] work log header:', JSON.stringify(head))
  if (!head || !/^Worked for \d/.test(head.text) || head.open !== 'false') throw new Error('a finished turn should fold to "Worked for ..."')
  if ((await count('.worklog-body')) !== 0) throw new Error('a folded work log still shows its steps')
  await click('.worklog-head')
  await waitFor("document.querySelectorAll('.worklog-body .tool-row').length >= 2", 4000, 'the work log opens on a click')
  const card = await evaluate("document.querySelector('.result-card .result-title')?.textContent ?? ''")
  if (!card.startsWith('Edited 1 file')) throw new Error(`the result card says "${card}"`)
  if ((await evaluate("document.querySelector('.session-header')?.getBoundingClientRect().height")) !== 52) throw new Error('the session header is not 52 px')

  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const thread = await evaluate("document.querySelector('.thread')?.getBoundingClientRect().width")
  if (thread !== 784) throw new Error(`the thread is ${thread} px wide, not 736 px of content with 24 px at each side`)
  await sleep(300)
  await screenshot('ui-dark-thread-1920x1080.png')
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(200)

  // The header menus.
  await click('.session-header [aria-label="Summary"]')
  await waitFor("!!document.querySelector('.ui-menu[aria-label=\"Summary\"]')", 4000, 'Summary menu')
  const summary = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  if (!summary.includes('Files changed') || !summary.includes('Commands run')) throw new Error(`the summary menu is missing items: ${summary}`)
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await waitFor("!document.querySelector('.ui-menu')", 4000, 'Escape closes the summary')
  console.log('[smoke] session view checks passed')
}

const FIND_STATE = `(() => {
  const marks = CSS.highlights.get('enc-find')
  const current = CSS.highlights.get('enc-find-current')
  return {
    bar: Boolean(document.querySelector('.find-bar')),
    count: document.querySelector('.find-bar-count')?.textContent ?? null,
    marks: marks?.size ?? 0,
    current: current ? [...current].map((range) => range.toString()).join('|') : '',
    logOpen: document.querySelector('.worklog-head')?.getAttribute('aria-expanded'),
    focus: document.activeElement?.className ?? '',
  }
})()`

/**
 * Ctrl+F in the session after the demo run: words that are only in the folded work log (the note the demo wrote, in
 * the Write step's diff) open it and are marked and counted; the note's path, named five times (twice in the Write step,
 * in the Read step, the reply and the change card's folded list of files), steps round with Enter and back with
 * Shift+Enter; words that are nowhere fold the log back; Esc closes the bar with the log left open
 * around the match it closed on and the focus back in the message box; Ctrl+F again keeps the words; and words
 * selected in the thread start a search.
 */
async function runFindChecks() {
  console.log('[smoke] --- find in the session ---')
  const countIs = (text) => `document.querySelector('.find-bar-count')?.textContent === ${JSON.stringify(text)}`
  if ((await evaluate("document.querySelector('.worklog-head')?.getAttribute('aria-expanded')")) === 'true') await click('.worklog-head')
  await waitFor("document.querySelectorAll('.worklog-body').length === 0", 4000, 'the work log folds')
  await evaluate("document.querySelector('.composer-input')?.focus()")
  await pressKey('f', { ctrl: true })
  await waitFor("document.activeElement?.classList.contains('find-bar-input') === true", 4000, 'Ctrl+F opens the find bar with the cursor in it')
  await typeInto('.find-bar-input', 'Written by  the OFFLINE demo')
  await waitFor(countIs('1 of 1'), 4000, 'the words written in the folded work log')
  let state = await evaluate(FIND_STATE)
  console.log('[smoke] find:', JSON.stringify(state))
  if (state.logOpen !== 'true' || state.marks !== 1 || state.current !== 'written by the offline demo') {
    throw new Error('find did not open the work log and mark the words written in it')
  }
  await screenshot('ui-dark-find.png')

  await typeInto('.find-bar-input', 'DEMO-NOTE.md')
  await waitFor("/^[1-5] of 5$/.test(document.querySelector('.find-bar-count')?.textContent ?? '')", 4000, 'the note named five times')
  if ((await evaluate(FIND_STATE)).current.toLowerCase() !== 'demo-note.md') throw new Error('the match in view is not marked')
  const first = await evaluate("document.querySelector('.find-bar-count').textContent")
  await pressKey('Enter')
  await waitFor(`document.querySelector('.find-bar-count')?.textContent !== ${JSON.stringify(first)}`, 4000, 'Enter moves to the next match')
  for (let press = 0; press < 4; press++) await pressKey('Enter')
  await waitFor(countIs(first), 4000, 'five presses of Enter go round to the same match')
  await pressKey('Enter', { shift: true })
  await waitFor(`document.querySelector('.find-bar-count')?.textContent !== ${JSON.stringify(first)}`, 4000, 'Shift+Enter goes back')

  await typeInto('.find-bar-input', 'no such words anywhere')
  await waitFor(countIs('No results'), 4000, 'No results')
  state = await evaluate(FIND_STATE)
  if (state.marks !== 0) throw new Error('marks stayed for words that are not there')
  if (state.logOpen !== 'false') throw new Error('the work log find opened did not fold back when its words went')
  await typeInto('.find-bar-input', 'written by the offline demo')
  await waitFor(countIs('1 of 1'), 4000, 'found again')

  await pressKey('Escape')
  await waitFor("!document.querySelector('.find-bar')", 4000, 'Esc closes the find bar')
  state = await evaluate(FIND_STATE)
  if (state.marks !== 0 || state.current) throw new Error('the marks stayed after the bar closed')
  if (state.logOpen !== 'true') throw new Error('the work log folded away from the match the bar closed on')
  if (!state.focus.includes('composer-input')) throw new Error(`the focus went to "${state.focus}", not back to the message box`)

  await pressKey('f', { ctrl: true })
  await waitFor(
    "(() => { const input = document.querySelector('.find-bar-input'); return input?.value === 'written by the offline demo' && document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length })()",
    4000,
    'Ctrl+F opens on the last words, selected',
  )
  await pressKey('Escape')
  await waitFor("!document.querySelector('.find-bar')", 4000, 'Esc closes it again')

  // Words selected in the reply start a search for them.
  const selected = await evaluate(`(() => {
    const reply = [...document.querySelectorAll('.msg-assistant')].at(-1)
    const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf('approval flow')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 'approval flow'.length)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      return true
    }
    return false
  })()`)
  if (!selected) throw new Error('the demo reply has no "approval flow" to select')
  await pressKey('f', { ctrl: true })
  await waitFor("document.querySelector('.find-bar-input')?.value === 'approval flow'", 4000, 'Ctrl+F looks for the selected words')
  await waitFor("/ of [1-9]/.test(document.querySelector('.find-bar-count')?.textContent ?? '')", 4000, 'the selected words are found')
  await click('.find-bar [aria-label="Close"]')
  await waitFor("!document.querySelector('.find-bar')", 4000, 'Close closes the find bar')
  await evaluate('getSelection().removeAllRanges()')
  console.log('[smoke] find in the session: ok')
}

/**
 * The side panel and the bottom panel: tabs and the New tab page, a Browser tab that remembers its
 * page, the three layouts, resizing, and the shortcuts that drive them.
 */
async function runPanelChecks() {
  console.log('[smoke] --- panels ---')
  // The layout rules below depend on the window's size, and a runner's screen can be smaller than the window: fix it.
  const windowSize = { width: 1480, height: 920 }
  const sizeWindow = (size) => send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false })
  await sizeWindow(windowSize)
  await sleep(300)
  const titles = () => evaluate("[...document.querySelectorAll('.side-panel .panel-tab-title')].map((node) => node.textContent)")
  const inFront = "document.querySelector('.side-panel .panel-tab.is-active .panel-tab-title')?.textContent"
  const layoutIs = (name) => `document.querySelector('.side-panel')?.dataset.layout === '${name}' && !document.querySelector('.right-wrap').classList.contains('is-hidden')`
  const panelHidden = "document.querySelector('.right-wrap')?.classList.contains('is-hidden') === true"
  const width = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`)
  const drag = (selector, moveX, moveY) =>
    evaluate(`(() => {
      const handle = document.querySelector(${JSON.stringify(selector)})
      const box = handle.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const at = (offsetX, offsetY) => ({ bubbles: true, cancelable: true, clientX: x + offsetX, clientY: y + offsetY })
      handle.dispatchEvent(new PointerEvent('pointerdown', at(0, 0)))
      window.dispatchEvent(new PointerEvent('pointermove', at(${moveX}, ${moveY})))
      window.dispatchEvent(new PointerEvent('pointerup', at(${moveX}, ${moveY})))
    })()`)

  // The strip: 30 px tabs, none wider than 170 px, one selected.
  const strip = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.side-panel .panel-tab')]
    return {
      count: tabs.length,
      height: tabs[0]?.getBoundingClientRect().height,
      widest: Math.max(...tabs.map((node) => node.getBoundingClientRect().width)),
      selected: document.querySelectorAll('.side-panel [role="tab"][aria-selected="true"]').length,
    }
  })()`)
  console.log('[smoke] strip:', JSON.stringify(strip))
  if (strip.count < 1 || strip.height !== 30 || strip.widest > 170 || strip.selected !== 1) throw new Error('the side panel tabs are not the specified size')

  // Ctrl+T opens a New tab page; choosing Browser turns that page into a Browser tab.
  const start = await titles()
  await key({ key: 't', code: 'KeyT', ctrlKey: true })
  await waitFor("!!document.querySelector('.newtab')", 4000, 'Ctrl+T opens a New tab page')
  await waitFor(`${inFront} === 'New tab'`, 4000, 'the New tab page is in front')
  await sleep(300)
  await screenshot('ui-dark-newtab.png')
  if (!(await click('.newtab-card', 'Browser'))) throw new Error('the New tab page has no Browser')
  await waitFor("!document.querySelector('.newtab') && !!document.querySelector('.browser-address input')", 4000, 'the page became a Browser tab')
  if ((await titles()).length !== start.length + 1) throw new Error('choosing Browser added a tab instead of using the New tab page')

  // A page that forbids being framed (X-Frame-Options and frame-ancestors) opens in the tab, which is a page of its own
  // rather than a frame, and its script-blocking policy is in force.
  const deniedUrl = `http://127.0.0.1:${providerPort}/__frame/denied`
  await typeInto('.browser-address input', deniedUrl)
  await evaluate("document.querySelector('.browser-address input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  // The page's target is there as soon as it starts loading; its title once it has loaded.
  let framed = ''
  for (const started = Date.now(); !framed && Date.now() - started < 10000; await sleep(200)) framed = await evaluateInFrame(deniedUrl, "document.readyState === 'complete' ? document.title : ''")
  if (framed !== 'Framed page') {
    throw new Error(framed === 'Script ran' ? 'The Browser tab did not keep the page policy: its script ran' : `The page is titled ${JSON.stringify(framed)}`)
  }
  console.log('[smoke] a page that forbids framing is shown in the Browser tab, with its policy')

  // An address that needs no network: nothing listens on port 8, so the tab says the page did not load.
  await typeInto('.browser-address input', 'http://127.0.0.1:8/')
  await evaluate("document.querySelector('.browser-address input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await waitFor(`${inFront} === '127.0.0.1:8'`, 4000, 'the tab is named after the page')
  await waitFor("/did not load/.test(document.querySelector('.side-panel .panel-pane.is-active .browser-failure')?.textContent ?? '')", 8000, 'the tab says the page did not load')
  await screenshot('ui-dark-browser-failed.png')

  // Ctrl+W closes it and Ctrl+Shift+T brings it back on the same page, in the same place.
  const withBrowser = await titles()
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.browser-address')", 4000, 'Ctrl+W closes the tab')
  if ((await titles()).length !== start.length) throw new Error('Ctrl+W did not close exactly one tab')
  await key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })
  await waitFor("document.querySelector('.browser-address input')?.value === 'http://127.0.0.1:8/'", 4000, 'Ctrl+Shift+T brings the tab back on its page')
  if (JSON.stringify(await titles()) !== JSON.stringify(withBrowser)) throw new Error('the reopened tab is not where it was')

  // The page is also listed on the New tab page.
  await key({ key: 't', code: 'KeyT', ctrlKey: true })
  await waitFor("[...document.querySelectorAll('.newtab-page')].some((node) => node.textContent.includes('127.0.0.1:8'))", 4000, 'the New tab page lists the recent page')
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.newtab')", 4000, 'an empty New tab page closes')

  // Tabs by number and by step.
  await key({ key: '1', code: 'Digit1', ctrlKey: true })
  await waitFor(`${inFront} === ${JSON.stringify(start[0])}`, 4000, 'Ctrl+1 goes to the first tab')
  await key({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true })
  await waitFor(`${inFront} === ${JSON.stringify(withBrowser[1])}`, 4000, 'Ctrl+Shift+] goes to the next tab')
  await key({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true })
  await waitFor(`${inFront} === ${JSON.stringify(start[0])}`, 4000, 'Ctrl+Shift+[ goes to the previous tab')

  // Layouts: full width covers the thread (which stays mounted), Ctrl+Shift+B cycles split, full, hidden.
  await key({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })
  await waitFor(layoutIs('full'), 4000, 'Ctrl+Alt+F makes the panel full width')
  if ((await evaluate("getComputedStyle(document.querySelector('.app-main')).display")) !== 'none') throw new Error('a full-width panel does not cover the thread')
  if (!(await evaluate("!!document.querySelector('.composer-input')"))) throw new Error('the thread was unmounted under the full-width panel')
  await sleep(300)
  await screenshot('ui-dark-panel-full.png')
  await key({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })
  await waitFor(layoutIs('split'), 4000, 'Ctrl+Alt+F goes back to split')
  await key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
  await waitFor(layoutIs('full'), 4000, 'Ctrl+Shift+B: split to full')
  await key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
  await waitFor(panelHidden, 4000, 'Ctrl+Shift+B: full to hidden')
  await key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
  await waitFor(layoutIs('split'), 4000, 'Ctrl+Shift+B: hidden to split')

  // Drag the divider: the panel follows the pointer, and keeps its width for the next run.
  const wide = await width('.right-wrap')
  await drag('.workrow > .resizer-v', -60, 0)
  await waitFor(`Math.abs(document.querySelector('.right-wrap').getBoundingClientRect().width - ${wide + 60}) < 2`, 4000, 'dragging the divider left widens the panel')
  if ((await evaluate("localStorage.getItem('eNCode.sidepanel.v1')")) !== String(Math.round(wide + 60))) throw new Error('the panel width was not saved')
  await drag('.workrow > .resizer-v', 60, 0)
  await waitFor(`Math.abs(document.querySelector('.right-wrap').getBoundingClientRect().width - ${wide}) < 2`, 4000, 'dragging the divider right narrows the panel')

  // In a narrow window the panel is held under 60% of the row, and a drag starts from the width on screen, not the saved one.
  await sizeWindow({ width: 1024, height: 768 })
  await waitFor("document.querySelector('.right-wrap').getBoundingClientRect().width <= document.querySelector('.workrow').getBoundingClientRect().width * 0.6 + 1", 4000, 'a narrow window holds the panel under 60% of the row')
  const held = await width('.right-wrap')
  if (held >= wide - 2) throw new Error(`the panel was not held back in a narrow window (${held} px, saved ${wide} px)`)
  await drag('.workrow > .resizer-v', 40, 0)
  await waitFor(`Math.abs(document.querySelector('.right-wrap').getBoundingClientRect().width - ${held - 40}) < 2`, 4000, 'a drag in a narrow window starts from the width on screen')
  await sizeWindow(windowSize)
  await sleep(300)
  await drag('.workrow > .resizer-v', Math.round((await width('.right-wrap')) - wide), 0)
  await waitFor(`Math.abs(document.querySelector('.right-wrap').getBoundingClientRect().width - ${wide}) < 2`, 4000, 'the panel is back at its width')

  // Bottom panel: the shell stays alive while the panel is hidden, and the panel resizes.
  const bottomShown = "!!document.querySelector('.bottom-panel') && !document.querySelector('.bottom-panel').classList.contains('is-closed')"
  await key({ key: '`', code: 'Backquote', ctrlKey: true })
  await waitFor(`${bottomShown} && !!document.querySelector('.bottom-panel .terminal-lines')`, 15000, 'Ctrl+` shows the terminal in the bottom panel')
  await waitFor("(document.querySelector('.bottom-panel .term-prompt')?.textContent ?? '').trim().length > 0", 15000, 'the shell has started')
  await typeInto('.bottom-panel .term-input', 'echo kept-ok')
  await sleep(250)
  await evaluate("document.querySelector('.bottom-panel .term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await waitFor("document.querySelector('.bottom-panel .terminal-lines')?.textContent.includes('kept-ok')", 10000, 'the shell answers')
  await key({ key: 'j', code: 'KeyJ', ctrlKey: true })
  await waitFor("document.querySelector('.bottom-panel')?.classList.contains('is-closed')", 4000, 'Ctrl+J hides the bottom panel')
  await key({ key: 'j', code: 'KeyJ', ctrlKey: true })
  await waitFor(bottomShown, 4000, 'Ctrl+J shows the bottom panel')
  if (!(await evaluate("document.querySelector('.bottom-panel .terminal-lines').textContent.includes('kept-ok')"))) throw new Error('hiding the bottom panel cleared the terminal')
  const tall = await evaluate("document.querySelector('.bottom-panel').getBoundingClientRect().height")
  await drag('.bottom-panel > .resizer-h', 0, -80)
  await waitFor(`Math.abs(document.querySelector('.bottom-panel').getBoundingClientRect().height - ${tall + 80}) < 2`, 4000, 'dragging the handle up raises the bottom panel')
  await drag('.bottom-panel > .resizer-h', 0, 80)
  await waitFor(`Math.abs(document.querySelector('.bottom-panel').getBoundingClientRect().height - ${tall}) < 2`, 4000, 'dragging the handle down lowers it')

  // Background jobs open beside the terminal, from the session summary.
  if (!(await click('.session-actions button[aria-label="Summary"]'))) throw new Error('Summary button not found')
  await waitFor(menuOpen('Summary'), 4000, 'Summary menu')
  if (!(await click('.ui-menu [role^="menuitem"]', 'Background jobs'))) throw new Error('Summary has no Background jobs')
  await waitFor("[...document.querySelectorAll('.bottom-panel .panel-tab-title')].some((node) => node.textContent === 'Jobs')", 4000, 'Background jobs opens the Jobs tab')
  await waitFor("document.querySelector('.bottom-panel .panel-tab.is-active .panel-tab-title')?.textContent === 'Jobs'", 4000, 'Jobs is in front')
  await sleep(300)
  await screenshot('ui-dark-bottom-panel.png')
  await key({ key: '`', code: 'Backquote', ctrlKey: true })
  await waitFor("document.querySelector('.bottom-panel .panel-tab.is-active .panel-tab-title')?.textContent === 'Terminal'", 4000, 'Ctrl+` brings the terminal forward')

  // Leave the side panel as it was found: the Browser tab closed, the first tab in front.
  if (!(await click('.side-panel .panel-tab-main', '127.0.0.1:8'))) throw new Error('the Browser tab is gone')
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.browser-address')", 4000, 'the Browser tab closed')
  await key({ key: '1', code: 'Digit1', ctrlKey: true })
  await waitFor(`${inFront} === ${JSON.stringify(start[0])}`, 4000, 'back on the first tab')
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(200)
}

/** Polls a check made in this process (on the disk, with git) until it holds. */
async function until(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await sleep(150)
  }
}

/**
 * The Review tab on a repository: a change shows in the Unstaged view with its colours, one of its two hunks is
 * staged and committed with a message typed over the drafted one, and a reverted file comes back with Ctrl+Z.
 */
async function runReviewChecks() {
  console.log('[smoke] --- review ---')
  const git = (...args) => execFileSync('git', args, { cwd: demoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  const sample = path.join(demoPath, 'src', 'review-me.ts')
  const lines = Array.from({ length: 40 }, (_, index) => `export const value${index + 1} = ${index + 1}`)
  await fs.writeFile(sample, lines.join('\n') + '\n')
  // The folder becomes a repository with everything committed; the identity is the repository's own, for the app's commit too.
  git('init', '-q')
  git('config', 'user.name', 'eNCode smoke')
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-q', '--no-verify', '-m', 'Baseline')
  // Two changes far apart: two hunks.
  lines[2] = 'export const value3 = 300 // first change'
  lines[34] = 'export const value35 = 3500 // second change'
  await fs.writeFile(sample, lines.join('\n') + '\n')

  await key({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true })
  await waitFor("document.querySelector('.side-panel .panel-tab.is-active .panel-tab-title')?.textContent === 'Review'", 6000, 'Ctrl+Shift+G opens the Review tab')
  await waitFor("[...document.querySelectorAll('.review-pane .rv-file-head .rv-name')].some((node) => node.textContent === 'review-me.ts')", 15000, 'the change shows in Review')
  await waitFor("document.querySelectorAll('.review-pane .rv-hunk-head').length === 2", 6000, 'the change is two hunks')
  const shown = await evaluate(`(() => ({
    added: [...document.querySelectorAll('.review-pane .rv-line.is-add')].map((node) => node.textContent),
    tokens: document.querySelectorAll('.review-pane .rv-line .tok-keyword').length,
    files: document.querySelectorAll('.review-pane .rv-file-head:not(.is-pinned)').length,
  }))()`)
  console.log('[smoke] review shows:', JSON.stringify(shown))
  if (shown.files !== 1) throw new Error(`the review lists ${shown.files} files, not the one that changed`)
  if (!shown.added.some((text) => text.includes('first change')) || !shown.added.some((text) => text.includes('second change'))) throw new Error('the added lines are not shown')
  if (shown.tokens < 1) throw new Error('the review does not colour the code')
  await sleep(300)
  await screenshot('ui-dark-review.png')

  // Stage the first hunk alone.
  if (!(await click('.review-pane .rv-hunk-head .rv-chip', 'Stage'))) throw new Error('the hunk has no Stage')
  await waitFor("document.querySelectorAll('.review-pane .rv-hunk-head').length === 1", 10000, 'one hunk is left to stage')
  const staged = git('diff', '--cached')
  if (!staged.includes('first change') || staged.includes('second change')) throw new Error(`staging one hunk staged something else:\n${staged}`)

  // Commit it, with a message typed over the one being drafted.
  if (!(await click('.review-pane .rv-commit'))) throw new Error('no Commit button')
  await waitFor("!!document.querySelector('[role=\"dialog\"] .commit-message')", 4000, 'the Commit dialog')
  await sleep(300)
  await typeInto('.commit-message', 'Change value3 from the smoke')
  await sleep(200)
  if (!(await click('[role="dialog"] .ui-dialog-foot .btn.primary', 'Commit'))) throw new Error('the dialog has no Commit button')
  await until(() => git('log', '-1', '--format=%s').trim() === 'Change value3 from the smoke', 15000, 'the commit is made with the typed message')
  await waitFor("!document.querySelector('[role=\"dialog\"] .commit-message')", 6000, 'the Commit dialog closes')
  if (git('diff', '--cached').trim()) throw new Error('something is still staged after the commit')
  await waitFor("document.querySelectorAll('.review-pane .rv-hunk-head').length === 1", 10000, 'the second change is still there to review')

  // Revert the file, then take it back with Ctrl+Z.
  if (!(await click('.review-pane .rv-file-head:not(.is-pinned) button[aria-label="Revert this file"]'))) throw new Error('no Revert this file')
  await until(async () => !(await fs.readFile(sample, 'utf8')).includes('second change'), 10000, 'the file is reverted on disk')
  await waitFor("!!document.querySelector('.review-pane .rv-empty')", 10000, 'nothing is left to review')
  await evaluate("document.querySelector('.review-pane .rv-bar').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))")
  await until(async () => (await fs.readFile(sample, 'utf8')).includes('second change'), 10000, 'Ctrl+Z brings the reverted change back')
  await waitFor("document.querySelectorAll('.review-pane .rv-hunk-head').length === 1", 10000, 'the change shows again')
  console.log('[smoke] review: staged a hunk, committed it, reverted a file and undid that')
  await runReviewerChecks()

  // Leave the side panel as it was found.
  await key({ key: 'w', code: 'KeyW', ctrlKey: true })
  await waitFor("!document.querySelector('.review-pane')", 4000, 'the Review tab closed')
}

/**
 * A worktree from the chat (ADR 0105), on the repository the review checks made: /worktree moves the session into one,
 * its chip's menu brings what it changed into the project and removes it, after asking, with the work in it; /local
 * takes the session back and leaves the worktree where it is.
 */
async function runChatWorktreeChecks() {
  console.log('[smoke] --- worktrees from the chat ---')
  const git = (...args) => execFileSync('git', args, { cwd: demoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  const chip = "document.querySelector('.session-header .ui-chip.tone-accent')?.textContent ?? ''"
  const folder = (name) => path.join(demoPath, '.encode-worktrees', name)
  // Run on its own (ENCODE_SMOKE_ONLY=worktree), the folder is not a repository yet.
  if (!(await fs.stat(path.join(demoPath, '.git')).catch(() => null))) {
    git('init', '-q')
    git('config', 'user.name', 'eNCode smoke')
    git('config', 'user.email', 'smoke@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('add', '-A')
    git('commit', '-q', '--no-verify', '-m', 'Baseline')
  }
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('/worktree chat-a')
  await waitFor(`(${chip}).includes('chat-a')`, 20000, 'the header shows the worktree')
  if (!(await fs.stat(folder('chat-a')).catch(() => null))) throw new Error('/worktree made no worktree')
  // What the agent would have done there: a new file, not committed.
  await fs.writeFile(path.join(folder('chat-a'), 'src', 'from-worktree.ts'), 'export const fromWorktree = true\n')
  const chooseFromChip = async (item) => {
    if (!(await click('.session-header .ui-chip.tone-accent'))) throw new Error('The worktree chip is not a button')
    await waitFor(menuOpen('Worktree'), 4000, 'the worktree menu')
    if (!(await click('.ui-menu [role^="menuitem"]', item))) throw new Error(`The worktree menu has no ${item}`)
  }
  await chooseFromChip('Bring changes into the project')
  await until(async () => (await fs.readFile(path.join(demoPath, 'src', 'from-worktree.ts'), 'utf8').catch(() => '')).includes('fromWorktree'), 10000, 'the change is in the project')
  await screenshot('ui-dark-chat-worktree.png')
  await chooseFromChip('Remove the worktree…')
  await waitFor("!!document.querySelector('.confirm-body')", 6000, 'removing asks first, since the worktree holds work')
  if (!(await click('.btn.danger', 'Remove'))) throw new Error('The confirm dialog has no Remove')
  await waitFor(`!(${chip}).includes('chat-a')`, 20000, 'the chip goes')
  if (await fs.stat(folder('chat-a')).catch(() => null)) throw new Error('The worktree folder is still there')
  if (git('branch', '--list', 'encode/chat-a').trim()) throw new Error('The worktree left its branch')

  await sendPrompt('/worktree chat-b')
  await waitFor(`(${chip}).includes('chat-b')`, 20000, 'the second worktree')
  await sendPrompt('/local')
  await waitFor(`!(${chip}).includes('chat-b')`, 20000, '/local takes the session back')
  if (!(await fs.stat(folder('chat-b')).catch(() => null))) throw new Error('/local removed the worktree')
  // Left as the review and best-of checks expect the repository: no worktree, and the brought file gone.
  git('worktree', 'remove', '--force', folder('chat-b'))
  git('branch', '-D', 'encode/chat-b')
  await fs.rm(path.join(demoPath, 'src', 'from-worktree.ts'), { force: true })
  console.log('[smoke] worktrees from the chat: entered, brought in, removed after asking, left with /local')
}

/**
 * Best of N (ADR 0098), on the repository the review checks made, their uncommitted change still in it: `/best 2`
 * makes two attempts in worktrees that hold that change too, each writes src/best.ts its own way and runs the demo's
 * tests, asked for under the card by attempt; the Reviewer picks the second; the project changes only on Keep, and
 * no worktree or branch is left after.
 */
async function runBestOfChecks() {
  console.log('[smoke] --- best of N ---')
  const git = (...args) => execFileSync('git', args, { cwd: demoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
  const target = path.join(demoPath, 'src', 'best.ts')
  const uncommitted = await fs.readFile(path.join(demoPath, 'src', 'review-me.ts'), 'utf8')
  if (!uncommitted.includes('second change')) throw new Error('The review checks left no uncommitted change to seed the attempts with')
  const before = await providerStats()
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'local-mock', checkGate: 'auto' })")
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('/best 2 [scenario:best-of] Add a sum function in src/best.ts')
  await waitFor("!!document.querySelector('.best-card')", 20000, 'the best-of card')
  await waitFor("document.querySelectorAll('.best-card .best-attempt').length === 2", 10000, 'two attempts on the card')
  // The attempts are under way: each has its worktree, which holds the project's uncommitted change.
  await until(async () => {
    const names = await fs.readdir(path.join(demoPath, '.encode-worktrees')).catch(() => [])
    return names.filter((name) => name.startsWith('best-')).length === 2
  }, 30000, 'two worktrees')
  const names = (await fs.readdir(path.join(demoPath, '.encode-worktrees'))).filter((name) => name.startsWith('best-')).sort()
  for (const name of names) {
    await until(async () => (await fs.readFile(path.join(demoPath, '.encode-worktrees', name, 'src', 'review-me.ts'), 'utf8').catch(() => '')).includes('second change'), 20000, `the seed of ${name}`)
  }
  const approvals = await driveAgent('16-best-of', 180000)
  console.log('[smoke] best of N asked:', JSON.stringify(approvals.map((card) => card.title)))
  if (!approvals.length || approvals.some((card) => !/^Attempt [12]: /.test(card.title))) throw new Error(`Every approval should name its attempt: ${JSON.stringify(approvals)}`)
  await waitFor("document.querySelector('.best-card')?.dataset.state === 'ready'", 30000, 'the attempts are judged')
  const after = await providerStats()
  if (after.bestOfRequests - before.bestOfRequests !== 1) throw new Error(`The Reviewer was asked ${after.bestOfRequests - before.bestOfRequests} times, not once`)
  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-best-of`)).json()
  console.log('[smoke] the verdict was asked:', JSON.stringify({ tools: seen.tools.length, user: seen.user.slice(0, 600) }))
  if (seen.tools.length) throw new Error('The Reviewer was given tools')
  if (!/<attempt-[0-9a-f]+ n="1">[\s\S]*\+2 \|\s+return a - b/.test(seen.user) || !/<attempt-[0-9a-f]+ n="2">[\s\S]*\+2 \|\s+return a \+ b/.test(seen.user)) throw new Error('The Reviewer did not see both attempts')
  const card = await evaluate(`(() => {
    const card = document.querySelector('.best-card')
    return {
      title: card.querySelector('.best-title')?.textContent ?? '',
      reason: card.querySelector('.best-reason')?.textContent ?? '',
      rows: [...card.querySelectorAll('.best-attempt')].map((row) => row.textContent),
    }
  })()`)
  console.log('[smoke] the card:', JSON.stringify(card))
  if (card.title !== 'Attempt 2 looks best' || !card.reason.includes('Attempt 2 adds the numbers')) throw new Error(`The card reads ${JSON.stringify(card)}`)
  if (!card.rows.every((row) => row.includes('Checks passed') && row.includes('+3'))) throw new Error(`Each attempt should show its passing checks and its lines: ${JSON.stringify(card.rows)}`)
  if (await fs.stat(target).catch(() => null)) throw new Error('The project changed before Keep')
  await screenshot('16-best-of.png')

  if (!(await click('.best-card .best-attempt[data-attempt="2"] .btn.primary'))) throw new Error('Attempt 2 has no Keep')
  await waitFor("document.querySelector('.best-card')?.dataset.state === 'kept'", 20000, 'the card says attempt 2 was kept')
  const kept = await fs.readFile(target, 'utf8')
  if (!kept.includes('return a + b')) throw new Error(`src/best.ts reads ${JSON.stringify(kept)}`)
  if ((await fs.readFile(path.join(demoPath, 'src', 'review-me.ts'), 'utf8')) !== uncommitted) throw new Error('Keeping the attempt changed a file it did not change')
  const left = (await fs.readdir(path.join(demoPath, '.encode-worktrees')).catch(() => [])).filter((name) => name.startsWith('best-'))
  if (left.length) throw new Error(`Worktrees were left: ${left.join(', ')}`)
  if (git('branch', '--list', 'encode/best-*').trim()) throw new Error('The attempts left branches')
  if (git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length !== 1) throw new Error('git still lists the attempts')
  // Kept through the checkpoints: the request that made the attempts changed one file, so Undo and Rewind can take it back.
  const recorded = await evaluate(`(async () => {
    const [session] = await window.eNCode.agent.sessions()
    const info = await window.eNCode.agent.checkpoints(session.id)
    return info.turns.map((turn) => turn.files)
  })()`)
  console.log('[smoke] the checkpoints hold:', JSON.stringify(recorded))
  if (recorded.at(-1) !== 1) throw new Error(`The checkpoints recorded ${JSON.stringify(recorded)}`)
  await screenshot('16b-best-of-kept.png')
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'demo', checkGate: 'off' })")
  await fs.rm(target, { force: true })
}

/**
 * Ask the Reviewer, with the unstaged change of the review checks in view: the offline demo says it reads no code;
 * a real model is sent the change with numbered lines and no tools, and its findings become comments on those lines,
 * marked with their priority, while a finding on a file the change does not touch is dropped.
 */
async function runReviewerChecks() {
  console.log('[smoke] --- the Reviewer ---')
  const findings = "[...document.querySelectorAll('.review-pane .rv-comment.is-reviewer')]"
  const verdict = "(document.querySelector('.review-pane .rv-verdict')?.textContent ?? '')"

  await click('.review-pane .rv-ask')
  await waitFor(`!!document.querySelector('.review-pane .rv-verdict.is-clean') && ${verdict}.includes('offline demo does not read code')`, 15000, 'the demo says it reads no code')
  if (await evaluate(`${findings}.length`)) throw new Error('the demo left findings')

  await evaluate("window.eNCode.settings.save({ activeProfileId: 'local-mock' })")
  await typeInto('.composer-input', '/review unstaged')
  await sleep(250)
  await composerKey({ key: 'Enter' })
  await waitFor(`${findings}.length === 2 && ${verdict}.includes('The Reviewer left 2 comments.')`, 30000, '/review leaves the findings as comments')
  const shown = await evaluate(`${findings}.map((node) => ({
    priority: node.dataset.priority,
    head: node.querySelector('.rv-comment-where')?.textContent ?? '',
    title: node.querySelector('.rv-finding-title')?.textContent ?? '',
  }))`)
  if (JSON.stringify(shown.map((item) => item.priority)) !== '["P1","P3"]') throw new Error(`the findings are ${JSON.stringify(shown)}`)
  if (shown[0].head !== 'Reviewer · Line 35' || shown[0].title !== 'Divides by zero when the list is empty') throw new Error(`the first finding reads ${JSON.stringify(shown[0])}`)
  const sent = await (await fetch(`http://127.0.0.1:${providerPort}/__last-code-review`)).json()
  if (sent.tools.length) throw new Error(`the Reviewer was offered tools: ${JSON.stringify(sent.tools)}`)
  if (!sent.user.includes('<file path="src/review-me.ts" change="modified">') || !sent.user.includes('+35 | export const value35 = 3500 // second change')) {
    throw new Error(`the Reviewer was not sent the numbered change: ${sent.user.slice(0, 400)}`)
  }
  if (!(await evaluate("document.querySelector('.review-pane .rv-foot')?.textContent ?? ''")).includes('Send 2 comments')) throw new Error('the findings cannot be sent to the agent')
  await sleep(300)
  await screenshot('ui-dark-reviewer.png')

  await evaluate(`${findings}[1].querySelector('[aria-label="Delete comment"]').click()`)
  await waitFor(`${findings}.length === 1`, 4000, 'a finding can be deleted')
  await click('.review-pane .rv-verdict [aria-label="Close"]')
  await waitFor("!document.querySelector('.review-pane .rv-verdict')", 4000, 'the verdict closes, and its comments stay')
  if ((await evaluate(`${findings}.length`)) !== 1) throw new Error('closing the verdict took the comments')
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'demo' })")
  console.log('[smoke] the Reviewer: ok')
}

/**
 * Changing shortcuts in Settings > Keyboard shortcuts: a shortcut is found by name, by its keys typed or pressed, a
 * chord that cannot be one is refused with the reason, a free one works at once, in the menus and after a restart, one
 * another command has asks first, Esc stops listening without leaving the page, and Reset all puts every shortcut
 * back, with an Undo that can be pressed over the page.
 */
async function runShortcutChecks() {
  console.log('[smoke] --- changing shortcuts ---')
  const row = (id) => `.shortcuts-row[data-shortcut="${id}"]`
  const keysOf = (id) =>
    evaluate(`[...document.querySelectorAll('${row(id)} .shortcuts-keys .ui-kbd-group')].map((group) => group.getAttribute('aria-label')).join(' or ')`)
  const saved = () => evaluate('window.eNCode.settings.get().then((settings) => JSON.stringify(settings.keybindings))')
  const bottomShown = "(!!document.querySelector('.bottom-panel') && !document.querySelector('.bottom-panel').classList.contains('is-closed'))"
  const sidebarShown = "!!document.querySelector('.session-sidebar')"
  const onTop = (selector) =>
    evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return false
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })()`)
  const openList = async () => {
    await key({ key: '/', code: 'Slash', ctrlKey: true })
    await waitFor("!!document.querySelector('.settings-page .shortcuts-row') && document.querySelector('.settings-heading')?.textContent === 'Keyboard shortcuts'", 4000, 'Ctrl+/ opens the shortcuts')
    await waitFor("document.activeElement?.classList.contains('shortcuts-filter') === true", 4000, 'the search of the shortcuts has the focus')
  }
  const pageOpen = () => evaluate("!!document.querySelector('.settings-page .shortcuts-row')")
  const listen = async (id) => {
    await click(`${row(id)} .shortcuts-keys`)
    await waitFor(`document.activeElement?.matches('${row(id)} .shortcuts-recorder') === true`, 4000, `the ${id} row listens for a new shortcut`)
  }

  await openList()
  await typeInto('.shortcuts-filter', 'bottom panel')
  await waitFor(`document.querySelectorAll('.shortcuts-row').length === 1 && !!document.querySelector('${row('view.bottomPanel')}')`, 4000, 'the list finds the row by name')
  await typeInto('.shortcuts-filter', 'ctrl j')
  await waitFor(`document.querySelectorAll('.shortcuts-row').length === 1 && !!document.querySelector('${row('view.bottomPanel')}')`, 4000, 'and by its keys')

  // Or by pressing them: the field takes the keys as the one shortcut to find, and Esc goes back to typing.
  await typeInto('.shortcuts-filter', '')
  const panelBefore = await evaluate(bottomShown)
  await click('.shortcuts-record')
  await waitFor("document.querySelector('.shortcuts-record')?.getAttribute('aria-pressed') === 'true' && document.activeElement?.classList.contains('shortcuts-filter') === true", 4000, 'the search listens for keys')
  await pressKey('j', { ctrl: true })
  await waitFor(`document.querySelector('.shortcuts-filter')?.value === '"Ctrl+J"' && document.querySelectorAll('.shortcuts-row').length === 1 && !!document.querySelector('${row('view.bottomPanel')}')`, 4000, 'pressing Ctrl+J finds the bottom panel')
  if ((await evaluate(bottomShown)) !== panelBefore) throw new Error('Ctrl+J pressed into the search toggled the bottom panel')
  await sleep(250)
  await screenshot('ui-dark-shortcuts-pressed.png')
  await pressKey('Escape')
  await waitFor("document.querySelector('.shortcuts-record')?.getAttribute('aria-pressed') === 'false'", 4000, 'Esc goes back to typing')
  if (!(await pageOpen())) throw new Error('Esc while the search listened left the page')
  await listen('view.bottomPanel')
  await pressKey('c', { ctrl: true })
  await waitFor("/copies/.test(document.querySelector('.shortcuts-note.is-refused')?.textContent ?? '')", 4000, 'Ctrl+C is refused, and the row says why')
  if (!(await pageOpen())) throw new Error('a refused chord closed the list')
  await pressKey('j', { ctrl: true, shift: true })
  await waitFor(`!document.querySelector('.shortcuts-recorder') && !!document.querySelector('${row('view.bottomPanel')} .shortcuts-changed')`, 4000, 'Ctrl+Shift+J is taken')
  if ((await keysOf('view.bottomPanel')) !== 'Ctrl Shift J') throw new Error(`the bottom panel shows ${await keysOf('view.bottomPanel')}`)
  await waitFor(`document.activeElement?.matches('${row('view.bottomPanel')} .shortcuts-keys') === true`, 4000, 'the focus is back on the row')
  if ((await saved()) !== '{"view.bottomPanel":["Ctrl+Shift+J"]}') throw new Error(`the settings keep ${await saved()}`)

  // A chord that another command has asks before it moves.
  await typeInto('.shortcuts-filter', '')
  await waitFor("document.querySelectorAll('.shortcuts-row').length > 30", 4000, 'every row again')
  await listen('view.bottomPanel')
  await pressKey('b', { ctrl: true })
  await waitFor("/Toggle sidebar/.test(document.querySelector('.shortcuts-take')?.textContent ?? '')", 4000, 'Ctrl+B asks first: the sidebar has it')
  await waitFor("document.activeElement?.matches('.shortcuts-take .btn.primary') === true", 4000, 'Use it here has the focus')
  await sleep(300)
  await screenshot('ui-dark-shortcuts-take.png')
  await click('.shortcuts-take .btn.primary')
  await waitFor(`!document.querySelector('.shortcuts-take')`, 4000, 'Use it here')
  await waitFor(`${JSON.stringify('Ctrl B')} === [...document.querySelectorAll('${row('view.bottomPanel')} .shortcuts-keys .ui-kbd-group')].map((group) => group.getAttribute('aria-label')).join(' or ')`, 4000, 'the bottom panel has Ctrl+B')
  if ((await keysOf('view.sidebar')) !== 'Ctrl Shift S') throw new Error(`the sidebar shows ${await keysOf('view.sidebar')}, not just Ctrl+Shift+S`)
  if (!(await evaluate(`!!document.querySelector('${row('view.sidebar')} .shortcuts-changed')`))) throw new Error('the sidebar does not show that it changed')

  // Esc stops listening and leaves the page open; a second Esc leaves the page.
  await listen('view.sidebar')
  await pressKey('Escape')
  await waitFor(`!document.querySelector('.shortcuts-recorder') && document.activeElement?.matches('${row('view.sidebar')} .shortcuts-keys') === true`, 4000, 'Esc stops listening')
  if (!(await pageOpen())) throw new Error('Esc while listening closed the list')
  await sleep(300)
  await screenshot('ui-dark-shortcuts-changed.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.settings-page')", 4000, 'a second Esc leaves the page')

  // The new shortcut works, the old one is gone, and the sidebar keeps the one it has left.
  let shown = await evaluate(bottomShown)
  await key({ key: 'b', ctrlKey: true })
  await waitFor(`${bottomShown} === ${!shown}`, 4000, 'Ctrl+B toggles the bottom panel now')
  if (!(await evaluate(sidebarShown))) throw new Error('Ctrl+B still hid the sidebar')
  await key({ key: 'j', ctrlKey: true })
  await sleep(300)
  if ((await evaluate(bottomShown)) !== !shown) throw new Error('Ctrl+J still toggles the bottom panel')
  await key({ key: 'S', ctrlKey: true, shiftKey: true })
  await waitFor(`!${sidebarShown}`, 4000, 'Ctrl+Shift+S still hides the sidebar')
  await key({ key: 'S', ctrlKey: true, shiftKey: true })
  await waitFor(sidebarShown, 4000, 'and shows it')

  // After a restart: the menus show it, and it works.
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload with changed shortcuts')
  const menuKeys = "(() => { const item = [...document.querySelectorAll('.ui-menu .ui-menu-item')].find((node) => node.textContent.includes('Toggle bottom panel')); return item?.querySelector('.ui-menu-shortcut')?.getAttribute('aria-label') ?? '' })()"
  await waitFor("!!document.querySelector('.tb-menu')", 8000, 'the menus')
  await click('.tb-menu', 'View')
  await waitFor(`${menuKeys} === 'Ctrl B'`, 8000, 'the View menu shows Ctrl+B for the bottom panel after a restart')
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await waitFor("!document.querySelector('.ui-menu')", 4000, 'Escape closes the menu')
  shown = await evaluate(bottomShown)
  await key({ key: 'b', ctrlKey: true })
  await waitFor(`${bottomShown} === ${!shown}`, 4000, 'Ctrl+B works after a restart')
  await key({ key: 'b', ctrlKey: true })
  await waitFor(`${bottomShown} === ${shown}`, 4000, 'and toggles back')

  // Reset all, with an Undo pressed over the dialog, then reset again for the checks that follow.
  await openList()
  await click('.shortcuts-bar .btn', 'Reset all')
  await waitFor(`!document.querySelector('.shortcuts-changed')`, 4000, 'Reset all clears every change')
  if ((await keysOf('view.bottomPanel')) !== 'Ctrl J' || (await keysOf('view.sidebar')) !== 'Ctrl B or Ctrl Shift S') throw new Error('Reset all did not bring the shipped shortcuts back')
  await waitFor("!!document.querySelector('.toast .toast-action')", 4000, 'Reset all offers Undo')
  if (!(await onTop('.toast .toast-action'))) throw new Error('the Undo of Reset all is under the page')
  await click('.toast .toast-action')
  await waitFor(`!!document.querySelector('${row('view.bottomPanel')} .shortcuts-changed')`, 4000, 'Undo brings the changes back')
  if ((await keysOf('view.bottomPanel')) !== 'Ctrl B') throw new Error('Undo did not bring Ctrl+B back')
  await click('.shortcuts-bar .btn', 'Reset all')
  await waitFor(`!document.querySelector('.shortcuts-changed')`, 4000, 'Reset all again')
  if ((await saved()) !== '{}') throw new Error(`the settings still keep ${await saved()}`)
  await pressKey('Escape')
  await waitFor("!document.querySelector('.settings-page')", 4000, 'Esc leaves the page')
  await evaluate("document.querySelector('.toast-close')?.click()")
  shown = await evaluate(bottomShown)
  await key({ key: 'j', ctrlKey: true })
  await waitFor(`${bottomShown} === ${!shown}`, 4000, 'Ctrl+J toggles the bottom panel again')
  await key({ key: 'j', ctrlKey: true })
  await waitFor(`${bottomShown} === ${shown}`, 4000, 'and back')
  console.log('[smoke] changing shortcuts: ok')
}

/**
 * The window shell: sizes from the spec, the menus by mouse and keyboard, every shortcut that
 * changes the layout, and sessions pinned, archived, deleted, with Back and Forward.
 */
async function runShellChecks() {
  console.log('[smoke] --- shell ---')
  const sizes = await evaluate(`(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect()
    return { titlebar: box('.titlebar')?.height, rail: box('.icon-rail')?.width, railButton: box('.rail-btn')?.width, sidebar: box('.sidebar-wrap')?.width }
  })()`)
  console.log('[smoke] shell sizes:', JSON.stringify(sizes))
  if (sizes.titlebar !== 44 || sizes.rail !== 52 || sizes.railButton !== 38) throw new Error('the title bar or icon rail is not the specified size')
  if (sizes.sidebar < 220 || sizes.sidebar > 480) throw new Error('the sidebar is outside its 220 to 480 px range')

  // Windows draws the window buttons itself over the right end of the bar; elsewhere the bar draws its own.
  const captions = await evaluate(`(() => {
    const bar = document.querySelector('.titlebar')
    return { native: bar.classList.contains('has-native-captions'), custom: !!document.querySelector('.caption'), padding: parseFloat(getComputedStyle(bar).paddingRight) }
  })()`)
  console.log('[smoke] window buttons:', JSON.stringify(captions))
  const expectNative = process.platform === 'win32' || process.env.ENCODE_NATIVE_CAPTIONS === '1'
  if (captions.native !== expectNative || captions.custom === expectNative) throw new Error('the title bar draws the window buttons twice, or not at all')
  if (expectNative && (captions.padding < 100 || captions.padding > 200)) throw new Error('the title bar does not leave room for the system window buttons')

  // Menus: a click opens, the arrow keys move to the next menu, Escape closes.
  if (!(await click('.tb-menu', 'View'))) throw new Error('View menu not found')
  await waitFor(menuOpen('View'), 4000, 'View menu')
  const viewItems = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  if (!viewItems.includes('Zoom in') || !viewItems.includes('Full screen')) throw new Error(`View menu is missing items: ${viewItems}`)
  await sleep(400)
  await screenshot('ui-dark-menu.png')
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
  await waitFor(menuOpen('Go'), 4000, 'ArrowRight opens the next menu')
  const goItems = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  if (!goItems.includes('Go to definition') || !goItems.includes('Go back in the editor')) throw new Error(`Go menu is missing items: ${goItems}`)
  await evaluate("document.querySelector('.ui-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await waitFor("!document.querySelector('.ui-menu')", 4000, 'Escape closes the menu')

  // Layout shortcuts.
  await key({ key: 'b', ctrlKey: true })
  await waitFor("!document.querySelector('.session-sidebar')", 4000, 'Ctrl+B hides the sidebar')
  await key({ key: 'b', ctrlKey: true })
  await waitFor("!!document.querySelector('.session-sidebar')", 4000, 'Ctrl+B shows the sidebar')
  await key({ key: 'b', ctrlKey: true, altKey: true })
  await waitFor("document.querySelector('.right-wrap')?.classList.contains('is-hidden')", 4000, 'Ctrl+Alt+B hides the side panel')
  await key({ key: 'b', ctrlKey: true, altKey: true })
  await waitFor("document.querySelector('.right-wrap') && !document.querySelector('.right-wrap').classList.contains('is-hidden')", 4000, 'Ctrl+Alt+B shows the side panel')
  const ratioBefore = await evaluate('window.devicePixelRatio')
  await key({ key: '=', code: 'Equal', ctrlKey: true })
  await waitFor(`window.devicePixelRatio > ${ratioBefore}`, 4000, 'Ctrl+= zooms in')
  await key({ key: '0', code: 'Digit0', ctrlKey: true })
  await waitFor(`window.devicePixelRatio === ${ratioBefore}`, 4000, 'Ctrl+0 resets the zoom')

  // The shortcuts list, a section of the Settings page.
  await key({ key: '/', code: 'Slash', ctrlKey: true })
  await waitFor("!!document.querySelector('.settings-page .shortcuts-row')", 4000, 'Ctrl+/ opens the shortcuts')
  const rows = await count('.shortcuts-row')
  if (rows < 30) throw new Error(`the shortcuts list has only ${rows} rows`)
  await sleep(400)
  await screenshot('ui-dark-shortcuts.png')
  await key({ key: 'Escape' })
  await waitFor("!document.querySelector('.settings-page')", 4000, 'Escape leaves the shortcuts')

  // Sessions: a new one, then Back and Forward over the ones you opened.
  const firstTitle = await activeTitle()
  const before = (await sidebarTitles()).length
  await key({ key: 'n', ctrlKey: true })
  await waitFor(`document.querySelectorAll('.session-sidebar .sb-row-main').length === ${before + 1}`, 6000, 'Ctrl+N adds a session')
  if ((await activeTitle()) !== 'New session') throw new Error('the new session is not the open one')
  await key({ key: '[', code: 'BracketLeft', ctrlKey: true })
  await waitFor(`document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === ${JSON.stringify(firstTitle)}`, 6000, 'Back returns to the first session')
  // The open session changes before the position in the history does: Forward counts once its button is enabled.
  await waitFor("document.querySelector('.titlebar [aria-label=\"Forward\"]')?.disabled === false", 6000, 'Forward is available after Back')
  await key({ key: ']', code: 'BracketRight', ctrlKey: true })
  await waitFor("document.querySelector('.session-sidebar .sb-row.is-active .title')?.textContent === 'New session'", 6000, 'Forward returns to the new session')

  // Pin from the context menu, then unpin with the shortcut.
  await chooseFromSessionMenu('Pin')
  await waitFor("!!document.querySelector('.session-sidebar section[aria-label=\"Pinned\"] .sb-row.is-active')", 6000, 'a pinned session is listed under Pinned')
  await screenshot('ui-dark-sidebar-pinned.png')
  await key({ key: 'p', ctrlKey: true, altKey: true })
  await waitFor("!document.querySelector('.session-sidebar section[aria-label=\"Pinned\"]')", 6000, 'Ctrl+Alt+P unpins')

  // The Activity view groups sessions by what they need.
  await key({ key: 'u', ctrlKey: true, altKey: true })
  await waitFor("!!document.querySelector('.sb-activity-row.is-active')", 6000, 'Ctrl+Alt+U shows the Activity view')
  await screenshot('ui-dark-activity.png')
  await key({ key: 'u', ctrlKey: true, altKey: true })
  await waitFor("!document.querySelector('.sb-activity-row')", 6000, 'Ctrl+Alt+U leaves the Activity view')

  // Archive, find it under Archived, restore it.
  await key({ key: 'A', ctrlKey: true, shiftKey: true })
  await waitFor(`document.querySelectorAll('.session-sidebar .sb-row-main').length === ${before}`, 6000, 'Ctrl+Shift+A archives the open session')
  await click('.rail-btn[aria-label="More"]')
  await waitFor(menuOpen('More'), 4000, 'More menu')
  await click('.ui-menu [role^="menuitem"]', 'Archived')
  await waitFor("!!document.querySelector('.session-sidebar [aria-label=\"Restore\"]')", 6000, 'archived sessions are listed')
  await click('.session-sidebar [aria-label="Restore"]')
  await click('.rail-btn[aria-label="More"]')
  await waitFor(menuOpen('More'), 4000, 'More menu again')
  await click('.ui-menu [role^="menuitem"]', 'Projects')
  await waitFor(`document.querySelectorAll('.session-sidebar .sb-row-main').length === ${before + 1}`, 6000, 'the restored session is back')

  // Delete asks first: Cancel keeps the session, Delete removes it.
  await click('.session-sidebar .sb-row-main', 'New session')
  await chooseFromSessionMenu('Delete…')
  await waitFor("!!document.querySelector('.ui-dialog')", 4000, 'delete confirmation')
  await click('.ui-dialog-foot .btn', 'Cancel')
  await waitFor("!document.querySelector('.ui-dialog')", 4000, 'Cancel closes the confirmation')
  if ((await sidebarTitles()).length !== before + 1) throw new Error('Cancel deleted the session')
  await chooseFromSessionMenu('Delete…')
  await waitFor("!!document.querySelector('.ui-dialog')", 4000, 'delete confirmation again')
  await click('.ui-dialog-foot .btn.danger')
  await waitFor(`document.querySelectorAll('.session-sidebar .sb-row-main').length === ${before}`, 6000, 'Delete removes the session')

  // A session nobody has used yet joins the folder that is open when it comes up.
  const looseId = await evaluate('window.eNCode.agent.createSession({ projectRoot: null }).then((session) => session.id)')
  const openId = await evaluate("localStorage.getItem('eNCode.activeSession')")
  await evaluate(`localStorage.setItem('eNCode.activeSession', ${JSON.stringify(looseId)})`)
  await send('Page.reload')
  await waitFor(
    "!!document.querySelector('.session-sidebar section[aria-label=\"Projects\"] .sb-row.is-active')",
    15000,
    'an unused session joins the open folder',
  )
  await evaluate(`window.eNCode.agent.remove(${JSON.stringify(looseId)})`)
  await evaluate(`localStorage.setItem('eNCode.activeSession', ${JSON.stringify(openId)})`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload after the adoption check')
  console.log('[smoke] shell checks passed')
}

/**
 * Help > About shows which build this is, and Save diagnostics writes a report that says so, lists the models
 * without their keys and holds none of the key that was just stored.
 */
async function runAboutChecks() {
  console.log('[smoke] --- about and diagnostics ---')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const info = await evaluate('window.eNCode.app.about()')
  console.log('[smoke] build:', JSON.stringify(info))
  if (info.version !== pkg.version) throw new Error(`About says version ${info.version}, package.json says ${pkg.version}`)
  if (!['tester', 'dev'].includes(info.channel)) throw new Error(`unknown channel ${info.channel}`)
  if (process.env.ENCODE_COMMIT && info.commit !== process.env.ENCODE_COMMIT.toLowerCase()) throw new Error('the build does not carry the commit CI named')
  if (info.commit && !/^[0-9a-f]{40}$/.test(info.commit)) throw new Error(`the commit is not a hash: ${info.commit}`)
  if (!info.electron || !info.os) throw new Error('About does not say what it runs on')

  if (!(await click('.tb-menu', 'Help'))) throw new Error('Help menu not found')
  await waitFor(menuOpen('Help'), 4000, 'Help menu')
  const items = await evaluate("[...document.querySelectorAll('.ui-menu .ui-menu-label')].map((node) => node.textContent)")
  for (const label of ['Keyboard shortcuts', 'Save diagnostics…', 'Report editor issue…', 'Show log files', 'About eNCode']) {
    if (!items.includes(label)) throw new Error(`Help menu is missing ${label}: ${items}`)
  }
  await click('.ui-menu [role^="menuitem"]', 'About eNCode')
  await waitFor("!!document.querySelector('.about-dialog .about-facts')", 6000, 'About shows the build')
  const shown = await evaluate("document.querySelector('.about-dialog').innerText")
  if (!shown.includes(`Version ${info.version}`)) throw new Error(`About does not show the version: ${shown}`)
  if (info.commit && !shown.includes(info.commit.slice(0, 7))) throw new Error('About does not show the commit')
  await sleep(300)
  await screenshot('ui-dark-about.png')

  // A key stored a moment ago must not be in the report; the profile is listed with "key stored".
  const secret = `sk-smoke-about-${Date.now().toString(36)}abcdef`
  await evaluate(`window.eNCode.settings.setProfileKey('local-mock', ${JSON.stringify(secret)})`)
  if (!(await click('.about-dialog .ui-dialog-foot .btn', 'Save diagnostics'))) throw new Error('Save diagnostics button not found')
  const file = process.env.ENCODE_DIAGNOSTICS_FILE
  if (!file) throw new Error('ENCODE_DIAGNOSTICS_FILE is not set (pnpm e2e sets it)')
  const started = Date.now()
  let report = ''
  while (!report && Date.now() - started < 10000) {
    report = await fs.readFile(file, 'utf8').catch(() => '')
    if (!report) await sleep(200)
  }
  if (!report.startsWith('eNCode diagnostics')) throw new Error('the diagnostics report was not written')
  if (!report.includes(`eNCode ${pkg.version} ${info.channel}`)) throw new Error('the report does not say which build it is')
  if (!/local-mock|Local mock/i.test(report) || !report.includes('key stored')) throw new Error('the report does not list the model with its key as stored')
  if (report.includes(secret)) throw new Error('the diagnostics report holds an API key')
  if (!/^ {2}\d{4}-\d\d-\d\dT/m.test(report)) throw new Error('the report has no log lines')
  await waitFor("[...document.querySelectorAll('.ui-toast, .toast')].some((node) => node.textContent.includes('Saved diagnostics'))", 6000, 'a note that the report was saved')
  await key({ key: 'Escape' })
  await waitFor("!document.querySelector('.about-dialog')", 4000, 'Escape closes About')
  console.log('[smoke] about and diagnostics checks passed')
}

/** eNCode's own files the dogfood phase works in: its largest code, prose, styles and data. */
const DOGFOOD_FILES = [
  { file: 'apps/desktop/scripts/smoke.mjs', word: 'await' },
  { file: 'packages/editor-view/src/view.ts', word: 'this.' },
  { file: 'apps/desktop/src/components/CodeEditor.tsx', word: 'const' },
  { file: 'docs/security/threat-model.md', word: 'the' },
  { file: 'apps/desktop/src/styles/42-code.css', word: 'var(' },
  { file: 'pnpm-lock.yaml', word: 'integrity' },
]

/** Generous: the runner is slower than a person's computer, and this guards against a step that hangs. */
const DOGFOOD_OPEN_MS = 6000

/**
 * Dogfood (ADR 0088): eNCode edits eNCode. A copy of the repository's own files is opened as a folder; in its largest
 * files the editor draws and colours the text, reaches the last line, finds what a plain count finds, takes an edit
 * back to the bytes it had, and records it all so a report of it replays without a problem. Find in files searches
 * the whole copy. The copy is the files git tracks, so the run cannot change the checkout.
 */
async function runDogfoodChecks() {
  console.log('[smoke] --- dogfood: eNCode edits eNCode ---')
  const repo = path.resolve(root, '..', '..')
  let tracked
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  } catch (error) {
    throw new Error(`The dogfood phase needs a git checkout of eNCode: ${error.message}`)
  }
  const copy = path.join(path.dirname(demoPath), 'encode-copy')
  let copied = 0
  for (const relative of tracked) {
    const from = path.join(repo, relative)
    const stat = await fs.stat(from).catch(() => null)
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue
    await fs.mkdir(path.dirname(path.join(copy, relative)), { recursive: true })
    await fs.copyFile(from, path.join(copy, relative))
    copied++
  }
  const opened = await evaluate(`window.eNCode.workspace.openPath(${JSON.stringify(copy)})`)
  if (opened?.name !== 'encode-copy') throw new Error(`The copy of eNCode did not open: ${JSON.stringify(opened)}`)
  // The page follows the folder the main process opened, as at the start of the run.
  await send('Page.reload')
  await waitFor("[...document.querySelectorAll('.tree-row')].some((row) => row.textContent.includes('packages'))", 30000, 'the copy of eNCode in the explorer')
  console.log(`[smoke] dogfood folder: ${copied} files`)

  const measures = []
  for (const { file, word } of DOGFOOD_FILES) {
    const text = (await fs.readFile(path.join(copy, file), 'utf8')).replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    // A piece of the first line with text that is drawn as it is (no tab before it).
    const firstLine = lines.find((line) => line.trim()) ?? ''
    const shownFirst = firstLine.slice(firstLine.lastIndexOf('\t') + 1).trim().slice(0, 40)
    const started = Date.now()
    await quickOpen(file, shownFirst)
    const openMs = Date.now() - started
    if (openMs > DOGFOOD_OPEN_MS) throw new Error(`${file} took ${openMs} ms to open`)
    await sleep(300)
    const coloured = await evaluate("document.querySelectorAll('.code-editor .enc-line [class*=\"tok-\"]').length")
    if (!file.endsWith('.md') && coloured < 5) throw new Error(`${file} is not coloured: ${coloured} tokens`)

    // Ctrl+End reaches the last line, Ctrl+Home the first.
    await focusEditor()
    await pressKey('End', { ctrl: true })
    const lastLine = [...lines].reverse().find((line) => line.trim()) ?? ''
    const shownLast = lastLine.slice(lastLine.lastIndexOf('\t') + 1).trim().slice(0, 40)
    await waitFor(`${RENDERED_LINES}.some((line) => line.includes(${JSON.stringify(shownLast)}))`, 6000, `the end of ${file}`)
    await pressKey('Home', { ctrl: true })
    await waitFor(`${RENDERED_LINES}.join('\\n').includes(${JSON.stringify(shownFirst)})`, 6000, `the start of ${file}`)

    // Find counts what a plain count counts (case does not matter by default).
    const lower = text.toLowerCase()
    let expected = 0
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) expected++
    await pressKey('f', { ctrl: true })
    await waitFor("!!document.querySelector('.enc-find')", 6000, 'find in ' + file)
    await send('Input.insertText', { text: word })
    await waitFor(`/ of \\d|found|No results/.test(document.querySelector('.enc-find-count')?.textContent ?? '')`, 6000, 'the count in ' + file)
    await sleep(300)
    const count = await evaluate("document.querySelector('.enc-find-count')?.textContent ?? ''")
    const found = Number((count.match(/(\d+)\+? found|of (\d+)/) ?? []).slice(1).find(Boolean) ?? NaN)
    if (found !== expected) throw new Error(`Find in ${file} says ${JSON.stringify(count)} for ${JSON.stringify(word)}; a plain count finds ${expected}`)
    await pressKey('Escape')
    await waitFor("!document.querySelector('.enc-find')", 4000, 'find closed')

    // An edit, then Ctrl+Z: the document has its bytes again and is not unsaved.
    await focusEditor()
    await send('Input.insertText', { text: 'dogfood' })
    // Whatever the word brought up (the list of suggestions) goes, so the keys after it are the editor's.
    await pressKey('Escape')
    await waitFor("!!document.querySelector('.editor-tab.is-dirty')", 4000, `${file} edited`)
    for (let undo = 0; undo < 4 && (await evaluate("!!document.querySelector('.editor-tab.is-dirty')")); undo++) {
      await pressKey('z', { ctrl: true })
      await sleep(150)
    }
    await waitFor("!document.querySelector('.editor-tab.is-dirty')", 6000, `${file} back to its bytes after Ctrl+Z`)
    measures.push(`${file.split('/').pop()} ${lines.length} lines ${openMs} ms`)
  }

  // What was recorded of the last of them replays without a problem.
  await runFromPalette('Report editor issue…')
  await waitFor("[...document.querySelectorAll('.editor-issue-dialog .install-server-facts dd')].map((node) => node.textContent)[2] === 'No problem found'", 20000, 'the record of a large real file replayed without a problem').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await evaluate("[...document.querySelectorAll('.editor-issue-dialog .install-server-facts dd')].map((node) => node.textContent)"))}`)
  })
  await pressKey('Escape')
  await waitFor("!document.querySelector('.editor-issue-dialog')", 4000, 'the report dialog closed')

  // Find in files over the whole copy: a name defined once and used in several files.
  const hits = await evaluate("window.eNCode.workspace.search({ query: 'EditRecorder', caseSensitive: true }).then((result) => ({ files: new Set(result.matches.map((match) => match.path)).size, matches: result.matches.length }))").catch((error) => ({ error: String(error) }))
  if (hits.error || hits.files < 3) throw new Error(`Find in files over eNCode's own code: ${JSON.stringify(hits)}`)
  await screenshot('58-dogfood.png')
  console.log(`[smoke] dogfood: ${measures.join('; ')}; EditRecorder in ${hits.files} files`)
}

/**
 * Settings > Appearance: a choice shows at once and is kept as it is made, across a reload. Captures the main window
 * and the Appearance section in both themes.
 */
async function runAppearanceChecks() {
  console.log('[smoke] --- appearance ---')
  if ((await theme()) !== 'dark') throw new Error(`eNCode should start dark, not ${await theme()}`)
  // The logo's black and chrome: the Mono accent, silver buttons with black text, and the dice in the title bar.
  const look = await evaluate(`(() => {
    const style = getComputedStyle(document.documentElement)
    const logo = document.querySelector('.titlebar-logo')
    return { accent: document.documentElement.dataset.accent, onAccent: style.getPropertyValue('--on-accent').trim(), canvas: style.getPropertyValue('--canvas').trim(), logo: logo ? { complete: logo.complete, width: logo.naturalWidth, src: logo.currentSrc.replace(/^.*\\/brand\\//, 'brand/') } : null }
  })()`)
  console.log('[smoke] look:', JSON.stringify(look))
  if (look.accent !== 'mono' || look.onAccent !== '#0a0a0a' || look.canvas !== '#0b0b0b') throw new Error(`eNCode should start black with the Mono accent: ${JSON.stringify(look)}`)
  // naturalWidth is in CSS px (a 64w render at 22 px reads 22), so a loaded picture is any width at all.
  await waitFor("(() => { const logo = document.querySelector('.titlebar-logo'); return !!logo && logo.complete && logo.naturalWidth > 0 && /\\/brand\\/mark-\\d+\\.png$/.test(logo.currentSrc) })()", 8000, 'the dice in the title bar')
  await screenshotSizes('ui-dark-main')

  await openAppearanceSettings()
  await screenshotSizes('ui-dark-appearance')
  await click('[data-setting="appearance.theme"] [role="radio"]', 'Light')
  await waitFor("document.documentElement.dataset.theme === 'light'", 4000, 'light at once')
  await settingIs("settings.appearance.mode === 'light'", 'Light')
  await click('.accent-swatch[aria-label="Jade"]')
  await waitFor("document.documentElement.dataset.accent === 'jade'", 4000, 'jade at once')
  await settingIs("settings.appearance.accent === 'jade'", 'Jade')
  await click('.accent-swatch[aria-label="Signal blue"]')
  await settingIs("settings.appearance.accent === 'blue'", 'Signal blue')
  await click('.accent-swatch[aria-label="Mono"]')
  await settingIs("settings.appearance.accent === 'mono'", 'Mono')
  // Mono on light is the logo's black: ink buttons with white text. The built stylesheet writes #111111 as #111.
  await waitFor("['#111', '#111111'].includes(getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim()) && ['#fff', '#ffffff'].includes(getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim())", 4000, 'ink buttons on light')
  await screenshotSizes('ui-light-appearance')
  await closeSettings()
  const saved = await evaluate('window.eNCode.settings.get().then((settings) => settings.appearance)')
  console.log('[smoke] saved appearance:', JSON.stringify(saved))
  if (saved.mode !== 'light' || saved.accent !== 'mono') throw new Error('Light was not saved')

  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload in light')
  if ((await theme()) !== 'light') throw new Error('the light theme did not survive a reload')
  await screenshotSizes('ui-light-main')

  await evaluate(`window.eNCode.settings.save({ appearance: ${JSON.stringify(DEFAULT_APPEARANCE)} })`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload in dark')
  if ((await theme()) !== 'dark') throw new Error('saving Dark did not switch back')
}

/** Chooses an option of a native select by its label and tells the page, as a click on the option would. */
const chooseOption = (selectLabel, optionLabel) =>
  evaluate(`(() => {
    const select = document.querySelector('select[aria-label=${JSON.stringify(selectLabel)}]')
    const option = select && [...select.options].find((item) => item.textContent === ${JSON.stringify(optionLabel)})
    if (!option) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
const cssVar = (name) => evaluate(`document.documentElement.style.getPropertyValue(${JSON.stringify(name)}).trim()`)
const bodyFont = () => evaluate('getComputedStyle(document.body).fontFamily')
const sizeOf = (selector) => evaluate(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize)`)

/**
 * Settings > Appearance > Fonts: Windows' own fonts at Codex's sizes by default, Inter and JetBrains Mono one choice
 * away, the installed fonts listed, sizes that move the whole interface, each choice kept as it is made, and a saved
 * choice drawn right from the first frame after a reload.
 */
async function runFontChecks() {
  console.log('[smoke] --- fonts ---')
  if (!(await bodyFont()).startsWith('system-ui')) throw new Error(`the default interface font is not the system font: ${await bodyFont()}`)
  if (!(await cssVar('--font-mono')).startsWith('Consolas')) throw new Error('the default code font is not Consolas')
  const smallSystem = await sizeOf('.session-sidebar .sb-row .meta')
  const inputSystem = await sizeOf('.composer-input')
  console.log('[smoke] system font sizes:', JSON.stringify({ smallSystem, inputSystem }))
  if (inputSystem !== 14) throw new Error(`the thread text is ${inputSystem} px, not Codex's 14`)

  await openAppearanceSettings()
  // The installed fonts arrive a moment after the page opens.
  await waitFor("document.querySelectorAll('select[aria-label=\"Interface font\"] option').length >= 4", 15000, 'the installed fonts')
  const options = await evaluate("[...document.querySelectorAll('select[aria-label=\"Interface font\"] option')].map((node) => node.textContent)")
  console.log('[smoke] interface font choices:', options.length, JSON.stringify(options.slice(0, 5)))
  if (options[0] !== 'System' || options[1] !== 'eNCode (Inter)') throw new Error('the built-in font choices are not first')
  if (options.length < 4) throw new Error('the installed fonts are not listed')
  await screenshotSizes('ui-dark-fonts')

  // Inter: the same sizes minus the pixel Windows' font gets on small text. The sidebar is under the page, so its
  // sizes are read once the page closes.
  if (!(await chooseOption('Interface font', 'eNCode (Inter)'))) throw new Error('no eNCode (Inter) choice')
  await waitFor("getComputedStyle(document.body).fontFamily.startsWith('Inter')", 4000, 'Inter at once')
  await waitFor("document.documentElement.style.getPropertyValue('--ui-small').trim() === '0px'", 4000, 'Inter takes no extra pixel')
  await closeSettings()
  const smallInter = await sizeOf('.session-sidebar .sb-row .meta')
  if (smallInter !== smallSystem - 1) throw new Error(`Inter's small text is ${smallInter} px, the system font's is ${smallSystem} px`)
  if ((await sizeOf('.composer-input')) !== inputSystem) throw new Error('Inter changed the size of the thread text')

  // The sizes move the whole interface.
  await openAppearanceSettings()
  if (!(await chooseOption('Interface size', '16 px'))) throw new Error('no 16 px choice')
  await waitFor("document.documentElement.style.getPropertyValue('--ui-delta').trim() === '2px'", 4000, '16 px at once')
  if (!(await chooseOption('Code size', '14 px'))) throw new Error('no 14 px choice')
  await waitFor("document.documentElement.style.getPropertyValue('--code-size').trim() === '14px'", 4000, 'code size at once')
  if (!(await chooseOption('Code font', 'eNCode (JetBrains Mono)'))) throw new Error('no JetBrains Mono choice')
  await waitFor("document.documentElement.style.getPropertyValue('--font-mono').trim().startsWith(\"'JetBrains Mono'\")", 4000, 'JetBrains Mono at once')
  await settingIs("settings.appearance.uiFont === '@encode' && settings.appearance.uiSize === 16 && settings.appearance.codeSize === 14 && settings.appearance.codeFont === '@encode'", 'the fonts and sizes')
  await closeSettings()
  if ((await sizeOf('.composer-input')) !== 16) throw new Error('the thread text did not follow the interface size')

  // Kept, Inter is there from the first frame of the next load.
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload with Inter')
  if (!(await bodyFont()).startsWith('Inter')) throw new Error('Inter did not survive a reload')
  await screenshot('ui-dark-inter.png')

  await evaluate(`window.eNCode.settings.save({ appearance: ${JSON.stringify(DEFAULT_APPEARANCE)} })`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload with the system fonts')
  if (!(await bodyFont()).startsWith('system-ui')) throw new Error('saving the defaults did not bring the system font back')
}

let pageCrashed = false

/**
 * The window's page is made to crash: eNCode says so (a test run writes what it would have asked to a file) and loads
 * it again, and the app comes back on a page of its own.
 */
async function runCrashCheck() {
  console.log('[smoke] --- a page that stops ---')
  const log = process.env.ENCODE_CRASH_LOG
  if (!log) throw new Error('ENCODE_CRASH_LOG is not set (pnpm e2e sets it)')
  pageCrashed = true
  // Page.crash never answers: the page it would answer from is gone.
  void send('Page.crash').catch(() => undefined)
  let told = ''
  for (const started = Date.now(); !told && Date.now() - started < 15000; await sleep(250)) told = await fs.readFile(log, 'utf8').catch(() => '')
  const said = told ? JSON.parse(told.trim().split('\n')[0]) : null
  if (!said || !/window stopped/.test(said.message) || !/Reload/.test(said.detail)) throw new Error(`the window did not say its page stopped: ${told || 'nothing'}`)
  let back = false
  for (const started = Date.now(); !back && Date.now() - started < 30000; await sleep(500)) {
    try {
      const page = await findPage(port, { attempts: 1 })
      back = (await evaluateOn(page.webSocketDebuggerUrl, "!!window.eNCode && !!document.querySelector('.titlebar .menubar') && document.querySelectorAll('.tree-row').length > 0", 5000)) === true
    } catch {
      // Not back yet.
    }
  }
  if (!back) throw new Error('the window did not come back after its page stopped')
  console.log('[smoke] a page that stopped was reported and loaded again:', said.reason)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor(
    "!!window.eNCode && !!document.querySelector('.titlebar .menubar') && !!document.querySelector('.icon-rail') && !!document.querySelector('.session-sidebar')",
    30000,
    'app shell',
  )
  console.log('[smoke] app shell rendered')
  await runFirstStartChecks()

  const opened = await evaluate(`window.eNCode.workspace.openPath(${JSON.stringify(demoPath)})`)
  console.log('[smoke] workspace opened:', opened?.name)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'file tree')
  console.log('[smoke] tree rows:', await evaluate("document.querySelectorAll('.tree-row').length"))
  await checkLegacyImport()

  // While working on one part: ENCODE_SMOKE_ONLY=browser runs those checks against the test provider, and nothing else.
  // A full run, as CI makes, never sets it.
  const only = (process.env.ENCODE_SMOKE_ONLY ?? '').split(',').filter(Boolean)
  if (only.length) {
    const parts = { browser: runAgentBrowserChecks, side: runSideChatChecks, worktree: runChatWorktreeChecks, panels: runPanelChecks, crash: runCrashCheck, appearance: runAppearanceChecks, wide: runWideLineChecks, remote: runRemoteChecks, stop: runStopChecks, attach: runAttachChecks }
    await useTestProvider()
    await send('Page.reload')
    await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after provider config')
    for (const name of only) {
      if (!parts[name]) throw new Error(`No part of the smoke is called ${name}: ${Object.keys(parts).join(', ')}`)
      await parts[name]()
    }
    throw new SmokePartsDone()
  }

  // Pin the offline demo profile and auto-approval so this run is deterministic.
  const initialSettings = await evaluate('window.eNCode.settings.get()')
  if (!initialSettings.profiles.some((profile) => profile.id === 'demo')) {
    const withDemo = [
      ...initialSettings.profiles,
      { id: 'demo', name: 'Demo (offline)', kind: 'demo', baseUrl: '', model: 'eNCode-demo' },
    ]
    await evaluate(`window.eNCode.settings.save({ profiles: ${JSON.stringify(withDemo)} })`)
  }
  await evaluate(
    "window.eNCode.settings.save({ activeProfileId: 'demo', policy: 'workspace-write', agentMode: 'code' })",
  )
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'file tree after profile pin')
  await evaluate('window.eNCode.agent.reset()')
  await sleep(400)
  await waitFor("!!document.querySelector('.files-switcher')", 8000, 'the Files tab')
  await screenshot('02-explorer.png')

  if (!(await click('.tree-row', 'README.md'))) throw new Error('README.md row not found')
  await waitFor(`${RENDERED_LINES}.join('\\n').includes('Demo Project')`, 15000, 'README loaded')
  await sleep(450)

  const integrity = await evaluate(`(async () => {
    const lines = ${RENDERED_LINES}
    const file = await window.eNCode.workspace.read('README.md')
    const expected = file.content.replace(/\\r\\n?/g, '\\n').split('\\n').slice(0, lines.length)
    return {
      equal: lines.join('\\n') === expected.join('\\n'),
      lines: lines.length,
      tokens: document.querySelectorAll('.enc-line .tok-heading, .enc-line .tok-meta').length,
      numbers: document.querySelectorAll('.enc-gutter-num').length,
    }
  })()`)
  console.log('[smoke] editor content:', JSON.stringify(integrity))
  if (!integrity.lines || !integrity.equal) throw new Error('the editor does not draw the file as it is on disk')
  if (integrity.tokens < 1) throw new Error('markdown tokens were not rendered')
  if (integrity.numbers < integrity.lines) throw new Error('the gutter does not number the lines')
  await screenshot('03-editor.png')

  // Typing, saving and undo through the editor, with the file checked on disk.
  const original = await evaluate("window.eNCode.workspace.read('README.md').then((file) => file.content)")
  await focusEditor()
  await pressKey('End', { ctrl: true })
  await send('Input.insertText', { text: '\n\nEdited by the eNCode smoke test.\n' })
  await sleep(450)
  const dirty = await evaluate("!!document.querySelector('.editor-tab.is-dirty')")
  await pressKey('s', { ctrl: true })
  await sleep(800)
  const savedOnDisk = await evaluate(
    "window.eNCode.workspace.read('README.md').then((file) => file.content.includes('Edited by the eNCode smoke test'), () => false)",
  )
  const cleanAfterSave = await evaluate("!document.querySelector('.editor-tab.is-dirty')")
  console.log(`[smoke] save round-trip dirty=${dirty} disk=${savedOnDisk} cleanAfterSave=${cleanAfterSave}`)
  if (!dirty || !savedOnDisk || !cleanAfterSave) throw new Error('editor save round-trip failed')

  // Undo goes back to the text the file had, which is no longer what is on disk: unsaved until saved again.
  await pressKey('z', { ctrl: true })
  await sleep(350)
  const dirtyAfterUndo = await evaluate("!!document.querySelector('.editor-tab.is-dirty')")
  if (!dirtyAfterUndo) throw new Error('undoing the edit did not mark the document as unsaved')
  await pressKey('s', { ctrl: true })
  await sleep(700)
  const restored = await evaluate("window.eNCode.workspace.read('README.md').then((file) => file.content)")
  if (restored !== original) throw new Error('undo and save did not restore README.md')

  // In-file find.
  await focusEditor()
  await pressKey('f', { ctrl: true })
  await waitFor("!!document.querySelector('.enc-find')", 6000, 'find widget')
  await send('Input.insertText', { text: 'Scripts' })
  await sleep(500)
  const findCount = await evaluate("document.querySelector('.enc-find-count')?.textContent")
  console.log('[smoke] find count:', findCount)
  if (!findCount || !/\d/.test(findCount)) throw new Error('find did not find matches')
  await screenshot('04-find.png')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.enc-find')", 4000, 'find widget closed')

  // Quick open → open src/utils.ts.
  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))",
  )
  await waitFor("!!document.querySelector('.quickopen')", 8000, 'quick open')
  await waitFor("!document.querySelector('.quickopen .spin')", 8000, 'file index')
  await typeInto('.quickopen-input', 'utils')
  await sleep(450)
  const quickHits = await evaluate("document.querySelectorAll('.quickopen-item').length")
  console.log('[smoke] quick open hits:', quickHits)
  await screenshot('05-quickopen.png')
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.quickopen-item')].find((node) => node.textContent.includes('src/utils.ts'))
    if (!item) return false
    item.click()
    return true
  })()`)
  await waitFor(`${RENDERED_LINES}.join('\\n').includes('export function add')`, 15000, 'utils.ts open')
  await sleep(500)
  const tsStats = await evaluate(`(() => ({
    keywords: document.querySelectorAll('.enc-line .tok-keyword').length,
    functions: document.querySelectorAll('.enc-line .tok-function').length,
    language: (document.querySelector('.editor-footer')?.textContent ?? '').includes('typescript'),
    tabs: document.querySelectorAll('.editor-tab').length,
  }))()`)
  console.log('[smoke] typescript tokens:', JSON.stringify(tsStats))
  if (tsStats.keywords < 1) throw new Error('TypeScript tokens were not rendered')
  if (!tsStats.language) throw new Error('the footer does not show the language')
  if (tsStats.tabs !== 2) throw new Error(`expected two tabs, saw ${tsStats.tabs}`)
  await screenshot('06-editor-ts.png')

  // Switching back keeps the document: its place, its undo history.
  await click('.editor-tab', 'README.md')
  await waitFor(`${RENDERED_LINES}.join('\\n').includes('Demo Project')`, 8000, 'README shown again')

  // Go to line: the editor asks, the footer follows.
  await focusEditor()
  await pressKey('g', { ctrl: true })
  await waitFor("!!document.querySelector('.prompt-dialog')", 6000, 'go to line prompt')
  await typeInto('.prompt-dialog .text-input', '5:3')
  await sleep(150)
  await pressKey('Enter')
  await waitFor("(document.querySelector('.editor-footer')?.textContent ?? '').includes('Ln 5, Col 3')", 6000, 'cursor moved by go to line')
  // A closed dialog gives focus back to where it was a moment later; a menu opened before that would lose it again.
  await waitFor("!document.querySelector('.prompt-dialog') && document.activeElement?.classList.contains('enc-input')", 4000, 'focus back in the editor')
  await sleep(400)

  // Right-click opens the editor's own menu, and the menu takes keyboard focus. That must hold when
  // the system reduces motion too (the runner's Windows does): a transition, however short, keeps an
  // element that was just shown at visibility hidden for a frame, and a hidden element cannot be focused.
  for (const reduce of [false, true]) {
    const how = reduce ? ' with reduced motion' : ''
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] })
    await evaluate(`(() => {
      const scroller = document.querySelector('.enc-scroller')
      const rect = scroller.getBoundingClientRect()
      scroller.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 140, clientY: rect.top + 70 }))
      return true
    })()`)
    await waitFor("[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.includes('Go to line'))", 6000, 'editor context menu' + how)
    if (!reduce) await screenshot('06b-editor-menu.png')
    await waitFor("!!document.activeElement?.closest('[role=menu]')", 4000, 'focus in the editor menu' + how)
    await pressKey('Escape')
    await waitFor("!document.querySelector('[role=menu]')", 4000, 'editor context menu closed' + how)
    await waitFor("document.activeElement?.classList.contains('enc-input')", 4000, 'focus back in the editor after Escape' + how)
  }
  await send('Emulation.setEmulatedMedia', { features: [] })

  // A change on disk (here a write through the app's API, as the agent's are) reaches the open document and keeps the cursor.
  const readme = await evaluate("window.eNCode.workspace.read('README.md').then((file) => file.content)")
  const cursorBefore = /Ln \d+, Col \d+/.exec(await evaluate("document.querySelector('.editor-footer')?.textContent ?? ''"))?.[0]
  await evaluate(
    `window.eNCode.workspace.write('README.md', ${JSON.stringify(readme.replace('Demo Project', 'Demo Project (changed on disk)'))})`,
  )
  await waitFor(`${RENDERED_LINES}.join('\\n').includes('changed on disk')`, 10000, 'change on disk shown')
  const afterExternal = await evaluate(`(() => ({
    dirty: Boolean(document.querySelector('.editor-tab.is-dirty')),
    footer: document.querySelector('.editor-footer')?.textContent ?? '',
  }))()`)
  console.log('[smoke] after change on disk:', JSON.stringify(afterExternal))
  if (afterExternal.dirty) throw new Error('a change from disk marked the document as edited')
  if (!cursorBefore || !afterExternal.footer.includes(cursorBefore)) throw new Error(`a change from disk moved the cursor from ${cursorBefore}`)
  await evaluate(`window.eNCode.workspace.write('README.md', ${JSON.stringify(readme)})`)
  await waitFor(`!${RENDERED_LINES}.join('\\n').includes('changed on disk')`, 10000, 'change on disk undone')

  // Closing a tab with unsaved changes asks first, and Cancel keeps the changes.
  await focusEditor()
  await send('Input.insertText', { text: 'unsaved' })
  await waitFor("!!document.querySelector('.editor-tab.is-dirty')", 4000, 'unsaved mark')
  await click('.editor-tab.is-active .tab-close')
  await waitFor("!!document.querySelector('.ui-dialog .confirm-body')", 6000, 'discard prompt')
  await screenshot('06c-discard.png')
  await click('.ui-dialog-foot button', 'Cancel')
  await waitFor("!document.querySelector('.ui-dialog')", 4000, 'discard prompt closed')
  if (!(await evaluate("!!document.querySelector('.editor-tab.is-dirty')"))) throw new Error('Cancel threw the changes away')
  await pressKey('z', { ctrl: true })
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 4000, 'undo back to the saved text')

  // A file that someone else changed since it was read is not overwritten unasked.
  const readDisk = () => evaluate("window.eNCode.workspace.read('README.md').then((file) => file.content)")
  await focusEditor()
  await send('Input.insertText', { text: 'mine ' })
  await waitFor("!!document.querySelector('.editor-tab.is-dirty')", 4000, 'unsaved mark before the overwrite check')
  await evaluate(`window.eNCode.workspace.write('README.md', ${JSON.stringify(`${readme}\nTheirs.\n`)})`)
  await pressKey('s', { ctrl: true })
  await waitFor("!!document.querySelector('.ui-dialog .confirm-body')", 6000, 'overwrite prompt')
  await screenshot('06d-overwrite.png')
  await click('.ui-dialog-foot button', 'Cancel')
  await waitFor("!document.querySelector('.ui-dialog')", 4000, 'overwrite prompt closed')
  const afterCancel = await readDisk()
  if (!afterCancel.includes('Theirs.') || afterCancel.includes('mine ')) throw new Error('Cancel still wrote the file')
  if (!(await evaluate("!!document.querySelector('.editor-tab.is-dirty')"))) throw new Error('Cancel marked the document as saved')
  await pressKey('s', { ctrl: true })
  await waitFor("!!document.querySelector('.ui-dialog .confirm-body')", 6000, 'overwrite prompt again')
  await click('.ui-dialog-foot button', 'Overwrite')
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 6000, 'saved after Overwrite')
  const afterOverwrite = await readDisk()
  if (!afterOverwrite.includes('mine ') || afterOverwrite.includes('Theirs.')) throw new Error('Overwrite did not write the typed version')
  // Back through the editor: the file is what the editor wrote last, so saving asks nothing.
  await pressKey('z', { ctrl: true })
  await waitFor("!!document.querySelector('.editor-tab.is-dirty')", 4000, 'undo makes the document differ from the file')
  await pressKey('s', { ctrl: true })
  await waitFor("!document.querySelector('.editor-tab.is-dirty')", 6000, 'saved without a prompt')
  if (await evaluate("!!document.querySelector('.ui-dialog')")) throw new Error('a file the editor wrote last was reported as changed')
  if ((await readDisk()) !== readme) throw new Error('the file was not put back')

  // Skills and agents, from the rail.
  if (!(await click('.rail-btn[aria-label="Skills and agents"]'))) throw new Error('Skills and agents button not found')
  await waitFor("document.querySelector('.settings-heading')?.textContent === 'Skills and agents' && !!document.querySelector('.item-row[data-agent=\"Explore\"]')", 8000, 'the Skills and agents page with the built-in agents')
  await screenshot('07-skills.png')
  await closeSettings()

  // Offline demo agent.
  await evaluate("window.eNCode.workspace.delete('.encode/demo-note.md').catch(() => null)")
  await typeInto('.composer-input', 'Create a short note that says hello from eNCode')
  await sleep(350)
  console.log('[smoke] demo send clicked:', await click('.composer-send'))

  // The demo writes into .encode, a protected folder, so even Workspace Write asks first.
  const demoApprovals = await driveAgent('08-demo')
  console.log('[smoke] demo approvals:', JSON.stringify(demoApprovals))
  if (demoApprovals.length !== 1 || !demoApprovals[0].title.includes('.encode/demo-note.md')) {
    throw new Error('Expected one approval for the protected .encode write')
  }
  if (!demoApprovals[0].reason.includes('protected')) throw new Error('The approval card does not say why it asks')
  await sleep(600)
  console.log(
    '[smoke] demo result:',
    JSON.stringify(
      await evaluate(`(() => ({
        entries: document.querySelectorAll('.chat-list .msg, .chat-list .tool-row').length,
        toolCards: document.querySelectorAll('.tool-row').length,
        diffs: document.querySelectorAll('.diff-view').length,
        status: document.querySelector('.chat-panel')?.dataset.status,
      }))()`),
    ),
  )
  await screenshot('08-agent.png')
  await runSessionViewChecks()
  await runFindChecks()
  await runComposerChecks()
  await runPaletteChecks()
  await runSettingsPageChecks()

  console.log(
    '[smoke] demo file bytes:',
    await evaluate(
      "window.eNCode.workspace.read('.encode/demo-note.md').then((file) => file.content.length, (error) => 'ERR: ' + error.message)",
    ),
  )

  // Ctrl+` opens the shell in the bottom panel.
  await key({ key: '`', code: 'Backquote', ctrlKey: true })
  await waitFor("!!document.querySelector('.bottom-panel .terminal-lines')", 15000, 'eNCode shell')
  await sleep(500)
  await typeInto('.term-input', 'echo shell-ok')
  await sleep(250)
  await evaluate(
    "document.querySelector('.term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))",
  )
  await waitFor("document.querySelector('.terminal-lines')?.textContent.includes('shell-ok')", 10000, 'shell output')
  // Real programs: found on PATH (Path on Windows), and npm.cmd run through cmd.exe on Windows.
  const programs = [
    ['node --version', process.version],
    ['npm --version', execSync('npm --version', { encoding: 'utf8' }).trim()],
  ]
  for (const [command, expected] of programs) {
    await typeInto('.term-input', command)
    await sleep(250)
    await evaluate(
      "document.querySelector('.term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))",
    )
    await waitFor(
      `document.querySelector('.terminal-lines')?.textContent.includes(${JSON.stringify(expected)})`,
      20000,
      `${command} prints ${expected}`,
    )
  }
  console.log(
    '[smoke] shell output:',
    JSON.stringify((await evaluate("document.querySelector('.terminal-lines').textContent")).slice(-160)),
  )
  await screenshot('09-terminal.png')

  // CI sets ENCODE_SMOKE_OFFLINE=1 so a run never depends on a third-party service being up.
  if (process.env.ENCODE_SMOKE_OFFLINE === '1') {
    console.log('[smoke] offline: OpenRouter catalog skipped')
  } else {
    const freeModels = await evaluate(
      "window.eNCode.models.openRouter(true).then((list) => list.length, (error) => 'ERR: ' + error.message)",
    )
    console.log('[smoke] openrouter free models:', freeModels)
    if (typeof freeModels !== 'number' || freeModels < 1) throw new Error('OpenRouter model catalog unavailable')
  }

  await runProviderPhase()

  await evaluate("window.eNCode.agent.reset()")
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'demo', policy: 'workspace-write' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'final reload')
  await screenshot('12-final.png')

  await runShellChecks()
  await runShortcutChecks()
  await runAboutChecks()
  await runPanelChecks()
  await runReviewChecks()
  await runBestOfChecks()
  await runChatWorktreeChecks()
  await runFontChecks()
  await runAppearanceChecks()
  await runDogfoodChecks()

  if (errors.length) {
    console.error('[smoke] renderer errors:\n' + errors.join('\n---\n'))
    process.exitCode = 1
  } else {
    // Last, since it takes the page this run talks to away.
    await runCrashCheck()
    console.log('[smoke] PASS — no renderer exceptions')
  }
} catch (error) {
  if (error instanceof SmokePartsDone) {
    console.log(errors.length ? '[smoke] renderer errors:\n' + errors.join('\n---\n') : '[smoke] PASS (only the parts asked for)')
    process.exitCode = errors.length ? 1 : 0
  } else {
    console.error('[smoke] FAILED:', error.message)
    if (errors.length) console.error('[smoke] renderer errors:\n' + errors.join('\n---\n'))
    try {
      // After the crash check the page this run talks to is gone, and a screenshot would wait for it for ever.
      if (!pageCrashed) await screenshot('99-failure.png')
    } catch {
      /* ignore */
    }
    process.exitCode = 1
  }
} finally {
  if (provider) provider.kill()
  ws.close()
  await sleep(150)
  process.exit(process.exitCode ?? 0)
}
