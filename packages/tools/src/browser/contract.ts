/**
 * What the Browser tool asks of the browser it drives, and what comes back. The desktop app serves it from a Browser
 * tab of the agent's own (ADR 0103): a page in a partition of its own, kept in memory, shared with none of the
 * person's tabs. Every request and answer is plain data, since it crosses from the agent host to the main process.
 */

/** An element of the page the model can act on, by ref (e12), as the latest look listed it. */
export interface BrowserElement {
  ref: string
  role: string
  name: string
  value?: string
  /** checked, disabled, expanded, focused, required, selected. */
  states?: string[]
}

export interface ConsoleLine {
  level: 'error' | 'warning' | 'info' | 'log'
  text: string
  /** The script and line it came from, when the page says. */
  source?: string
}

/** The page as it stands after a step. */
export interface BrowserPage {
  url: string
  title: string
  /** The HTTP status of the page's last load; 0 when it did not load. */
  status: number
  /** Why the page did not load, in words. */
  error?: string
  elements: BrowserElement[]
  /** Elements the outline left out, for the model to scroll or look again. */
  more: number
  /** The page's visible text, cut to a few thousand characters. */
  text: string
  /** Console errors and warnings since the last answer, and the page's own logs when asked for. */
  console: ConsoleLine[]
  /** What the page did on its own that was held back: a link or redirect to a host the agent did not open. */
  held?: string
  /**
   * The page as a picture, only when asked for one. Its pixels are the page's own (CSS pixels), so a coordinate read
   * off it is one to click; a page wider than the picture gives the picture's size over the page's as `scale`.
   */
  image?: { mediaType: 'image/jpeg' | 'image/png'; data: string; width: number; height: number; scale?: number }
}

export type BrowserStep =
  | { type: 'open'; url: string }
  | { type: 'look' }
  | { type: 'click'; ref?: string; x?: number; y?: number; double?: boolean }
  | { type: 'type'; ref?: string; text: string; submit?: boolean }
  | { type: 'key'; key: string }
  | { type: 'scroll'; ref?: string; direction: 'up' | 'down'; amount?: number }
  | { type: 'select'; ref: string; value: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'wait'; text?: string; ms?: number }
  | { type: 'console' }
  | { type: 'close' }

export interface BrowserRequest {
  step: BrowserStep
  /** Send a picture of the page with the answer (only for a model that reads images). */
  image: boolean
}

export type BrowserErrorCode =
  /** There is no page yet: open one first. */
  | 'no-page'
  /** The ref is not on the page any more. */
  | 'stale-ref'
  /** The field takes a password: the agent never types one. */
  | 'password'
  | 'timeout'
  /** The address is not one the browser opens (not http or https). */
  | 'refused'
  /** eNCode's window is closed or has no Browser to show. */
  | 'unavailable'
  | 'failed'

export type BrowserAnswer = { ok: true; page: BrowserPage | null } | { ok: false; code: BrowserErrorCode; message: string; page?: BrowserPage }

export interface BrowserBackend {
  call(request: BrowserRequest, signal: AbortSignal): Promise<BrowserAnswer>
  /** The session lets go: its tab closes. */
  dispose(): Promise<void>
}

/** True for this computer's own addresses: a dev server the agent opens without asking. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name)
}

/** The address the model gave, as the browser opens it: a bare host gets http for this computer and https otherwise. */
export function browserUrl(raw: string): URL | string {
  const text = raw.trim()
  if (!text) return 'Give the address to open.'
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^(localhost|[\w.-]+):\d+/i.test(text) ? text : `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return `${text.slice(0, 80)} is not an address.`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `The browser opens http and https addresses, not ${url.protocol.replace(/:$/, '')}.`
  if (url.username || url.password) return 'An address with a user name or password in it is not opened.'
  return url
}

export const REF_PATTERN = /^e\d{1,5}$/
export const KEY_PATTERN = /^(Enter|Escape|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F5|(Control|Shift|Alt)\+[A-Za-z0-9])$/
const MAX_TYPED = 10_000

/**
 * A request as the main process takes it from the agent host: the host is another process, so what it sends is checked
 * again, field by field, and anything else is dropped. Null when it is not a request the browser serves.
 */
export function parseBrowserRequest(value: unknown): BrowserRequest | null {
  if (!value || typeof value !== 'object') return null
  const { step, image } = value as { step?: unknown; image?: unknown }
  if (!step || typeof step !== 'object' || typeof image !== 'boolean') return null
  const raw = step as Record<string, unknown>
  const text = (field: string, max: number) => (typeof raw[field] === 'string' && (raw[field] as string).length <= max ? (raw[field] as string) : undefined)
  const ref = raw.ref === undefined ? undefined : typeof raw.ref === 'string' && REF_PATTERN.test(raw.ref) ? raw.ref : null
  if (ref === null) return null
  const number = (field: string, min: number, max: number) => (typeof raw[field] === 'number' && Number.isFinite(raw[field]) ? Math.min(Math.max(raw[field] as number, min), max) : undefined)
  const withRef = ref ? { ref } : {}
  let parsed: BrowserStep | null = null
  switch (raw.type) {
    case 'open': {
      const url = browserUrl(text('url', 4_096) ?? '')
      parsed = typeof url === 'string' ? null : { type: 'open', url: url.href }
      break
    }
    case 'click': {
      const x = number('x', 0, 20_000)
      const y = number('y', 0, 20_000)
      const point = !ref && x !== undefined && y !== undefined ? { x, y } : {}
      parsed = ref || 'x' in point ? { type: 'click', ...withRef, ...point, ...(raw.double === true ? { double: true } : {}) } : null
      break
    }
    case 'type': {
      const typed = text('text', MAX_TYPED)
      parsed = typed === undefined ? null : { type: 'type', ...withRef, text: typed, ...(raw.submit === true ? { submit: true } : {}) }
      break
    }
    case 'key': {
      const key = text('key', 40)
      parsed = key && KEY_PATTERN.test(key) ? { type: 'key', key } : null
      break
    }
    case 'scroll': {
      const amount = number('amount', 0.25, 10)
      parsed = raw.direction === 'up' || raw.direction === 'down' ? { type: 'scroll', ...withRef, direction: raw.direction, ...(amount ? { amount } : {}) } : null
      break
    }
    case 'select': {
      const choice = text('value', 500)
      parsed = ref && choice !== undefined ? { type: 'select', ref, value: choice } : null
      break
    }
    case 'wait': {
      const waitFor = text('text', 500)
      const ms = number('ms', 0, 10_000)
      parsed = waitFor || ms !== undefined ? { type: 'wait', ...(waitFor ? { text: waitFor } : {}), ...(ms !== undefined ? { ms } : {}) } : null
      break
    }
    case 'look':
    case 'back':
    case 'forward':
    case 'reload':
    case 'console':
    case 'close':
      parsed = { type: raw.type }
      break
  }
  return parsed ? { step: parsed, image } : null
}
