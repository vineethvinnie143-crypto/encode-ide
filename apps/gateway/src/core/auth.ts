import type { DevicePollResponse, DeviceStartResponse, MeResponse, SessionTokens } from '@encode/gateway-protocol'
import type { GatewayConfig } from './config'
import { GatewayError } from './errors'
import type { GitHubClient, GitHubUser } from './github'
import { bearerToken, json, readJson } from './http'
import type { Account, AccountStore, AddressLimiterPort, Logger, Session, UserQuotaPort } from './ports'
import { DAY, HOUR, MINUTE, SECOND } from './time'
import { TokenService, type AccessClaims } from './tokens'
import type { WindowRule } from './user-quota'

/**
 * Accounts and sessions. Sign-in is GitHub's device flow, proxied by the
 * gateway so the client never handles a GitHub token. A session is a family
 * of rotating refresh tokens bound to one device id: each refresh returns a
 * new token, the one before it is honored again only for a short grace window
 * (for a response lost in transit), and any later reuse ends the family.
 */

export interface AuthDeps {
  config: GatewayConfig
  tokens: TokenService
  accounts: AccountStore
  github: GitHubClient | null
  addresses: AddressLimiterPort
  users: UserQuotaPort
  log: Logger
  now: () => number
  newId: (prefix: string) => string
}

const AUTH_BODY_LIMIT = 4 * 1024
const DEVICE_ID = /^[A-Za-z0-9_-]{32,128}$/
const DEVICE_CODE = /^[A-Za-z0-9_-]{8,128}$/

function field(body: unknown, name: string, pattern: RegExp): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined
  if (typeof value !== 'string' || !pattern.test(value)) throw new GatewayError('invalid_request', `${name} is missing or malformed.`)
  return value
}

function invalidGrant(): GatewayError {
  return new GatewayError('invalid_grant', 'This session has ended. Sign in again.')
}

async function limitAddress(deps: AuthDeps, address: string, rule: WindowRule): Promise<void> {
  const bucket = await deps.tokens.ipBucket(address)
  const verdict = await deps.addresses.hit(bucket, [rule])
  if (!verdict.ok) throw new GatewayError('rate_limited', 'Too many sign-in requests from this network. Wait a little.', verdict.retryAfterMs)
}

function githubOrThrow(deps: AuthDeps): GitHubClient {
  if (!deps.github) throw new GatewayError('service_disabled', 'Sign-in is turned off on this gateway.')
  return deps.github
}

export async function authenticate(request: Request, deps: { tokens: TokenService; now: () => number }): Promise<AccessClaims> {
  const token = bearerToken(request)
  if (!token) throw new GatewayError('auth_required', 'Sign in to use the eNCode free tier.')
  return deps.tokens.verifyAccess(token, deps.now())
}

function publicAccount(account: Account): SessionTokens['account'] {
  return { id: account.id, login: account.login, ...(account.avatarUrl ? { avatar_url: account.avatarUrl } : {}) }
}

async function issueSession(deps: AuthDeps, account: Account, deviceId: string, client: string | null): Promise<SessionTokens> {
  const now = deps.now()
  const { tokens } = deps.config
  const refreshToken = deps.tokens.newRefreshToken()
  const expiresAt = now + tokens.sessionMaxSeconds * SECOND
  const session: Session = {
    id: deps.newId('ses'),
    accountId: account.id,
    deviceHash: await deps.tokens.hashDevice(deviceId),
    refreshHash: await deps.tokens.hashRefresh(refreshToken),
    previousHash: null,
    rotatedAt: null,
    createdAt: now,
    expiresAt,
    refreshExpiresAt: Math.min(expiresAt, now + tokens.refreshTtlSeconds * SECOND),
    lastUsedAt: now,
    revokedAt: null,
    revokedReason: null,
    client,
  }
  await deps.accounts.createSession(session)
  const access = await deps.tokens.issueAccess(account.id, session.id, now)
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: refreshToken,
    refresh_expires_in: Math.floor((session.refreshExpiresAt - now) / SECOND),
    account: publicAccount(account),
  }
}

export async function deviceStart(request: Request, deps: AuthDeps, address: string): Promise<Response> {
  const github = githubOrThrow(deps)
  const { value } = await readJson(request, AUTH_BODY_LIMIT)
  field(value, 'device_id', DEVICE_ID)
  await limitAddress(deps, address, { name: 'device_start', limit: deps.config.signIn.startsPerIpPerHour, windowMs: HOUR })
  const code = await github.startDeviceFlow()
  const body: DeviceStartResponse = {
    device_code: code.deviceCode,
    user_code: code.userCode,
    verification_uri: code.verificationUri,
    expires_in: code.expiresIn,
    interval: code.interval,
  }
  return json(body)
}

/** Who may get a new account. Existing accounts sign in unless suspended. */
async function admitNewAccount(deps: AuthDeps, user: GitHubUser): Promise<void> {
  const { signup } = deps.config
  if (signup.mode === 'closed') throw new GatewayError('signup_closed', 'The eNCode free tier is not taking new accounts right now.')
  // Logins from ALLOWED_GITHUB_LOGINS join the stored allowlist, so they too bind to the first GitHub user id that signs in with them.
  if (signup.allowedLogins.includes(user.login.toLowerCase())) await deps.accounts.allow(user.login, deps.now())
  const invited = await deps.accounts.allowlisted(user.login, user.id)
  if (signup.mode === 'allowlist' && !invited) {
    throw new GatewayError('signup_closed', 'The eNCode free tier is invite-only for now. Your own keys still work.')
  }
  // An invitation vouches for the person, so it waives the account-age rule meant for strangers.
  if (!invited && signup.minAccountAgeDays > 0) {
    const ageDays = user.createdAt === null ? 0 : (deps.now() - user.createdAt) / DAY
    if (ageDays < signup.minAccountAgeDays) {
      throw new GatewayError(
        'account_not_eligible',
        `The free tier needs a GitHub account at least ${signup.minAccountAgeDays} days old. Your own keys still work.`,
      )
    }
  }
}

export async function devicePoll(request: Request, deps: AuthDeps, address: string, client: string | null): Promise<Response> {
  const github = githubOrThrow(deps)
  const { value } = await readJson(request, AUTH_BODY_LIMIT)
  const deviceCode = field(value, 'device_code', DEVICE_CODE)
  const deviceId = field(value, 'device_id', DEVICE_ID)
  await limitAddress(deps, address, { name: 'device_poll', limit: deps.config.signIn.pollsPerIpPerMinute, windowMs: MINUTE })

  const poll = await github.pollDeviceFlow(deviceCode)
  let body: DevicePollResponse
  switch (poll.kind) {
    case 'pending':
      body = { status: 'pending', interval: poll.interval ?? 5 }
      return json(body)
    case 'slow_down':
      body = { status: 'slow_down', interval: poll.interval }
      return json(body)
    case 'denied':
      return json({ status: 'denied' } satisfies DevicePollResponse)
    case 'expired':
      return json({ status: 'expired' } satisfies DevicePollResponse)
  }

  const user = await github.user(poll.accessToken)
  if (user.type !== 'User') throw new GatewayError('account_not_eligible', 'Sign in with a personal GitHub account.')
  const existing = await deps.accounts.findByGitHubId(user.id)
  if (existing?.status === 'suspended') throw new GatewayError('account_suspended', 'This account cannot use the free tier.')
  if (!existing) await admitNewAccount(deps, user)
  const account = await deps.accounts.upsertFromGitHub(
    { id: user.id, login: user.login, ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}) },
    deps.now(),
    deps.newId('acc'),
  )
  const tokens = await issueSession(deps, account, deviceId, client)
  deps.log.event('sign_in', { uid: await deps.tokens.logId(account.id), created: !existing })
  return json({ status: 'complete', ...tokens } satisfies DevicePollResponse)
}

async function endFamily(deps: AuthDeps, session: Session, reason: string): Promise<void> {
  const now = deps.now()
  await deps.accounts.revokeSession(session.id, reason, now)
  // Access tokens already issued for this session stop working at once, not when they expire.
  await deps.users.revokeSession(session.accountId, session.id, now + deps.config.tokens.accessTtlSeconds * SECOND)
}

async function rotate(deps: AuthDeps, presented: string, deviceId: string, retried = false): Promise<SessionTokens> {
  const now = deps.now()
  const presentedHash = await deps.tokens.hashRefresh(presented)
  const found = await deps.accounts.findSession(presentedHash)
  if (!found) throw invalidGrant()
  const { session, match } = found
  if (session.revokedAt !== null) throw invalidGrant()
  if (session.deviceHash !== (await deps.tokens.hashDevice(deviceId))) {
    await endFamily(deps, session, 'device_mismatch')
    deps.log.event('refresh_refused', { reason: 'device_mismatch', uid: await deps.tokens.logId(session.accountId) })
    throw invalidGrant()
  }
  if (now >= session.expiresAt || (match === 'current' && now >= session.refreshExpiresAt)) throw invalidGrant()

  const grace = deps.config.tokens.refreshGraceSeconds * SECOND
  const replay = match === 'previous'
  if (replay && (session.rotatedAt === null || now - session.rotatedAt > grace)) {
    await endFamily(deps, session, 'refresh_reuse')
    deps.log.event('refresh_refused', { reason: 'reuse', uid: await deps.tokens.logId(session.accountId) })
    throw invalidGrant()
  }

  const account = await deps.accounts.getAccount(session.accountId)
  if (!account) throw invalidGrant()
  if (account.status === 'suspended') {
    await endFamily(deps, session, 'suspended')
    throw new GatewayError('account_suspended', 'This account cannot use the free tier.')
  }

  const next = deps.tokens.newRefreshToken()
  const nextHash = await deps.tokens.hashRefresh(next)
  const refreshExpiresAt = Math.min(session.expiresAt, now + deps.config.tokens.refreshTtlSeconds * SECOND)
  // A replay inside the grace window replaces the token the client never received; the grace window does not restart.
  const rotated = await deps.accounts.rotateSession(session.id, session.refreshHash, {
    refreshHash: nextHash,
    previousHash: replay ? (session.previousHash ?? presentedHash) : presentedHash,
    rotatedAt: replay ? (session.rotatedAt ?? now) : now,
    refreshExpiresAt,
  })
  if (!rotated) {
    if (retried) throw invalidGrant()
    return rotate(deps, presented, deviceId, true)
  }
  const access = await deps.tokens.issueAccess(account.id, session.id, now)
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: next,
    refresh_expires_in: Math.floor((refreshExpiresAt - now) / SECOND),
    account: publicAccount(account),
  }
}

export async function refresh(request: Request, deps: AuthDeps, address: string): Promise<Response> {
  const { value } = await readJson(request, AUTH_BODY_LIMIT)
  const token = TokenService.refreshTokenShape((value as Record<string, unknown> | null)?.refresh_token)
  if (!token) throw invalidGrant()
  const deviceId = field(value, 'device_id', DEVICE_ID)
  await limitAddress(deps, address, { name: 'refresh', limit: deps.config.signIn.refreshesPerIpPerMinute, windowMs: MINUTE })
  return json(await rotate(deps, token, deviceId))
}

/** Ends the session that owns the refresh token. Answers 204 either way, so it says nothing about the token. */
export async function logout(request: Request, deps: AuthDeps): Promise<Response> {
  const { value } = await readJson(request, AUTH_BODY_LIMIT)
  const token = TokenService.refreshTokenShape((value as Record<string, unknown> | null)?.refresh_token)
  const deviceId = (value as Record<string, unknown> | null)?.device_id
  if (token && typeof deviceId === 'string' && DEVICE_ID.test(deviceId)) {
    const found = await deps.accounts.findSession(await deps.tokens.hashRefresh(token))
    if (found && found.session.revokedAt === null && found.session.deviceHash === (await deps.tokens.hashDevice(deviceId))) {
      await endFamily(deps, found.session, 'sign_out')
    }
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

export async function me(claims: AccessClaims, deps: AuthDeps, scale: number): Promise<Response> {
  const account = await deps.accounts.getAccount(claims.sub)
  if (!account) throw new GatewayError('invalid_token', 'This account no longer exists. Sign in again.')
  if (account.status === 'suspended') throw new GatewayError('account_suspended', 'This account cannot use the free tier.')
  const quota = await deps.users.snapshot(account.id, scale, claims.sid)
  if (!quota) throw new GatewayError('invalid_token', 'This session was signed out. Sign in again.')
  return json({ account: publicAccount(account), quota } satisfies MeResponse)
}

