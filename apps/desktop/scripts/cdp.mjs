/**
 * A small Chrome DevTools Protocol client for the scripts that drive the running app (smoke.mjs,
 * packaged-smoke.mjs): find the app's page on the DevTools port, send commands, evaluate expressions,
 * and collect what the page reports as errors.
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isAppPage = (target) => target.type === 'page' && (target.url.startsWith('app://') || target.url.includes('localhost:'))

/** The DevTools target of the app's window, once Electron is up and the page has loaded. */
export async function findPage(port, { attempts = 120, accept = isAppPage } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => accept(target) && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* electron not up yet */
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for the Electron page target on port ${port}`)
}

/**
 * Connects to the page. `errors` collects uncaught exceptions and console errors for the whole run;
 * `evaluate` runs an expression in the page (awaiting a promise) and returns its value.
 */
export async function connect(port, options) {
  const target = await findPage(port, options)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const errors = []
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
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed'
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

  return { target, ws, send, evaluate, waitFor, errors }
}
