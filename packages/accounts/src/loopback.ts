import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AccountsError } from './errors'

/**
 * The one-shot local listener that OpenRouter's authorization page returns the
 * browser to. It binds to loopback only, on a port the system picks, answers
 * a single valid callback, and shuts down. Anything else that reaches it (a
 * stray request, a page probing localhost, a wrong state) is refused without
 * ending the wait.
 */

export interface CallbackListener {
  /** The `callback_url` to give OpenRouter: `http://localhost:<port>/callback`. */
  readonly url: string
  /** The authorization code, once the browser comes back with the right state. */
  readonly code: Promise<string>
  /** Tells the browser how the exchange went, then shuts the listener down. */
  finish(outcome: 'connected' | 'failed'): void
  /** Gives up: `code` rejects with `cancelled` and the listener shuts down at once. */
  cancel(): void
}

export interface ListenOptions {
  /** The random value sent as `state`; the callback must return it. */
  state: string
  /** How long to wait for the user before giving up. */
  timeoutMs: number
  signal?: AbortSignal
  /** Name shown on the page the browser lands on. */
  productName?: string
}

/** Printable ASCII without spaces, as a code in a query string is. */
const CODE = /^[\x21-\x7e]{8,512}$/
/** The browser should be sent to its final page quickly; this only bounds a hung exchange. */
const HOLD_MS = 45_000
const LINGER_MS = 5_000

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0e0e10;color:#ece9e2}
main{max-width:26rem;padding:2rem;text-align:center}
h1{margin:0 0 .5rem;font-size:1.1rem;font-weight:600;letter-spacing:.01em}
p{margin:0;color:#98948b}
@media (prefers-color-scheme:light){body{background:#f5f3ee;color:#1b1a17}p{color:#6a665d}}
</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
`
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

export async function listenForCallback(options: ListenOptions): Promise<CallbackListener> {
  const product = options.productName ?? 'eNCode'
  let port = 0
  let accepted = false
  let finished = false
  let held: http.ServerResponse | null = null
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: AccountsError) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // The caller may only look at `code` later; a rejection must not escape before then.
  code.catch(() => undefined)
  const timers: NodeJS.Timeout[] = []

  const send = (response: http.ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    response.writeHead(status, { ...HEADERS, ...extra })
    response.end(html)
  }

  const route = (request: http.IncomingMessage, response: http.ServerResponse) => {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
    // A page that makes the browser resolve its own name to 127.0.0.1 would send another Host.
    if (!hosts.includes(request.headers.host ?? '')) return send(response, 400, page('Not found', 'This address is not served here.'))
    if (request.method !== 'GET') return send(response, 405, page('Not allowed', 'This address only answers GET.'), { allow: 'GET' })
    const url = new URL(request.url ?? '/', `http://localhost:${port}`)
    switch (url.pathname) {
      case '/callback': {
        const state = url.searchParams.get('state')
        const authorization = url.searchParams.get('code')
        if (accepted || !state || !equal(state, options.state)) return send(response, 400, page('Link not valid', `Start again from ${product}.`))
        if (url.searchParams.get('error')) {
          accepted = true
          send(response, 303, '', { location: '/failed' })
          rejectCode(new AccountsError('denied', 'Access was declined on OpenRouter.'))
          return void linger()
        }
        if (!authorization || !CODE.test(authorization)) return send(response, 400, page('Link not valid', `Start again from ${product}.`))
        accepted = true
        // The browser waits here until the exchange is done, then lands on the page that says how it went.
        held = response
        timers.push(setTimeout(() => finish('failed'), HOLD_MS).unref())
        resolveCode(authorization)
        return
      }
      case '/connected':
        send(response, 200, page(`${product} is connected`, 'You can close this tab and go back to the app.'))
        return void lingerBriefly()
      case '/failed':
        send(response, 200, page('Not connected', `Go back to ${product} and try again.`))
        return void lingerBriefly()
      default:
        return send(response, 404, page('Not found', 'This address is not served here.'))
    }
  }

  const handle = (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      route(request, response)
    } catch {
      // A malformed request line must not take the app down with it.
      if (!response.headersSent) send(response, 400, page('Not valid', 'This request could not be read.'))
      else response.destroy()
    }
  }

  const servers: http.Server[] = [http.createServer(handle)]
  const close = () => {
    if (finished) return
    finished = true
    for (const timer of timers) clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    held?.destroy()
    held = null
    for (const server of servers) {
      server.close()
      server.closeAllConnections()
    }
  }
  const finish = (outcome: 'connected' | 'failed') => {
    const response = held
    held = null
    if (response && !response.destroyed) send(response, 303, '', { location: outcome === 'connected' ? '/connected' : '/failed' })
    // The final page is fetched next; the listener stays up just long enough to serve it.
    linger()
  }
  const linger = () => {
    if (!finished) timers.push(setTimeout(close, LINGER_MS).unref())
  }
  const lingerBriefly = () => void timers.push(setTimeout(close, 300).unref())
  const cancel = () => {
    rejectCode(new AccountsError('cancelled', 'Connecting to OpenRouter was cancelled.'))
    close()
  }

  try {
    port = await listen(servers[0], '127.0.0.1', 0)
  } catch (error) {
    throw new AccountsError('listen_failed', 'eNCode could not open a local port for OpenRouter to return to.', { cause: error })
  }
  // Browsers resolve "localhost" to ::1 first on many systems, so answer there too when the machine has IPv6.
  const v6 = http.createServer(handle)
  try {
    await listen(v6, '::1', port)
    servers.push(v6)
  } catch {
    v6.close()
  }

  timers.push(
    setTimeout(() => {
      // Once the code is in, the exchange (with its own deadline) decides how this ends.
      if (accepted) return
      rejectCode(new AccountsError('timeout', 'OpenRouter was not approved in time. Start again.'))
      close()
    }, options.timeoutMs).unref(),
  )
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })

  return { url: `http://localhost:${port}/callback`, code, finish, cancel }
}
