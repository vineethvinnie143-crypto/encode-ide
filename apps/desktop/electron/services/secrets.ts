import type { KeyStorage } from '../../shared/types'

/**
 * API keys at rest. A key reaches the disk only after the operating system's
 * keychain has encrypted it (DPAPI on Windows, the Keychain on macOS, Secret
 * Service or KWallet on Linux). Where no keychain is usable, a key lives in
 * memory until eNCode quits and is never written anywhere.
 *
 * Electron's safeStorage is injected, so this runs under plain Node in tests.
 */
export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only. */
  getSelectedStorageBackend?(): string
}

const SEALED = 'enc:'
/** What builds before the vault wrote without a keychain: base64, which is not encryption. */
const LEGACY_PLAIN = 'plain:'

/**
 * Linux stores that protect nothing. basic_text derives its key from a password
 * compiled into Chromium, so anything it "encrypts" is readable by any process
 * that can read the file; unknown means the backend was never chosen.
 */
const UNPROTECTED_LINUX_BACKENDS = new Set(['basic_text', 'unknown'])

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function detectKeyStorage(cipher: Cipher, platform: NodeJS.Platform = process.platform): KeyStorage {
  // Checked first: Electron also reports encryption as unavailable here, but the backend says how to fix it.
  if (platform === 'linux') {
    let backend = 'unknown'
    try {
      backend = cipher.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      /* stays unknown */
    }
    if (UNPROTECTED_LINUX_BACKENDS.has(backend)) {
      return {
        mode: 'session',
        reason: `No keyring service is running, and the ${backend} fallback would leave keys readable. Start GNOME Keyring or KWallet to keep keys between sessions.`,
      }
    }
  }
  let available = false
  try {
    available = cipher.isEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) return { mode: 'session', reason: 'The system keychain is not available to eNCode.' }
  return { mode: 'keychain' }
}

export class KeyVault {
  /** Keys held only in memory because no keychain would take them. */
  private readonly sessionKeys = new Map<string, string>()
  /** Profiles whose sealed key this keychain cannot open (another machine's, or a reset keychain). */
  private readonly unreadable = new Set<string>()
  private readonly detected: KeyStorage
  private refusal: string | null = null

  constructor(
    private readonly cipher: Cipher,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.detected = detectKeyStorage(cipher, platform)
  }

  get storage(): KeyStorage {
    if (this.detected.mode === 'keychain' && this.refusal) return { mode: 'session', reason: this.refusal }
    return this.detected
  }

  /**
   * Takes a new key for `id` and returns what to persist: a sealed key, or
   * undefined when nothing may be written because the key is empty or no
   * keychain is usable (it is then held in memory for this session).
   */
  put(id: string, key: string): string | undefined {
    this.sessionKeys.delete(id)
    this.unreadable.delete(id)
    const trimmed = key.trim()
    if (!trimmed) return undefined
    if (this.storage.mode === 'keychain') {
      try {
        return SEALED + this.cipher.encryptString(trimmed).toString('base64')
      } catch (error) {
        this.refusal = `The system keychain refused to encrypt the key (${describe(error)}).`
      }
    }
    this.sessionKeys.set(id, trimmed)
    return undefined
  }

  /** The key for `id`, or '' when there is none or it cannot be decrypted. */
  get(id: string, stored: string | undefined): string {
    const held = this.sessionKeys.get(id)
    if (held !== undefined) return held
    if (!stored?.startsWith(SEALED)) return ''
    try {
      const key = this.cipher.decryptString(Buffer.from(stored.slice(SEALED.length), 'base64'))
      this.unreadable.delete(id)
      return key
    } catch {
      this.unreadable.add(id)
      return ''
    }
  }

  has(id: string, stored: string | undefined): boolean {
    if (this.sessionKeys.has(id)) return true
    return Boolean(stored?.startsWith(SEALED)) && !this.unreadable.has(id)
  }

  forget(id: string): void {
    this.sessionKeys.delete(id)
    this.unreadable.delete(id)
  }

  /**
   * Brings a stored value from an earlier build up to date and returns what to
   * persist. A legacy plain-text key is sealed, or moved into memory when no
   * keychain is usable, so it leaves the disk either way. A sealed key is opened
   * once, so one this keychain cannot read shows as missing instead of failing
   * every request. Values in a format this build does not know are kept as they
   * are, since they may belong to a newer one.
   */
  load(id: string, stored: string | undefined): string | undefined {
    if (stored?.startsWith(LEGACY_PLAIN)) {
      return this.put(id, Buffer.from(stored.slice(LEGACY_PLAIN.length), 'base64').toString('utf8'))
    }
    if (stored?.startsWith(SEALED)) this.get(id, stored)
    return stored
  }
}
