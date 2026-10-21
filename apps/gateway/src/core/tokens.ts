import { GatewayError } from './errors'
import { base64url, deriveKeyBytes, fromBase64url, hex, hmac, hmacKey, hmacVerify, randomToken, sha256Hex, utf8 } from './crypto'

/**
 * Access tokens are stateless and short-lived: `ea1.<claims>.<tag>`, the
 * claims base64url JSON and the tag an HMAC-SHA256 over everything before it.
 * Tokens signed with the previous secret still verify, so the secret can be
 * rotated without signing everyone out within the hour.
 *
 * Refresh tokens are 256 random bits (`er1_…`). Only their SHA-256 is stored,
 * which is safe for values that cannot be guessed, and keeps sessions valid
 * across secret rotations.
 */

const ACCESS_PREFIX = 'ea1.'
const REFRESH_PREFIX = 'er1_'
const MAX_TOKEN_LENGTH = 1024
/** Clock skew tolerated between isolates for `iat`. */
const MAX_SKEW_SECONDS = 300

export interface AccessClaims {
  /** Account id. */
  sub: string
  /** Session (refresh-token family) id. */
  sid: string
  iat: number
  exp: number
}

const ID = /^[A-Za-z0-9_-]{8,64}$/

function isClaims(value: unknown): value is AccessClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Record<string, unknown>
  return (
    typeof claims.sub === 'string' &&
    ID.test(claims.sub) &&
    typeof claims.sid === 'string' &&
    ID.test(claims.sid) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp)
  )
}

export class TokenService {
  private constructor(
    private readonly signing: CryptoKey,
    private readonly previousSigning: CryptoKey | null,
    private readonly logKey: CryptoKey,
    private readonly ipKey: CryptoKey,
    readonly accessTtlSeconds: number,
  ) {}

  static async create(secret: string, previousSecret: string | null, accessTtlSeconds: number): Promise<TokenService> {
    const [signing, previousSigning, logKey, ipKey] = await Promise.all([
      deriveKeyBytes(secret, 'access-token').then(hmacKey),
      previousSecret ? deriveKeyBytes(previousSecret, 'access-token').then(hmacKey) : Promise.resolve(null),
      deriveKeyBytes(secret, 'log-id').then(hmacKey),
      deriveKeyBytes(secret, 'ip-key').then(hmacKey),
    ])
    return new TokenService(signing, previousSigning, logKey, ipKey, accessTtlSeconds)
  }

  async issueAccess(accountId: string, sessionId: string, nowMs: number): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(nowMs / 1000)
    const claims: AccessClaims = { sub: accountId, sid: sessionId, iat, exp: iat + this.accessTtlSeconds }
    const body = ACCESS_PREFIX + base64url(utf8(JSON.stringify(claims)))
    const tag = await hmac(this.signing, body)
    return { token: `${body}.${base64url(tag)}`, expiresIn: this.accessTtlSeconds }
  }

  /** The claims of a valid token. Throws `invalid_token`, or `token_expired` for a genuine token past its time. */
  async verifyAccess(token: string, nowMs: number): Promise<AccessClaims> {
    const invalid = () => new GatewayError('invalid_token', 'The access token is not valid. Sign in again.')
    if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(ACCESS_PREFIX)) throw invalid()
    const dot = token.lastIndexOf('.')
    if (dot <= ACCESS_PREFIX.length) throw invalid()
    const body = token.slice(0, dot)
    const tag = fromBase64url(token.slice(dot + 1))
    if (!tag || tag.length !== 32) throw invalid()

    let verified = await hmacVerify(this.signing, body, tag)
    if (!verified && this.previousSigning) verified = await hmacVerify(this.previousSigning, body, tag)
    if (!verified) throw invalid()

    const payload = fromBase64url(body.slice(ACCESS_PREFIX.length))
    let claims: unknown
    try {
      claims = payload ? JSON.parse(new TextDecoder().decode(payload)) : null
    } catch {
      claims = null
    }
    if (!isClaims(claims)) throw invalid()
    const now = Math.floor(nowMs / 1000)
    if (claims.iat > now + MAX_SKEW_SECONDS || claims.exp <= claims.iat) throw invalid()
    if (claims.exp <= now) throw new GatewayError('token_expired', 'The access token has expired. Refresh it and retry.')
    return claims
  }

  newRefreshToken(): string {
    return REFRESH_PREFIX + randomToken(32)
  }

  /** Null for anything that cannot be a refresh token this service issued. */
  static refreshTokenShape(token: unknown): string | null {
    return typeof token === 'string' && /^er1_[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  }

  hashRefresh(token: string): Promise<string> {
    return sha256Hex(token)
  }

  hashDevice(deviceId: string): Promise<string> {
    return sha256Hex(`device:${deviceId}`)
  }

  /** A stable pseudonym for logs and for OpenRouter's `user` field: unlinkable to the account without the secret. */
  async logId(accountId: string): Promise<string> {
    return hex(await hmac(this.logKey, accountId)).slice(0, 16)
  }

  /** The key a client address is rate-limited under. Raw addresses are never stored. */
  async ipBucket(address: string): Promise<string> {
    return hex(await hmac(this.ipKey, address)).slice(0, 32)
  }
}
