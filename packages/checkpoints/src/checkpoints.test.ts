import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { blobFile, sha256 } from './blobs'
import { checkpointHooks } from './hooks'
import { parseManifest } from './manifest'
import { memoryFs } from './memory-fs'
import { CheckpointService } from './service'
import { checkpointDir, pruneStore } from './store'
import type { ApplyOutcome, ApplyResult } from './types'

function setup(options: { windows?: boolean; maxFileBytes?: number } = {}) {
  const windows = options.windows === true
  const api = windows ? path.win32 : path.posix
  const root = windows ? 'C:\\ws' : '/ws'
  const store = windows ? 'C:\\store\\w1' : '/store/w1'
  const mem = memoryFs({ windows })
  mem.mkdir(root)
  const notices: string[] = []
  let time = 1_000
  const make = (sessionId = 's1') =>
    new CheckpointService({
      fs: mem,
      dir: store,
      roots: [root],
      sessionId,
      platform: windows ? 'win32' : 'linux',
      now: () => ++time,
      maxFileBytes: options.maxFileBytes,
      notice: (text) => notices.push(text),
    })
  const service = make()
  const file = (relative: string) => api.join(root, ...relative.split('/'))
  const manifestFile = (sessionId = 's1') => api.join(store, 'sessions', `${sessionId}.jsonl`)
  let calls = 0

  /** An agent write the way the tools make one: the seam, the write, then the post hook. */
  async function write(turn: string, relative: string, text: string, svc = service) {
    const target = file(relative)
    const tool = `call-${++calls}`
    await svc.beforeWrite(target, mem.get(target) ?? null, { turnId: turn, toolUseId: tool })
    mem.put(target, text)
    await svc.afterTool(tool)
  }

  async function rewind(turn: string, force = false, svc = service) {
    const plan = await svc.planRewind(turn)
    const outcome = await svc.apply(plan, { force })
    return { plan, outcome }
  }

  return { api, root, store, mem, notices, service, make, file, manifestFile, write, rewind }
}

function done(outcome: ApplyOutcome): ApplyResult {
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.message)
  return outcome as ApplyResult
}

describe('rewinding', () => {
  it('puts files back to the start of a turn, and deletes what the turn created', async () => {
    const t = setup()
    t.mem.put(t.file('keep.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'keep.ts', 'one')
    await t.write('t1', 'new/dir/made.ts', 'made')
    await t.service.beginTurn('t2')
    await t.write('t2', 'keep.ts', 'two')
    await t.write('t2', 'keep.ts', 'three')

    const second = done((await t.rewind('t2')).outcome)
    assert.deepEqual(second.restored, [t.file('keep.ts')])
    assert.equal(t.mem.text(t.file('keep.ts')), 'one')
    assert.equal(t.mem.text(t.file('new/dir/made.ts')), 'made')

    const first = done((await t.rewind('t1')).outcome)
    assert.deepEqual(first.deleted, [t.file('new/dir/made.ts')])
    assert.equal(t.mem.text(t.file('keep.ts')), 'original')
    assert.equal(t.mem.get(t.file('new/dir/made.ts')), undefined)
    assert.equal(await t.mem.exists(t.file('new')), false, 'folders the write created go with it')
    assert.equal(await t.mem.exists(t.root), true)
  })

  it('keeps the version a turn found, however often the turn writes the file', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    for (const text of ['a', 'b', 'c']) await t.write('t1', 'a.ts', text)
    assert.deepEqual((await t.service.turns()).map((turn) => turn.files), [[t.file('a.ts')]])
    done((await t.rewind('t1')).outcome)
    assert.equal(t.mem.text(t.file('a.ts')), 'original')
  })

  it('rewinds to the turn it is asked for, not to the one before', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'zero')
    for (const [turn, text] of [['t1', 'one'], ['t2', 'two'], ['t3', 'three']]) {
      await t.service.beginTurn(turn)
      await t.write(turn, 'a.ts', text)
    }
    done((await t.rewind('t2')).outcome)
    assert.equal(t.mem.text(t.file('a.ts')), 'one')
    // Rewinding further reaches through the turn that was rewound away.
    done((await t.rewind('t1')).outcome)
    assert.equal(t.mem.text(t.file('a.ts')), 'zero')
  })

  it('says so when a turn has no history, and refuses to apply that', async () => {
    const t = setup()
    const plan = await t.service.planRewind('nope')
    assert.equal(plan.known, false)
    assert.deepEqual(plan.files, [])
    const outcome = await t.service.apply(plan)
    assert.deepEqual(outcome.ok === false && outcome.reason, 'unavailable')
  })

  it('leaves files alone that the turn did not change', async () => {
    const t = setup()
    t.mem.put(t.file('other.ts'), 'mine')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'x')
    t.mem.put(t.file('other.ts'), 'edited later')
    done((await t.rewind('t1')).outcome)
    assert.equal(t.mem.text(t.file('other.ts')), 'edited later')
  })

  it('keeps a folder that something else now lives in', async () => {
    const t = setup()
    await t.service.beginTurn('t1')
    await t.write('t1', 'new/a.ts', 'x')
    t.mem.put(t.file('new/user.txt'), 'mine')
    done((await t.rewind('t1')).outcome)
    assert.equal(t.mem.get(t.file('new/a.ts')), undefined)
    assert.equal(t.mem.text(t.file('new/user.txt')), 'mine')
  })

  it('records a turn that no hook announced', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'before')
    await t.write('late', 'a.ts', 'after')
    assert.deepEqual((await t.service.turns()).map((turn) => turn.turn), ['late'])
    done((await t.rewind('late')).outcome)
    assert.equal(t.mem.text(t.file('a.ts')), 'before')
  })

  it('works through the hooks the agent calls', async () => {
    const t = setup()
    const hooks = checkpointHooks(t.service)
    t.mem.put(t.file('a.ts'), 'before')
    await hooks.userPromptSubmit({ messageId: 'm1' })
    await t.service.beforeWrite(t.file('a.ts'), Buffer.from('before'), { turnId: 'm1', toolUseId: 'u1' })
    t.mem.put(t.file('a.ts'), 'after')
    await hooks.postToolUse({ toolUseId: 'u1' })
    const plan = await t.service.planRewind('m1')
    assert.equal(plan.files[0].conflict, false, 'what the hook recorded is what the agent left')
    done(await t.service.apply(plan))
    assert.equal(t.mem.text(t.file('a.ts')), 'before')
  })

  it('records writes made at the same time without mixing up the manifest', async () => {
    const t = setup()
    await t.service.beginTurn('t1')
    await Promise.all(Array.from({ length: 20 }, (_, index) => t.write('t1', `f${index}.ts`, `v${index}`)))
    const text = t.mem.text(t.manifestFile())!
    assert.equal(parseManifest(text).bad, 0)
    assert.equal((await t.service.turns())[0].files.length, 20)
  })
})

describe('conflicts', () => {
  it('flags a file someone else changed, and leaves it unless forced', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    t.mem.put(t.file('a.ts'), 'user edit')

    const plan = await t.service.planRewind('t1')
    assert.equal(plan.files[0].action, 'restore')
    assert.equal(plan.files[0].conflict, true)
    const kept = done(await t.service.apply(plan))
    assert.deepEqual(kept.restored, [])
    assert.match(kept.skipped[0].reason, /changed since the agent last wrote it/)
    assert.equal(t.mem.text(t.file('a.ts')), 'user edit')

    const forced = done(await t.service.apply(await t.service.planRewind('t1'), { force: true }))
    assert.deepEqual(forced.restored, [t.file('a.ts')])
    assert.equal(t.mem.text(t.file('a.ts')), 'original')

    // The user's version was kept, and comes back with the undo.
    const undo = await t.service.planRedo()
    assert.equal(undo?.files[0].conflict, false)
    done(await t.service.apply(undo!))
    assert.equal(t.mem.text(t.file('a.ts')), 'user edit')
    assert.equal(await t.service.canRedo(), false)
  })

  it('treats a file the user deleted as a conflict, and a created file the user edited too', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    await t.write('t1', 'made.ts', 'agent')
    await t.mem.remove(t.file('a.ts'))
    t.mem.put(t.file('made.ts'), 'user edit')
    const plan = await t.service.planRewind('t1')
    assert.deepEqual(plan.files.map((file) => [file.action, file.conflict]), [['restore', true], ['delete', true]])
    done(await t.service.apply(plan))
    assert.equal(t.mem.text(t.file('made.ts')), 'user edit')
    assert.equal(t.mem.get(t.file('a.ts')), undefined)

    done(await t.service.apply(await t.service.planRewind('t1'), { force: true }))
    assert.equal(t.mem.text(t.file('a.ts')), 'original')
    assert.equal(t.mem.get(t.file('made.ts')), undefined)
    const undo = done(await t.service.apply((await t.service.planRedo())!))
    assert.deepEqual(undo.deleted, [t.file('a.ts')], 'the user deleted it, so the undo deletes it again')
    assert.equal(t.mem.text(t.file('made.ts')), 'user edit')
  })

  it('does not call a file created by the turn and already gone a change', async () => {
    const t = setup()
    await t.service.beginTurn('t1')
    await t.write('t1', 'made.ts', 'agent')
    await t.mem.remove(t.file('made.ts'))
    const plan = await t.service.planRewind('t1')
    assert.deepEqual(plan.files.map((file) => [file.action, file.conflict]), [['unchanged', false]])
  })

  it('does not treat a write that never finished as a conflict while the file still holds the old bytes', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    // The seam ran, the write did not, and no post hook came.
    await t.service.beforeWrite(t.file('a.ts'), Buffer.from('original'), { turnId: 't1', toolUseId: 'u1' })
    t.mem.put(t.file('b.ts'), 'unrelated')
    const plan = await t.service.planRewind('t1')
    assert.deepEqual(plan.files.map((file) => file.action), ['unchanged'])
    // A write that did happen but was never confirmed is a conflict the user can override.
    t.mem.put(t.file('a.ts'), 'written, unconfirmed')
    assert.equal((await t.service.planRewind('t1')).files[0].conflict, true)
  })

  it('refuses a plan the files or the history have moved on from', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    const plan = await t.service.planRewind('t1')

    t.mem.put(t.file('a.ts'), 'edited meanwhile')
    const edited = await t.service.apply(plan, { force: true })
    assert.equal(edited.ok === false && edited.reason, 'stale')
    assert.equal(t.mem.text(t.file('a.ts')), 'edited meanwhile')

    const again = await t.service.planRewind('t1')
    await t.service.beginTurn('t2')
    await t.write('t2', 'b.ts', 'new file in a later turn')
    const grown = await t.service.apply(again, { force: true })
    assert.equal(grown.ok === false && grown.reason, 'stale')
    assert.equal(t.mem.text(t.file('a.ts')), 'edited meanwhile')
  })
})

describe('undoing a rewind', () => {
  it('restores what the rewind replaced', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    await t.write('t1', 'made.ts', 'made')
    done((await t.rewind('t1')).outcome)
    assert.equal(await t.service.canRedo(), true)
    const undo = done(await t.service.apply((await t.service.planRedo())!))
    assert.deepEqual([...undo.restored, ...undo.deleted].sort(), [t.file('a.ts'), t.file('made.ts')].sort())
    assert.equal(t.mem.text(t.file('a.ts')), 'agent')
    assert.equal(t.mem.text(t.file('made.ts')), 'made')
    assert.equal(await t.service.canRedo(), false)
    assert.equal(await t.service.planRedo(), null)
  })

  it('is offered only until the conversation moves on', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    done((await t.rewind('t1')).outcome)
    const undo = (await t.service.planRedo())!
    await t.service.beginTurn('t2')
    assert.equal(await t.service.canRedo(), false)
    const refused = await t.service.apply(undo)
    assert.equal(refused.ok === false && refused.reason, 'unavailable')
  })

  it('stays open when part of it had to be skipped', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    done((await t.rewind('t1')).outcome)
    t.mem.put(t.file('a.ts'), 'edited after the rewind')
    const partial = done(await t.service.apply((await t.service.planRedo())!))
    assert.equal(partial.skipped.length, 1)
    assert.equal(t.mem.text(t.file('a.ts')), 'edited after the rewind')
    assert.equal(await t.service.canRedo(), true)
    done(await t.service.apply((await t.service.planRedo())!, { force: true }))
    assert.equal(t.mem.text(t.file('a.ts')), 'agent')
    assert.equal(await t.service.canRedo(), false)
  })

  it('survives a rewind that failed half way', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'a original')
    t.mem.put(t.file('b.ts'), 'b original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'a agent')
    await t.write('t1', 'b.ts', 'b agent')
    t.mem.failWhen = (operation, target) => (operation === 'overwrite' && target === t.file('b.ts') ? new Error('disk full') : undefined)
    const broken = done((await t.rewind('t1')).outcome)
    assert.deepEqual(broken.restored, [t.file('a.ts')])
    assert.deepEqual(broken.failed, [{ path: t.file('b.ts'), error: 'disk full' }])
    assert.equal(t.mem.text(t.file('b.ts')), 'b agent')

    // Trying again finishes the job without calling the half-done file a conflict.
    t.mem.failWhen = () => undefined
    const retry = await t.rewind('t1')
    assert.deepEqual(retry.plan.files.map((file) => [file.action, file.conflict]), [['unchanged', false], ['restore', false]])
    done(retry.outcome)
    assert.equal(t.mem.text(t.file('b.ts')), 'b original')

    // And the undo of the latest rewind brings back the file it changed.
    done(await t.service.apply((await t.service.planRedo())!))
    assert.equal(t.mem.text(t.file('b.ts')), 'b agent')
    assert.equal(t.mem.text(t.file('a.ts')), 'a original')
  })
})

describe('what a rewind will not touch', () => {
  it('writes only inside the workspace and outside .git and .encode, whatever the history says', async () => {
    const t = setup()
    const evil = Buffer.from('pwned')
    const hash = sha256(evil)
    t.mem.put(blobFile(t.store, hash, t.api), gzipSync(evil))
    t.mem.mkdir('/outside')
    t.mem.link('/ws/link', '/outside')
    const snap = (file: string, extra: Record<string, unknown> = {}) => ({ t: 'snap', turn: 't1', tool: 'u', path: file, hash, size: 5, stored: true, at: 2, ...extra })
    const lines = [
      { t: 'turn', turn: 't1', at: 1 },
      snap('/etc/passwd'),
      snap('/ws/.git/hooks/pre-commit'),
      snap('/ws/sub/.ENCODE/settings.json'),
      snap('/ws/../etc/shadow'),
      snap('/ws/link/escape.txt'),
      snap('relative/path.txt'),
    ]
    t.mem.put(t.manifestFile(), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const plan = await t.service.planRewind('t1')
    assert.equal(plan.files.length, 6)
    assert.ok(plan.files.every((file) => file.action === 'skip'), JSON.stringify(plan.files))
    const reasons = plan.files.map((file) => file.reason)
    assert.equal(reasons.filter((reason) => reason === 'outside the workspace').length, 3)
    assert.equal(reasons.filter((reason) => /inside \.git or \.encode/.test(reason ?? '')).length, 2)
    assert.ok(reasons.includes('not an absolute path'))
    done(await t.service.apply(plan, { force: true }))
    for (const target of ['/etc/passwd', '/etc/shadow', '/outside/escape.txt', '/ws/.git/hooks/pre-commit', '/ws/sub/.ENCODE/settings.json']) {
      assert.equal(t.mem.get(target), undefined, target)
    }
  })

  it('removes no folder the history does not own', async () => {
    const t = setup()
    t.mem.mkdir(t.file('a'))
    const lines = [
      { t: 'turn', turn: 't1', at: 1 },
      { t: 'snap', turn: 't1', tool: 'u', path: t.file('x.ts'), hash: null, size: 0, stored: false, madeDir: t.root, at: 2 },
      { t: 'snap', turn: 't1', tool: 'u', path: t.file('a/y.ts'), hash: null, size: 0, stored: false, madeDir: t.file('other'), at: 3 },
    ]
    t.mem.put(t.manifestFile(), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    t.mem.put(t.file('x.ts'), 'x')
    t.mem.put(t.file('a/y.ts'), 'y')
    await t.service.beforeWrite(t.file('x.ts'), Buffer.from('x'), { turnId: 't1', toolUseId: 'v' })
    await t.service.afterTool('v')
    await t.service.beforeWrite(t.file('a/y.ts'), Buffer.from('y'), { turnId: 't1', toolUseId: 'w' })
    await t.service.afterTool('w')
    done(await t.service.apply(await t.service.planRewind('t1'), { force: true }))
    assert.equal(t.mem.get(t.file('x.ts')), undefined)
    assert.equal(await t.mem.exists(t.root), true)
    assert.equal(await t.mem.exists(t.file('a')), true)
  })

  it('skips a file whose saved copy is damaged, swapped or gone', async () => {
    const t = setup()
    for (const name of ['damaged', 'swapped', 'gone']) t.mem.put(t.file(`${name}.ts`), `${name} original`)
    await t.service.beginTurn('t1')
    for (const name of ['damaged', 'swapped', 'gone']) await t.write('t1', `${name}.ts`, `${name} agent`)
    const blob = (name: string) => blobFile(t.store, sha256(Buffer.from(`${name} original`)), t.api)
    t.mem.put(blob('damaged'), 'not gzip at all')
    t.mem.put(blob('swapped'), gzipSync(Buffer.from('some other content')))
    await t.mem.remove(blob('gone'))

    const { plan, outcome } = await t.rewind('t1')
    assert.deepEqual(plan.files.map((file) => file.reason), ['saved copy damaged', 'saved copy missing', 'saved copy damaged'])
    const result = done(outcome)
    assert.equal(result.restored.length, 0)
    assert.equal(result.skipped.length, 3)
    for (const name of ['damaged', 'swapped', 'gone']) assert.equal(t.mem.text(t.file(`${name}.ts`)), `${name} agent`)
  })

  it('does not copy files outside the workspace, and does not restore them', async () => {
    const t = setup()
    t.mem.put('/home/u/.bashrc', 'secret original')
    await t.service.beginTurn('t1')
    await t.service.beforeWrite('/home/u/.bashrc', Buffer.from('secret original'), { turnId: 't1', toolUseId: 'u1' })
    t.mem.put('/home/u/.bashrc', 'changed')
    await t.service.afterTool('u1')
    assert.deepEqual((await t.service.turns())[0].outside, ['/home/u/.bashrc'])
    assert.equal(t.mem.files().some((file) => file.includes('blobs')), false)
    const { plan, outcome } = await t.rewind('t1', true)
    assert.deepEqual(plan.files.map((file) => [file.action, file.reason]), [['skip', 'outside the workspace']])
    done(outcome)
    assert.equal(t.mem.text('/home/u/.bashrc'), 'changed')
  })

  it('follows a list of folders that changes while the session runs', async () => {
    const t = setup()
    const roots = [t.root]
    const service = new CheckpointService({ fs: t.mem, dir: t.store, roots: () => roots, sessionId: 'moving', platform: 'linux', now: () => 5 })
    const edit = async (turn: string, tool: string, text: string) => {
      await service.beforeWrite('/shared/lib.ts', t.mem.get('/shared/lib.ts') ?? null, { turnId: turn, toolUseId: tool })
      t.mem.put('/shared/lib.ts', text)
      await service.afterTool(tool)
    }
    t.mem.put('/shared/lib.ts', 'original')
    await service.beginTurn('t1')
    await edit('t1', 'u1', 'one')
    assert.deepEqual((await service.turns())[0].outside, ['/shared/lib.ts'], 'a folder that is not on the list is noted, not kept')

    roots.push('/shared')
    await service.beginTurn('t2')
    await edit('t2', 'u2', 'two')
    assert.deepEqual((await service.turns())[1].files, ['/shared/lib.ts'])
    const result = done(await service.apply(await service.planRewind('t2')))
    assert.deepEqual(result.restored, ['/shared/lib.ts'])
    assert.equal(t.mem.text('/shared/lib.ts'), 'one')

    roots.pop()
    const after = await service.planRewind('t2')
    assert.deepEqual(after.files.map((file) => [file.action, file.reason]), [['skip', 'outside the workspace']], 'a folder taken off the list is not written to')
  })

  it('cannot keep or restore a file larger than the limit', async () => {
    const t = setup({ maxFileBytes: 10 })
    t.mem.put(t.file('big.ts'), 'x'.repeat(40))
    t.mem.put(t.file('small.ts'), 'tiny')
    await t.service.beginTurn('t1')
    await t.write('t1', 'big.ts', 'now small')
    await t.write('t1', 'small.ts', 'y'.repeat(40))
    await t.write('t1', 'made.ts', 'z'.repeat(40))
    const { plan, outcome } = await t.rewind('t1')
    assert.deepEqual(
      plan.files.map((file) => [file.path.split('/').pop(), file.action, file.reason]),
      [['big.ts', 'skip', 'too large to keep a copy of'], ['made.ts', 'delete', undefined], ['small.ts', 'restore', undefined]],
    )
    const result = done(outcome)
    // Putting back "tiny" would throw away 40 bytes nothing keeps a copy of.
    assert.deepEqual(result.skipped.map((item) => item.path.split('/').pop()), ['big.ts', 'made.ts', 'small.ts'])
    assert.match(result.skipped[1].reason, /too large to keep a copy of before it is replaced/)
    assert.equal(t.mem.text(t.file('small.ts')), 'y'.repeat(40))
  })
})

describe('the history file', () => {
  it('reads past a torn last line and starts the next line cleanly', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    const whole = t.mem.text(t.manifestFile())!
    t.mem.put(t.manifestFile(), whole.slice(0, whole.length - 15))

    const reopened = t.make()
    assert.deepEqual((await reopened.turns()).map((turn) => turn.turn), ['t1'])
    assert.deepEqual(t.notices, ["1 damaged line in this session's checkpoint history was skipped."])
    await reopened.beginTurn('t2')
    const again = t.make()
    assert.deepEqual((await again.turns()).map((turn) => turn.turn), ['t1', 't2'])
    assert.equal(t.notices.length, 2, 'the torn line is still the only damaged one')
  })

  it('keeps going from where the session left off', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'agent')
    const resumed = t.make()
    await resumed.beginTurn('t2')
    await t.write('t2', 'a.ts', 'second', resumed)
    done((await t.rewind('t1', false, resumed)).outcome)
    assert.equal(t.mem.text(t.file('a.ts')), 'original')
  })

  it('rejects the write when the history cannot be saved, and recovers afterwards', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'original')
    t.mem.failWhen = (operation) => (operation === 'append' ? new Error('read-only file system') : undefined)
    await assert.rejects(t.service.beforeWrite(t.file('a.ts'), Buffer.from('original'), { turnId: 't1', toolUseId: 'u1' }), /read-only/)
    t.mem.failWhen = () => undefined
    await t.write('t1', 'a.ts', 'agent')
    assert.deepEqual((await t.service.turns())[0].files, [t.file('a.ts')])
  })

  it('tries again after a read of the history failed', async () => {
    const t = setup()
    t.mem.failWhen = (operation, target) => (operation === 'read' && target === t.manifestFile() ? new Error('EBUSY') : undefined)
    await assert.rejects(t.service.turns(), /EBUSY/)
    t.mem.failWhen = () => undefined
    assert.deepEqual(await t.service.turns(), [])
  })

  it('rejects ids that could not name a file or a turn', async () => {
    const t = setup()
    for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(200)]) {
      assert.throws(() => new CheckpointService({ fs: t.mem, dir: t.store, roots: [t.root], sessionId: bad }), /session id/)
    }
    assert.throws(() => t.service.beginTurn(''), /turn id/)
    await assert.rejects(t.service.beforeWrite('relative.ts', null, { turnId: 't1', toolUseId: 'u' }), /not absolute/)
  })

  it('keeps one copy of identical content', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'same')
    t.mem.put(t.file('b.ts'), 'same')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'x')
    await t.write('t1', 'b.ts', 'y')
    assert.equal(t.mem.files().filter((file) => file.includes('blobs')).length, 1)
  })
})

describe('Windows paths', () => {
  it('treats spellings that differ only in case as one file', async () => {
    const t = setup({ windows: true })
    t.mem.put(t.file('Src/A.ts'), 'original')
    await t.service.beginTurn('t1')
    await t.write('t1', 'Src/A.ts', 'one')
    await t.service.beforeWrite('c:\\WS\\src\\a.TS', Buffer.from('one'), { turnId: 't1', toolUseId: 'again' })
    t.mem.put('c:\\WS\\src\\a.TS', 'two')
    await t.service.afterTool('again')
    assert.equal((await t.service.turns())[0].files.length, 1)
    done((await t.rewind('t1')).outcome)
    assert.equal(t.mem.text(t.file('Src/A.ts')), 'original')
  })

  it('removes the folders a deleted file made, with backslashes', async () => {
    const t = setup({ windows: true })
    await t.service.beginTurn('t1')
    await t.write('t1', 'a/b/c.ts', 'x')
    done((await t.rewind('t1')).outcome)
    assert.equal(await t.mem.exists(t.file('a')), false)
    assert.equal(await t.mem.exists(t.root), true)
  })

  it('refuses files on other drives and UNC shares', async () => {
    const t = setup({ windows: true })
    await t.service.beginTurn('t1')
    await t.service.beforeWrite('D:\\other\\x.ts', null, { turnId: 't1', toolUseId: 'u1' })
    await t.service.beforeWrite('\\\\server\\share\\x.ts', null, { turnId: 't1', toolUseId: 'u2' })
    assert.equal((await t.service.turns())[0].outside.length, 2)
  })
})

describe('keeping the store small', () => {
  it('forgets old sessions and the blobs only they used', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'old session content')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'x')
    const recent = t.make('s2')
    t.mem.put(t.file('b.ts'), 'recent session content')
    await recent.beginTurn('u1')
    await t.write('u1', 'b.ts', 'y', recent)
    const unreferenced = blobFile(t.store, sha256(Buffer.from('nothing names me')), t.api)
    const fresh = blobFile(t.store, sha256(Buffer.from('written a moment ago')), t.api)
    t.mem.put(unreferenced, 'x')
    t.mem.put(fresh, 'x')

    const now = 10_000_000
    t.mem.touch(t.manifestFile('s1'), 0)
    t.mem.touch(t.manifestFile('s2'), now - 5)
    t.mem.touch(fresh, now - 10)
    const result = await pruneStore(t.mem, t.store, { maxAgeMs: 1_000_000, now, platform: 'linux' })
    assert.equal(result.sessions, 1)
    assert.equal(result.blobs, 2, 'the old session blob and the one nothing names')
    assert.equal(t.mem.get(t.manifestFile('s1')), undefined)
    assert.ok(t.mem.get(t.manifestFile('s2')))
    assert.ok(t.mem.get(blobFile(t.store, sha256(Buffer.from('recent session content')), t.api)))
    assert.equal(t.mem.get(blobFile(t.store, sha256(Buffer.from('old session content')), t.api)), undefined)
    assert.equal(t.mem.get(unreferenced), undefined)
    assert.ok(t.mem.get(fresh), 'a blob this young may belong to a snapshot another window is still recording')
  })

  it('deletes no blob when a manifest could not be read', async () => {
    const t = setup()
    t.mem.put(t.file('a.ts'), 'content')
    await t.service.beginTurn('t1')
    await t.write('t1', 'a.ts', 'x')
    t.mem.failWhen = (operation, target) => (operation === 'read' && target === t.manifestFile() ? new Error('EBUSY') : undefined)
    const result = await pruneStore(t.mem, t.store, { maxAgeMs: 1e12, now: 1e9, graceMs: 0, platform: 'linux' })
    assert.deepEqual(result, { sessions: 0, blobs: 0, bytes: 0 })
    assert.ok(t.mem.get(blobFile(t.store, sha256(Buffer.from('content')), t.api)))
  })

  it('names a workspace folder without its path', () => {
    const dir = checkpointDir('/home/u/.encode/checkpoints', '/work/app', 'linux')
    assert.match(dir, /^\/home\/u\/\.encode\/checkpoints\/[0-9a-f]{24}$/)
    assert.equal(dir, checkpointDir('/home/u/.encode/checkpoints', '/work/app/', 'linux'))
    assert.notEqual(dir, checkpointDir('/home/u/.encode/checkpoints', '/work/other', 'linux'))
    assert.equal(checkpointDir('C:\\s', 'C:\\Work\\App', 'win32'), checkpointDir('C:\\s', 'c:\\work\\app', 'win32'))
  })
})
