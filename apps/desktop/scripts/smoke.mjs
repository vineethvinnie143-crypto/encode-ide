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
import { fileURLToPath } from 'node:url'
import { connect, sleep } from './cdp.mjs'

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
console.log('[smoke] target:', target.url)

/**
 * Evaluates in the frame, a DevTools target of its own, that has loaded `url`. A frame the page refused to
 * show is an error page, so it has no target at that address.
 */
async function evaluateInFrame(url, expression, timeoutMs = 10000) {
  const started = Date.now()
  let seen = []
  while (Date.now() - started < timeoutMs) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    seen = targets.filter((target) => target.type === 'iframe').map((target) => target.url)
    const frame = targets.find((target) => target.type === 'iframe' && target.url === url && target.webSocketDebuggerUrl)
    if (frame) return evaluateOn(frame.webSocketDebuggerUrl, expression)
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

const KEY_CODES = { End: 35, Home: 36, Escape: 27, Enter: 13 }

/** A key chord through the browser's own input path, to whatever has focus. */
async function pressKey(key, { ctrl = false, shift = false } = {}) {
  const common = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
    windowsVirtualKeyCode: KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0),
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
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
        "[...document.querySelectorAll('.msg-error')].map((node) => node.textContent).join('\\n')",
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
        detail: card.querySelector('.approval-detail')?.textContent ?? '',
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
  await waitFor("!!document.querySelector('.settings-modal .settings-roles')", 8000, 'the Roles settings')
  const roles = await evaluate("[...document.querySelectorAll('.role-row')].map((node) => node.dataset.role)")
  if (roles.join() !== 'main,explore,planner,reviewer,summarizer,utility') throw new Error(`the Roles settings list ${roles.join()}`)
  await waitFor("document.querySelectorAll('[data-section=\"status\"] .status-row').length >= 1", 30000, 'the connections report')
  const report = await evaluate("document.querySelector('[data-section=\"status\"]').textContent")
  if (!report.includes('Custom')) throw new Error(`the connections report reads "${report}"`)
  if ((await evaluate("document.querySelector('#free-only').getAttribute('aria-checked')")) !== 'true') throw new Error('"Only use free models" should be on')
  await screenshot('01-roles.png')
  if (!(await click('.settings-footer .btn', 'Cancel'))) throw new Error('no Cancel in settings')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings closed')

  // Back to a plain install for the checks that follow.
  const keep = demoSettings.profiles.filter((profile) => profile.id !== connection.id)
  await evaluate(`window.eNCode.settings.save({ profiles: ${JSON.stringify(keep)}, roles: {}, activeProfileId: ${JSON.stringify(demoSettings.activeProfileId)} })`)
}

async function runProviderPhase() {
  console.log('[smoke] --- provider phase (local OpenAI-compatible server) ---')
  await ensureFakeProvider()

  await evaluate('window.eNCode.agent.reset()')
  await evaluate("window.eNCode.workspace.delete('provider-check.txt').catch(() => null)")
  // Project instructions: the next conversation starts with them.
  const marker = `smoke-instructions-${Date.now().toString(36)}`
  await evaluate(`window.eNCode.workspace.write('ENCODE.md', ${JSON.stringify(`# Smoke project\n\nAlways mention ${marker}.\n`)})`)
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
    maxSteps: 12
  })`)
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
  await runStopChecks()
  await runSteerChecks()
  await runEffortChecks()
  await runSubagentChecks()
  await runWebChecks()
  await runSearchChecks()
  await runPermissionChecks()
  await runAutoReviewChecks()
  await runRewindChecks()
  await runMcpChecks()
  await runComputerChecks()
  await runCompactionChecks()
  await runNamingChecks()
}

async function providerStats() {
  return (await fetch(`http://127.0.0.1:${providerPort}/__stats`)).json()
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
  if (!(await click('.rail-btn[aria-label="Settings"]'))) throw new Error('Settings button not found')
  await waitFor("!!document.querySelector('.settings-modal .settings-tabs')", 8000, 'settings')
  if (!(await click('.settings-tabs button', 'Agent'))) throw new Error('Agent tab not found')
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
  await waitFor("!!document.querySelector('.settings-agent [role=\"status\"].error-text')", 20000, 'the test to answer')
  const noKey = await evaluate("document.querySelector('.settings-agent [role=\"status\"]').textContent")
  if (noKey !== 'There is no API key for Brave Search. Paste one above, then press Test search.') throw new Error(`The test without a key says ${JSON.stringify(noKey)}`)
  await evaluate("document.querySelector('.settings-agent [role=\"status\"]')?.scrollIntoView({ block: 'end' })")
  await sleep(250)
  await screenshot('15-search-settings.png')

  // Type a key and save: the page learns only that one is stored, and the disk holds it sealed.
  const secret = `brave-smoke-${Date.now().toString(36)}`
  if (!(await typeInto('.search-key .text-input', secret))) throw new Error('No key field')
  await click('.settings-footer .btn.primary')
  await waitFor("!document.querySelector('.settings-modal')", 8000, 'settings close')
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
  await click('.settings-footer .btn.primary')
  await waitFor("!document.querySelector('.settings-modal')", 8000, 'settings close')
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
      buttons: [...card.querySelectorAll('.mcp-actions .btn')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
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
  await click('.settings-tabs button', 'MCP')
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

  await click('.settings-footer .btn.primary')
  await waitFor("!document.querySelector('.settings-modal')", 8000, 'settings close')
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
  if (!(await click('.rail-btn[aria-label="Settings"]'))) throw new Error('Settings button not found')
  await waitFor("!!document.querySelector('.settings-modal .settings-tabs')", 8000, 'settings')
  if (!(await click('.settings-tabs button', 'Agent'))) throw new Error('Agent tab not found')
  await waitFor("!!document.querySelector('#computer-use')", 4000, 'the computer switch')
  await screenshot('computer-settings.png')
  await click('#computer-use')
  if ((await evaluate("document.querySelector('#computer-use').getAttribute('aria-checked')")) !== 'true') throw new Error('The computer switch did not turn on')
  await click('.settings-footer .btn.primary')
  await waitFor('window.eNCode.settings.get().then((value) => value.computer === true)', 8000, 'the computer setting is saved')
  await waitFor("!document.querySelector('.settings-modal')", 8000, 'settings close')
  if ((await bannerTargets()).length) throw new Error('A banner is up with nothing using the computer')

  for (const [label, stop] of [
    // The banner closes with the turn, so the click is made after the answer has gone out; a page that is gone cannot answer.
    ['the banner button', () => evaluateInBanner("setTimeout(() => document.getElementById('stop').click(), 50), true")],
    ['Ctrl+Alt+Esc', async () => pressStopShortcut()],
  ]) {
    await sendPrompt('[scenario:computer-check] Look at the desktop, then run a command.')
    // The first use builds the helper that drives windows, which takes a while.
    await waitFor("!!document.querySelector('.approval-card')", 180000, `the command waits for you (${label})`)
    const banner = await evaluateInBanner(BANNER_STATE)
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

/** Esc twice stops the agent: the first press says what a second does, and the note goes when no second comes. */
async function runStopChecks() {
  console.log('[smoke] --- Esc twice ---')
  const running = "!!document.querySelector('.composer-send.is-stop')"
  const hint = "(document.querySelector('.composer-hint')?.textContent ?? '')"
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:slow-reply] Write a long review.')
  await waitFor(`${running} && document.body.textContent.includes('The parser')`, 20000, 'the long answer streams')

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

  // Steer as the default: Enter steers and Ctrl+Enter queues; a queued message is steered with its button.
  if (!(await click('.rail-btn[aria-label="Settings"]'))) throw new Error('Settings button not found')
  await waitFor("!!document.querySelector('.settings-modal .settings-tabs')", 8000, 'settings')
  if (!(await click('.settings-tabs button', 'Agent'))) throw new Error('Agent tab not found')
  await waitFor("!!document.querySelector('[aria-label=\"What Enter does while the agent works\"]')", 4000, 'the follow-up choice')
  await click('[aria-label="What Enter does while the agent works"] .ui-segment', 'Steer')
  await click('.settings-footer .btn.primary', 'Save')
  await waitFor("window.eNCode.settings.get().then((settings) => settings.followUp === 'steer')", 4000, 'Steer is saved')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings close on Save')

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
  await waitFor("!!document.querySelector('.settings-modal .settings-roles .role-effort')", 8000, 'the Roles settings with an effort for each role')
  const shown = await evaluate("[...document.querySelectorAll('.role-row')].map((row) => row.dataset.role + '=' + row.querySelector('.role-effort select').value).join()")
  if (shown !== 'main=low,explore=default,planner=default,reviewer=default,summarizer=default,utility=default') throw new Error(`the roles show ${shown}`)
  await selectOption('.role-row[data-role="explore"] .role-effort select', 'max')
  await sleep(250)
  await screenshot('ui-dark-role-efforts.png')
  await click('.settings-footer .btn.primary', 'Save')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings close on Save')
  if ((await efforts()) !== '{"main":"low","explore":"max"}') throw new Error(`the efforts are ${await efforts()} after Save`)

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
}

const DEFAULT_APPEARANCE = {
  mode: 'dark',
  accent: 'blue',
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
async function screenshotSizes(name) {
  for (const [width, height] of [
    [1280, 800],
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
  if (!(await click('.rail-btn[aria-label="Settings"]'))) throw new Error('Settings button not found')
  await waitFor("!!document.querySelector('.settings-modal .settings-tabs')", 8000, 'settings')
  if (!(await click('.settings-tabs button', 'Appearance'))) throw new Error('Appearance tab not found')
  await waitFor("!!document.querySelector('.settings-appearance')", 4000, 'appearance settings')
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
  await waitFor("document.querySelector('.settings-modal .settings-tabs button.is-on')?.textContent === 'Sandbox'", 6000, 'the settings open on that page')
  await click('.settings-header .icon-btn')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'the settings close')

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

  // A page that forbids being framed (X-Frame-Options and frame-ancestors) opens in the panel instead of leaving it blank
  // white, and its script-blocking policy is still in force.
  const deniedUrl = `http://127.0.0.1:${providerPort}/__frame/denied`
  await typeInto('.browser-address input', deniedUrl)
  await evaluate("document.querySelector('.browser-address input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  const framed = await evaluateInFrame(deniedUrl, 'document.title')
  if (framed !== 'Framed page') {
    throw new Error(framed === 'Script ran' ? 'The Browser tab dropped more than frame-ancestors from the page policy: its script ran' : `The framed page is titled ${JSON.stringify(framed)}`)
  }
  console.log('[smoke] a page that forbids framing is shown in the Browser tab, with the rest of its policy')

  // An address that needs no network: nothing listens on port 8, so the frame shows its error page.
  await typeInto('.browser-address input', 'http://127.0.0.1:8/')
  await evaluate("document.querySelector('.browser-address input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await waitFor(`${inFront} === '127.0.0.1:8'`, 4000, 'the tab is named after the page')

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
  await waitFor(menuOpen('Session'), 4000, 'ArrowRight opens the next menu')
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

  // The shortcuts list.
  await key({ key: '/', code: 'Slash', ctrlKey: true })
  await waitFor("!!document.querySelector('.shortcuts-dialog')", 4000, 'Ctrl+/ opens the shortcuts')
  const rows = await count('.shortcuts-row')
  if (rows < 30) throw new Error(`the shortcuts list has only ${rows} rows`)
  await sleep(400)
  await screenshot('ui-dark-shortcuts.png')
  await key({ key: 'Escape' })
  await waitFor("!document.querySelector('.shortcuts-dialog')", 4000, 'Escape closes the shortcuts')

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
  for (const label of ['Keyboard shortcuts', 'Save diagnostics…', 'Show log files', 'About eNCode']) {
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

/**
 * Settings > Appearance: a choice previews at once, Cancel puts the saved look back, Save
 * keeps it across a reload. Captures the main window and the Appearance page in both themes.
 */
async function runAppearanceChecks() {
  console.log('[smoke] --- appearance ---')
  if ((await theme()) !== 'dark') throw new Error(`eNCode should start dark, not ${await theme()}`)
  await screenshotSizes('ui-dark-main')

  await openAppearanceSettings()
  await screenshotSizes('ui-dark-appearance')
  await click('.settings-appearance [role="radio"]', 'Light')
  await waitFor("document.documentElement.dataset.theme === 'light'", 4000, 'light preview')
  await click('.settings-footer .btn', 'Cancel')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings closed')
  if ((await theme()) !== 'dark') throw new Error('Cancel did not put the dark theme back')

  await openAppearanceSettings()
  await click('.settings-appearance [role="radio"]', 'Light')
  await click('.accent-swatch[aria-label="Jade"]')
  await waitFor("document.documentElement.dataset.accent === 'jade'", 4000, 'jade preview')
  await click('.accent-swatch[aria-label="Signal blue"]')
  await screenshotSizes('ui-light-appearance')
  await click('.settings-footer .btn.primary')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings saved')
  const saved = await evaluate('window.eNCode.settings.get().then((settings) => settings.appearance)')
  console.log('[smoke] saved appearance:', JSON.stringify(saved))
  if (saved.mode !== 'light' || saved.accent !== 'blue') throw new Error('Light was not saved')

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
 * Settings > Appearance > Fonts: Windows' own fonts at Codex's sizes by default, Inter and JetBrains Mono
 * one choice away, the installed fonts listed, sizes that move the whole interface, Cancel putting
 * the old fonts back, and a saved choice drawn right from the first frame after a reload.
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

  // Inter: the same sizes minus the pixel Windows' font gets on small text.
  if (!(await chooseOption('Interface font', 'eNCode (Inter)'))) throw new Error('no eNCode (Inter) choice')
  await waitFor("getComputedStyle(document.body).fontFamily.startsWith('Inter')", 4000, 'Inter preview')
  await waitFor("document.documentElement.style.getPropertyValue('--ui-small').trim() === '0px'", 4000, 'Inter takes no extra pixel')
  const smallInter = await sizeOf('.session-sidebar .sb-row .meta')
  if (smallInter !== smallSystem - 1) throw new Error(`Inter's small text is ${smallInter} px, the system font's is ${smallSystem} px`)
  if ((await sizeOf('.composer-input')) !== inputSystem) throw new Error('Inter changed the size of the thread text')

  // The sizes move the whole interface.
  if (!(await chooseOption('Interface size', '16 px'))) throw new Error('no 16 px choice')
  await waitFor("document.documentElement.style.getPropertyValue('--ui-delta').trim() === '2px'", 4000, '16 px preview')
  if ((await sizeOf('.composer-input')) !== 16) throw new Error('the thread text did not follow the interface size')
  if (!(await chooseOption('Code size', '14 px'))) throw new Error('no 14 px choice')
  await waitFor("document.documentElement.style.getPropertyValue('--code-size').trim() === '14px'", 4000, 'code size preview')
  if (!(await chooseOption('Code font', 'eNCode (JetBrains Mono)'))) throw new Error('no JetBrains Mono choice')
  await waitFor("document.documentElement.style.getPropertyValue('--font-mono').trim().startsWith(\"'JetBrains Mono'\")", 4000, 'JetBrains Mono preview')

  // Cancel puts Windows' fonts back.
  await click('.settings-footer .btn', 'Cancel')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings closed')
  await waitFor("getComputedStyle(document.body).fontFamily.startsWith('system-ui') && parseFloat(getComputedStyle(document.querySelector('.composer-input')).fontSize) === 14", 4000, 'Cancel puts the fonts back')

  // Saved, Inter is there from the first frame of the next load.
  await openAppearanceSettings()
  if (!(await chooseOption('Interface font', 'eNCode (Inter)'))) throw new Error('no eNCode (Inter) choice')
  await click('.settings-footer .btn.primary')
  await waitFor("!document.querySelector('.settings-modal')", 4000, 'settings saved')
  const saved = await evaluate('window.eNCode.settings.get().then((settings) => settings.appearance)')
  if (saved.uiFont !== '@encode' || saved.uiSize !== 14) throw new Error(`the fonts were not saved: ${JSON.stringify(saved)}`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload with Inter')
  if (!(await bodyFont()).startsWith('Inter')) throw new Error('Inter did not survive a reload')
  await screenshot('ui-dark-inter.png')

  await evaluate(`window.eNCode.settings.save({ appearance: ${JSON.stringify(DEFAULT_APPEARANCE)} })`)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'reload with the system fonts')
  if (!(await bodyFont()).startsWith('system-ui')) throw new Error('saving the defaults did not bring the system font back')
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

  // Settings modal.
  if (!(await click('.rail-btn[aria-label="Plugins and skills"]'))) throw new Error('Plugins button not found')
  await waitFor("!!document.querySelector('.settings-modal')", 8000, 'settings modal')
  await screenshot('07-settings.png')
  await click('.settings-header .icon-btn')
  await sleep(300)

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
  await runAboutChecks()
  await runPanelChecks()
  await runReviewChecks()
  await runFontChecks()
  await runAppearanceChecks()

  if (errors.length) {
    console.error('[smoke] renderer errors:\n' + errors.join('\n---\n'))
    process.exitCode = 1
  } else {
    console.log('[smoke] PASS — no renderer exceptions')
  }
} catch (error) {
  console.error('[smoke] FAILED:', error.message)
  if (errors.length) console.error('[smoke] renderer errors:\n' + errors.join('\n---\n'))
  try {
    await screenshot('99-failure.png')
  } catch {
    /* ignore */
  }
  process.exitCode = 1
} finally {
  if (provider) provider.kill()
  ws.close()
  await sleep(150)
  process.exit(process.exitCode ?? 0)
}
