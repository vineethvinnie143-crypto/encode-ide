import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, mock } from 'node:test'
import { readText, writeAtomic } from './node-fs'
import { loadSettingsSources, parseSettings, resolveSettings, type SettingsSource } from './settings'
import { canonicalJson, folderConfigDigest, TrustStore, trustWarning, type TrustFs } from './trust'

function memoryFiles(files: Record<string, string>) {
  return async (file: string) => (Object.hasOwn(files, file) ? files[file] : null)
}

function memoryTrustFs(): TrustFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: async (file) => files.get(file) ?? null,
    writeAtomic: async (file, text) => {
      files.set(file, text)
    },
  }
}

const HOME = '/home/u'
const ROOT = '/ws'

describe('settings files', () => {
  it('keeps valid entries and reports the rest', () => {
    const { settings, problems } = parseSettings(
      JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)', 3, ''], deny: 'Read(.env)', defaultMode: 'yolo' },
        env: { GOOD: '1', 'BAD-NAME': 'x', NUMBER: 2 },
        model: 'some/model',
        enableAllProjectMcpServers: 'yes',
        statusLine: { type: 'command' },
      }),
    )
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test:*)'] })
    assert.deepEqual(settings.env, { GOOD: '1' })
    assert.equal(settings.model, 'some/model')
    assert.deepEqual(settings.statusLine, { type: 'command' })
    assert.equal(problems.length, 7)
    assert.match(problems.join('\n'), /permissions\.allow\[1\]/)
    assert.match(problems.join('\n'), /permissions\.deny must be a list/)
    assert.match(problems.join('\n'), /defaultMode/)
    assert.match(problems.join('\n'), /BAD-NAME/)
  })

  it('reports files that are not JSON objects', () => {
    assert.match(parseSettings('{ "a": 1, }').problems[0], /not valid JSON/)
    assert.match(parseSettings('[1]').problems[0], /JSON object/)
    assert.deepEqual(parseSettings('\uFEFF{"model":"m"}').settings, { model: 'm' })
    assert.match(parseSettings(`{"x":"${'a'.repeat(1024 * 1024)}"}`).problems[0], /larger than 1 MB/)
    assert.match(parseSettings('{"__proto__": {"polluted": true}}').problems[0], /not a setting/)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  it('says which problems may have lost a restriction: a bad deny or ask list or entry, a file that does not parse, but not a bad allow entry', () => {
    const lost = (text: string) => parseSettings(text).unsafe
    assert.deepEqual(lost(JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 3], defaultMode: 'yolo', additionalDirectories: [1] }, env: { 'BAD-NAME': 'x' }, model: 4 })), [])
    assert.match(lost(JSON.stringify({ permissions: { deny: ['Read(./.env)', 7] } }))[0], /permissions\.deny\[1\]/)
    assert.match(lost(JSON.stringify({ permissions: { ask: 'Bash' } }))[0], /permissions\.ask must be a list/)
    assert.match(lost(JSON.stringify({ permissions: [] }))[0], /permissions must be an object/)
    assert.match(lost('{ "permissions": { "deny": [ }')[0], /not valid JSON/)
    assert.match(lost('[1]')[0], /JSON object/)
    assert.match(lost(`{"x":"${'a'.repeat(1024 * 1024)}"}`)[0], /larger than 1 MB/)
    assert.deepEqual(lost('{"permissions":{"deny":["Read(./.env)"],"allow":["Bash(ls:*)"]},"model":"m"}'), [])
  })

  it('loads user, project, local and command-line settings in order', async () => {
    const read = memoryFiles({
      '/home/u/.encode/settings.json': '{"model":"user"}',
      '/ws/.encode/settings.json': '{"model":"project"}',
      '/ws/.encode/settings.local.json': 'not json',
    })
    const sources = await loadSettingsSources({ home: HOME, root: ROOT, read, cli: { model: 'cli' }, platform: 'linux' })
    assert.deepEqual(sources.map((source) => source.scope), ['user', 'project', 'local', 'cli'])
    assert.match(sources[2].problems[0], /not valid JSON/)
    const failing = await loadSettingsSources({ home: HOME, root: ROOT, read: async () => { throw new Error('EACCES') }, platform: 'linux' })
    assert.match(failing[0].problems[0], /could not be read: EACCES/)
    assert.match(failing[0].unsafe[0], /could not be read: EACCES/)
    assert.deepEqual(sources[0].unsafe, [])
    assert.match(sources[2].unsafe[0], /not valid JSON/)
    const windows = await loadSettingsSources({
      home: 'C:\\Users\\u',
      root: 'D:\\ws',
      read: memoryFiles({ 'C:\\Users\\u\\.encode\\settings.json': '{"model":"user"}', 'D:\\ws\\.encode\\settings.local.json': '{}' }),
      platform: 'win32',
    })
    assert.deepEqual(windows.map((source) => [source.scope, source.file]), [
      ['user', 'C:\\Users\\u\\.encode\\settings.json'],
      ['local', 'D:\\ws\\.encode\\settings.local.json'],
    ])
  })
})

describe('resolveSettings', () => {
  const sources: SettingsSource[] = [
    { scope: 'user', file: 'u', problems: [], unsafe: [], settings: { permissions: { allow: ['Bash(ls:*)'], deny: ['Read(~/.ssh/**)'] }, model: 'a', env: { A: '1' } } },
    {
      scope: 'project',
      file: 'p',
      problems: ['bad entry', 'permissions.deny[1] must be a non-empty string'],
      unsafe: ['permissions.deny[1] must be a non-empty string'],
      settings: {
        permissions: { allow: ['Bash'], deny: ['Bash(curl:*)'], ask: ['Bash(git push:*)'], defaultMode: 'full-access' },
        hooks: { PreToolUse: [] },
        env: { NODE_OPTIONS: '--require=./x.js' },
        disabledMcpjsonServers: ['bad'],
        enableAllProjectMcpServers: true,
      },
    },
  ]

  it('applies only the restrictions of a folder that is not approved', () => {
    const effective = resolveSettings(sources, { folderApproved: false })
    assert.deepEqual(effective.rules, [
      { behavior: 'deny', text: 'Read(~/.ssh/**)', source: 'user' },
      { behavior: 'allow', text: 'Bash(ls:*)', source: 'user' },
      { behavior: 'deny', text: 'Bash(curl:*)', source: 'project' },
      { behavior: 'ask', text: 'Bash(git push:*)', source: 'project' },
    ])
    assert.equal(effective.defaultMode, undefined)
    assert.deepEqual(effective.env, { A: '1' })
    assert.deepEqual(effective.hooks, [])
    assert.deepEqual(effective.mcp, { enableAll: false, enabled: [], disabled: ['bad'] })
    assert.deepEqual(effective.heldBack, ['p: enableAllProjectMcpServers, env, hooks, permissions'])
    assert.deepEqual(effective.problems, ['p: bad entry', 'p: permissions.deny[1] must be a non-empty string'])
    assert.deepEqual(effective.unsafe, ['p: permissions.deny[1] must be a non-empty string'])
  })

  it('applies everything once the folder is approved, later sources winning single values', () => {
    const effective = resolveSettings(sources, { folderApproved: true })
    assert.equal(effective.rules.filter((rule) => rule.behavior === 'allow').length, 2)
    assert.equal(effective.defaultMode, 'full-access')
    assert.deepEqual(effective.env, { A: '1', NODE_OPTIONS: '--require=./x.js' })
    assert.deepEqual(effective.hooks, [{ scope: 'project', config: { PreToolUse: [] } }])
    assert.equal(effective.mcp.enableAll, true)
    assert.deepEqual(effective.heldBack, [])
  })
})

describe('workspace trust', () => {
  const project = (settings: SettingsSource['settings']): SettingsSource[] => [{ scope: 'project', file: 'p', problems: [], unsafe: [], settings }]

  it('digests only what a folder grants, independent of key order', () => {
    const a = folderConfigDigest(project({ permissions: { allow: ['Bash'], deny: ['x'] }, env: { A: '1', B: '2' } }))
    const b = folderConfigDigest(project({ env: { B: '2', A: '1' }, permissions: { deny: ['y', 'z'], allow: ['Bash'] } }))
    assert.equal(a, b)
    assert.notEqual(a, folderConfigDigest(project({ permissions: { allow: ['Bash(ls)'] }, env: { A: '1', B: '2' } })))
    assert.equal(folderConfigDigest(project({ permissions: { deny: ['Bash(curl:*)'] } })), null)
    assert.equal(folderConfigDigest([{ scope: 'user', problems: [], unsafe: [], settings: { env: { A: '1' } } }]), null)
    assert.equal(canonicalJson({ b: [1, { d: 1, c: undefined }], a: 'x' }), '{"a":"x","b":[1,{"d":1}]}')
  })

  it('turns folder settings off again when they change', async () => {
    const store = new TrustStore('/home/u/.encode/trust.json', memoryTrustFs(), false)
    const digest = folderConfigDigest(project({ hooks: { Stop: [] } }))
    assert.deepEqual(await store.state(ROOT, digest), { trusted: false, configApproved: false, configDigest: digest })
    await store.trust(ROOT, digest, 1000)
    assert.deepEqual(await store.state(ROOT, digest), { trusted: true, configApproved: true, configDigest: digest })
    const changed = folderConfigDigest(project({ hooks: { Stop: [{ hooks: [] }] } }))
    assert.equal((await store.state(ROOT, changed)).configApproved, false)
    assert.equal((await store.state(ROOT, changed)).trusted, true)
    await store.approveConfig(ROOT, changed!)
    assert.equal((await store.state(ROOT, changed)).configApproved, true)
    // A folder that grants nothing needs no approval beyond trust.
    assert.equal((await store.state(ROOT, null)).configApproved, true)
    await store.revoke(ROOT)
    assert.equal((await store.state(ROOT, null)).trusted, false)
  })

  it('does not inherit trust, and matches Windows paths without case', async () => {
    const posix = new TrustStore('/t.json', memoryTrustFs(), false)
    await posix.trust('/code', null)
    assert.equal((await posix.state('/code/new-clone', null)).trusted, false)
    const windows = new TrustStore('C:\\t.json', memoryTrustFs(), true)
    await windows.trust('C:\\Code\\App', null)
    assert.equal((await windows.state('c:\\code\\app', null)).trusted, true)
  })

  it('approves MCP servers one configuration at a time, and only in trusted folders', async () => {
    const store = new TrustStore('/t.json', memoryTrustFs(), false)
    await store.approveServer(ROOT, 'db', 'd1')
    assert.equal(await store.serverApproved(ROOT, 'db', 'd1'), false)
    await store.trust(ROOT, null)
    assert.equal(await store.serverApproved(ROOT, 'db', 'd1'), true)
    assert.equal(await store.serverApproved(ROOT, 'db', 'd2'), false)
    assert.equal(await store.serverApproved(ROOT, 'toString', 'x'), false)
    await store.revokeServer(ROOT, 'db')
    assert.equal(await store.serverApproved(ROOT, 'db', 'd1'), false)
  })

  it('trusts nothing when the store is unreadable', async () => {
    const files = memoryTrustFs()
    files.files.set('/t.json', '{ broken')
    const store = new TrustStore('/t.json', files, false)
    assert.equal((await store.get(ROOT)).trusted, false)
    files.files.set('/t.json', JSON.stringify({ version: 1, workspaces: { ['__proto__']: { trusted: true } } }))
    assert.equal((await store.get('__proto__')).trusted, true)
    assert.equal(({} as { trusted?: boolean }).trusted, undefined)
  })

  it('does not write over a trust file it could not read, which would forget every other folder', async () => {
    const files = memoryTrustFs()
    files.files.set('/t.json', JSON.stringify({ version: 1, workspaces: { '/other': { trusted: true } } }))
    let failing = true
    const store = new TrustStore('/t.json', { ...files, read: async (file) => (failing ? Promise.reject(new Error('EBUSY')) : files.read(file)) }, false)
    await assert.rejects(() => store.trust(ROOT, null), /EBUSY/)
    // Reading alone still counts a store it cannot read as one that trusts nothing.
    assert.equal((await store.get('/other')).trusted, false)
    failing = false
    await store.trust(ROOT, null)
    assert.equal((await store.get('/other')).trusted, true)
    assert.equal((await store.get(ROOT)).trusted, true)
  })

  it('warns before trusting a home folder or a drive root', () => {
    assert.match(trustWarning('/home/u', '/home/u', false)!, /home folder/)
    assert.match(trustWarning('C:\\', 'C:\\Users\\u', true)!, /root of a drive/)
    assert.equal(trustWarning('/home/u/app', '/home/u', false), null)
  })

  it('reads a file again when it fails the way one being replaced does, and gives up on the rest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-read-'))
    const file = path.join(dir, 'settings.json')
    await fs.writeFile(file, '{"ok":true}')
    const real = fs.readFile.bind(fs)
    const failures = ['EBUSY', 'EPERM']
    const spy = mock.method(fs, 'readFile', (async (target: Parameters<typeof fs.readFile>[0], options: Parameters<typeof fs.readFile>[1]) => {
      const code = failures.shift()
      if (code && target === file) throw Object.assign(new Error(code), { code })
      return real(target, options)
    }) as unknown as typeof fs.readFile)
    try {
      assert.equal(await readText(file), '{"ok":true}')
      assert.equal(spy.mock.callCount(), 3)
      // The third failure in a row is reported rather than hidden; a permanent error is not tried again.
      failures.push('EBUSY', 'EBUSY', 'EBUSY')
      await assert.rejects(() => readText(file), /EBUSY/)
      assert.equal(spy.mock.callCount(), 6)
      failures.length = 0
      failures.push('EISDIR')
      await assert.rejects(() => readText(file), /EISDIR/)
      assert.equal(spy.mock.callCount(), 7)
    } finally {
      spy.mock.restore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the store atomically on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-trust-'))
    try {
      const file = path.join(dir, 'nested', 'trust.json')
      await writeAtomic(file, '{"version":1,"workspaces":{}}\n')
      await writeAtomic(file, '{"version":1,"workspaces":{"x":{"trusted":true}}}\n')
      assert.equal(await readText(file), '{"version":1,"workspaces":{"x":{"trusted":true}}}\n')
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['trust.json'])
      assert.equal(await readText(path.join(dir, 'missing.json')), null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
