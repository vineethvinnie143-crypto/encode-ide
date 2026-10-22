import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, mock } from 'node:test'
import { folderConfigDigest, loadSettingsSources, nodeTrustFs, TrustStore } from '@encode/config'
import { withGitSafety, type DiskProbe, type RuleQuery } from '@encode/permissions'
import { tempWorkspace } from '@encode/tools/testing'
import { WorkspaceConfig } from './config'

/** A real folder, a home folder, and the config over them; nothing here touches the real home. */
async function setup(files: Record<string, string> = {}, homeFiles: Record<string, string> = {}) {
  const root = await fs.realpath(await tempWorkspace(files))
  const home = await fs.realpath(await tempWorkspace(homeFiles))
  const config = new WorkspaceConfig({ root, home })
  return { root, home, config }
}

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const json = (value: unknown) => JSON.stringify(value)

const query = (config: WorkspaceConfig, paths: string[], type: 'read' | 'write' = 'read') => config.current().rules.evaluate({ type, paths })

describe('a folder\'s settings', () => {
  it('start with no rules at all', async () => {
    const { config } = await setup()
    const snapshot = await config.refresh()
    assert.deepEqual(snapshot.effective.rules, [])
    assert.deepEqual(snapshot.problems, [])
    assert.equal(snapshot.folder.trusted, false)
    assert.equal(config.current(), snapshot)
  })

  it('refuse to be asked before they have been read', async () => {
    const { config } = await setup()
    assert.throws(() => config.current(), /have not been read yet/)
  })

  it('apply the user\'s rules at once, whether or not the folder is trusted', async () => {
    const { root, config } = await setup({}, { '.encode/settings.json': json({ permissions: { deny: ['Read(./.env)'], allow: ['Bash(npm test:*)'] } }) })
    await config.refresh()
    assert.equal(query(config, [path.join(root, '.env')])?.decision, 'deny')
    const assessed = await config.assessor('npm test', { root, cwd: root, home: root, env: withGitSafety({}, false), dialect: 'bash' })
    assert.equal(assessed.decision, 'allow')
    assert.equal(assessed.source, 'rule')
  })

  it('keep what the folder grants waiting until the folder is trusted and its settings approved, but apply what it takes away', async () => {
    const { root, home, config } = await setup({
      '.encode/settings.json': json({ permissions: { allow: ['Edit(/scripts/**)'], deny: ['Read(./private/**)'] } }),
    })
    let snapshot = await config.refresh()
    // Only the restriction applies.
    assert.equal(query(config, [path.join(root, 'private', 'a.txt')])?.decision, 'deny')
    assert.equal(query(config, [path.join(root, 'scripts', 'x.sh')], 'write'), null)
    assert.equal(snapshot.effective.heldBack.length, 1)
    assert.match(snapshot.effective.heldBack[0], /settings\.json: permissions/)

    // Trusting the folder approves the settings as they are.
    const digest = folderConfigDigest(snapshot.sources)
    await config.trustStore.trust(root, digest)
    snapshot = await config.refresh()
    assert.equal(snapshot.folder.trusted, true)
    assert.equal(snapshot.folder.configApproved, true)
    assert.equal(query(config, [path.join(root, 'scripts', 'x.sh')], 'write')?.decision, 'allow')
    assert.deepEqual(snapshot.effective.heldBack, [])

    // An edit to what the folder grants (a pull, or the agent itself) turns it off again until it is approved.
    await write(path.join(root, '.encode', 'settings.json'), json({ permissions: { allow: ['Edit(/scripts/**)', 'Edit(/src/**)'], deny: ['Read(./private/**)'] } }))
    snapshot = await config.refresh()
    assert.equal(snapshot.folder.trusted, true)
    assert.equal(snapshot.folder.configApproved, false)
    assert.equal(query(config, [path.join(root, 'scripts', 'x.sh')], 'write'), null)
    assert.ok(home)
  })

  it('see a change to a file at the next refresh, and keep the same picture when nothing changed', async () => {
    const { root, home, config } = await setup()
    const first = await config.refresh()
    assert.equal(await config.refresh(), first)
    await write(path.join(home, '.encode', 'settings.json'), json({ permissions: { deny: ['WebFetch(domain:evil.test)'] } }))
    const second = await config.refresh()
    assert.notEqual(second, first)
    assert.equal(config.current().rules.evaluate({ type: 'web', url: 'https://evil.test/x' })?.decision, 'deny')
    await write(path.join(root, '.encode', 'settings.local.json'), json({ permissions: { deny: ['Read(./a)'] } }))
    assert.notEqual(await config.refresh(), second)
  })

  it('see a trust change made elsewhere, such as the Settings screen in another window', async () => {
    const { root, home, config } = await setup({ '.encode/settings.local.json': json({ env: { MODE: 'x' } }) })
    const before = await config.refresh()
    assert.equal(before.folder.trusted, false)
    assert.deepEqual(before.effective.env, {})
    await new TrustStore(path.join(home, '.encode', 'trust.json'), nodeTrustFs, process.platform === 'win32').trust(root, folderConfigDigest(before.sources))
    const after = await config.refresh()
    assert.equal(after.folder.trusted, true)
    assert.deepEqual(after.effective.env, { MODE: 'x' })
  })

  it('rebuild when told to, whatever the files say', async () => {
    const { config } = await setup()
    const first = await config.refresh()
    config.invalidate()
    assert.notEqual(await config.refresh(), first)
  })

  it('refuse everything while a file is not JSON or a deny rule does not read, saying which, and recover when it is fixed', async () => {
    const { root, home, config } = await setup(
      { '.encode/settings.json': '{ nope' },
      { '.encode/settings.json': json({ permissions: { deny: ['Read(./.env)', 'not a rule at all (', 'Bash()'] } }) },
    )
    const snapshot = await config.refresh()
    assert.ok(snapshot.problems.some((problem) => /not valid JSON/.test(problem)), snapshot.problems.join('\n'))
    assert.ok(snapshot.problems.some((problem) => /not a rule/.test(problem) || /empty parentheses/.test(problem)), snapshot.problems.join('\n'))
    assert.match(snapshot.broken ?? '', /cannot tell what your settings forbid/)
    assert.match(snapshot.broken ?? '', /not valid JSON/)
    assert.match(snapshot.broken ?? '', /user settings/)
    // Not only the rules that failed: nothing runs, whatever it touches.
    const context = { root, cwd: root, home, env: withGitSafety({}, false), dialect: 'bash' as const }
    const queries: RuleQuery[] = [{ type: 'read', paths: [path.join(root, 'README.md')] }, { type: 'write', paths: [path.join(root, 'a.txt')] }, { type: 'web', url: 'https://example.com/' }]
    for (const query of queries) {
      assert.equal(config.rules.evaluate(query)?.decision, 'deny')
      assert.match(config.rules.evaluate(query)?.reason ?? '', /nothing runs until that is fixed/)
    }
    const shell = await config.assessor('ls', context)
    assert.equal(shell.decision, 'deny')
    assert.match(shell.reason ?? '', /nothing runs until that is fixed/)

    await write(path.join(root, '.encode', 'settings.json'), json({}))
    await write(path.join(home, '.encode', 'settings.json'), json({ permissions: { deny: ['Read(./.env)'] } }))
    const fixed = await config.refresh()
    assert.equal(fixed.broken, null)
    assert.equal(config.rules.evaluate({ type: 'read', paths: [path.join(root, 'README.md')] }), null)
    assert.equal(config.rules.evaluate({ type: 'read', paths: [path.join(root, '.env')] })?.decision, 'deny')
    assert.notEqual((await config.assessor('ls', context)).reason, shell.reason)
  })

  it('lose nothing over an allow rule that does not read, or a setting that is not valid, and say so', async () => {
    const { root, config } = await setup({}, {
      '.encode/settings.json': json({ permissions: { allow: ['Bash()', 'Bash(npm test:*)', 4], defaultMode: 'yolo' }, model: 3 }),
    })
    const snapshot = await config.refresh()
    assert.equal(snapshot.broken, null)
    assert.ok(snapshot.problems.length >= 3, snapshot.problems.join('\n'))
    assert.equal(config.rules.evaluate({ type: 'read', paths: [path.join(root, 'a')] }), null)
  })

  it('count a deny rule that cannot be anchored as lost, since it would have stopped something', async () => {
    const { config } = await setup({}, { '.encode/settings.json': json({ permissions: { deny: ['Read(~nobody-at-all/secrets/**)'] } }) })
    const snapshot = await config.refresh()
    assert.ok(snapshot.problems.some((problem) => /cannot be anchored/.test(problem)), snapshot.problems.join('\n'))
    assert.match(snapshot.broken ?? '', /could not be applied/)
  })

  it('refuse everything when a file cannot be read, rather than carry on without what it said', async () => {
    const { root, home } = await setup()
    let failing = true
    const config = new WorkspaceConfig({
      root,
      home,
      fs: {
        ...(await import('./fs')).nodeWorkspaceFs,
        read: async (file) => {
          if (failing && file.endsWith('settings.local.json')) throw new Error('EACCES')
          return null
        },
      },
    })
    const snapshot = await config.refresh()
    assert.ok(snapshot.problems.some((problem) => /could not be read: EACCES/.test(problem)), snapshot.problems.join('\n'))
    assert.match(snapshot.broken ?? '', /could not be read: EACCES/)
    assert.equal(config.rules.evaluate({ type: 'read', paths: [path.join(root, 'a')] })?.decision, 'deny')
    failing = false
    assert.equal((await config.refresh()).broken, null)
  })

  it('refuse everything when the picture cannot be rebuilt, and try again at the next call', async () => {
    const { root, config } = await setup({ '.encode/settings.json': json({ permissions: { deny: ['Read(./.env)'] } }) })
    await config.refresh()
    const query: RuleQuery = { type: 'read', paths: [path.join(root, 'README.md')] }
    assert.equal(config.rules.evaluate(query), null)
    const state = mock.method(config.trustStore, 'state', async () => {
      throw new Error('trust store gone')
    })
    try {
      config.invalidate()
      const failed = await config.refresh()
      assert.match(failed.broken ?? '', /could not read this folder's settings again \(trust store gone\)/)
      assert.equal(config.rules.evaluate(query)?.decision, 'deny')
      // Still failing: still refusing, and still asking again.
      assert.equal((await config.refresh()).broken === null, false)
    } finally {
      state.mock.restore()
    }
    assert.equal((await config.refresh()).broken, null)
    assert.equal(config.rules.evaluate(query), null)
    assert.equal(config.rules.evaluate({ type: 'read', paths: [path.join(root, '.env')] })?.decision, 'deny')
  })

  it('tell the caller when the first picture cannot be built', async () => {
    const { root, home } = await setup()
    const config = new WorkspaceConfig({ root, home })
    const state = mock.method(config.trustStore, 'state', async () => {
      throw new Error('trust store gone')
    })
    try {
      await assert.rejects(() => config.refresh(), /trust store gone/)
    } finally {
      state.mock.restore()
    }
    assert.equal((await config.refresh()).broken, null)
  })

  it('turn additional directories into real paths: relative to the folder, or to home', async () => {
    const parent = await fs.realpath(await tempWorkspace({ 'shared/lib.ts': 'x', 'app/.encode/settings.json': json({ permissions: { additionalDirectories: ['../shared', '~/docs', '/nowhere/at/all'] } }) }))
    const root = path.join(parent, 'app')
    const home = await fs.realpath(await tempWorkspace({ 'docs/readme.md': 'x' }))
    const config = new WorkspaceConfig({ root, home })
    // The folder's own settings grant directories only once it is trusted and approved.
    assert.deepEqual((await config.refresh()).extraRoots, [])
    await config.trustStore.trust(root, folderConfigDigest(await loadSettingsSources({ home, root, read: nodeTrustFs.read })))
    const { extraRoots } = await config.refresh()
    assert.deepEqual(extraRoots, [path.join(parent, 'shared'), path.join(home, 'docs'), path.resolve('/nowhere/at/all')])
  })

  it('let git run unasked only in a trusted folder', async () => {
    const { root, home } = await setup()
    const probe: DiskProbe = { rootReal: root, realPath: async (target) => target, locate: () => [process.platform === 'win32' ? 'C:\\Git\\git.exe' : '/usr/bin/git'], exists: async () => false }
    const config = new WorkspaceConfig({ root, home, probe })
    const context = { root, cwd: root, home, env: withGitSafety({}, process.platform === 'win32'), dialect: 'bash' as const }
    await config.refresh()
    assert.equal((await config.assessor('git status', context)).decision, 'ask')
    await config.trustStore.trust(root, null)
    await config.refresh()
    assert.equal((await config.assessor('git status', context)).decision, 'allow')
  })

  it('share one read among callers that arrive together', async () => {
    const { root, home } = await setup()
    let reads = 0
    const base = (await import('./fs')).nodeWorkspaceFs
    const config = new WorkspaceConfig({ root, home, fs: { ...base, read: async (file) => (reads++, base.read(file)) } })
    await Promise.all([config.refresh(), config.refresh(), config.refresh()])
    // Four files, once; the build reads three of them again for the rules.
    assert.ok(reads <= 8, `read ${reads} times`)
  })
})
