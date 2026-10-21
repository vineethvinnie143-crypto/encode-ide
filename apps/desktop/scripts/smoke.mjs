/**
 * End-to-end smoke test driven over the Chrome DevTools Protocol.
 *
 *   1. start Electron:  .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
 *   2. run:             node scripts/smoke.mjs <workspace-to-open>
 *
 * Exercises the hand-built editor (overlay integrity, save round-trip, find,
 * quick open), the offline demo agent, then a real streaming provider via
 * scripts/fake-provider.mjs including approvals, diffs and command execution.
 * Screenshots land in ./screenshots.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.ENCODE_DEBUG_PORT || '9222'
const providerPort = 8787
const demoPath = (process.argv[2] || path.join(root, '..', 'demo-project')).replace(/\\/g, '/')
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
 */
async function driveAgent(label, timeoutMs = 120000) {
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
      await click('.approval-card .btn.primary')
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

  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'tree after provider config')

  await typeInto('.composer-input', 'Create provider-check.txt, then run echo to verify the shell.')
  await sleep(350)
  await click('.composer-send')

  // Workspace Write: the write runs unasked, the command asks and the card shows the exact command.
  const approvals = await driveAgent('10-provider')
  console.log('[smoke] provider approvals:', JSON.stringify(approvals))
  if (approvals.length !== 1) throw new Error(`Expected 1 approval prompt (the command), saw ${approvals.length}`)
  if (!approvals[0].detail.includes('echo provider-command-ok')) {
    throw new Error('The command approval card does not show the command')
  }

  await evaluate(`(() => {
    document.querySelectorAll('.tool-row').forEach((row) => {
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

  const statsText = await evaluate("document.querySelector('.composer-stats')?.textContent ?? ''")
  console.log('[smoke] usage stats:', JSON.stringify(statsText.trim()))
  if (!statsText.includes('cache hit')) console.log('[smoke] note: no usage frame from provider')

  await screenshot('11-provider-agent.png')

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
  const approvals = await driveAgent('13-subagent')
  console.log('[smoke] subagent approvals:', JSON.stringify(approvals))
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
  await click('.composer-send.is-stop')
  await waitFor(
    "['idle', 'done'].includes(document.querySelector('.chat-panel')?.dataset.status ?? '') && !document.querySelector('.approval-card')",
    15000,
    'stop while the subagent waits',
  )
  const stopped = await evaluate('window.eNCode.agent.history().then((history) => history.status)')
  console.log('[smoke] subagent stop status:', stopped)
  if (stopped !== 'idle') throw new Error(`Stopping during a subagent approval left the agent ${stopped}`)

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

try {
  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor(
    "!!window.eNCode && !!document.querySelector('.menubar') && !!document.querySelector('.session-rail')",
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
  if (!(await click('.rail-nav button', 'Plugins'))) throw new Error('Plugins nav entry not found')
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
  console.log(
    '[smoke] shell output:',
    JSON.stringify((await evaluate("document.querySelector('.terminal-lines').textContent")).slice(-160)),
  )
  await screenshot('09-terminal.png')

  const freeModels = await evaluate(
    "window.eNCode.models.openRouter(true).then((list) => list.length, (error) => 'ERR: ' + error.message)",
  )
  console.log('[smoke] openrouter free models:', freeModels)
  if (typeof freeModels !== 'number' || freeModels < 1) throw new Error('OpenRouter model catalog unavailable')

  await runProviderPhase()

  await evaluate("window.eNCode.agent.reset()")
  await evaluate("window.eNCode.settings.save({ activeProfileId: 'demo', policy: 'workspace-write' })")
  await send('Page.reload')
  await waitFor("document.querySelectorAll('.tree-row').length > 0", 30000, 'final reload')
  await screenshot('12-final.png')

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
