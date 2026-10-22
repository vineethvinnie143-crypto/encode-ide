import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Sandbox, type SandboxEngine } from '@encode/sandbox'
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
