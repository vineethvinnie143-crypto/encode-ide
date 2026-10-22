import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { nodeCheckpointFs } from './node-fs'
import { CheckpointService } from './service'
import { checkpointDir, pruneStore } from './store'
import type { ApplyOutcome, ApplyResult } from './types'

async function workspace() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-checkpoints-')))
  const root = path.join(base, 'ws')
  await fs.mkdir(root)
  const store = checkpointDir(path.join(base, 'store'), root)
  const disk = nodeCheckpointFs()
  const service = new CheckpointService({ fs: disk, dir: store, roots: [root], sessionId: 'disk-session' })
  let calls = 0
  /** An agent write the way the tools make one. */
  async function write(turn: string, file: string, bytes: Buffer) {
    const previous = await fs.readFile(file).catch(() => null)
    const tool = `call-${++calls}`
    await service.beforeWrite(file, previous, { turnId: turn, toolUseId: tool })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes)
    await service.afterTool(tool)
  }
  return { base, root, store, disk, service, write, cleanup: () => fs.rm(base, { recursive: true, force: true }) }
}

function done(outcome: ApplyOutcome): ApplyResult {
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.message)
  return outcome as ApplyResult
}

describe('checkpoints on a real disk', () => {
  it('rewinds and undoes byte for byte, including a byte order mark and CRLF', async () => {
    const t = await workspace()
    try {
      const keep = path.join(t.root, 'keep.txt')
      const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\r\nline two\r\n\u00e9')])
      await fs.writeFile(keep, original)
      await t.service.beginTurn('t1')
      await t.write('t1', keep, Buffer.from('rewritten\n'))
      const made = path.join(t.root, 'new', 'nested', 'made.txt')
      await t.write('t1', made, Buffer.from('made'))

      const plan = await t.service.planRewind('t1')
      assert.deepEqual(plan.files.map((file) => [path.basename(file.path), file.action, file.conflict]), [['keep.txt', 'restore', false], ['made.txt', 'delete', false]])
      done(await t.service.apply(plan))
      assert.ok((await fs.readFile(keep)).equals(original))
      assert.equal(await fs.stat(path.join(t.root, 'new')).then(() => true, () => false), false)

      done(await t.service.apply((await t.service.planRedo())!))
      assert.equal(await fs.readFile(keep, 'utf8'), 'rewritten\n')
      assert.equal(await fs.readFile(made, 'utf8'), 'made')
    } finally {
      await t.cleanup()
    }
  })

  it('keeps the history after the service is started again', async () => {
    const t = await workspace()
    try {
      const file = path.join(t.root, 'a.txt')
      await fs.writeFile(file, 'before')
      await t.service.beginTurn('t1')
      await t.write('t1', file, Buffer.from('after'))
      const again = new CheckpointService({ fs: t.disk, dir: t.store, roots: [t.root], sessionId: 'disk-session' })
      done(await again.apply(await again.planRewind('t1')))
      assert.equal(await fs.readFile(file, 'utf8'), 'before')
    } finally {
      await t.cleanup()
    }
  })

  it('does not follow a link out of the workspace', async (context) => {
    const t = await workspace()
    try {
      const outside = path.join(t.base, 'outside')
      await fs.mkdir(outside)
      const link = path.join(t.root, 'link')
      try {
        await fs.symlink(outside, link, 'junction')
      } catch {
        context.skip('this system does not allow creating links')
        return
      }
      const target = path.join(link, 'x.txt')
      await fs.writeFile(path.join(outside, 'x.txt'), 'outside original')
      await t.service.beginTurn('t1')
      await t.write('t1', target, Buffer.from('changed'))

      assert.deepEqual((await t.service.turns())[0].outside, [target])
      assert.deepEqual((await t.service.turns())[0].files, [])
      const plan = await t.service.planRewind('t1')
      assert.deepEqual(plan.files.map((file) => [file.action, file.reason]), [['skip', 'outside the workspace']])
      done(await t.service.apply(plan, { force: true }))
      assert.equal(await fs.readFile(path.join(outside, 'x.txt'), 'utf8'), 'changed')
    } finally {
      await t.cleanup()
    }
  })

  it('creates store files private to the user', async (context) => {
    if (process.platform === 'win32') {
      context.skip('Windows keeps the profile folder permissions')
      return
    }
    const t = await workspace()
    try {
      const file = path.join(t.root, 'a.txt')
      await fs.writeFile(file, 'secret')
      await t.service.beginTurn('t1')
      await t.write('t1', file, Buffer.from('x'))
      const manifest = path.join(t.store, 'sessions', 'disk-session.jsonl')
      assert.equal((await fs.stat(manifest)).mode & 0o777, 0o600)
      assert.equal((await fs.stat(path.dirname(manifest))).mode & 0o777, 0o700)
      const blobs = await fs.readdir(path.join(t.store, 'blobs'))
      const blob = path.join(t.store, 'blobs', blobs[0], (await fs.readdir(path.join(t.store, 'blobs', blobs[0])))[0])
      assert.equal((await fs.stat(blob)).mode & 0o777, 0o600)
    } finally {
      await t.cleanup()
    }
  })

  it('writes a blob once even when several writers save it at the same moment', async () => {
    const t = await workspace()
    try {
      const file = path.join(t.store, 'blobs', 'ab', 'abcdef')
      await Promise.all(Array.from({ length: 20 }, () => t.disk.writeOnce(file, Buffer.from('same bytes'))))
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['abcdef'])
      assert.equal(await fs.readFile(file, 'utf8'), 'same bytes')
    } finally {
      await t.cleanup()
    }
  })

  it('forgets old sessions and unused blobs on disk', async () => {
    const t = await workspace()
    try {
      const file = path.join(t.root, 'a.txt')
      await fs.writeFile(file, 'content')
      await t.service.beginTurn('t1')
      await t.write('t1', file, Buffer.from('x'))
      const manifest = path.join(t.store, 'sessions', 'disk-session.jsonl')
      const old = new Date(Date.now() - 90 * 24 * 3600 * 1000)
      await fs.utimes(manifest, old, old)
      const blobFolder = path.join(t.store, 'blobs')
      for (const group of await fs.readdir(blobFolder)) {
        for (const blob of await fs.readdir(path.join(blobFolder, group))) await fs.utimes(path.join(blobFolder, group, blob), old, old)
      }
      const result = await pruneStore(t.disk, t.store, { maxAgeMs: 30 * 24 * 3600 * 1000 })
      assert.equal(result.sessions, 1)
      assert.equal(result.blobs, 1)
      assert.equal(await fs.stat(manifest).then(() => true, () => false), false)
    } finally {
      await t.cleanup()
    }
  })

  it('answers the way the service expects about missing files and folders', async () => {
    const t = await workspace()
    try {
      const folder = path.join(t.root, 'a', 'b')
      assert.equal(await t.disk.read(path.join(folder, 'missing.txt')), null)
      assert.equal(await t.disk.exists(folder), false)
      assert.equal(await t.disk.realpath(path.join(folder, 'c.txt')), path.join(t.root, 'a', 'b', 'c.txt'))
      assert.deepEqual(await t.disk.list(folder), [])
      assert.equal(await t.disk.size?.(path.join(folder, 'c.txt')), null)
      await t.disk.overwrite(path.join(folder, 'c.txt'), Buffer.from('c'))
      assert.equal(await t.disk.size?.(path.join(folder, 'c.txt')), 1)
      assert.equal(await t.disk.size?.(folder), null, 'a folder is not a file')
      assert.equal(await t.disk.removeEmptyDir(folder), false, 'not empty')
      await t.disk.remove(path.join(folder, 'c.txt'))
      await t.disk.remove(path.join(folder, 'c.txt'))
      assert.equal(await t.disk.removeEmptyDir(folder), true)
      assert.equal(await t.disk.removeEmptyDir(folder), false, 'gone')
      assert.deepEqual((await t.disk.list(path.join(t.root, 'a'))).map((entry) => entry.name), [])
    } finally {
      await t.cleanup()
    }
  })
})
