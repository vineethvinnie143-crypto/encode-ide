import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_APPEARANCE } from '../../shared/appearance'
import { FakeCipher } from '../testing/fake-cipher'
import type { Settings } from '../../shared/types'
import { SettingsService } from './settings'

let dir = ''
const file = () => path.join(dir, 'eNCode-settings.json')
const onDisk = () => fs.readFileSync(file(), 'utf8')
const legacy = (key: string) => `plain:${Buffer.from(key, 'utf8').toString('base64')}`

function writeLegacySettings(key: string): void {
  const settings = {
    profiles: [{ id: 'router', name: 'OpenRouter', kind: 'openrouter', baseUrl: '', model: 'm', apiKeyEnc: legacy(key) }],
    activeProfileId: 'router',
    policy: 'workspace-write',
  }
  fs.writeFileSync(file(), JSON.stringify(settings), { mode: 0o644 })
  fs.chmodSync(file(), 0o644)
  // What an earlier build left behind when it crashed between write and rename.
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(settings))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-settings-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('SettingsService keys', () => {
  it('seals a legacy plain-text key at startup and leaves no plain copy on disk', () => {
    writeLegacySettings('sk-or-legacy-key')
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.keyFor('router'), 'sk-or-legacy-key')
    const disk = onDisk()
    assert.doesNotMatch(disk, /plain:|sk-or-legacy-key/)
    assert.match(disk, /"apiKeyEnc": "enc:/)
    assert.equal(fs.existsSync(`${file()}.tmp`), false, 'the stale temp copy is gone')
    assert.equal(settings.get().profiles[0].hasApiKey, true)
    assert.deepEqual(settings.get().keyStorage, { mode: 'keychain' })
  })

  it('without a keychain, keeps a legacy key for this session and removes it from disk', () => {
    writeLegacySettings('sk-or-legacy-key')
    const cipher = new FakeCipher()
    cipher.backend = 'basic_text'
    const settings = new SettingsService(dir, cipher, 'linux')
    assert.equal(settings.keyFor('router'), 'sk-or-legacy-key')
    assert.equal(settings.get().keyStorage.mode, 'session')
    assert.doesNotMatch(onDisk(), /apiKeyEnc|sk-or-legacy-key/)

    const restarted = new SettingsService(dir, cipher, 'linux')
    assert.equal(restarted.keyFor('router'), '')
    assert.equal(restarted.get().profiles[0].hasApiKey, false)
  })

  it('never hands a key or its sealed form to the renderer', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    const [profile] = settings.save({
      profiles: [{ id: 'custom', name: 'Custom', kind: 'custom', baseUrl: 'https://api.example.com/v1', model: 'm' }],
    }).profiles
    const after = settings.setProfileKey(profile.id, '  sk-secret-value  ')
    assert.equal(after.profiles[0].hasApiKey, true)
    assert.doesNotMatch(JSON.stringify(after), /sk-secret-value|enc:|apiKeyEnc/)
    assert.equal(settings.keyFor('custom'), 'sk-secret-value')
    assert.doesNotMatch(onDisk(), /sk-secret-value/)
  })

  it('clears a key, and forgets a session key with its profile', () => {
    const cipher = new FakeCipher()
    cipher.available = false
    const settings = new SettingsService(dir, cipher, 'win32')
    settings.save({ profiles: [{ id: 'a', name: 'A', kind: 'custom', baseUrl: '', model: '' }] })
    settings.setProfileKey('a', 'sk-a')
    assert.equal(settings.keyFor('a'), 'sk-a')
    settings.setProfileKey('a', '')
    assert.equal(settings.keyFor('a'), '')

    settings.setProfileKey('a', 'sk-a')
    settings.save({ profiles: [{ id: 'b', name: 'B', kind: 'custom', baseUrl: '', model: '' }] })
    settings.save({ profiles: [{ id: 'a', name: 'A', kind: 'custom', baseUrl: '', model: '' }] })
    assert.equal(settings.keyFor('a'), '', 'a recreated profile does not inherit the deleted one’s key')
  })

  it('shows a key sealed by another keychain as missing', () => {
    const elsewhere = new SettingsService(dir, new FakeCipher(0x33), 'win32')
    elsewhere.save({ profiles: [{ id: 'a', name: 'A', kind: 'custom', baseUrl: '', model: '' }] })
    elsewhere.setProfileKey('a', 'sk-elsewhere')
    const here = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(here.get().profiles[0].hasApiKey, false)
    assert.equal(here.keyFor('a'), '')
  })

  it('drops a key when its profile is pointed at another server', () => {
    for (const available of [true, false]) {
      const cipher = new FakeCipher()
      cipher.available = available
      const settings = new SettingsService(fs.mkdtempSync(path.join(dir, 'server-')), cipher, 'win32')
      const profile = (baseUrl: string) => ({ id: 'a', name: 'A', kind: 'custom' as const, baseUrl, model: 'm' })
      settings.save({ profiles: [profile('https://api.example.com/v1')] })
      settings.setProfileKey('a', 'sk-a')
      settings.save({ profiles: [profile('https://api.example.com/v2/')] })
      assert.equal(settings.keyFor('a'), 'sk-a', 'same server')
      const moved = settings.save({ profiles: [profile('https://api.example.net/v1')] })
      assert.equal(settings.keyFor('a'), '', `another server (keychain ${available})`)
      assert.equal(moved.profiles[0].hasApiKey, false)
    }
  })

  it('refuses keys that cannot travel in an HTTP header', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: [{ id: 'a', name: 'A', kind: 'custom', baseUrl: '', model: '' }] })
    for (const bad of ['sk two words', 'sk-a\r\nX-Injected: 1', 'sk-ключ', 'k'.repeat(4097)]) {
      assert.throws(() => settings.setProfileKey('a', bad), /API key/, JSON.stringify(bad.slice(0, 20)))
    }
    assert.equal(settings.keyFor('a'), '')
    settings.setProfileKey('a', '\tsk-padded \n')
    assert.equal(settings.keyFor('a'), 'sk-padded')
  })

  it('writes the settings file for its owner only', { skip: process.platform === 'win32' }, () => {
    writeLegacySettings('sk-or-legacy-key')
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600)
    settings.save({ maxSteps: 12 })
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600)
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    )
  })
})

describe('SettingsService appearance', () => {
  it('starts dark with the Signal blue accent, in the system fonts', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(settings.get().appearance, DEFAULT_APPEARANCE)
    assert.equal(settings.get().appearance.mode, 'dark')
    assert.equal(settings.get().appearance.accent, 'blue')
  })

  it('saves a change, keeps the fields a patch leaves out, and reads it back after a restart', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ appearance: { ...settings.get().appearance, mode: 'light', accent: 'jade' } })
    const partial = { density: 'compact' } as unknown as Settings['appearance']
    const saved = settings.save({ appearance: partial }).appearance
    assert.deepEqual(saved, { ...DEFAULT_APPEARANCE, mode: 'light', accent: 'jade', density: 'compact' })
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().appearance, saved)
  })

  it('ignores values it does not know, from the renderer or from the file', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    const bad = { mode: 'neon', accent: 'url(evil)', contrast: 7, density: null, motion: 'full', uiFont: 'x"; y', uiSize: 99, extra: 'x' }
    const saved = settings.save({ appearance: bad as unknown as Settings['appearance'] }).appearance
    assert.deepEqual(saved, { ...DEFAULT_APPEARANCE, motion: 'full' })

    fs.writeFileSync(file(), JSON.stringify({ appearance: 'light' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().appearance.mode, 'dark')
  })

  it('hands the renderer a copy', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.get().appearance.mode = 'light'
    assert.equal(settings.get().appearance.mode, 'dark')
  })
})

describe('SettingsService defaults and secrets', () => {
  it('starts a new install where it is safe: the offline model, asking before commands, nothing remembered', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(settings.policy, 'workspace-write', 'never Full access until the user chooses it')
    assert.equal(settings.activeProfileId, 'demo')
    assert.deepEqual(settings.profiles.map((profile) => [profile.id, profile.kind, profile.hasApiKey]), [['demo', 'demo', false]])
    assert.deepEqual(settings.recentWorkspaces, [])
    assert.equal(settings.lastWorkspace, null)
    assert.equal(settings.agentMode, 'code')
  })

  it('falls back to those defaults when the file is damaged', () => {
    fs.writeFileSync(file(), '{ not json')
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().policy, 'workspace-write')
    fs.writeFileSync(file(), JSON.stringify({ policy: 'everything', profiles: [] }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().policy, 'workspace-write', 'an unknown policy is not Full access')
  })

  it('lists the keys it holds, so a log or a report can be scrubbed of exactly those', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(settings.secrets(), [])
    settings.save({
      profiles: [
        { id: 'demo', name: 'Demo', kind: 'demo', baseUrl: '', model: 'eNCode-demo' },
        { id: 'a', name: 'A', kind: 'custom', baseUrl: 'https://a.example/v1', model: 'm' },
        { id: 'b', name: 'B', kind: 'custom', baseUrl: 'https://b.example/v1', model: 'm' },
      ],
    })
    settings.setProfileKey('a', 'key-for-a-0001')
    settings.setProfileKey('b', 'key-for-b-0002')
    assert.deepEqual(settings.secrets().sort(), ['key-for-a-0001', 'key-for-b-0002'])
    settings.setProfileKey('a', '')
    assert.deepEqual(settings.secrets(), ['key-for-b-0002'])
  })
})

describe('SettingsService models', () => {
  const profiles = (): Settings['profiles'] => [
    { id: 'demo', name: 'Demo', kind: 'demo', baseUrl: '', model: 'eNCode-demo' },
    { id: 'or', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
    { id: 'oa', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ]

  it('starts a new install with only free models allowed, the first-run dialog unanswered and no role chosen', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(settings.freeOnly, true, 'nothing is billed until the person says so')
    assert.equal(settings.setupDone, false)
    assert.deepEqual(settings.roles, {})
    assert.equal(settings.freeProfileId, null)
  })

  it('keeps allowing what already worked: a file from before roles that uses a real model has set up and may pay', () => {
    fs.writeFileSync(file(), JSON.stringify({ profiles: [{ id: 'x', name: 'X', kind: 'custom', baseUrl: 'https://a.example/v1', model: 'm', apiKeyEnc: legacy('key-0001-abcd') }], activeProfileId: 'x' }))
    const settings = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(settings.freeOnly, false)
    assert.equal(settings.setupDone, true)

    fs.writeFileSync(file(), JSON.stringify({ profiles: [{ id: 'x', name: 'X', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'm' }], activeProfileId: 'x' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().setupDone, true, 'a model on this machine needs no key')

    fs.writeFileSync(file(), JSON.stringify({ profiles: [{ id: 'x', name: 'X', kind: 'custom', baseUrl: 'https://a.example/v1', model: 'm' }], activeProfileId: 'x' }))
    const keyless = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(keyless.freeOnly, true)
    assert.equal(keyless.setupDone, false)
  })

  it('saves the roles, the free-only switch, the free connection and the answered dialog, and reads them back after a restart', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: profiles() })
    const saved = settings.save({ roles: { main: ['oa:gpt-4o', '@free'], reviewer: ['or:qwen/qwen3-coder:free'] }, freeOnly: false, freeProfileId: 'or', setupDone: true })
    assert.deepEqual(saved.roles, { main: ['oa:gpt-4o', '@free'], reviewer: ['or:qwen/qwen3-coder:free'] })
    assert.equal(saved.freeOnly, false)
    assert.equal(saved.freeProfileId, 'or')
    assert.equal(saved.setupDone, true)
    const again = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.deepEqual(again.roles, saved.roles)
    assert.equal(again.freeOnly, false)
    assert.equal(again.freeProfileId, 'or')
  })

  it('leaves them alone when a patch does not name them', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: profiles(), roles: { main: ['oa:gpt-4o'] }, freeOnly: false, setupDone: true })
    const saved = settings.save({ maxSteps: 12 })
    assert.deepEqual(saved.roles, { main: ['oa:gpt-4o'] })
    assert.equal(saved.freeOnly, false)
    assert.equal(saved.setupDone, true)
  })

  it('drops what names a profile that went away, an unknown role, or something that is not a reference', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: profiles() })
    const bad = { main: ['gone:x', 'oa:gpt-4o', 5], dreamer: ['oa:gpt-4o'], utility: 'oa:gpt-4o' }
    assert.deepEqual(settings.save({ roles: bad as unknown as Settings['roles'] }).roles, { main: ['oa:gpt-4o'] })
    settings.save({ roles: { main: ['oa:gpt-4o'], reviewer: ['oa:o3', 'or:a:free'] } })
    assert.deepEqual(settings.save({ profiles: profiles().filter((profile) => profile.id !== 'oa') }).roles, { reviewer: ['or:a:free'] })
  })

  it('takes a free connection only if it is an OpenRouter profile that exists', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: profiles() })
    assert.equal(settings.save({ freeProfileId: 'oa' }).freeProfileId, null, 'OpenAI cannot serve the free models')
    assert.equal(settings.save({ freeProfileId: 'gone' }).freeProfileId, null)
    assert.equal(settings.save({ freeProfileId: 'or' }).freeProfileId, 'or')
    assert.equal(settings.save({ freeProfileId: null }).freeProfileId, null)
    settings.save({ freeProfileId: 'or' })
    assert.equal(settings.save({ profiles: profiles().filter((profile) => profile.id !== 'or') }).freeProfileId, null)
  })

  it('ignores a free-only switch that is not true or false, from the renderer or from the file', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.save({ freeOnly: 'no' as unknown as boolean }).freeOnly, true)
    fs.writeFileSync(file(), JSON.stringify({ freeOnly: 'false' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().freeOnly, true, 'a switch that guards against spending stays on')
  })

  it('numbers a profile\'s key anew each time it changes, so the agent host can tell without seeing it', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ profiles: profiles() })
    const start = settings.keyRevision('oa')
    settings.setProfileKey('oa', 'key-for-oa-0001')
    const first = settings.keyRevision('oa')
    settings.setProfileKey('oa', 'key-for-oa-0002')
    const second = settings.keyRevision('oa')
    assert.ok(first > start && second > first)
    assert.equal(settings.keyRevision('or'), 0, 'another profile\'s key did not change')
    // Pointing the profile at another server drops its key, which is a change too.
    settings.save({ profiles: profiles().map((profile) => (profile.id === 'oa' ? { ...profile, baseUrl: 'https://elsewhere.example/v1' } : profile)) })
    assert.ok(settings.keyRevision('oa') > second)
  })
})
