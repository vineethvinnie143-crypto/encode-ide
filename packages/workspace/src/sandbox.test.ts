import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, Sandbox, SandboxError, type GrantOutcome, type SandboxEngine } from '@encode/sandbox'
import { tempWorkspace } from '@encode/tools/testing'
import { sandboxActionProblem } from './sandbox-actions'
import { Workspaces } from './scope'

const json = (value: unknown) => JSON.stringify(value)

function engine(probe: { ok: boolean; reason?: string } = { ok: true }, unsupported?: SandboxEngine['unsupported']): SandboxEngine {
  return {
    name: 'bubblewrap',
    limits: { reads: true, network: true, protectedPaths: 'exact', processes: true },
    probe: async () => probe,
    prepare: async () => undefined,
    wrap: (spec) => spec,
    ...(unsupported ? { unsupported } : {}),
  }
}

async function setup(folderSettings: unknown | undefined, userSettings: unknown | undefined, probe?: { ok: boolean; reason?: string }, unsupported?: SandboxEngine['unsupported']) {
  const root = await fs.realpath(await tempWorkspace(folderSettings === undefined ? {} : { '.encode/settings.json': json(folderSettings) }))
  const home = await fs.realpath(await tempWorkspace(userSettings === undefined ? {} : { '.encode/settings.json': json(userSettings) }))
  const dir = await fs.realpath(await tempWorkspace())
  const sandbox = new Sandbox({ platform: process.platform, home, dir, engine: engine(probe, unsupported), env: {} })
  await sandbox.start()
  return { root, home, workspaces: new Workspaces({ home, platform: process.platform, sandbox }), sandbox }
}

describe('the Sandbox screen', () => {
  it('reports an active sandbox with what the engine can hold back and where the switches are saved', async () => {
    const { root, home, workspaces } = await setup(undefined, undefined)
    const report = await workspaces.sandboxReport(root)
    assert.equal(report.state, 'active')
    assert.equal(report.engine, 'bubblewrap')
    assert.deepEqual(report.limits, { reads: true, network: true, protectedPaths: 'exact', processes: true })
    assert.equal(report.settings.network, 'allow')
    assert.equal(report.settings.allowUnsandboxed, true)
    assert.deepEqual(report.tightened, [])
    assert.equal(report.file, path.join(home, '.encode', 'settings.json'))
  })

  it('says why it is off or cannot run, in words', async () => {
    const off = await setup(undefined, { sandbox: { enabled: false } })
    const offReport = await off.workspaces.sandboxReport(off.root)
    assert.equal(offReport.state, 'off')
    assert.match(offReport.reason ?? '', /turned off/)
    const broken = await setup(undefined, undefined, { ok: false, reason: 'bubblewrap is not installed.' })
    const brokenReport = await broken.workspaces.sandboxReport(broken.root)
    assert.equal(brokenReport.state, 'unavailable')
    assert.equal(brokenReport.reason, 'bubblewrap is not installed.')
    const none = new Workspaces({ home: broken.home, platform: process.platform })
    assert.equal((await none.sandboxReport(broken.root)).state, 'unavailable')
  })

  it('names the shell commands run in, and says so when the sandbox cannot confine it', async () => {
    const plain = await setup(undefined, undefined)
    const fine = await plain.workspaces.sandboxReport(plain.root)
    assert.equal(fine.state, 'active')
    assert.ok(fine.shell && !fine.shell.unsupported, 'the shell is named and nothing is said against it')
    const declined = await setup(undefined, undefined, undefined, (file) => (path.basename(file) === 'bash' || path.basename(file) === 'bash.exe' ? 'This shell cannot run in the sandbox.' : undefined))
    const report = await declined.workspaces.sandboxReport(declined.root)
    if (report.shell?.name === 'bash' || report.shell?.name === 'Git Bash') {
      assert.equal(report.state, 'unavailable')
      assert.equal(report.reason, 'This shell cannot run in the sandbox.')
      assert.equal(report.shell.unsupported, 'This shell cannot run in the sandbox.')
    }
  })

  it('asks for PowerShell unless the person turned it off, whatever a folder says', async () => {
    const preferOf = async (made: Awaited<ReturnType<typeof setup>>) => (await made.workspaces.scope({ sessionId: 's1', root: made.root, notice: () => undefined })).shell!().prefer
    const plain = await setup(undefined, undefined)
    assert.equal(await preferOf(plain), 'pwsh')
    assert.equal((await plain.workspaces.sandboxReport(plain.root)).settings.powershell, true)
    assert.equal(await preferOf(await setup({ sandbox: { powershell: false } }, undefined)), 'pwsh', 'a folder cannot turn it off')
    assert.equal(await preferOf(await setup(undefined, { sandbox: { powershell: false } })), undefined)
    assert.equal(await preferOf(await setup({ sandbox: { powershell: true } }, { sandbox: { powershell: false } })), 'pwsh', 'a folder can turn it on')
    // With the sandbox off there is nothing to make room for.
    assert.equal(await preferOf(await setup(undefined, { sandbox: { enabled: false } })), undefined)
  })

  it('shows what the folder tightened, and nothing it tried to loosen', async () => {
    const { root, workspaces } = await setup({ sandbox: { network: 'block', denyWrite: ['dist'], allowWrite: ['/'], allowUnsandboxed: true } }, { sandbox: { allowUnsandboxed: false } })
    const report = await workspaces.sandboxReport(root)
    assert.equal(report.settings.network, 'block')
    assert.deepEqual(report.settings.allowWrite, [])
    assert.equal(report.settings.allowUnsandboxed, false)
    assert.deepEqual(report.tightened, ["This folder's settings block the network for commands.", "This folder's settings keep 1 more path read-only."])
    assert.ok(report.problems.some((problem) => /allowWrite is only read from the user's settings/.test(problem)))
  })

  it('saves a switch into the person’s own file and reports the new state, and says when the folder overrules it', async () => {
    const { root, home, workspaces } = await setup({ sandbox: { network: 'block' } }, { model: 'x' })
    const set = await workspaces.sandboxAct(root, { type: 'set', key: 'allowUnsandboxed', value: false })
    assert.equal(set.ok, true)
    assert.equal(set.report.settings.allowUnsandboxed, false)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.encode', 'settings.json'), 'utf8')), { model: 'x', sandbox: { allowUnsandboxed: false } })
    const off = await workspaces.sandboxAct(root, { type: 'set', key: 'enabled', value: false })
    assert.equal(off.ok && off.report.state, 'off')
    const allowed = await workspaces.sandboxAct(root, { type: 'set', key: 'network', value: 'allow' })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.report.settings.network, 'block')
    assert.match(allowed.ok ? (allowed.note ?? '') : '', /this folder's own settings still decide here: it blocks the network/)
  })

  it('checks the machine again when asked, and refuses what is not an action', async () => {
    let probes = 0
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const dir = await fs.realpath(await tempWorkspace())
    const counting: SandboxEngine = { ...engine(), probe: async () => (++probes, { ok: true }) }
    const sandbox = new Sandbox({ platform: process.platform, home, dir, engine: counting, env: {} })
    const workspaces = new Workspaces({ home, platform: process.platform, sandbox })
    const first = await workspaces.sandboxReport(root)
    assert.equal(first.state, 'unavailable', 'before the first check there is no answer yet')
    await workspaces.sandboxAct(root, { type: 'recheck' })
    await workspaces.sandboxAct(root, { type: 'recheck' })
    assert.equal(probes, 2)
    for (const action of [null, 'x', {}, { type: 'delete' }, { type: 'set', key: 'allowWrite', value: ['/'] }, { type: 'set', key: 'enabled', value: 'no' }]) {
      assert.notEqual(sandboxActionProblem(action), null, JSON.stringify(action))
      const refused = await workspaces.sandboxAct(root, action as never)
      assert.equal(refused.ok, false)
    }
  })

  it('lists the folders the sandbox marked and takes the marks off, one or all', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const dir = await fs.realpath(await tempWorkspace())
    let marks = ['C:\\work\\shop', 'C:\\work\\api']
    const released: (readonly string[] | undefined)[] = []
    const marking: SandboxEngine = {
      ...engine(),
      marked: async () => marks,
      release: async (folders) => {
        released.push(folders)
        const done = folders ? marks.filter((folder) => folders.includes(folder)) : marks
        marks = marks.filter((folder) => !done.includes(folder))
        return done
      },
    }
    const sandbox = new Sandbox({ platform: process.platform, home, dir, engine: marking, env: {} })
    await sandbox.start()
    const workspaces = new Workspaces({ home, platform: process.platform, sandbox })
    assert.deepEqual((await workspaces.sandboxReport(root)).marked, ['C:\\work\\shop', 'C:\\work\\api'])

    const one = await workspaces.sandboxAct(root, { type: 'unmark', folders: ['C:\\work\\api'] })
    assert.equal(one.ok, true)
    assert.deepEqual(one.report.marked, ['C:\\work\\shop'])
    assert.match(one.ok ? (one.note ?? '') : '', /^Took the marks off C:\\work\\api\. A folder is marked again the next time/)
    const all = await workspaces.sandboxAct(root, { type: 'unmark' })
    assert.deepEqual(all.report.marked, [])
    assert.deepEqual(released, [['C:\\work\\api'], undefined])
    const none = await workspaces.sandboxAct(root, { type: 'unmark' })
    assert.match(none.ok ? (none.note ?? '') : '', /No folder had marks/)

    for (const action of [{ type: 'unmark', folders: 'C:\\' }, { type: 'unmark', folders: [''] }, { type: 'unmark', folders: [7] }]) assert.notEqual(sandboxActionProblem(action), null, JSON.stringify(action))
    // An engine that marks nothing (Linux, macOS) has none to show.
    assert.deepEqual((await (await setup(undefined, undefined)).workspaces.sandboxReport(root)).marked, [])
  })

  it('fixes a folder Windows refused the sandbox, after an administrator’s yes, and says what changed (ADR 0118)', async () => {
    const root = await fs.realpath(await tempWorkspace())
    const home = await fs.realpath(await tempWorkspace())
    const dir = await fs.realpath(await tempWorkspace())
    let allowed = false
    const answers: GrantOutcome[] = [{ ok: false, cancelled: true }, { ok: true, owner: true }]
    const fixing: SandboxEngine = {
      ...engine(),
      prepare: async (policy) => {
        if (!allowed && policy.writable.includes(root)) throw new SandboxError('no-permission', `Windows does not let this account change the security settings of ${root}.`, root)
      },
      grant: async () => {
        const answer = answers.shift()!
        if (answer.ok) allowed = true
        return answer
      },
    }
    const sandbox = new Sandbox({ platform: process.platform, home, dir, engine: fixing, env: {} })
    await sandbox.start()
    const workspaces = new Workspaces({ home, platform: process.platform, sandbox })
    const session = sandbox.session({ roots: () => [root], settings: () => ({ ...DEFAULT_SETTINGS, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] }) })
    await assert.rejects(session.wrapSpawn({ file: '/bin/sh', args: [], env: {}, cwd: root }))
    assert.deepEqual((await workspaces.sandboxReport(root)).blocked, [root])

    const no = await workspaces.sandboxAct(root, { type: 'fix', folder: root })
    assert.ok(no.ok && no.note === 'Nothing changed: Windows did not get an administrator’s yes.')
    assert.deepEqual(no.report.blocked, [root])

    const yes = await workspaces.sandboxAct(root, { type: 'fix', folder: root })
    assert.ok(yes.ok)
    assert.deepEqual(yes.report.blocked, [])
    assert.equal(yes.note, `Your account has Full control of ${root}, and the sandbox has marked it. Commands there run inside the sandbox again. Windows first had to make the account that said yes its owner.`)

    const again = await workspaces.sandboxAct(root, { type: 'fix', folder: root })
    assert.ok(!again.ok && /nothing to fix/.test(again.reason), 'a folder that works is not fixed again')
    for (const action of [{ type: 'fix' }, { type: 'fix', folder: '' }, { type: 'fix', folder: 7 }, { type: 'fix', folder: 'x'.repeat(5000) }]) assert.notEqual(sandboxActionProblem(action), null, JSON.stringify(action))
  })

  it('tells a listener when the sandbox changes', async () => {
    const { workspaces, sandbox } = await setup(undefined, undefined)
    let calls = 0
    const stop = workspaces.onSandboxChange(() => calls++)
    await sandbox.refresh()
    assert.ok(calls >= 1)
    stop()
    const after = calls
    await sandbox.refresh()
    assert.equal(calls, after)
  })
})
