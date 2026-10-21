import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEntry } from '../../shared/types'
import { applySessionPatch, newSessionMeta, previewOf, readSessionMeta, sessionsToKeep, type SessionMeta } from './sessions'

const entry = (kind: ConversationEntry['kind'], text: string): ConversationEntry => ({
  id: `${kind}-${text.length}`,
  kind,
  text,
  createdAt: 0,
})

describe('session metadata', () => {
  it('reads a session saved by an earlier build, which had no marks', () => {
    const meta = readSessionMeta({ id: 'a', title: 'Fix login', createdAt: 5, updatedAt: 9, messages: [] }, 100)
    assert.deepEqual(meta, {
      id: 'a',
      title: 'Fix login',
      createdAt: 5,
      updatedAt: 9,
      projectRoot: null,
      pinned: false,
      archived: false,
      unread: false,
    })
  })

  it('refuses entries without an id and repairs bad fields', () => {
    assert.equal(readSessionMeta({ title: 'x' }), null)
    assert.equal(readSessionMeta('a'), null)
    const meta = readSessionMeta({ id: 'b', title: '  ', createdAt: 'yesterday', pinned: 'yes', projectRoot: '' }, 42)
    assert.equal(meta?.title, 'New session')
    assert.equal(meta?.createdAt, 42)
    assert.equal(meta?.pinned, false)
    assert.equal(meta?.projectRoot, null)
  })

  it('creates sessions with a trimmed title in a project or standalone', () => {
    const meta = newSessionMeta('c', `  ${'t'.repeat(120)}  `, 'C:/work/app', 7)
    assert.equal(meta.title.length, 90)
    assert.equal(meta.projectRoot, 'C:/work/app')
    assert.equal(newSessionMeta('d', '', null).title, 'New session')
  })
})

describe('session patches', () => {
  const base = (): SessionMeta => newSessionMeta('s', 'Session', 'C:/work/app', 1)

  it('changes only the fields it names, with the right types', () => {
    const meta = base()
    assert.equal(applySessionPatch(meta, { pinned: true, unread: 'yes', title: 42, extra: 1 }), true)
    assert.deepEqual([meta.pinned, meta.unread, meta.title], [true, false, 'Session'])
    assert.equal(applySessionPatch(meta, { pinned: true }), false, 'no change, nothing to save')
    assert.equal(applySessionPatch(meta, null), false)
  })

  it('moves a session between projects and to standalone', () => {
    const meta = base()
    applySessionPatch(meta, { projectRoot: 'D:/other' })
    assert.equal(meta.projectRoot, 'D:/other')
    applySessionPatch(meta, { projectRoot: null })
    assert.equal(meta.projectRoot, null)
    applySessionPatch(meta, { projectRoot: 7 })
    assert.equal(meta.projectRoot, null)
  })

  it('unpins a session it archives', () => {
    const meta = base()
    applySessionPatch(meta, { pinned: true })
    applySessionPatch(meta, { archived: true })
    assert.deepEqual([meta.archived, meta.pinned], [true, false])
    applySessionPatch(meta, { archived: false })
    assert.equal(meta.archived, false)
  })

  it('renames with a trimmed, bounded title and ignores a blank one', () => {
    const meta = base()
    applySessionPatch(meta, { title: '  Ship the shell  ' })
    assert.equal(meta.title, 'Ship the shell')
    applySessionPatch(meta, { title: '   ' })
    assert.equal(meta.title, 'Ship the shell')
  })
})

describe('session previews', () => {
  it('shows the last reply on one line, without markdown marks or code', () => {
    const entries = [
      entry('assistant', 'First reply'),
      entry('tool', 'ran a command'),
      entry('assistant', '## Done\n\nI updated **two** files:\n```ts\nconst x = 1\n```\nand `ran` the tests.'),
      entry('user', 'thanks'),
    ]
    assert.equal(previewOf(entries), 'Done I updated two files: and ran the tests.')
    assert.equal(previewOf([entry('user', 'hi')]), '')
    assert.equal(previewOf([entry('assistant', 'x'.repeat(200))], 20), `${'x'.repeat(19)}…`)
  })
})

describe('sessions kept on disk', () => {
  it('keeps every pinned session, then the newest, newest first', () => {
    const list = [
      { id: 'old-pin', pinned: true, updatedAt: 1 },
      { id: 'a', pinned: false, updatedAt: 50 },
      { id: 'b', pinned: false, updatedAt: 40 },
      { id: 'c', pinned: false, updatedAt: 30 },
      { id: 'new-pin', pinned: true, updatedAt: 45 },
    ]
    assert.deepEqual(
      sessionsToKeep(list, 3).map((session) => session.id),
      ['a', 'new-pin', 'old-pin'],
    )
    assert.deepEqual(
      sessionsToKeep(list, 1).map((session) => session.id),
      ['new-pin', 'old-pin'],
      'pins are never dropped',
    )
  })
})
