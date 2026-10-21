import { GatewayError } from './errors'

/**
 * GitHub's device flow, run by the gateway on the client's behalf. It asks
 * for no scopes: the gateway only needs to know who the user is. The GitHub
 * token is used once, to read the user's id, and is never stored or returned.
 */

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { kind: 'pending'; interval?: number }
  | { kind: 'slow_down'; interval: number }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'token'; accessToken: string }

export interface GitHubUser {
  id: number
  login: string
  type: string
  createdAt: number | null
  avatarUrl?: string
}

const TIMEOUT_MS = 10_000

function unavailable(): GatewayError {
  return new GatewayError('upstream_unavailable', 'GitHub sign-in is unavailable right now. Try again in a minute.', 60_000)
}

function misconfigured(): GatewayError {
  return new GatewayError('internal_error', 'GitHub sign-in is not set up correctly on this gateway.')
}

export class GitHubClient {
  constructor(
    private readonly options: { baseUrl: string; apiBaseUrl: string; clientId: string },
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'encode-gateway' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw unavailable()
    }
    if (response.status >= 500) throw unavailable()
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw unavailable()
    }
    if (!body || typeof body !== 'object') throw unavailable()
    return body as Record<string, unknown>
  }

  async startDeviceFlow(): Promise<DeviceCode> {
    const body = await this.post('/login/device/code', { client_id: this.options.clientId, scope: '' })
    if (body.error === 'device_flow_disabled' || body.error === 'incorrect_client_credentials' || body.error === 'unauthorized_client') {
      throw misconfigured()
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval } = body
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') throw unavailable()
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresIn: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 900,
      interval: typeof interval === 'number' && interval > 0 ? interval : 5,
    }
  }

  async pollDeviceFlow(deviceCode: string): Promise<DevicePoll> {
    const body = await this.post('/login/oauth/access_token', {
      client_id: this.options.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof body.access_token === 'string' && body.access_token) return { kind: 'token', accessToken: body.access_token }
    const interval = typeof body.interval === 'number' && body.interval > 0 ? body.interval : undefined
    switch (body.error) {
      case 'authorization_pending':
        return interval ? { kind: 'pending', interval } : { kind: 'pending' }
      case 'slow_down':
        return { kind: 'slow_down', interval: interval ?? 10 }
      case 'access_denied':
        return { kind: 'denied' }
      case 'expired_token':
      case 'incorrect_device_code':
        return { kind: 'expired' }
      case 'device_flow_disabled':
      case 'incorrect_client_credentials':
      case 'unsupported_grant_type':
      case 'unauthorized_client':
        throw misconfigured()
      default:
        throw unavailable()
    }
  }

  async user(accessToken: string): Promise<GitHubUser> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.apiBaseUrl}/user`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'encode-gateway',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw unavailable()
    }
    if (!response.ok) throw unavailable()
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !Number.isSafeInteger(body.id) || typeof body.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(body.login)) {
      throw unavailable()
    }
    const created = typeof body.created_at === 'string' ? Date.parse(body.created_at) : Number.NaN
    return {
      id: body.id as number,
      login: body.login,
      type: typeof body.type === 'string' ? body.type : 'User',
      createdAt: Number.isFinite(created) ? created : null,
      ...(typeof body.avatar_url === 'string' && body.avatar_url.startsWith('https://') ? { avatarUrl: body.avatar_url } : {}),
    }
  }
}
