import { randomBytes } from 'node:crypto'
import { errorAction, GatewayPaths, type AccountInfo, type DeviceStartResponse, type MeResponse, type StatusResponse } from '@encode/gateway-protocol'
import { AccountsError, isAccountsError } from './errors'
import { failureOf, GatewayHttp, type Reply } from './http'
import { clamp, object, readQuota, readSession, readStart, readStatus } from './readers'
import { parseSession, readAccount, serializeSession, StoreKeys, type SecretStore, type StoredSession } from './store'

/** What the sign-in screen and the account menu show. */
export type AccountState =
  /** `restore()` has not finished yet. */
  | { status: 'loading' }
  /** `ended` is set when the gateway, not the user, ended the session. */
  | { status: 'signed_out'; ended?: { code: 'session_ended' | 'refused'; message: string } }
  /** The user is at GitHub with this code. */
  | { status: 'signing_in'; userCode: string; verificationUri: string; expiresAt: number }
  /** `persisted` is false when the store refused the session, so the user must sign in again after a restart. */
  | { status: 'signed_in'; account: AccountInfo; persisted: boolean }

export interface AccountsOptions {
  /** The gateway's base URL. It must be https, except for a loopback address while developing. */
  gatewayUrl: string
  /** Where the session lives between launches; the desktop app passes its keychain-backed vault. */
  store: SecretStore
  /** Sent as `x-encode-client`, for example `{ app: 'desktop', version: '0.1.0' }`. */
  client: { app: string; version: string }
  fetch?: typeof fetch
  now?: () => number
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Milliseconds a gateway request may take. Default 15 000. */
  requestTimeoutMs?: number
  /** Refresh this long before the access token expires. Default 120 000. */
  refreshMarginMs?: number
  /** Hosts a verification link may point to. Default `github.com` only. */
  verificationHosts?: readonly string[]
}

export interface SignInFlow {
  /** Show this to the user, who types it at `verificationUri`. */
  readonly userCode: string
  /** Always https, on a host from `verificationHosts`. */
  readonly verificationUri: string
  /** Epoch milliseconds when the code stops working. */
  readonly expiresAt: number
  /** Settles with the account once the user approves, and rejects with an AccountsError when they decline, run out of time or cancel. */
  readonly result: Promise<AccountInfo>
  cancel(): void
}

export interface AccessTokenOptions {
  /** A token the gateway just rejected with 401. It is never handed out again; a newer one is returned, refreshing if need be. */
  rejected?: string
  signal?: AbortSignal
}

const DEVICE_ID = /^[A-Za-z0-9_-]{32,128}$/
/** A poll that fails this many times in a row ends the sign-in, so a dead network does not spin until the code expires. */
const MAX_POLL_FAILURES = 8
const LOGOUT_TIMEOUT_MS = 5_000

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** A base URL without a trailing slash, or an error for one that would send tokens in clear text. */
function normalizeGatewayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`gatewayUrl is not a URL: ${value}`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('gatewayUrl must be https, or http on a loopback address.')
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('gatewayUrl must not carry credentials, a query or a fragment.')
  return url.href.replace(/\/+$/, '')
}

/** Lets one caller stop waiting on shared work without stopping it for the others. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new AccountsError('cancelled', 'Cancelled.'))
    if (signal.aborted) return cancelled()
    signal.addEventListener('abort', cancelled, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', cancelled)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancelled)
        reject(error)
      },
    )
  })
}

/** Whether `candidate` is a later state of the same sign-in than `base`, or a newer sign-in. */
function newer(candidate: StoredSession, base: StoredSession): boolean {
  if (candidate.signedInAt !== base.signedInAt) return candidate.signedInAt > base.signedInAt
  return candidate.accessExpiresAt > base.accessExpiresAt
}

/**
 * The app's side of eNCode accounts: GitHub sign-in through the gateway (the
 * app never sees a GitHub token), a session that renews itself, and the
 * bearer token the model router attaches to free-tier requests.
 *
 * The router needs one thing from here:
 *
 *   const token = await accounts.accessToken()
 *   // on a 401 from the gateway:
 *   const next = await accounts.accessToken({ rejected: token })
 *
 * Refreshes are single-flight, so any number of agents asking at once cause
 * one request. Refresh tokens rotate, and the gateway ends the session of one
 * that is replayed after its grace window. The new session is therefore
 * written to the store before its token is used, and a refresh that loses a
 * race with another process sharing the store adopts that process's result
 * instead of replaying the old token.
 */
export class Accounts {
  private readonly http: GatewayHttp
  private readonly store: SecretStore
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly refreshMarginMs: number
  private readonly verificationHosts: readonly string[]
  private readonly listeners = new Set<(state: AccountState) => void>()
  private current: AccountState = { status: 'loading' }
  private session: StoredSession | null = null
  private persisted = true
  private device: Promise<string> | null = null
  private restoring: Promise<void> | null = null
  private refreshing: Promise<StoredSession> | null = null
  private flow: AbortController | null = null
  private readonly background = new Set<Promise<void>>()

  constructor(options: AccountsOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
    this.refreshMarginMs = options.refreshMarginMs ?? 120_000
    this.verificationHosts = options.verificationHosts ?? ['github.com']
    this.http = new GatewayHttp({
      baseUrl: normalizeGatewayUrl(options.gatewayUrl),
      fetch: options.fetch ?? fetch,
      client: options.client,
      timeoutMs: options.requestTimeoutMs ?? 15_000,
    })
  }

  get state(): AccountState {
    return this.current
  }

  /** The signed-in account, or null. */
  get account(): AccountInfo | null {
    return this.session?.account ?? null
  }

  /** Calls `listener` on every change. Returns the function that stops it. */
  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Loads the saved session. Every other method waits for it, so calling it at start-up is optional but makes `state` accurate sooner. */
  restore(): Promise<AccountState> {
    this.restoring ??= this.load()
    return this.restoring.then(() => this.current)
  }

  /**
   * Starts GitHub's device flow through the gateway. Show `userCode` and open
   * `verificationUri`; `result` settles when the user finishes. Starting
   * another sign-in cancels the one in progress.
   */
  async beginSignIn(options: { signal?: AbortSignal } = {}): Promise<SignInFlow> {
    await this.restore()
    this.flow?.abort()
    const controller = new AbortController()
    this.flow = controller
    const cancel = () => controller.abort()
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const release = () => {
      options.signal?.removeEventListener('abort', cancel)
      if (this.flow === controller) this.flow = null
    }
    try {
      const deviceId = await this.deviceId()
      const reply = await this.http.send(GatewayPaths.deviceStart, { body: { device_id: deviceId }, signal: controller.signal })
      if (!reply.ok) throw failureOf(reply)
      const start = readStart(reply.body, this.verificationHosts)
      const expiresAt = this.now() + start.expires_in * 1000
      this.setState({ status: 'signing_in', userCode: start.user_code, verificationUri: start.verification_uri, expiresAt })
      const result = this.poll(start, deviceId, expiresAt, controller.signal).finally(() => {
        const mine = this.flow === controller
        release()
        // Only the newest flow puts the state back; a replaced one leaves it to its successor.
        if (mine && this.current.status === 'signing_in') this.setState(this.settledState())
      })
      // The caller may attach its handlers later; a rejection must not escape before then.
      result.catch(() => undefined)
      return { userCode: start.user_code, verificationUri: start.verification_uri, expiresAt, result, cancel }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * A bearer token for the gateway that is good for at least the refresh
   * margin. Throws `signed_out` when there is no session, `session_ended` when
   * the gateway ended it (the saved session is then removed), and `network`,
   * `unavailable` or `rate_limited` when the gateway cannot be reached right
   * now, in which case the session is kept and a later call tries again.
   */
  async accessToken(options: AccessTokenOptions = {}): Promise<string> {
    await this.restore()
    const session = this.session
    if (!session) throw new AccountsError('signed_out', 'Sign in to use the eNCode free tier.')
    const usable = session.accessToken !== options.rejected && session.accessExpiresAt - this.now() > this.refreshMarginMs
    if (usable) return session.accessToken
    return (await abortable(this.refresh(), options.signal)).accessToken
  }

  /** Signs out on this device: the saved session goes first, then the gateway is told, on a short deadline. */
  async signOut(): Promise<void> {
    await this.restore()
    const session = this.session
    this.flow?.abort()
    await this.drop()
    this.setState({ status: 'signed_out' })
    if (session) await this.revoke(session)
  }

  /** The account and today's quota, for the account menu. */
  async me(signal?: AbortSignal): Promise<MeResponse> {
    const body = object(await this.authorized(GatewayPaths.me, signal))
    const account = readAccount(body?.account)
    const quota = readQuota(body?.quota)
    if (!account || !quota) throw new AccountsError('invalid_response', 'The gateway sent an account summary this version of eNCode cannot read.')
    return { account, quota }
  }

  /** Whether the free tier is available right now, and what to tell the user if it is not. Needs no sign-in. */
  async status(signal?: AbortSignal): Promise<StatusResponse> {
    const reply = await this.http.send(GatewayPaths.status, { signal })
    if (!reply.ok) throw failureOf(reply)
    const status = readStatus(reply.body)
    if (!status) throw new AccountsError('invalid_response', 'That address did not answer like an eNCode gateway.')
    return status
  }

  /** Waits for work that was started and not awaited: ending a replaced session on the gateway. Await it before the app quits. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background])
  }

  /** Cancels a sign-in in progress and drops the listeners. Call it when the app quits. */
  dispose(): void {
    this.flow?.abort()
    this.listeners.clear()
  }

  // Loading and saving.

  private async load(): Promise<void> {
    let text: string | undefined
    try {
      text = await this.store.get(StoreKeys.session)
    } catch {
      text = undefined
    }
    const session = parseSession(text)
    if (text && !session) await this.forget()
    if (session && session.refreshExpiresAt <= this.now()) {
      await this.forget()
      this.setState({ status: 'signed_out', ended: { code: 'session_ended', message: 'Your eNCode session expired. Sign in again.' } })
      return
    }
    this.session = session
    this.setState(session ? { status: 'signed_in', account: session.account, persisted: true } : { status: 'signed_out' })
  }

  private async readStored(): Promise<StoredSession | null> {
    try {
      return parseSession(await this.store.get(StoreKeys.session))
    } catch {
      return null
    }
  }

  private async forget(): Promise<void> {
    try {
      await this.store.delete(StoreKeys.session)
    } catch {
      // Nothing more can be done about a store that will not delete.
    }
  }

  /** Writes the session to the store. A store that refuses does not stop the session working for this run. */
  private async save(session: StoredSession): Promise<void> {
    try {
      await this.store.set(StoreKeys.session, serializeSession(session))
      this.persisted = true
    } catch {
      this.persisted = false
    }
  }

  private async drop(): Promise<void> {
    this.session = null
    await this.forget()
  }

  private deviceId(): Promise<string> {
    this.device ??= this.loadDeviceId()
    return this.device
  }

  private async loadDeviceId(): Promise<string> {
    let stored: string | undefined
    try {
      stored = await this.store.get(StoreKeys.device)
    } catch {
      stored = undefined
    }
    if (stored && DEVICE_ID.test(stored)) return stored
    const fresh = randomBytes(32).toString('base64url')
    try {
      await this.store.set(StoreKeys.device, fresh)
    } catch {
      // The id then lasts for this run; a restart signs in again anyway, because the session could not be kept either.
    }
    return fresh
  }

  private setState(next: AccountState): void {
    this.current = next
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private settledState(): AccountState {
    return this.session ? { status: 'signed_in', account: this.session.account, persisted: this.persisted } : { status: 'signed_out' }
  }

  /** Ends the session because the gateway said so, and tells the listeners why. */
  private async end(error: AccountsError): Promise<AccountsError> {
    await this.drop()
    this.setState({ status: 'signed_out', ended: { code: error.code === 'refused' ? 'refused' : 'session_ended', message: error.message } })
    return error
  }

  /** Tells the gateway to end a session, once. Being offline must not keep anyone signed in, so failures are ignored. */
  private async revoke(session: StoredSession): Promise<void> {
    try {
      await this.http.send(GatewayPaths.logout, {
        body: { refresh_token: session.refreshToken, device_id: await this.deviceId() },
        timeoutMs: LOGOUT_TIMEOUT_MS,
      })
    } catch {
      // The session expires on its own.
    }
  }

  private later(work: Promise<void>): void {
    this.background.add(work)
    void work.finally(() => this.background.delete(work))
  }

  // Sign-in.

  /** Polls until the user finishes, at the pace the gateway (and so GitHub) asks for. */
  private async poll(start: DeviceStartResponse, deviceId: string, expiresAt: number, signal: AbortSignal): Promise<AccountInfo> {
    let seconds = start.interval
    let failures = 0
    for (;;) {
      await this.sleep(seconds * 1000, signal)
      if (signal.aborted) throw new AccountsError('cancelled', 'Sign-in cancelled.')
      if (this.now() >= expiresAt) throw new AccountsError('expired', 'The sign-in code expired. Start again.')
      let reply: Reply
      try {
        reply = await this.http.send(GatewayPaths.devicePoll, { body: { device_code: start.device_code, device_id: deviceId }, signal })
      } catch (error) {
        if (!isAccountsError(error) || error.code !== 'network' || ++failures >= MAX_POLL_FAILURES) throw error
        continue
      }
      if (!reply.ok) {
        const error = failureOf(reply)
        // Rate limits and gateway hiccups are waited out; a refusal of this account is final.
        if ((error.code !== 'rate_limited' && error.code !== 'unavailable') || ++failures >= MAX_POLL_FAILURES) throw error
        seconds = Math.max(seconds, Math.ceil((error.retryAfterMs ?? 0) / 1000))
        continue
      }
      failures = 0
      const body = object(reply.body)
      switch (body?.status) {
        case 'pending':
        case 'slow_down':
          if (typeof body.interval === 'number' && Number.isFinite(body.interval)) seconds = clamp(body.interval, 1, 60)
          continue
        case 'denied':
          throw new AccountsError('denied', 'Sign-in was declined on GitHub.')
        case 'expired':
          throw new AccountsError('expired', 'The sign-in code expired. Start again.')
        case 'complete':
          return this.complete(reply.body)
        default:
          throw new AccountsError('invalid_response', 'The gateway answered a sign-in poll in a way this version of eNCode cannot read.')
      }
    }
  }

  private async complete(body: unknown): Promise<AccountInfo> {
    const session = readSession(body, this.now())
    const previous = this.session
    this.session = session
    await this.save(session)
    this.setState({ status: 'signed_in', account: session.account, persisted: this.persisted })
    if (previous) this.later(this.revoke(previous))
    return session.account
  }

  // Refresh.

  private refresh(): Promise<StoredSession> {
    this.refreshing ??= this.rotate().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * Trades the refresh token for a new session. The store is read first: a
   * second process sharing it may have rotated the token already, and
   * replaying the old one would end the session for both.
   */
  private async rotate(): Promise<StoredSession> {
    for (let attempt = 0; ; attempt++) {
      let session = this.session
      if (!session) throw new AccountsError('signed_out', 'Sign in to use the eNCode free tier.')
      const stored = await this.readStored()
      if (stored && stored.refreshToken !== session.refreshToken && newer(stored, session)) {
        session = stored
        this.session = stored
        this.setState({ status: 'signed_in', account: stored.account, persisted: this.persisted })
        if (stored.accessExpiresAt - this.now() > this.refreshMarginMs) return stored
      }
      if (session.refreshExpiresAt <= this.now()) {
        throw await this.end(new AccountsError('session_ended', 'Your eNCode session expired. Sign in again.'))
      }

      const reply = await this.http.send(GatewayPaths.refresh, { body: { refresh_token: session.refreshToken, device_id: await this.deviceId() } })
      if (reply.ok) {
        const next = readSession(reply.body, this.now())
        // The old token is spent the moment the gateway answers, so the new one is stored before anything uses it.
        this.session = { ...next, signedInAt: session.signedInAt }
        await this.save(this.session)
        this.setState({ status: 'signed_in', account: next.account, persisted: this.persisted })
        return this.session
      }

      const error = failureOf(reply)
      const action = reply.detail ? errorAction(reply.detail.code) : undefined
      const gone = action === 'sign_in' || action === 'refresh'
      if (gone && attempt === 0) {
        // Lost a race: the store holds a newer refresh token than the one just refused.
        const latest = await this.readStored()
        if (latest && latest.refreshToken !== session.refreshToken) {
          this.session = latest
          continue
        }
      }
      if (gone) throw await this.end(new AccountsError('session_ended', error.message, { status: error.status, ...(error.gatewayCode ? { gatewayCode: error.gatewayCode } : {}) }))
      if (error.code === 'refused') throw await this.end(error)
      throw error
    }
  }

  /** A GET with the bearer token that renews the session once if the gateway rejects it. */
  private async authorized(path: string, signal?: AbortSignal): Promise<unknown> {
    let token = await this.accessToken({ signal })
    for (let attempt = 0; ; attempt++) {
      const reply = await this.http.send(path, { token, signal })
      if (reply.ok) return reply.body
      const action = reply.detail ? errorAction(reply.detail.code) : undefined
      // A suspension revokes the session on the gateway, so nothing is left to keep here.
      if (reply.detail?.code === 'account_suspended') throw await this.end(failureOf(reply))
      if (action !== 'refresh' && action !== 'sign_in') throw failureOf(reply)
      if (attempt > 0) throw await this.end(failureOf(reply))
      token = await this.accessToken({ rejected: token, signal })
    }
  }
}
