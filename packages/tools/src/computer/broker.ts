/**
 * One desktop, many sessions. Two chats driving the same mouse would each read the other's input as the
 * user's and click where the other one meant to, so a session holds the desktop while it sends input and
 * the others are told to wait. Looking (windows, screenshots, the cursor) takes no hold: it changes
 * nothing. A session lets go when it has not sent input for `idleMs`, when the user stops it, and when it
 * closes. The hold changes hands only between calls: a call that is running is never cut off.
 */
import { DEFAULT_DESKTOP_OPTIONS, DesktopError, type DesktopBackend, type DesktopOptions } from './contract'
import { ComputerState, type DesktopServices } from './state'

/** How long a session keeps the desktop after its last input. */
export const DESKTOP_IDLE_MS = 30_000

export interface DesktopBroker {
  /** What one session uses: the shared backend as that session sees it, and a state of its own. */
  open(sessionId: string): DesktopServices
  /** The session that holds the desktop now, if any. */
  holder(): string | undefined
  /** Stops the backend. Views that sessions still hold refuse every call afterwards. */
  dispose(): Promise<void>
}

export interface DesktopBrokerOptions {
  options?: Partial<DesktopOptions>
  idleMs?: number
  now?: () => number
}

export function createDesktopBroker(backend: DesktopBackend, config: DesktopBrokerOptions = {}): DesktopBroker {
  const idleMs = config.idleMs ?? DESKTOP_IDLE_MS
  const clock = config.now ?? Date.now
  const options: DesktopOptions = { ...DEFAULT_DESKTOP_OPTIONS, ...config.options }

  let owner: string | undefined
  let running = 0
  let last = 0
  let leaving = false
  let closed = false

  const alive = (): void => {
    if (closed) throw new DesktopError('unavailable', 'Desktop control has been shut down.')
  }

  const take = (id: string): void => {
    alive()
    const now = clock()
    if (owner !== undefined && owner !== id && (running > 0 || now - last < idleMs)) {
      throw new DesktopError('busy', 'Another chat is using the desktop right now, so nothing was done.')
    }
    if (owner !== id) {
      owner = id
      running = 0
    }
    leaving = false
    running++
    last = now
  }

  const done = (id: string): void => {
    if (owner !== id) return
    running = Math.max(0, running - 1)
    last = clock()
    if (leaving && running === 0) owner = undefined
  }

  const release = (id: string): void => {
    if (owner !== id) return
    if (running === 0) owner = undefined
    else leaving = true
  }

  const view = (id: string): DesktopBackend => {
    const holding = async <T>(work: () => Promise<T>): Promise<T> => {
      take(id)
      try {
        return await work()
      } finally {
        done(id)
      }
    }
    const looking = async <T>(work: () => Promise<T>): Promise<T> => {
      alive()
      return work()
    }
    return {
      ready: (signal) => looking(() => backend.ready(signal)),
      windows: (signal) => looking(() => backend.windows(signal)),
      look: (request, signal) => looking(() => backend.look(request, signal)),
      cursor: (signal) => looking(() => backend.cursor(signal)),
      apps: (signal) => looking(() => backend.apps(signal)),
      focus: (request, signal) => holding(() => backend.focus(request, signal)),
      act: (request, signal) => holding(() => backend.act(request, signal)),
      open: (request, signal) => holding(() => backend.open(request, signal)),
      // A session closing its view lets go of the desktop; the backend belongs to the broker.
      dispose: async () => release(id),
    }
  }

  return {
    open: (sessionId) => ({ backend: view(sessionId), state: new ComputerState(), options: { ...options } }),
    holder: () => owner,
    async dispose() {
      closed = true
      owner = undefined
      await backend.dispose()
    },
  }
}
