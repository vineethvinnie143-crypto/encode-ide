import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { memoryFs } from './memory-fs'
import { CheckpointService } from './service'

/**
 * Random sessions against a model of what a rewind should do.
 *
 * The model is deliberately plain: it keeps every write the agent made, in
 * order, and works out a rewind from the definition ("each file the agent
 * touched since the turn began goes back to what it held before the first of
 * those writes, unless someone else changed it") without any of the service's
 * indexes. The service has to agree on the files after every rewind and undo,
 * on which files it calls conflicts, and on whether an undo is on offer;
 * a service started afresh from the saved history has to agree with itself.
 *
 * Without outside edits there is a stronger oracle: a rewind must give back
 * the workspace exactly as it was when the turn began.
 */

const PATHS = ['a.ts', 'src/b.ts', 'src/deep/c.ts', 'd.ts']
const TEXTS = ['x', 'y', 'z']

type Op =
  | { op: 'turn' }
  | { op: 'agent'; file: number; text: number }
  | { op: 'user'; file: number; text: number | null }
  | { op: 'rewind'; back: number; force: boolean }
  | { op: 'redo'; force: boolean }

const fileIndex = gen.int(0, PATHS.length - 1)
const turnOp: Gen<Op> = () => ({ op: 'turn' })
const agentOp: Gen<Op> = gen.map(gen.tuple(fileIndex, gen.int(0, TEXTS.length - 1)), ([file, text]) => ({ op: 'agent', file, text }))
const userOp: Gen<Op> = gen.map(gen.tuple(fileIndex, gen.int(-1, TEXTS.length - 1)), ([file, text]) => ({ op: 'user', file, text: text < 0 ? null : text }))
const rewindOp: Gen<Op> = gen.map(gen.tuple(gen.int(0, 3), gen.oneOf(false, false, true)), ([back, force]) => ({ op: 'rewind', back, force }))
const redoOp: Gen<Op> = gen.map(gen.oneOf(false, false, true), (force) => ({ op: 'redo', force }))

const withoutOutsideEdits = gen.array(gen.weighted<Op>([5, agentOp], [3, turnOp], [3, rewindOp], [2, redoOp]))
const withOutsideEdits = gen.array(gen.weighted<Op>([5, agentOp], [3, turnOp], [3, rewindOp], [2, redoOp], [3, userOp]))

type Content = string | null
type Files = Map<string, Content>

interface Change {
  /** Where the file stood just before the rewind, and what the rewind put there. */
  before: Content
  after: Content
}

async function run(program: Op[]): Promise<void> {
  const mem = memoryFs()
  mem.mkdir('/ws')
  let clock = 0
  const open = () => new CheckpointService({ fs: mem, dir: '/store', roots: ['/ws'], sessionId: 's', platform: 'linux', now: () => ++clock })
  const service = open()
  const abs = (name: string) => `/ws/${name}`
  const onDisk = (name: string): Content => mem.text(abs(name)) ?? null
  const put = async (name: string, content: Content) => {
    if (content === null) await mem.remove(abs(name))
    else mem.put(abs(name), content)
  }

  // The model.
  const ws: Files = new Map(PATHS.map((name) => [name, null]))
  for (const name of ['a.ts', 'src/b.ts']) {
    ws.set(name, 'initial')
    mem.put(abs(name), 'initial')
  }
  let seq = 0
  let turns = 0
  let calls = 0
  let needTurn = true
  let live: { id: string; start: Files }[] = []
  const markers = new Map<string, number>()
  const writes: { seq: number; path: string; before: Content }[] = []
  const lastLeft = new Map<string, Content>()
  let undo: { changes: Map<string, Change>; ws: Files; live: typeof live } | undefined
  let edited = false

  const agree = async (what: string) => {
    for (const name of PATHS) assert.equal(onDisk(name), ws.get(name), `${what}: ${name} on disk`)
    assert.equal(await service.canRedo(), undo !== undefined, `${what}: undo on offer`)
  }

  for (const step of program) {
    if (step.op === 'turn' || (step.op === 'agent' && (needTurn || !live.length))) {
      const id = `t${++turns}`
      await service.beginTurn(id)
      live.push({ id, start: new Map(ws) })
      markers.set(id, ++seq)
      needTurn = false
      undo = undefined
    }
    if (step.op === 'agent') {
      const name = PATHS[step.file]
      const before = ws.get(name)!
      const after = TEXTS[step.text]
      const tool = `u${++calls}`
      await service.beforeWrite(abs(name), before === null ? null : Buffer.from(before), { turnId: live[live.length - 1].id, toolUseId: tool })
      mem.put(abs(name), after)
      ws.set(name, after)
      await service.afterTool(tool)
      writes.push({ seq: ++seq, path: name, before })
      lastLeft.set(name, after)
    } else if (step.op === 'user') {
      const name = PATHS[step.file]
      const content = step.text === null ? null : `user ${TEXTS[step.text]}`
      await put(name, content)
      ws.set(name, content)
      edited = true
    } else if (step.op === 'rewind' && live.length) {
      const index = Math.max(0, live.length - 1 - step.back)
      const target = live[index]
      const plan = await service.planRewind(target.id)

      const expected: Files = new Map(ws)
      const changes = new Map<string, Change>()
      const conflicts: string[] = []
      for (const name of PATHS) {
        const first = writes.find((write) => write.seq > markers.get(target.id)! && write.path === name)
        if (!first) continue
        const current = ws.get(name)!
        if (current === first.before) continue
        const conflict = current !== lastLeft.get(name)
        if (conflict) conflicts.push(abs(name))
        if (conflict && !step.force) continue
        expected.set(name, first.before)
        changes.set(name, { before: current, after: first.before })
      }
      assert.deepEqual(plan.files.filter((file) => file.conflict).map((file) => file.path), conflicts.sort(), 'conflicts')

      const outcome = await service.apply(plan, { force: step.force })
      assert.equal(outcome.ok, true)
      const before = new Map(ws)
      const liveBefore = [...live]
      for (const [name, content] of expected) ws.set(name, content)
      for (const [name, change] of changes) lastLeft.set(name, change.after)
      if (!edited) {
        for (const name of PATHS) assert.equal(onDisk(name), target.start.get(name), `the workspace as turn ${target.id} began: ${name}`)
      }
      live = live.slice(0, index)
      needTurn = true
      if (changes.size) undo = { changes, ws: before, live: liveBefore }
    } else if (step.op === 'redo') {
      const plan = await service.planRedo()
      if (!undo) {
        assert.equal(plan, null, 'no undo on offer')
      } else {
        assert.ok(plan, 'undo on offer')
        const expected: Files = new Map(ws)
        const done = new Map<string, Change>()
        let skipped = 0
        for (const [name, change] of undo.changes) {
          const current = ws.get(name)!
          if (current === change.before) continue
          const conflict = current !== change.after
          if (conflict && !step.force) {
            skipped++
            continue
          }
          expected.set(name, change.before)
          done.set(name, change)
        }
        const outcome = await service.apply(plan, { force: step.force })
        assert.equal(outcome.ok, true)
        for (const [name, content] of expected) ws.set(name, content)
        for (const [name, change] of done) lastLeft.set(name, change.before)
        if (!skipped) {
          if (!edited) for (const name of PATHS) assert.equal(onDisk(name), undo.ws.get(name), `the workspace as it was before the rewind: ${name}`)
          live = undo.live
          undo = undefined
        }
        needTurn = true
      }
    }
    await agree(JSON.stringify(step))
  }

  // A service started from the saved history agrees with the one that wrote it.
  const reopened = open()
  assert.equal(await reopened.canRedo(), undo !== undefined, 'undo after reopening')
  for (const turn of live) {
    const [a, b] = await Promise.all([service.planRewind(turn.id), reopened.planRewind(turn.id)])
    assert.equal(b.fingerprint, a.fingerprint, `plan for ${turn.id} after reopening`)
  }
}

describe('rewinding against a model', () => {
  it('gives back the workspace as the turn began when only the agent changes files', async () => {
    await check(withoutOutsideEdits, run, { maxSize: 30 })
  })

  it('agrees with the definition when files are also edited, deleted and re-created from outside', async () => {
    await check(withOutsideEdits, run, { maxSize: 30 })
  })
})
