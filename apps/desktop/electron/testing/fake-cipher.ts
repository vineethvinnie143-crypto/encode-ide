import type { Cipher } from '../services/secrets'

/** A stand-in for safeStorage whose ciphertext only this instance can open. */
export class FakeCipher implements Cipher {
  readonly sealed: string[] = []
  available = true
  backend = 'gnome_libsecret'
  refuse = false

  constructor(private readonly mark = 0x5a) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  encryptString(plainText: string): Buffer {
    if (this.refuse) throw new Error('User canceled the operation.')
    this.sealed.push(plainText)
    return Buffer.concat([Buffer.from([this.mark]), Buffer.from(plainText, 'utf8').map((byte) => byte ^ this.mark)])
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available || encrypted[0] !== this.mark) throw new Error('Error while decrypting the ciphertext')
    return Buffer.from(encrypted.subarray(1).map((byte) => byte ^ this.mark)).toString('utf8')
  }
}
