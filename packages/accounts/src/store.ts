import type { AccountInfo } from '@encode/gateway-protocol'

/**
 * Where the session and the device id live between launches. The desktop app
 * backs this with its key vault (the OS keychain), never with a settings file
 * and never with anything the renderer can read: a refresh token is as good as
 * a password for the free tier until it is rotated or revoked.
 *
 * Where no keychain is usable the vault keeps values in memory, so the user
 * signs in again after a restart. Nothing here may write a secret in clear text.
 */
export interface SecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** A store that forgets everything at exit. Tests use it, and so does a headless run with no keychain. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name)
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value)
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name)
  }
}

/** The keys this package writes. A host that namespaces its vault ids can map them one to one. */
export const StoreKeys = {
  device: 'accounts.device-id',
  session: 'accounts.session',
} as const

/** Everything needed to keep a signed-in session alive. Times are epoch milliseconds on this machine's clock. */
export interface StoredSession {
  v: 1
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  account: AccountInfo
  signedInAt: number
}

/** Printable ASCII without spaces: what a bearer token or an id looks like, wherever it came from. */
const TOKEN = /^[\x21-\x7e]{16,1024}$/
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8.64e15
}

/** The account in a gateway answer or a saved session, or undefined when it is not one. */
export function readAccount(value: unknown): AccountInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, login, avatar_url: avatar } = value as Record<string, unknown>
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(id)) return undefined
  if (typeof login !== 'string' || !LOGIN.test(login)) return undefined
  const account: AccountInfo = { id, login }
  if (typeof avatar === 'string' && avatar.length <= 512 && /^https:\/\//.test(avatar)) account.avatar_url = avatar
  return account
}

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

export function serializeSession(session: StoredSession): string {
  return JSON.stringify(session)
}

/** A saved session, or null when the text is missing, damaged or from a build that wrote another format. Never throws. */
export function parseSession(text: string | undefined): StoredSession | null {
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.v !== 1) return null
  const account = readAccount(record.account)
  if (!account) return null
  if (!isToken(record.accessToken) || !isToken(record.refreshToken)) return null
  if (!isTime(record.accessExpiresAt) || !isTime(record.refreshExpiresAt) || !isTime(record.signedInAt)) return null
  return {
    v: 1,
    accessToken: record.accessToken,
    accessExpiresAt: record.accessExpiresAt,
    refreshToken: record.refreshToken,
    refreshExpiresAt: record.refreshExpiresAt,
    account,
    signedInAt: record.signedInAt,
  }
}
