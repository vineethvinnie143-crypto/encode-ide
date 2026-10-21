/**
 * End-to-end smoke test driven over the Chrome DevTools Protocol.
 *
 * pnpm e2e (scripts/e2e.mjs) runs it in a throwaway sandbox. By hand:
 *
 *   1. start Electron:  .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
 *   2. run:             node scripts/smoke.mjs <workspace-to-open>
 *
 * ENCODE_DEBUG_PORT and ENCODE_FAKE_PROVIDER_PORT override the ports (9222, 8787).
 *
 * Exercises the hand-built editor (overlay integrity, save round-trip, find,
 * quick open), the offline demo agent, then a real streaming provider via
 * scripts/fake-provider.mjs including approvals, diffs and command execution, and
 * last the appearance settings, capturing dark and light at 1280 x 800 and 1920 x 1080.
 * Screenshots land in ./screenshots.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const errors = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findTarget() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(
        (target) => target.type === 'page' && (target.url.startsWith('app://') || target.url.includes('localhost:')),
      )
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* electron not up yet */
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for the Electron page target on port ${port}`)
}

const target = await findTarget()
console.log('[smoke] target:', target.url)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let messageId = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params?.exceptionDetails?.exception?.description ?? 'Unknown exception')
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    errors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
})

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed'
    throw new Error(description)
  }
  return result.result?.value
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* context may be reloading */
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for: ${label}`)
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

/**
 * Waits for the agent to finish, approving every approval card on the way.
 * Returns the approval cards it saw ({ title, reason, detail }).
 * options.keyboard approves with Enter; options.whileWaiting runs once, while the first card shows.
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
        detail: card.querySelector('.approval-detail')?.textContent ?? '',
      }
    })()`)
    if (card) {
      approvals.push(card)
      await sleep(250)
      await screenshot(`${label}-approval-${approvals.length}.png`)
      if (options.whileWaiting && approvals.length === 1) await options.whileWaiting()
      if (options.keyboard) {
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
    stdio: 'ignore',
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

async function runProviderPhase() {
  console.log('[smoke] --- provider phase (local OpenAI-compatible server) ---')
  await ensureFakeProvider()

  await evaluate('window.eNCode.agent.reset()')
  await evaluate("window.eNCode.workspace.delete('provider-check.txt').catch(() => null)")
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
  if (!stats.tools || !stats.commandOutput) throw new Error('run_command output missing')
  if (!stats.completion) throw new Error('completion summary missing')

  const seen = await (await fetch(`http://127.0.0.1:${providerPort}/__last-authorization`)).json()
  if (seen.authorization !== `Bearer ${secret}`) throw new Error('The stored key did not reach the provider')

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
  if (featureCheck.todoCount !== 1 || featureCheck.todoStatus !== 'in_progress') throw new Error('todo_write surface failed')
  if (featureCheck.scheduled < 1 || featureCheck.remaining !== featureCheck.scheduled - 1) {
    throw new Error('schedule create/remove failed')
  }
  if (!featureCheck.skillListed || !featureCheck.skillText) throw new Error('skill create/read failed')
  if (!featureCheck.jobsArray || !featureCheck.planNull) throw new Error('jobs/plan surface failed')

  await runSubagentChecks()
  await runWebChecks()
  await runCompactionChecks()
}

async function providerStats() {
  return (await fetch(`http://127.0.0.1:${providerPort}/__stats`)).json()
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
  console.log('[smoke] --- web_fetch ---')
  // A new site asks once per session; localhost then fails the address check, so nothing is fetched.
  await evaluate('window.eNCode.agent.reset()')
  await sendPrompt('[scenario:web-check] Fetch two pages from one site.')
  const approvals = await driveAgent('15-web')
  console.log('[smoke] web approvals:', JSON.stringify(approvals))
  if (approvals.length !== 1 || approvals[0].title !== 'Fetch from localhost') {
    throw new Error('Expected one approval for the first fetch from localhost')
  }
  if (!approvals[0].reason.includes('until the session ends')) throw new Error('The web approval does not explain itself')
  const fetches = (await toolOutputs()).filter((entry) => entry.name === 'web_fetch')
  console.log('[smoke] web fetches:', JSON.stringify(fetches.map((entry) => entry.output.slice(0, 120))))
  if (fetches.length !== 2 || !fetches.every((entry) => entry.output.includes('private or special-purpose network address'))) {
    throw new Error('web_fetch reached a private address')
  }
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
  const task = (await toolOutputs()).find((entry) => entry.name === 'task')
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
  const planTask = (await toolOutputs()).find((entry) => entry.name === 'task')
  console.log('[smoke] plan mode subagent:', JSON.stringify({ approvals: planApprovals.length, escalation, task: planTask }))
  if (escalation !== 'absent') throw new Error('A subagent wrote a file while the session was in Plan mode')
  await evaluate("window.eNCode.settings.save({ agentMode: 'code', policy: 'workspace-write' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after code mode')
}

const DEFAULT_APPEARANCE = { mode: 'dark', accent: 'blue', contrast: 'standard', density: 'comfortable', motion: 'system' }
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
  if (sizes.titlebar !== 44 || sizes.rail !== 52 || sizes.railButton !== 36) throw new Error('the title bar or icon rail is not the specified size')
  if (sizes.sidebar < 220 || sizes.sidebar > 480) throw new Error('the sidebar is outside its 220 to 480 px range')

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
  await waitFor("!document.querySelector('.right-wrap')", 4000, 'Ctrl+Alt+B hides the side panel')
  await key({ key: 'b', ctrlKey: true, altKey: true })
  await waitFor("!!document.querySelector('.right-wrap')", 4000, 'Ctrl+Alt+B shows the side panel')
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

try {
  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor(
    "!!window.eNCode && !!document.querySelector('.titlebar .menubar') && !!document.querySelector('.icon-rail') && !!document.querySelector('.session-sidebar')",
    30000,
    'app shell',
  )
  console.log('[smoke] app shell rendered')
  await screenshot('01-launch.png')

  const opened = await evaluate(`window.eNCode.workspace.openPath(${JSON.stringify(demoPath)})`)
  console.log('[smoke] workspace opened:', opened?.name)
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'file tree')
  console.log('[smoke] tree rows:', await evaluate("document.querySelectorAll('.tree-row').length"))

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
  await click('.right-tab', 'Workspace')
  await waitFor("!!document.querySelector('.files-switcher')", 8000, 'workspace drawer')
  await screenshot('02-explorer.png')

  if (!(await click('.tree-row', 'README.md'))) throw new Error('README.md row not found')
  await waitFor("document.querySelector('.code-input')?.value.includes('Demo Project')", 15000, 'README loaded')
  await sleep(450)

  const integrity = await evaluate(`(() => {
    const source = document.querySelector('.code-input').value
    const rendered = document.querySelector('.code-highlight code').textContent
    return {
      equal: source === rendered,
      tokens: document.querySelectorAll('.code-highlight .tok-heading, .code-highlight .tok-meta').length,
    }
  })()`)
  console.log('[smoke] overlay integrity:', JSON.stringify(integrity))
  if (!integrity.equal) throw new Error('highlight overlay does not match the source text')
  if (integrity.tokens < 1) throw new Error('markdown tokens were not rendered')
  await screenshot('03-editor.png')

  // Save round-trip through the custom editor.
  const original = await evaluate("document.querySelector('.code-input').value")
  await typeInto('.code-input', original + '\n\nEdited by the eNCode smoke test.\n')
  await sleep(450)
  const dirty = await evaluate("!!document.querySelector('.editor-tab.is-dirty')")
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))")
  await sleep(800)
  const savedOnDisk = await evaluate(
    "window.eNCode.workspace.read('README.md').then((file) => file.content.includes('Edited by the eNCode smoke test'), () => false)",
  )
  console.log(`[smoke] save round-trip dirty=${dirty} disk=${savedOnDisk}`)
  if (!dirty || !savedOnDisk) throw new Error('editor save round-trip failed')

  await typeInto('.code-input', original)
  await sleep(300)
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))")
  await sleep(600)

  // In-file find.
  await evaluate(`(() => {
    const textarea = document.querySelector('.code-input')
    textarea.focus()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await waitFor("!!document.querySelector('.find-bar')", 6000, 'find bar')
  await typeInto('.find-input', 'Scripts')
  await sleep(500)
  const findCount = await evaluate("document.querySelector('.find-count')?.textContent")
  console.log('[smoke] find count:', findCount)
  if (!findCount || findCount === '0/0') throw new Error('find bar did not find matches')
  await screenshot('04-find.png')
  await evaluate("document.querySelectorAll('.find-bar .icon-btn').forEach((button) => button.click())")
  await sleep(300)

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
  await waitFor("document.querySelector('.code-input')?.value.includes('export function add')", 15000, 'utils.ts open')
  await sleep(500)
  const tsStats = await evaluate(`(() => ({
    keywords: document.querySelectorAll('.code-highlight .tok-keyword').length,
    functions: document.querySelectorAll('.code-highlight .tok-function').length,
    language: (document.querySelector('.editor-footer')?.textContent ?? '').includes('typescript'),
  }))()`)
  console.log('[smoke] typescript tokens:', JSON.stringify(tsStats))
  if (tsStats.keywords < 1) throw new Error('TypeScript tokens were not rendered')
  await screenshot('06-editor-ts.png')

  // Settings modal.
  if (!(await click('.rail-btn[aria-label="Plugins and skills"]'))) throw new Error('Plugins button not found')
  await waitFor("!!document.querySelector('.settings-modal')", 8000, 'settings modal')
  await screenshot('07-settings.png')
  await click('.settings-header .icon-btn')
  await sleep(300)

  // Offline demo agent.
  await evaluate("window.eNCode.workspace.delete('.eNCode/demo-note.md').catch(() => null)")
  await typeInto('.composer-input', 'Create a short note that says hello from eNCode')
  await sleep(350)
  console.log('[smoke] demo send clicked:', await click('.composer-send'))

  // The demo writes into .eNCode, a protected folder, so even Workspace Write asks first.
  const demoApprovals = await driveAgent('08-demo')
  console.log('[smoke] demo approvals:', JSON.stringify(demoApprovals))
  if (demoApprovals.length !== 1 || !demoApprovals[0].title.includes('.eNCode/demo-note.md')) {
    throw new Error('Expected one approval for the protected .eNCode write')
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
  await runComposerChecks()

  console.log(
    '[smoke] demo file bytes:',
    await evaluate(
      "window.eNCode.workspace.read('.eNCode/demo-note.md').then((file) => file.content.length, (error) => 'ERR: ' + error.message)",
    ),
  )

  await click('.right-tab', 'Workspace')
  if (!(await click('.workspace-tabs button', 'Shell'))) throw new Error('Shell workspace tab not found')
  await waitFor("!!document.querySelector('.terminal-lines')", 15000, 'eNCode shell')
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
