import type { DeviceStartResponse, QuotaSnapshot, StatusResponse } from '@encode/gateway-protocol'
import { AccountsError } from './errors'
import { isToken, readAccount, type StoredSession } from './store'

/**
 * Parsers for what the gateway sends. The gateway is ours, but the address is
 * a setting: whatever answers there is untrusted until it parses.
 */

const MIN_ACCESS_SECONDS = 30
const MAX_ACCESS_SECONDS = 24 * 3600
const MIN_REFRESH_SECONDS = 60
const MAX_REFRESH_SECONDS = 400 * 24 * 3600

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function unreadable(what: string): AccountsError {
  return new AccountsError('invalid_response', `The gateway sent ${what} this version of eNCode cannot read.`)
}

/** A session from the gateway's token answer. Lifetimes are counted from `now` on this machine's clock, so clock skew cancels out. */
export function readSession(value: unknown, now: number): StoredSession {
  const record = object(value)
  const account = readAccount(record?.account)
  if (!record || !account) throw unreadable('a session')
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: accessSeconds, refresh_expires_in: refreshSeconds } = record
  if (!isToken(accessToken) || !isToken(refreshToken) || !finite(accessSeconds) || !finite(refreshSeconds)) throw unreadable('a session')
  return {
    v: 1,
    accessToken,
    accessExpiresAt: now + clamp(accessSeconds, MIN_ACCESS_SECONDS, MAX_ACCESS_SECONDS) * 1000,
    refreshToken,
    refreshExpiresAt: now + clamp(refreshSeconds, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS) * 1000,
    account,
    signedInAt: now,
  }
}

/** The device-flow start answer, with the verification link held to https on a known host. */
export function readStart(value: unknown, hosts: readonly string[]): DeviceStartResponse {
  const body = object(value)
  if (!body) throw unreadable('a sign-in code')
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, expires_in: expiresIn, interval } = body
  if (typeof deviceCode !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(deviceCode)) throw unreadable('a sign-in code')
  if (typeof userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) throw unreadable('a sign-in code')
  if (!finite(expiresIn) || !finite(interval)) throw unreadable('a sign-in code')
  let link: URL | null = null
  try {
    link = typeof uri === 'string' ? new URL(uri) : null
  } catch {
    link = null
  }
  if (!link || link.protocol !== 'https:' || link.username || link.password || !hosts.includes(link.hostname)) {
    throw unreadable('a sign-in link')
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: link.href,
    expires_in: clamp(expiresIn, 30, 3600),
    interval: clamp(interval, 1, 60),
  }
}

function counter(value: unknown, keys: readonly string[]): boolean {
  const record = object(value)
  return !!record && keys.every((key) => finite(record[key]))
}

export function readQuota(value: unknown): QuotaSnapshot | null {
  const record = object(value)
  if (!record) return null
  if (!counter(record.requests, ['used', 'limit', 'remaining'])) return null
  if (!counter(record.input_tokens, ['used', 'limit']) || !counter(record.output_tokens, ['used', 'limit'])) return null
  if (!finite(record.requests_per_minute) || !finite(record.concurrent_streams) || !finite(record.reset_at)) return null
  return record as unknown as QuotaSnapshot
}

export function readStatus(value: unknown): StatusResponse | null {
  const record = object(value)
  const tier = object(record?.free_tier)
  if (!record || !tier || record.service !== 'encode-gateway') return null
  if (!finite(record.api_version) || typeof tier.available !== 'boolean' || typeof record.data_policy !== 'string') return null
  return record as unknown as StatusResponse
}
