import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sandboxChangeProblem, setSandboxSetting } from './sandbox-settings'
import { loadSettingsSources, resolveSettings } from './settings'
import type { TrustFs } from './trust'

function memory(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  let writes = 0
  const fs: TrustFs = {
    read: async (file) => files.get(file) ?? null,
    writeAtomic: async (file, text) => {
      writes++
      files.set(file, text)
    },
  }
  return { files, fs, writes: () => writes }
}

const base = { home: '/home/u', platform: 'linux' as const }
const USER = '/home/u/.encode/settings.json'

describe('changing the sandbox from Settings', () => {
  it('writes the switch into the user’s own file and leaves the rest of it alone', async () => {
    const original = { model: 'x', permissions: { allow: ['Bash(ls:*)'] }, sandbox: { network: 'allow', denyWrite: ['~/keep'] } }
    const disk = memory({ [USER]: JSON.stringify(original) })
    assert.deepEqual(await setSandboxSetting({ ...base, fs: disk.fs, change: { key: 'network', value: 'block' } }), { ok: true, file: USER, changed: true })
    assert.deepEqual(JSON.parse(disk.files.get(USER)!), { ...original, sandbox: { network: 'block', denyWrite: ['~/keep'] } })
    assert.deepEqual(await setSandboxSetting({ ...base, fs: disk.fs, change: { key: 'network', value: 'block' } }), { ok: true, file: USER, changed: false })
    assert.equal(disk.writes(), 1)
    const fresh = memory()
    await setSandboxSetting({ ...base, fs: fresh.fs, change: { key: 'enabled', value: false } })
    assert.deepEqual(JSON.parse(fresh.files.get(USER)!), { sandbox: { enabled: false } })
  })

  it('is what the settings loader applies, and a folder cannot undo it', async () => {
    const disk = memory()
    await setSandboxSetting({ ...base, fs: disk.fs, change: { key: 'allowUnsandboxed', value: false } })
    const sources = await loadSettingsSources({ home: '/home/u', root: '/work', read: disk.fs.read, platform: 'linux' })
    assert.deepEqual(resolveSettings(sources, { folderApproved: false }).sandbox, [{ scope: 'user', config: { allowUnsandboxed: false } }])
  })

  it('never overwrites a file it cannot read as settings', async () => {
    for (const content of ['{ "sandbox": {', '[]', '"text"', '{"sandbox": "on"}', '{"sandbox": []}']) {
      const disk = memory({ [USER]: content })
      const result = await setSandboxSetting({ ...base, fs: disk.fs, change: { key: 'enabled', value: false } })
      assert.equal(result.ok, false, content)
      assert.equal(disk.files.get(USER), content)
    }
    const failing: TrustFs = { read: async () => Promise.reject(new Error('EACCES')), writeAtomic: async () => {} }
    assert.deepEqual(await setSandboxSetting({ ...base, fs: failing, change: { key: 'caches', value: false } }), { ok: false, reason: `${USER} could not be read: EACCES` })
    const readOnly: TrustFs = { read: async () => null, writeAtomic: async () => Promise.reject(new Error('EROFS')) }
    const refused = await setSandboxSetting({ ...base, fs: readOnly, change: { key: 'caches', value: false } })
    assert.equal(refused.ok, false)
  })

  it('refuses a setting that is not one of the switches, and a value of the wrong kind', () => {
    for (const change of [null, 'enabled', {}, { key: 'enabled' }, { key: 'enabled', value: 'yes' }, { key: 'network', value: true }, { key: 'allowWrite', value: ['/'] }, { key: 'network', value: 'maybe' }]) {
      assert.notEqual(sandboxChangeProblem(change), null, JSON.stringify(change))
    }
    for (const change of [{ key: 'enabled', value: true }, { key: 'required', value: false }, { key: 'allowUnsandboxed', value: false }, { key: 'caches', value: true }, { key: 'network', value: 'allow' }, { key: 'network', value: 'block' }]) {
      assert.equal(sandboxChangeProblem(change), null, JSON.stringify(change))
    }
  })
})
