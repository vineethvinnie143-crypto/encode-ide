/**
 * The scratch folder of each session (ADR 0141): made and removed with it, told to the agent, written without asking,
 * and no change to the project.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { messageText, type UserMessage } from '@encode/providers'
import { tempWorkspace } from '@encode/tools/testing'
import { CheckLedger, type ProjectCheck } from './checks'
import { toldScratch } from './environment'
import { createScratchStore, inScratch } from './scratch'
import type { Script } from './scripted'
import { closeHarnesses, hostHarness, loopHarness, stubShell } from './testing'

after(closeHarnesses)

const DAY = 24 * 60 * 60 * 1000

describe('the scratch store', () => {
  it("makes a session's folder, only its owner may open, at its real path, and removes it", async () => {
    const dir = path.join(await tempWorkspace(), 'scratch')
    const store = createScratchStore({ dir })
    const folder = await store.make('session-1')
    assert.equal(folder, path.join(await fs.realpath(dir), 'session-1'))
    assert.ok((await fs.stat(folder!)).isDirectory())
    if (process.platform !== 'win32') assert.equal((await fs.stat(folder!)).mode & 0o777, 0o700)
    assert.equal(await store.make('session-1'), folder, 'made again, the same folder')
    await store.remove('session-1')
    assert.equal(await fs.stat(folder!).catch(() => undefined), undefined)
  })

  it('makes no folder for an id that is not a session id', async () => {
    const dir = path.join(await tempWorkspace(), 'scratch')
    const store = createScratchStore({ dir })
    for (const id of ['../escape', 'a/b', '', '.', '..', 'x'.repeat(201)]) assert.equal(await store.make(id), undefined, id)
    await store.remove('..')
    await store.remove('.')
    assert.ok((await fs.stat(path.dirname(dir))).isDirectory(), 'nothing above the store is touched')
  })

  it('removes the folders nothing changed in for a week, but not those of open sessions or with recent work', async () => {
    const dir = path.join(await tempWorkspace(), 'scratch')
    let now = Date.now()
    const store = createScratchStore({ dir, now: () => now })
    const old = (await store.make('old'))!
    const open = (await store.make('open'))!
    const busy = (await store.make('busy'))!
    now += 8 * DAY
    // Work in a folder two levels down keeps it.
    await fs.mkdir(path.join(busy, 'probe'))
    await fs.writeFile(path.join(busy, 'probe', 'try.mjs'), 'console.log(1)\n')
    const later = new Date(now)
    await fs.utimes(path.join(busy, 'probe', 'try.mjs'), later, later)
    await store.tidy((id) => id === 'open')
    assert.equal(await fs.stat(old).catch(() => undefined), undefined)
    assert.ok(await fs.stat(open))
    assert.ok(await fs.stat(busy))
  })

  it('removes a link left in place of a folder, and not what it leads to', { skip: process.platform === 'win32' && 'links need rights on Windows' }, async () => {
    const dir = path.join(await tempWorkspace(), 'scratch')
    const elsewhere = await tempWorkspace({ 'keep.txt': 'mine\n' })
    const store = createScratchStore({ dir })
    const folder = (await store.make('linked'))!
    await fs.rm(folder, { recursive: true })
    await fs.symlink(elsewhere, folder)
    await store.remove('linked')
    assert.equal(await fs.lstat(folder).catch(() => undefined), undefined)
    assert.equal(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf8'), 'mine\n')
  })

  it('says which files lie in the folder', () => {
    assert.ok(inScratch('/data/scratch/s1', '/data/scratch/s1/probe.mjs', 'linux'))
    assert.ok(!inScratch('/data/scratch/s1', '/data/scratch/s10/probe.mjs', 'linux'))
    assert.ok(!inScratch('/data/scratch/s1', '/data/scratch/s1/../s2/probe.mjs', 'linux'))
    assert.ok(inScratch('C:\\Data\\scratch\\s1', 'c:\\data\\Scratch\\s1\\probe.mjs', 'win32'))
    assert.ok(!inScratch(undefined, '/data/scratch/s1/probe.mjs', 'linux'))
  })
})

const TEST: ProjectCheck = { command: 'npm test', kind: 'test', source: 'package.json' }

describe('what the agent writes in the scratch folder', () => {
  it('is written without asking, kept from nothing, and runs no checks', async () => {
    const scratch = await fs.realpath(await tempWorkspace())
    const ran: string[] = []
    const kept: string[] = []
    const ledger = new CheckLedger()
    const h = await loopHarness({
      script: [{ calls: [{ name: 'Write', input: { file_path: path.join(scratch, 'probe.test.mjs'), content: "import { slug } from '/work/src/slug.js'\n" } }] }, { text: 'Probed.' }],
      shell: (root) => ({
        ...stubShell(root),
        run: async (command) => {
          ran.push(command)
          return { output: 'ok', exitCode: 0, timedOut: false, interrupted: false, cwd: root }
        },
      }),
      services: { scratch, checks: { list: async () => [TEST], ledger }, beforeWrite: async (file) => void kept.push(file) },
    })
    assert.deepEqual(await h.run('probe it'), { kind: 'done', reply: 'Probed.' })
    assert.equal(h.surface.approvals.length, 0, 'not asked')
    assert.match(await fs.readFile(path.join(scratch, 'probe.test.mjs'), 'utf8'), /import \{ slug \}/)
    assert.deepEqual(kept, [], 'nothing kept to be put back')
    assert.equal(ledger.changedInRequest, false)
    assert.deepEqual(ran, [], 'no checks ran')
  })

  it('is still asked about outside the folder, and in the project it is a change like any other', async () => {
    const scratch = await fs.realpath(await tempWorkspace())
    const outside = await fs.realpath(await tempWorkspace())
    const ledger = new CheckLedger()
    const h = await loopHarness({
      scriptFor: (root) => [
        { calls: [{ name: 'Write', input: { file_path: path.join(root, 'src', 'a.ts'), content: 'export const a = 1\n' } }] },
        { calls: [{ name: 'Write', input: { file_path: path.join(outside, 'b.ts'), content: 'export const b = 1\n' } }] },
        { text: 'Done.' },
      ],
      services: { scratch, checks: { list: async () => [], ledger } },
    })
    h.surface.decide = () => false
    await h.run('write them')
    assert.equal(ledger.changedInRequest, true)
    assert.equal(h.surface.approvals.length, 1)
    assert.match(h.surface.approvals[0]!.reason ?? '', /outside the workspace/)
  })
})

/** The text of the user messages a request sent, its reminders among them. */
const sent = (messages: readonly { role: string }[]) =>
  messages
    .filter((message): message is UserMessage => message.role === 'user')
    .map((message) => messageText(message))
    .join('\n')

describe("a session's scratch folder", () => {
  it('is made when the session opens, named to the agent, written without asking, and goes with the session', async () => {
    let told: string | undefined
    const script: Script = (request, step) => {
      if (step > 0) return { text: 'done' }
      told = toldScratch(request.payload.messages)
      return { calls: [{ name: 'Write', input: { file_path: path.join(told ?? os.tmpdir(), 'probe.mjs'), content: 'console.log(1)\n' } }] }
    }
    const h = await hostHarness({ script })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'try the slug function', mode: 'code' })
    const folder = path.join(await fs.realpath(h.dir), 'scratch', session.id)
    assert.equal(told, folder)
    assert.match(sent(h.client.requests[0].payload.messages), /Put probes, throwaway scripts and scratch tests here, never in the project/)
    assert.equal(h.of('approval-request').length, 0, 'written without asking')
    assert.equal(await fs.readFile(path.join(folder, 'probe.mjs'), 'utf8'), 'console.log(1)\n')
    await h.host.remove(session.id)
    assert.equal(await fs.stat(folder).catch(() => undefined), undefined)
  })

  it("is open to the session inside eNCode's own folder, which stays off limits", async () => {
    const profile = await fs.realpath(await tempWorkspace({ 'keys.json': '{"key":"secret"}' }))
    const dir = path.join(profile, 'sessions')
    await fs.mkdir(dir)
    const script: Script = (request, step) => {
      const folder = toldScratch(request.payload.messages) ?? ''
      if (step === 0) return { calls: [{ name: 'Write', input: { file_path: path.join(folder, 'probe.mjs'), content: 'console.log(2)\n' } }] }
      if (step === 1) return { calls: [{ name: 'Read', input: { file_path: path.join(profile, 'keys.json') } }] }
      return { text: 'done' }
    }
    const h = await hostHarness({ settings: { policy: 'full-access' }, host: { dir, offLimits: { folders: [profile] } }, script })
    const session = await h.host.create()
    await h.host.start(session.id, { text: 'probe', mode: 'code' })
    assert.equal(await fs.readFile(path.join(dir, 'scratch', session.id, 'probe.mjs'), 'utf8'), 'console.log(2)\n')
    const last = JSON.stringify(h.client.requests.at(-1)!.payload.messages)
    assert.match(last, /eNCode's own folder/)
    assert.doesNotMatch(last, /secret/)
  })

  it('is told once to a chat from before scratch folders, and to a copy of a chat, whose folder is its own', async () => {
    const first = await hostHarness({ script: [{ text: 'one' }], host: { scratch: false } })
    const session = await first.host.create()
    await first.host.start(session.id, { text: 'one', mode: 'code' })
    assert.equal(toldScratch(first.client.requests[0].payload.messages), undefined)
    await first.host.dispose()

    const second = await hostHarness({ script: [{ text: 'two' }, { text: 'three' }, { text: 'copy' }], host: { dir: first.dir, workspace: first.root, home: first.home } })
    await second.host.start(session.id, { text: 'two', mode: 'code' })
    await second.host.start(session.id, { text: 'three', mode: 'code' })
    const scratch = path.join(await fs.realpath(first.dir), 'scratch', session.id)
    const reminders = (request: number) => sent(second.client.requests[request].payload.messages).match(/Your scratch folder for this chat/g)?.length ?? 0
    assert.equal(toldScratch(second.client.requests[0].payload.messages), scratch)
    assert.equal(reminders(1), 1, 'told once, and not again')

    const copy = await second.host.fork(session.id)
    await second.host.start(copy.id, { text: 'copy', mode: 'code' })
    assert.equal(toldScratch(second.client.requests[2].payload.messages), path.join(await fs.realpath(first.dir), 'scratch', copy.id))
  })
})
