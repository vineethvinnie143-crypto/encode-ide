/**
 * Small wrappers over Web Crypto, which the Workers runtime and Node share.
 * Nothing here keeps state; keys are derived once by the caller and reused.
 */

const encoder = new TextEncoder()

/** Bytes backed by a plain ArrayBuffer, the only kind Web Crypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>

export function utf8(text: string): Bytes {
  return new Uint8Array(encoder.encode(text))
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes unpadded base64url, or returns null for anything else. */
export function fromBase64url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (let index = 0; index < view.length; index++) out += view[index].toString(16).padStart(2, '0')
  return out
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length))
}

/** A URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes))
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', utf8(text)))
}

/** HKDF-SHA256: a 32-byte key for one purpose, from the gateway's master secret. */
export async function deriveKeyBytes(secret: string, purpose: string): Promise<Bytes> {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('encode-gateway/v1'), info: utf8(purpose) },
    material,
    256,
  )
  return new Uint8Array(bits)
}

export async function hmacKey(bytes: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function hmac(key: CryptoKey, data: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(data)))
}

/** Constant-time check of an HMAC tag. */
export async function hmacVerify(key: CryptoKey, data: string, tag: Bytes): Promise<boolean> {
  return crypto.subtle.verify('HMAC', key, tag, utf8(data))
}

/**
 * Compares two secrets without leaking where they differ: both sides are
 * hashed first, so the comparison runs over equal-length digests.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ])
  const x = new Uint8Array(left)
  const y = new Uint8Array(right)
  let difference = 0
  for (let index = 0; index < x.length; index++) difference |= x[index] ^ y[index]
  return difference === 0
}
