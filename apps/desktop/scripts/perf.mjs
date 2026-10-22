/**
 * Measures how smooth the interface is, over the Chrome DevTools Protocol, against the built app:
 *
 *   pnpm build && pnpm perf
 *
 * (scripts/e2e.mjs starts the app in a throwaway sandbox and runs this file against it.)
 *
 * It streams a long markdown answer (scripts/fake-provider.mjs, the `long-reply` scenario, about
 * 2,000 pieces at 300 a second) into a thread that gets longer each run, then scrolls that thread
 * and drags the side panel's edge, and prints for each how many frames the page drew and how long
 * the slow ones took. A frame budget is 16.7 ms at 60 Hz. Numbers from a machine without a GPU
 * (CI, a container) are slower than a PC's; compare runs of the same machine.
 *
 *   PERF_RUNS=5     long answers streamed one after another (default 4)
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.ENCODE_DEBUG_PORT || '9222'
const providerPort = Number(process.env.ENCODE_FAKE_PROVIDER_PORT || 8787)
const runs = Number(process.env.PERF_RUNS || 4)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!process.argv[2]) {
  console.error('usage: node scripts/perf.mjs <copy-of-test/fixtures/demo-project>  (pnpm perf does this)')
  process.exit(2)
}

async function findTarget() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page' && (target.url.startsWith('app://') || target.url.includes('localhost:')))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* electron not up yet */
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for the Electron page target on port ${port}`)
}

const target = await findTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let messageId = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.exception?.description ?? 'Unknown exception')
})

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed')
  return result.result?.value
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(expression)) return
    } catch {
      /* the page may be reloading */
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

let provider = null
async function ensureFakeProvider() {
  const up = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${providerPort}/health`)).ok
    } catch {
      return false
    }
  }
  if (await up()) return
  provider = spawn(process.execPath, [path.join(root, 'scripts', 'fake-provider.mjs')], {
    env: { ...process.env, FAKE_PROVIDER_PORT: String(providerPort) },
    stdio: 'ignore',
    windowsHide: true,
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await up()) return
    await sleep(250)
  }
  throw new Error('Fake provider failed to start')
}

// What the page records while a run is measured: the gap between animation frames, and tasks over 50 ms.
const SAMPLER = `(() => {
  if (window.__perf) return
  const state = { on: false, frames: [], tasks: [], last: performance.now() }
  const tick = (now) => {
    if (state.on) state.frames.push(now - state.last)
    state.last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((list) => {
      if (state.on) for (const entry of list.getEntries()) state.tasks.push(entry.duration)
    }).observe({ type: 'longtask' })
  } catch {
    /* long task timing is not available */
  }
  window.__perf = state
})()`

async function metrics() {
  const { metrics } = await send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]))
}

async function measure(label, action) {
  await evaluate('window.__perf.frames.length = 0; window.__perf.tasks.length = 0; window.__perf.on = true; true')
  const before = await metrics()
  const started = Date.now()
  await action()
  const seconds = (Date.now() - started) / 1000
  const after = await metrics()
  const { frames, tasks } = await evaluate('window.__perf.on = false, { frames: window.__perf.frames, tasks: window.__perf.tasks }')
  const sorted = [...frames].sort((a, b) => a - b)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  const per = (name) => ((after[name] - before[name]) * 1000) / seconds
  const row = {
    label,
    seconds: Number(seconds.toFixed(1)),
    frames: frames.length,
    fps: Number((frames.length / seconds).toFixed(1)),
    p50: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    p99: Number(at(0.99).toFixed(1)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    over33: frames.filter((gap) => gap > 33.4).length,
    longTasks: tasks.length,
    longTaskMs: Math.round(tasks.reduce((sum, duration) => sum + duration, 0)),
    scriptMsPerS: Math.round(per('ScriptDuration')),
    layoutMsPerS: Math.round(per('LayoutDuration')),
    styleMsPerS: Math.round(per('RecalcStyleDuration')),
    nodes: after.Nodes,
    heapMB: Math.round(after.JSHeapUsedSize / 1048576),
  }
  console.log(`[perf] ${JSON.stringify(row)}`)
  return row
}

async function typeAndSend(text) {
  await evaluate(`(() => {
    const input = document.querySelector('.composer-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(250)
  if (!(await evaluate("(() => { const send = document.querySelector('.composer-send'); send?.click(); return Boolean(send) })()"))) {
    throw new Error('The send button is not on screen')
  }
}

async function waitForDone(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  await sleep(300)
  let last = ''
  while (Date.now() < deadline) {
    const status = await evaluate("document.querySelector('.chat-panel')?.dataset.status ?? ''")
    if (status !== last) console.log(`[perf] status ${status || '(none)'} after ${Math.round((Date.now() - deadline + timeoutMs) / 100) / 10}s`)
    last = status
    if (status === 'done') return
    if (status === 'error') throw new Error(`The agent failed: ${await evaluate("[...document.querySelectorAll('.msg-error')].map((node) => node.textContent).join(' ')")}`)
    await sleep(100)
  }
  throw new Error('The agent did not finish')
}

/** A mouse wheel gesture at 60 events a second over the thread. */
async function wheel(x, y, deltaY, count) {
  for (let step = 0; step < count; step++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
    await sleep(16)
  }
}

async function drag(fromX, fromY, toX, steps) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 })
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + ((toX - fromX) * step) / steps, y: fromY, button: 'left', buttons: 1 })
    await sleep(8)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: fromY, button: 'left', clickCount: 1 })
}

await send('Runtime.enable')
await send('Performance.enable')
await send('Page.enable')
await ensureFakeProvider()
await waitFor("!!window.eNCode && !!document.querySelector('.icon-rail') && !!document.querySelector('.session-sidebar')", 30000, 'the app shell')
await evaluate(`window.eNCode.workspace.openPath(${JSON.stringify(path.resolve(process.argv[2]).replace(/\\/g, '/'))})`)

const current = await evaluate('window.eNCode.settings.get()')
const profiles = current.profiles.filter((profile) => profile.id !== 'local-mock')
profiles.push({ id: 'local-mock', name: 'Local mock provider', kind: 'custom', baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: 'mock-model' })
await evaluate(`window.eNCode.settings.save({ profiles: ${JSON.stringify(profiles)}, activeProfileId: 'local-mock', policy: 'workspace-write', maxSteps: 12 })`)
await evaluate('window.eNCode.agent.reset()')
await send('Page.reload')
await waitFor("document.querySelector('.composer-input') !== null", 30000, 'the composer')
await evaluate(SAMPLER)

const rows = []
for (let run = 1; run <= runs; run++) {
  rows.push(
    await measure(`stream ${run} (thread of ${run - 1} long answers)`, async () => {
      await typeAndSend(`[scenario:long-reply] Review the code, answer ${run}.`)
      await waitForDone()
    }),
  )
}

// The answer was drawn piece by piece; it must be the answer, whole and in order, as if it had been drawn at once.
const answer = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.msg-assistant .markdown')]
  const last = nodes[nodes.length - 1]
  const count = (selector) => last.querySelectorAll(selector).length
  return {
    answers: nodes.length,
    blocks: last.children.length,
    h1: count('h1'), h2: count('h2'), tables: count('table'), code: count('.code-block'), quotes: count('blockquote'), lists: count('ul') + count('ol'),
    first: last.firstElementChild?.tagName, last: last.lastElementChild?.textContent,
  }
})()`)
const expected = { answers: runs, blocks: 1 + 8 * 7 + 2, h1: 1, h2: 9, tables: 8, code: 8, quotes: 8, lists: 16, first: 'H1', last: 'Eight parts, one idea: do the work once, and say so when you did not.' }
for (const [name, value] of Object.entries(expected)) {
  if (answer[name] !== value) throw new Error(`The streamed answer is wrong: ${name} is ${JSON.stringify(answer[name])}, expected ${JSON.stringify(value)}`)
}
console.log('[perf] the streamed answers are complete and in order')

const list = await evaluate(`(() => { const rect = document.querySelector('.chat-list').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
rows.push(
  await measure(`scroll the thread (${runs} long answers)`, async () => {
    await wheel(list.x, list.y, -400, 60)
    await wheel(list.x, list.y, 400, 60)
  }),
)

// The side panel's edge: open it from the rail, then drag it back and forth.
await evaluate("document.querySelector('.rail-btn[aria-label=\"Review\"]')?.click(); true")
await sleep(800)
const edge = await evaluate(`(() => {
  const resizers = [...document.querySelectorAll('.resizer-v')]
  const rect = resizers[resizers.length - 1]?.getBoundingClientRect()
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
})()`)
if (edge) {
  rows.push(
    await measure('drag the side panel edge', async () => {
      await drag(edge.x, edge.y, edge.x - 220, 40)
      await drag(edge.x - 220, edge.y, edge.x, 40)
    }),
  )
} else {
  console.log('[perf] the side panel has no edge to drag; skipped')
}

if (errors.length) {
  console.error(`[perf] renderer exceptions:\n${errors.join('\n')}`)
  provider?.kill()
  process.exit(1)
}
provider?.kill()
ws.close()
console.log('[perf] done')
process.exit(0)
