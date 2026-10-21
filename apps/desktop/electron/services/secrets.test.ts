import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { FakeCipher } from '../testing/fake-cipher'
import { detectKeyStorage, KeyVault } from './secrets'

const legacy = (key: string) => `plain:${Buffer.from(key, 'utf8').toString('base64')}`

describe('detectKeyStorage', () => {
  it('uses the keychain wherever the OS offers one', () => {
    assert.deepEqual(detectKeyStorage(new FakeCipher(), 'win32'), { mode: 'keychain' })
    assert.deepEqual(detectKeyStorage(new FakeCipher(), 'darwin'), { mode: 'keychain' })
    assert.deepEqual(detectKeyStorage(new FakeCipher(), 'linux'), { mode: 'keychain' })
  })

  it('keeps keys for the session only without encryption, or behind a Linux store that protects nothing', () => {
    const none = new FakeCipher()
    none.available = false
    assert.equal(detectKeyStorage(none, 'win32').mode, 'session')
    for (const backend of ['basic_text', 'unknown']) {
      for (const available of [true, false]) {
        const linux = new FakeCipher()
        linux.backend = backend
        linux.available = available
        const storage = detectKeyStorage(linux, 'linux')
        assert.equal(storage.mode, 'session', backend)
        assert.match((storage as { reason: string }).reason, new RegExp(`${backend}.*GNOME Keyring or KWallet`))
      }
      const elsewhere = new FakeCipher()
      elsewhere.backend = backend
      assert.equal(detectKeyStorage(elsewhere, 'win32').mode, 'keychain', 'the backend only matters on Linux')
    }
  })

  it('treats a throwing probe as no keychain', () => {
    const cipher = new FakeCipher()
    cipher.isEncryptionAvailable = () => {
      throw new Error('called before ready')
    }
    assert.equal(detectKeyStorage(cipher, 'darwin').mode, 'session')
  })
})

describe('KeyVault', () => {
  it('persists only what the keychain sealed, and reads it back', async () => {
    await check(gen.string('abcXYZ019-_ ./+=éü🔑', 0, 80), (key) => {
      const cipher = new FakeCipher()
      const vault = new KeyVault(cipher, 'win32')
      const stored = vault.put('p', key)
      if (!key.trim()) {
        assert.equal(stored, undefined)
        assert.equal(vault.has('p', stored), false)
        return
      }
      assert.equal(stored, `enc:${cipher.encryptString(key.trim()).toString('base64')}`)
      assert.equal(vault.get('p', stored), key.trim())
      assert.equal(vault.has('p', stored), true)
      assert.equal(new KeyVault(new FakeCipher(0x33), 'win32').get('p', stored), '', 'another keychain cannot open it')
    }, { runs: 400 })
  })

  it('holds keys in memory when there is no keychain, and writes nothing', () => {
    const cipher = new FakeCipher()
    cipher.available = false
    const vault = new KeyVault(cipher, 'win32')
    assert.equal(vault.put('p', '  sk-session  '), undefined)
    assert.deepEqual(cipher.sealed, [])
    assert.equal(vault.get('p', undefined), 'sk-session')
    assert.equal(vault.has('p', undefined), true)
    vault.forget('p')
    assert.equal(vault.get('p', undefined), '')
    assert.equal(vault.has('p', undefined), false)
  })

  it('falls back to memory, and says so, when the keychain refuses at runtime', () => {
    const cipher = new FakeCipher()
    cipher.refuse = true
    const vault = new KeyVault(cipher, 'darwin')
    assert.equal(vault.storage.mode, 'keychain')
    assert.equal(vault.put('p', 'sk-refused'), undefined)
    assert.equal(vault.get('p', undefined), 'sk-refused')
    assert.equal(vault.storage.mode, 'session')
    assert.match((vault.storage as { reason: string }).reason, /refused.*User canceled/)
  })

  it('replacing or clearing a key drops the held one', () => {
    const cipher = new FakeCipher()
    cipher.available = false
    const vault = new KeyVault(cipher, 'win32')
    vault.put('p', 'first')
    vault.put('p', 'second')
    assert.equal(vault.get('p', undefined), 'second')
    vault.put('p', '   ')
    assert.equal(vault.has('p', undefined), false)
  })

  it('seals a legacy plain-text key on load', () => {
    const cipher = new FakeCipher()
    const vault = new KeyVault(cipher, 'win32')
    const upgraded = vault.load('p', legacy('sk-legacy'))
    assert.ok(upgraded?.startsWith('enc:'))
    assert.ok(!upgraded?.includes(Buffer.from('sk-legacy').toString('base64')))
    assert.equal(vault.get('p', upgraded), 'sk-legacy')
  })

  it('moves a legacy plain-text key into memory when there is no keychain', () => {
    const cipher = new FakeCipher()
    cipher.backend = 'basic_text'
    const vault = new KeyVault(cipher, 'linux')
    assert.equal(vault.load('p', legacy('sk-legacy')), undefined)
    assert.equal(vault.get('p', undefined), 'sk-legacy')
    assert.deepEqual(cipher.sealed, [])
  })

  it('reports a sealed key this keychain cannot open as missing, until it is replaced', () => {
    const foreign = new KeyVault(new FakeCipher(0x33), 'win32').put('p', 'sk-elsewhere')
    const vault = new KeyVault(new FakeCipher(), 'win32')
    assert.equal(vault.load('p', foreign), foreign, 'kept on disk: the keychain may come back')
    assert.equal(vault.has('p', foreign), false)
    assert.equal(vault.get('p', foreign), '')
    const replaced = vault.put('p', 'sk-new')
    assert.equal(vault.has('p', replaced), true)
  })

  it('keeps values in a format it does not know without using them', () => {
    const vault = new KeyVault(new FakeCipher(), 'win32')
    assert.equal(vault.load('p', 'v2:opaque'), 'v2:opaque')
    assert.equal(vault.has('p', 'v2:opaque'), false)
    assert.equal(vault.get('p', 'v2:opaque'), '')
  })
})
