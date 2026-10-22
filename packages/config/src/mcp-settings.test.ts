import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { disabledIn, setMcpServerOff } from './mcp-settings'
import { loadSettingsSources, resolveSettings } from './settings'
import { folderConfigDigest, type TrustFs } from './trust'

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

const base = { home: '/home/u', root: '/work', platform: 'linux' as const }
const USER = '/home/u/.encode/settings.json'
const LOCAL = '/work/.encode/settings.local.json'

describe('turning an MCP server off and on', () => {
  it('lists the server in the file of the scope asked for, and takes it out again', async () => {
    const disk = memory()
    assert.deepEqual(await setMcpServerOff({ ...base, fs: disk.fs, name: 'github', off: true, scope: 'local' }), { ok: true, file: LOCAL, changed: true })
    assert.deepEqual(JSON.parse(disk.files.get(LOCAL)!), { disabledMcpjsonServers: ['github'] })
    assert.deepEqual(await setMcpServerOff({ ...base, fs: disk.fs, name: 'files', off: true, scope: 'local' }), { ok: true, file: LOCAL, changed: true })
    assert.deepEqual(JSON.parse(disk.files.get(LOCAL)!), { disabledMcpjsonServers: ['github', 'files'] })
    assert.deepEqual(await setMcpServerOff({ ...base, fs: disk.fs, name: 'github', off: false, scope: 'local' }), { ok: true, file: LOCAL, changed: true })
    assert.deepEqual(JSON.parse(disk.files.get(LOCAL)!), { disabledMcpjsonServers: ['files'] })
    await setMcpServerOff({ ...base, fs: disk.fs, name: 'files', off: false, scope: 'local' })
    assert.deepEqual(JSON.parse(disk.files.get(LOCAL)!), {}, 'an empty list is not left behind')
    const user = await setMcpServerOff({ ...base, fs: disk.fs, name: 'mine', off: true, scope: 'user' })
    assert.equal(user.ok && user.file, USER)
  })

  it('changes nothing for a server that is already in the state asked for, and leaves the rest of the file alone', async () => {
    const original = { model: 'x', permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] }, hooks: { Stop: [] }, disabledMcpjsonServers: ['github'] }
    const disk = memory({ [LOCAL]: JSON.stringify(original) })
    assert.deepEqual(await setMcpServerOff({ ...base, fs: disk.fs, name: 'github', off: true, scope: 'local' }), { ok: true, file: LOCAL, changed: false })
    assert.deepEqual(await setMcpServerOff({ ...base, fs: disk.fs, name: 'other', off: false, scope: 'local' }), { ok: true, file: LOCAL, changed: false })
    assert.equal(disk.writes(), 0)
    await setMcpServerOff({ ...base, fs: disk.fs, name: 'other', off: true, scope: 'local' })
    assert.deepEqual(JSON.parse(disk.files.get(LOCAL)!), { ...original, disabledMcpjsonServers: ['github', 'other'] })
    const empty = memory()
    await setMcpServerOff({ ...base, fs: empty.fs, name: 'a', off: false, scope: 'user' })
    assert.equal(empty.writes(), 0, 'turning on a server that was never off does not make a file')
  })

  it('never overwrites a file it cannot read as settings', async () => {
    for (const content of ['{ "disabledMcpjsonServers": [', '[]', '"text"', '{"disabledMcpjsonServers": "github"}', '{"disabledMcpjsonServers": [1]}']) {
      const disk = memory({ [LOCAL]: content })
      const result = await setMcpServerOff({ ...base, fs: disk.fs, name: 'github', off: true, scope: 'local' })
      assert.equal(result.ok, false, content)
      assert.equal(disk.files.get(LOCAL), content)
    }
    const failing: TrustFs = { read: async () => Promise.reject(new Error('EACCES')), writeAtomic: async () => {} }
    assert.deepEqual(await setMcpServerOff({ ...base, fs: failing, name: 'a', off: true, scope: 'local' }), { ok: false, reason: `${LOCAL} could not be read: EACCES` })
    const unwritable: TrustFs = { read: async () => null, writeAtomic: async () => Promise.reject(new Error('EROFS')) }
    assert.deepEqual(await setMcpServerOff({ ...base, fs: unwritable, name: 'a', off: true, scope: 'local' }), { ok: false, reason: `${LOCAL} could not be written: EROFS` })
  })

  it('follows the platform', async () => {
    const disk = memory()
    const result = await setMcpServerOff({ home: 'C:\\Users\\u', root: 'D:\\ws', platform: 'win32', fs: disk.fs, name: 'a', off: true, scope: 'local' })
    assert.equal(result.ok && result.file, 'D:\\ws\\.encode\\settings.local.json')
  })

  it('what it saves is what the settings loader applies, in a folder that is not approved too, and does not change the approval', async () => {
    const disk = memory({ [LOCAL]: JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }) })
    const before = folderConfigDigest(await loadSettingsSources({ home: base.home, root: base.root, read: disk.fs.read, platform: 'linux' }))
    await setMcpServerOff({ ...base, fs: disk.fs, name: 'github', off: true, scope: 'local' })
    const sources = await loadSettingsSources({ home: base.home, root: base.root, read: disk.fs.read, platform: 'linux' })
    assert.deepEqual(resolveSettings(sources, { folderApproved: false }).mcp.disabled, ['github'])
    assert.equal(folderConfigDigest(sources), before)
    assert.deepEqual(disabledIn(sources, 'github'), [LOCAL])
    assert.deepEqual(disabledIn(sources, 'other'), [])
  })
})
