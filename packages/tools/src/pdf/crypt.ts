/**
 * The standard security handler (PDF 32000-1:2008, 7.6.3, and ISO 32000-2 for AES-256), for files whose user
 * password is empty: anyone may open them, and the encryption only carries the author's restrictions on printing
 * or copying. A file that needs a password is left closed.
 */
import crypto from 'node:crypto'
import { nameOf, numberOf, PdfDict, PdfName, PdfString, type PdfObject } from './objects'

const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

type Method = 'none' | 'rc4' | 'aes128' | 'aes256'

export interface Decryptor {
  /** A string or a stream's data of the object `num gen`, decrypted. */
  decrypt(data: Uint8Array, num: number, gen: number, kind: 'string' | 'stream'): Uint8Array
}

export type Security = { ok: true; decryptor: Decryptor } | { ok: false; reason: 'password' | 'unsupported' }

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

const md5 = (...parts: Uint8Array[]): Uint8Array => {
  const hash = crypto.createHash('md5')
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest())
}

function aesDecrypt(bits: 128 | 256, key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32 || data.length % 16) return data.length <= 16 ? new Uint8Array(0) : data.subarray(16)
  const iv = data.subarray(0, 16)
  const body = data.subarray(16)
  try {
    const decipher = crypto.createDecipheriv(`aes-${bits}-cbc`, key, iv)
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]))
  } catch {
    // Bad padding: some writers pad wrongly. The data is still worth having without it.
    const decipher = crypto.createDecipheriv(`aes-${bits}-cbc`, key, iv)
    decipher.setAutoPadding(false)
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]))
  }
}

function aesEncryptNoPad(bits: 128 | 256, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const cipher = crypto.createCipheriv(`aes-${bits}-cbc`, key, iv)
  cipher.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]))
}

function equal(a: Uint8Array, b: Uint8Array, length = Math.min(a.length, b.length)): boolean {
  if (a.length < length || b.length < length) return false
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return false
  return true
}

/** ISO 32000-2, algorithm 2.B: the hash an AES-256 (revision 6) file checks a password against. */
function hash2B(password: Uint8Array, salt: Uint8Array, user: Uint8Array): Uint8Array {
  let k = new Uint8Array(crypto.createHash('sha256').update(password).update(salt).update(user).digest())
  for (let round = 0; ; round++) {
    const unit = new Uint8Array(password.length + k.length + user.length)
    unit.set(password, 0)
    unit.set(k, password.length)
    unit.set(user, password.length + k.length)
    const k1 = new Uint8Array(unit.length * 64)
    for (let i = 0; i < 64; i++) k1.set(unit, i * unit.length)
    const e = aesEncryptNoPad(128, k.subarray(0, 16), k.subarray(16, 32), k1)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    const algorithm = ['sha256', 'sha384', 'sha512'][sum % 3]
    k = new Uint8Array(crypto.createHash(algorithm).update(e).digest())
    if (round >= 63 && e[e.length - 1] <= round - 31) break
  }
  return k.subarray(0, 32)
}

const bytesOf = (value: PdfObject | undefined): Uint8Array => (value instanceof PdfString ? value.bytes : new Uint8Array(0))

/** The method a crypt filter names (V4 and V5 files say per crypt filter how strings and streams are encrypted). */
function methodOf(dict: PdfDict, name: string | undefined, resolve: (value: PdfObject | undefined) => PdfObject | undefined, fallback: Method): Method {
  if (!name || name === 'Identity') return name === 'Identity' ? 'none' : fallback
  const filters = resolve(dict.get('CF'))
  const filter = filters instanceof PdfDict ? resolve(filters.get(name)) : undefined
  const cfm = filter instanceof PdfDict ? nameOf(resolve(filter.get('CFM'))) : undefined
  if (cfm === 'V2') return 'rc4'
  if (cfm === 'AESV2') return 'aes128'
  if (cfm === 'AESV3') return 'aes256'
  if (cfm === 'None') return 'none'
  return fallback
}

/** Opens the file's encryption with the empty user password, when it can be. */
export function openSecurity(encrypt: PdfDict, firstId: Uint8Array, resolve: (value: PdfObject | undefined) => PdfObject | undefined): Security {
  if (nameOf(resolve(encrypt.get('Filter'))) !== 'Standard') return { ok: false, reason: 'unsupported' }
  const v = numberOf(resolve(encrypt.get('V'))) ?? 0
  const r = numberOf(resolve(encrypt.get('R'))) ?? 2
  const o = bytesOf(resolve(encrypt.get('O')))
  const u = bytesOf(resolve(encrypt.get('U')))
  const p = numberOf(resolve(encrypt.get('P'))) ?? 0
  const encryptMetadata = resolve(encrypt.get('EncryptMetadata')) !== false
  const empty = new Uint8Array(0)

  let fileKey: Uint8Array
  let base: Method
  if (r >= 5) {
    if (u.length < 48) return { ok: false, reason: 'unsupported' }
    const check = r === 5 ? new Uint8Array(crypto.createHash('sha256').update(empty).update(u.subarray(32, 40)).digest()) : hash2B(empty, u.subarray(32, 40), empty)
    if (!equal(check, u, 32)) return { ok: false, reason: 'password' }
    const intermediate = r === 5 ? new Uint8Array(crypto.createHash('sha256').update(empty).update(u.subarray(40, 48)).digest()) : hash2B(empty, u.subarray(40, 48), empty)
    const ue = bytesOf(resolve(encrypt.get('UE')))
    if (ue.length < 32) return { ok: false, reason: 'unsupported' }
    const decipher = crypto.createDecipheriv('aes-256-cbc', intermediate, new Uint8Array(16))
    decipher.setAutoPadding(false)
    fileKey = new Uint8Array(Buffer.concat([decipher.update(ue.subarray(0, 32)), decipher.final()]))
    base = 'aes256'
  } else {
    if (v < 1 || v > 4 || o.length < 32 || u.length < 16) return { ok: false, reason: 'unsupported' }
    const length = r === 2 ? 5 : Math.min(16, Math.max(5, Math.floor((numberOf(resolve(encrypt.get('Length'))) ?? 40) / 8)))
    const pBytes = Uint8Array.from([p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >> 24) & 0xff])
    let key = md5(PADDING, o.subarray(0, 32), pBytes, firstId, ...(r >= 4 && !encryptMetadata ? [Uint8Array.from([0xff, 0xff, 0xff, 0xff])] : []))
    if (r >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, length))
    fileKey = key.subarray(0, length)
    if (r === 2) {
      if (!equal(rc4(fileKey, PADDING), u, 32)) return { ok: false, reason: 'password' }
    } else {
      let x = rc4(fileKey, md5(PADDING, firstId))
      for (let i = 1; i <= 19; i++) x = rc4(fileKey.map((byte) => byte ^ i), x)
      if (!equal(x, u, 16)) return { ok: false, reason: 'password' }
    }
    base = v === 4 ? 'aes128' : 'rc4'
  }

  const forStrings = v >= 4 ? methodOf(encrypt, nameOf(resolve(encrypt.get('StrF'))) ?? 'Identity', resolve, base) : base
  const forStreams = v >= 4 ? methodOf(encrypt, nameOf(resolve(encrypt.get('StmF'))) ?? 'Identity', resolve, base) : base
  const keys = new Map<string, Uint8Array>()
  const objectKey = (num: number, gen: number, aes: boolean): Uint8Array => {
    const id = `${num} ${gen} ${aes}`
    let key = keys.get(id)
    if (!key) {
      const extra = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])
      key = md5(fileKey, extra, ...(aes ? [Uint8Array.from([0x73, 0x41, 0x6c, 0x54])] : [])).subarray(0, Math.min(16, fileKey.length + 5))
      keys.set(id, key)
    }
    return key
  }
  return {
    ok: true,
    decryptor: {
      decrypt(data, num, gen, kind) {
        const method = kind === 'string' ? forStrings : forStreams
        switch (method) {
          case 'none':
            return data
          case 'rc4':
            return rc4(objectKey(num, gen, false), data)
          case 'aes128':
            return aesDecrypt(128, objectKey(num, gen, true), data)
          case 'aes256':
            return aesDecrypt(256, fileKey, data)
        }
      },
    },
  }
}

/** Whether a stream is left unencrypted in an encrypted file: cross-reference streams, and metadata when the file says so. */
export function streamIsClear(dict: PdfDict, encrypt: PdfDict, resolve: (value: PdfObject | undefined) => PdfObject | undefined): boolean {
  const type = nameOf(resolve(dict.get('Type')))
  if (type === 'XRef') return true
  if (type === 'Metadata' && resolve(encrypt.get('EncryptMetadata')) === false) return true
  const filter = resolve(dict.get('Filter'))
  const names = Array.isArray(filter) ? filter.map((item) => nameOf(resolve(item))) : [nameOf(filter)]
  if (names.includes('Crypt')) {
    const params = resolve(dict.get('DecodeParms'))
    const list = Array.isArray(params) ? params.map((item) => resolve(item)) : [params]
    const own = list.find((item) => item instanceof PdfDict && nameOf(resolve(item.get('Type'))) === 'CryptFilterDecodeParms') ?? list.find((item) => item instanceof PdfDict)
    const name = own instanceof PdfDict ? nameOf(resolve(own.get('Name'))) : undefined
    return name === undefined || name === 'Identity'
  }
  return false
}

export { PdfName }
