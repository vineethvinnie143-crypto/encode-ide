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

describe('SettingsService context size', () => {
  it('summarizes past 200k tokens until the person picks one of the offered sizes, and takes no other', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.get().contextCap, 200_000)
    assert.equal(settings.save({ contextCap: 400_000 }).contextCap, 400_000)
    assert.equal(settings.save({ contextCap: 123_456 }).contextCap, 400_000, 'a size not offered is not taken')
    assert.equal(settings.save({ contextCap: Number.POSITIVE_INFINITY }).contextCap, 400_000)
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().contextCap, 400_000, 'kept across a restart')
    fs.writeFileSync(file(), JSON.stringify({ ...JSON.parse(onDisk()), contextCap: 'all of it' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().contextCap, 200_000, 'a file with anything else goes back to the default')
  })
})

describe('SettingsService step limit', () => {
  it('lets a request take 200 steps until the person sets a limit from 1 to 1000, and keeps it across restarts', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.get().maxSteps, 200)
    assert.equal(settings.save({ maxSteps: 30 }).maxSteps, 30)
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().maxSteps, 30, 'a 30 the person chose stays')
    assert.equal(settings.save({ maxSteps: 5000 }).maxSteps, 1000)
    assert.equal(settings.save({ maxSteps: 0 }).maxSteps, 1)
  })

  it('reads the 30 every older file holds as the new default, and keeps any other limit', () => {
    fs.writeFileSync(file(), JSON.stringify({ policy: 'workspace-write', maxSteps: 30 }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().maxSteps, 200)
    fs.writeFileSync(file(), JSON.stringify({ policy: 'workspace-write', maxSteps: 75 }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().maxSteps, 75)
    fs.writeFileSync(file(), JSON.stringify({ policy: 'workspace-write', maxSteps: 'many' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().maxSteps, 200)
  })
})

describe('SettingsService appearance', () => {
  it('starts dark with the Mono accent, in the system fonts', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(settings.get().appearance, DEFAULT_APPEARANCE)
    assert.equal(settings.get().appearance.mode, 'dark')
    assert.equal(settings.get().appearance.accent, 'mono')
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
    assert.equal(settings.followUp, 'queue', 'a message sent while the agent works waits, unless the person steers with it')
  })

  it('keeps what Enter does while the agent works, and nothing but its two values', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.save({ followUp: 'steer' }).followUp, 'steer')
    assert.equal(settings.save({ followUp: 'now' as unknown as Settings['followUp'] }).followUp, 'steer')
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().followUp, 'steer')
    fs.writeFileSync(file(), JSON.stringify({ followUp: 42 }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().followUp, 'queue')
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

describe('SettingsService web search', () => {
  it('starts on Parallel, which needs no key, with no key stored', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(settings.searchProvider, 'parallel')
    assert.deepEqual(settings.searchKeys, [])
  })

  it('moves a file that holds the old default, DuckDuckGo, to Parallel once, and keeps DuckDuckGo chosen since', () => {
    // Every file from before 0123 holds DuckDuckGo, chosen or not: only a choice made since is kept.
    fs.writeFileSync(file(), JSON.stringify({ policy: 'read-only', searchProvider: 'duckduckgo' }))
    const moved = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(moved.get().searchProvider, 'parallel')
    moved.save({ maxSteps: 12 })
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().searchProvider, 'parallel', 'and written back as Parallel')

    moved.save({ searchProvider: 'duckduckgo' })
    assert.match(onDisk(), /"searchChosen": true/)
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().searchProvider, 'duckduckgo', 'chosen in Settings, it stays')

    fs.writeFileSync(file(), JSON.stringify({ searchProvider: 'brave' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().searchProvider, 'brave', 'a keyed provider was always a choice')
  })

  it('saves the provider, keeps it when a patch does not name it, and takes only a provider that exists', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.save({ searchProvider: 'tavily' }).searchProvider, 'tavily')
    assert.equal(settings.save({ maxSteps: 12 }).searchProvider, 'tavily')
    assert.equal(settings.save({ searchProvider: 'bing' as never }).searchProvider, 'tavily')
    assert.equal(settings.save({ searchProvider: 7 as never }).searchProvider, 'tavily')
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().searchProvider, 'tavily', 'and still after a restart')
    fs.writeFileSync(file(), JSON.stringify({ searchProvider: 'evil' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().searchProvider, 'parallel', 'a file that names no provider we know falls back')
  })

  it('seals a key, shows only that there is one, and hands it over to the main process alone', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    const after = settings.setSearchKey('brave', '  BSA-secret-value  ')
    assert.deepEqual(after.searchKeys, ['brave'])
    assert.doesNotMatch(JSON.stringify(after), /BSA-secret-value|enc:|searchKeysEnc/)
    assert.equal(settings.searchKeyFor('brave'), 'BSA-secret-value')
    assert.equal(settings.searchKeyFor('exa'), '')
    assert.doesNotMatch(onDisk(), /BSA-secret-value/)
    assert.match(onDisk(), /"searchKeysEnc": \{\s+"brave": "enc:/)
    const restarted = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(restarted.searchKeyFor('brave'), 'BSA-secret-value')
    assert.deepEqual(restarted.get().searchKeys, ['brave'])
  })

  it('keeps a key per provider, replaces one, and removes one with an empty key', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.setSearchKey('brave', 'brave-key-0001')
    settings.setSearchKey('exa', 'exa-key-0001')
    assert.deepEqual(settings.get().searchKeys.sort(), ['brave', 'exa'])
    settings.setSearchKey('brave', 'brave-key-0002')
    assert.equal(settings.searchKeyFor('brave'), 'brave-key-0002')
    assert.equal(settings.searchKeyFor('exa'), 'exa-key-0001')
    assert.deepEqual(settings.setSearchKey('brave', '').searchKeys, ['exa'])
    assert.equal(settings.searchKeyFor('brave'), '')
    assert.doesNotMatch(onDisk(), /brave-key/)
  })

  it('has no key for Parallel or DuckDuckGo, or for a name that is not a provider, and says so', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.throws(() => settings.setSearchKey('parallel', 'k-0001'), /does not use a key/)
    assert.throws(() => settings.setSearchKey('duckduckgo', 'k-0001'), /does not use a key/)
    assert.throws(() => settings.setSearchKey('search:brave' as never, 'k-0001'), /does not use a key/)
    assert.throws(() => settings.setSearchKey('__proto__' as never, 'k-0001'), /does not use a key/)
    assert.equal(settings.searchKeyFor('duckduckgo'), '')
    assert.equal(settings.searchKeyFor('constructor' as never), '')
    assert.deepEqual(settings.get().searchKeys, [])
  })

  it('refuses keys that cannot travel in an HTTP header, as it does for a model', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    for (const bad of ['two words', 'k\r\nX-Injected: 1', 'ключ', 'k'.repeat(4097)]) {
      assert.throws(() => settings.setSearchKey('tavily', bad), /API key/, JSON.stringify(bad.slice(0, 20)))
    }
    assert.equal(settings.searchKeyFor('tavily'), '')
  })

  it('holds a key in memory only, and never on disk, where no keychain would take it', () => {
    const cipher = new FakeCipher()
    cipher.available = false
    const settings = new SettingsService(dir, cipher, 'win32')
    assert.deepEqual(settings.setSearchKey('exa', 'exa-session-key').searchKeys, ['exa'])
    assert.equal(settings.searchKeyFor('exa'), 'exa-session-key')
    assert.doesNotMatch(onDisk(), /exa-session-key|"exa":/)
    const restarted = new SettingsService(dir, cipher, 'win32')
    assert.deepEqual(restarted.get().searchKeys, [])
    assert.equal(restarted.searchKeyFor('exa'), '')
  })

  it('shows a key sealed by another keychain as missing', () => {
    new SettingsService(dir, new FakeCipher(0x33), 'win32').setSearchKey('brave', 'sealed-elsewhere')
    const here = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(here.get().searchKeys, [])
    assert.equal(here.searchKeyFor('brave'), '')
  })

  it('lists the keys among the secrets a log or a report is scrubbed of', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.setSearchKey('brave', 'brave-key-0001')
    settings.setSearchKey('tavily', 'tavily-key-0001')
    assert.deepEqual(settings.secrets().sort(), ['brave-key-0001', 'tavily-key-0001'])
    settings.setSearchKey('brave', '')
    assert.deepEqual(settings.secrets(), ['tavily-key-0001'])
  })

  it('reads a settings file from before search providers, and one that keeps strange things where keys go', () => {
    fs.writeFileSync(file(), JSON.stringify({ policy: 'read-only' }))
    const old = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(old.searchProvider, 'parallel')
    assert.deepEqual(old.searchKeys, [])
    fs.writeFileSync(file(), JSON.stringify({ searchKeysEnc: { brave: 5, exa: null, duckduckgo: 'enc:xx', evil: 'enc:yy' } }))
    const odd = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(odd.get().searchKeys, [])
    odd.save({ maxSteps: 12 })
    assert.doesNotMatch(onDisk(), /"duckduckgo": "enc|evil/, 'what was not a key of a provider that exists is not written back')
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

  it('leaves every role\'s effort to its model until the person picks one, and keeps a pick across restarts', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(settings.get().efforts, {})
    assert.deepEqual(settings.save({ efforts: { main: 'max', explore: 'low' } }).efforts, { main: 'max', explore: 'low' })
    assert.deepEqual(settings.save({ maxSteps: 12 }).efforts, { main: 'max', explore: 'low' }, 'a patch that does not name them leaves them')
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().efforts, { main: 'max', explore: 'low' })
    assert.deepEqual(settings.save({ efforts: {} }).efforts, {})
  })

  it('takes only known roles at known levels, from the renderer or from the file', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    const bad = { main: 'ultra', reviewer: 'high', dreamer: 'max', utility: 2 }
    assert.deepEqual(settings.save({ efforts: bad as unknown as Settings['efforts'] }).efforts, { reviewer: 'high' })
    assert.deepEqual(settings.save({ efforts: 'max' as unknown as Settings['efforts'] }).efforts, {})
    fs.writeFileSync(file(), JSON.stringify({ efforts: { main: 'low', planner: ['max'] } }))
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().efforts, { main: 'low' })
    fs.writeFileSync(file(), JSON.stringify({ efforts: ['low'] }))
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().efforts, {})
  })

  it('hands the renderer a copy of the efforts', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ efforts: { main: 'high' } })
    const copy = settings.get()
    copy.efforts.main = 'max'
    assert.deepEqual(settings.get().efforts, { main: 'high' })
  })

  it('keeps the shortcuts the person chose across restarts, and only well-formed ones', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.deepEqual(settings.get().keybindings, {}, 'a new install has the shortcuts eNCode ships with')
    const chosen = { 'view.bottomPanel': ['Ctrl+Shift+J'], 'edit.find': [] }
    assert.deepEqual(settings.save({ keybindings: chosen }).keybindings, chosen)
    assert.deepEqual(settings.save({ maxSteps: 12 }).keybindings, chosen, 'a patch that does not name them leaves them')
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().keybindings, chosen)
    const bad = { __proto__: ['Ctrl+J'], 'view.sidebar': 'Ctrl+B', 'edit.find': ['Ctrl+F', 3] }
    assert.deepEqual(settings.save({ keybindings: bad as unknown as Settings['keybindings'] }).keybindings, { 'edit.find': ['Ctrl+F'] })
    fs.writeFileSync(file(), JSON.stringify({ keybindings: ['Ctrl+J'] }))
    assert.deepEqual(new SettingsService(dir, new FakeCipher(), 'win32').get().keybindings, {})
    const copy = settings.get()
    copy.keybindings['edit.find'].push('F9')
    assert.deepEqual(settings.get().keybindings, { 'edit.find': ['Ctrl+F'] }, 'the renderer gets a copy')
  })

  it('ignores a free-only switch that is not true or false, from the renderer or from the file', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.save({ freeOnly: 'no' as unknown as boolean }).freeOnly, true)
    fs.writeFileSync(file(), JSON.stringify({ freeOnly: 'false' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().freeOnly, true, 'a switch that guards against spending stays on')
  })

  it('keeps the agent off the rest of the computer until the person turns that on, and only takes true or false', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    assert.equal(settings.get().computer, false, 'off on a new install')
    assert.equal(settings.get().computerSupported, true, 'where Windows can be driven')
    assert.equal(new SettingsService(dir, new FakeCipher(), 'linux').get().computerSupported, false)
    assert.equal(settings.save({ computer: true }).computer, true)
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().computer, true, 'and still on after a restart')
    assert.equal(settings.save({ policy: 'read-only' }).computer, true, 'a patch that does not name it leaves it')
    assert.equal(settings.save({ computer: 'yes' as unknown as boolean }).computer, true, 'something that is not true or false is ignored')
    assert.equal(settings.save({ computer: false }).computer, false)
    fs.writeFileSync(file(), JSON.stringify({ computer: 'true' }))
    assert.equal(new SettingsService(dir, new FakeCipher(), 'win32').get().computer, false, 'a file that says something else leaves it off')
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

describe('SettingsService general and notices', () => {
  it('starts with Enter sending, the computer kept awake while an agent works, and notices while eNCode is in the back', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.equal(settings.sendKey, 'enter')
    assert.equal(settings.keepAwake, true)
    assert.equal(settings.notifyDone, 'background')
    assert.equal(settings.notifyNeeds, 'background')
    assert.equal(settings.flashTaskbar, true)
    assert.equal(settings.autoUpdate, true)
  })

  it('saves each one, reads it back after a restart, and takes only the values it knows', () => {
    const settings = new SettingsService(dir, new FakeCipher(), 'win32')
    settings.save({ sendKey: 'ctrl-enter', keepAwake: false, notifyDone: 'always', notifyNeeds: 'never', flashTaskbar: false, autoUpdate: false })
    const strange = settings.save({
      sendKey: 'shift-enter' as unknown as Settings['sendKey'],
      keepAwake: 'yes' as unknown as boolean,
      notifyDone: 'sometimes' as unknown as Settings['notifyDone'],
      notifyNeeds: 1 as unknown as Settings['notifyNeeds'],
      flashTaskbar: null as unknown as boolean,
      autoUpdate: 'on' as unknown as boolean,
    })
    const picked = (from: Settings) => [from.sendKey, from.keepAwake, from.notifyDone, from.notifyNeeds, from.flashTaskbar, from.autoUpdate]
    assert.deepEqual(picked(strange), ['ctrl-enter', false, 'always', 'never', false, false], 'a value that is not one of the choices changes nothing')
    const restarted = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.deepEqual(picked(restarted), ['ctrl-enter', false, 'always', 'never', false, false])
    fs.writeFileSync(file(), JSON.stringify({ sendKey: 'tab', keepAwake: 0, notifyDone: [], notifyNeeds: {}, flashTaskbar: 'false', autoUpdate: 1 }))
    const damaged = new SettingsService(dir, new FakeCipher(), 'win32').get()
    assert.deepEqual(picked(damaged), ['enter', true, 'background', 'background', true, true])
  })
})

describe('SettingsService chats folder', () => {
  // Chats live outside eNCode's own folder, which is `dir` here.
  let place = ''
  beforeEach(() => {
    place = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-chats-'))
  })
  afterEach(() => {
    fs.rmSync(place, { recursive: true, force: true })
  })
  const chats = () => path.join(place, 'Documents', 'eNCode')
  const home = () => path.join(place, 'home')
  const make = () => new SettingsService(dir, new FakeCipher(), process.platform, { chatsFolder: chats(), home: home() })

  it('works in the default folder until the person chooses one, and hands the renderer the folder in use', () => {
    const settings = make()
    assert.equal(settings.get().chatsFolder, chats())
    assert.equal(settings.get().chatsFolderDefault, chats())
    settings.save({ keepAwake: false })
    assert.doesNotMatch(onDisk(), /Documents/, 'the default is not written down, so a later default reaches whoever never chose')
  })

  it('keeps a folder chosen in the dialog across restarts, and goes back to the default', () => {
    const chosen = path.join(place, 'My chats')
    assert.equal(make().setChatsFolder(chosen).chatsFolder, chosen)
    assert.equal(make().get().chatsFolder, chosen)
    assert.equal(make().setChatsFolder(null).chatsFolder, chats())
    assert.equal(make().get().chatsFolder, chats())
    make().setChatsFolder(chats())
    assert.doesNotMatch(onDisk(), /Documents/, 'choosing the default folder is the same as not choosing')
  })

  it('never takes the folder from a save, which the window could send with any path in it', () => {
    const settings = make()
    const saved = settings.save({ chatsFolder: path.join(place, 'elsewhere') } as Partial<Settings>)
    assert.equal(saved.chatsFolder, chats())
  })

  it('refuses a folder that is not a whole path on this computer, and reads such a file as no choice', () => {
    const settings = make()
    assert.throws(() => settings.setChatsFolder('relative/chats'), /Choose a folder/)
    assert.throws(() => settings.setChatsFolder(`${place}\0x`), /Choose a folder/)
    assert.throws(() => settings.setChatsFolder(path.join(place, 'x'.repeat(1100))), /Choose a folder/)
    assert.equal(settings.get().chatsFolder, chats())
    fs.writeFileSync(file(), JSON.stringify({ chatsFolder: 'chats' }))
    assert.equal(make().get().chatsFolder, chats())
  })

  it("refuses a whole drive, the home folder, and a folder that holds eNCode's own files or lies in them, from the file too", () => {
    const settings = make()
    for (const folder of [path.parse(place).root, home(), dir, path.join(dir, 'chats'), path.dirname(dir)]) {
      assert.throws(() => settings.setChatsFolder(folder), /of its own/, folder)
    }
    assert.equal(settings.get().chatsFolder, chats())
    for (const folder of [dir, home(), path.parse(place).root]) {
      fs.writeFileSync(file(), JSON.stringify({ chatsFolder: folder }))
      assert.equal(make().get().chatsFolder, chats(), `${folder} in the file is no choice`)
    }
  })

  it('opens the chats folder like a project without listing it with the projects', () => {
    const settings = make()
    const project = path.join(place, 'project')
    settings.touchWorkspace(project)
    settings.touchWorkspace(chats())
    const after = settings.get()
    assert.deepEqual(after.recentWorkspaces, [project])
    assert.equal(after.lastWorkspace, chats(), 'it is still where eNCode opens next time')
  })
})
