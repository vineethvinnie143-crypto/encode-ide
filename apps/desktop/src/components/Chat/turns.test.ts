import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEntry, DiffHunk } from '@shared/types'
import { buildTurns, editTotals, editedFiles, formatClock, formatDuration, logItems, stepKind, stepsOf, summarizeSteps } from './turns'

let counter = 0
function entry(kind: ConversationEntry['kind'], patch: Partial<ConversationEntry> = {}): ConversationEntry {
  counter += 1
  return { id: `e${counter}`, kind, createdAt: counter * 1000, ...patch }
}
const tool = (name: string, input: Record<string, unknown> = {}, extra: Partial<ConversationEntry['tool']> = {}) =>
  entry('tool', { tool: { name, input, state: 'done', ...extra } })
const hunk = (adds: number, dels: number): DiffHunk => ({
  oldStart: 1,
  oldLines: dels,
  newStart: 1,
  newLines: adds,
  lines: [
    ...Array.from({ length: adds }, (_, index) => ({ type: 'add' as const, text: `+${index}` })),
    ...Array.from({ length: dels }, (_, index) => ({ type: 'del' as const, text: `-${index}` })),
  ],
})

describe('turns', () => {
  it('splits at each message of yours, with the answer after the last tool call', () => {
    const user1 = entry('user', { text: 'fix it' })
    const note = entry('assistant', { text: 'Looking.' })
    const read = tool('read', { path: 'a.ts' })
    const answer = entry('assistant', { text: 'Fixed.' })
    const user2 = entry('user', { text: 'thanks' })
    const reply2 = entry('assistant', { text: 'Welcome.' })
    const turns = buildTurns([user1, note, read, answer, user2, reply2], false)
    assert.equal(turns.length, 2)
    assert.deepEqual(turns[0].log.map((item) => item.id), [note.id, read.id])
    assert.deepEqual(turns[0].reply.map((item) => item.id), [answer.id])
    assert.deepEqual(turns[1].log, [])
    assert.deepEqual(turns[1].reply.map((item) => item.id), [reply2.id])
    assert.equal(turns[0].user?.id, user1.id)
    assert.equal(turns[0].id, user1.id)
  })

  it('times a turn from your message to its last entry, and marks only the last one live', () => {
    const user = entry('user')
    const reply = entry('assistant', { text: 'x' })
    const [turn] = buildTurns([user, reply], true)
    assert.equal(turn.endedAt - turn.startedAt, reply.createdAt - user.createdAt)
    assert.equal(turn.active, true)
    assert.equal(buildTurns([user, reply], false)[0].active, false)
    const many = buildTurns([user, reply, entry('user'), entry('assistant', { text: 'y' })], true)
    assert.deepEqual(many.map((item) => item.active), [false, true])
  })

  it('keeps entries that come before any message of yours in a turn of their own', () => {
    const notice = entry('notice', { text: 'Offline demo' })
    const turns = buildTurns([notice, entry('user'), entry('assistant', { text: 'hi' })], false)
    assert.equal(turns.length, 2)
    assert.equal(turns[0].user, null)
    assert.deepEqual(turns[0].reply, [notice])
  })

  it('keeps an error visible with the reply, and an empty conversation empty', () => {
    const user = entry('user')
    const call = tool('pwsh', { command: 'x' })
    const failure = entry('error', { text: 'The provider failed.' })
    const [turn] = buildTurns([user, call, failure], false)
    assert.deepEqual(turn.log, [call])
    assert.deepEqual(turn.reply, [failure])
    assert.deepEqual(buildTurns([], false), [])
  })
})

describe('steps', () => {
  it('sorts tools into kinds', () => {
    assert.equal(stepKind('read'), 'read')
    assert.equal(stepKind('grep'), 'search')
    assert.equal(stepKind('write'), 'edit')
    assert.equal(stepKind('pwsh'), 'shell')
    assert.equal(stepKind('web_fetch'), 'web')
    assert.equal(stepKind('task'), 'subagent')
    assert.equal(stepKind('todo_write'), 'other')
  })

  it('summarises what a turn did, in order, counting an edited file once', () => {
    const steps = [
      tool('read', { path: 'a' }),
      tool('read', { path: 'b' }),
      tool('pwsh', { command: 'ls' }),
      tool('edit', { path: 'a' }),
      tool('edit', { path: 'a' }),
      tool('write', { path: 'c' }),
      tool('read', { path: 'd' }),
      tool('grep', { query: 'x' }),
    ]
    assert.equal(summarizeSteps(steps), 'Read 3 files, ran 1 command, edited 2 files, searched 1 time')
    assert.equal(summarizeSteps([]), '')
    assert.equal(summarizeSteps([tool('todo_write'), tool('todo_write')]), 'Used 2 other tools')
  })

  it('folds runs of reads, searches and web calls into one row, but not commands or edits', () => {
    const items = logItems([
      entry('assistant', { text: 'Let me look.' }),
      tool('read', { path: 'a' }),
      tool('read', { path: 'b' }),
      tool('read', { path: 'c' }),
      tool('pwsh', { command: 'ls' }),
      tool('pwsh', { command: 'pwd' }),
      tool('read', { path: 'd' }),
      tool('edit', { path: 'a' }),
      tool('edit', { path: 'b' }),
      entry('notice', { text: 'Compacted.' }),
      entry('assistant', { text: '', streaming: false }),
    ])
    assert.deepEqual(
      items.map((item) => (item.type === 'group' ? `group:${item.kind}:${item.entries.length}` : item.type)),
      ['text', 'group:read:3', 'step', 'step', 'step', 'step', 'step', 'notice'],
    )
  })

  it('keeps an empty reply that is still streaming, so the log can show its caret', () => {
    const items = logItems([entry('assistant', { text: '', streaming: true })])
    assert.deepEqual(items.map((item) => item.type), ['text'])
  })

  it('lists the tool calls of a turn', () => {
    const call = tool('read')
    assert.deepEqual(stepsOf({ log: [entry('assistant', { text: 'x' }), call] }), [call])
  })
})

describe('durations', () => {
  it('reads like a sentence', () => {
    assert.equal(formatDuration(200), '1s')
    assert.equal(formatDuration(45_000), '45s')
    assert.equal(formatDuration(134_000), '2m 14s')
    assert.equal(formatDuration(3_780_000), '1h 3m')
  })

  it('reads like a clock', () => {
    assert.equal(formatClock(18_400), '0:18')
    assert.equal(formatClock(725_000), '12:05')
    assert.equal(formatClock(3_789_000), '1:03:09')
    assert.equal(formatClock(-5), '0:00')
  })
})

describe('edit totals', () => {
  it('counts files once and sums added and removed lines', () => {
    const a1 = tool('edit', { path: 'a.ts' }, { diff: [hunk(3, 1)] })
    const a2 = tool('edit', { path: 'a.ts' }, { diff: [hunk(2, 0)] })
    const b = tool('write', { path: 'b.ts' }, { diff: [hunk(4, 0)] })
    const read = tool('read', { path: 'c.ts' })
    assert.deepEqual(editTotals([a1, a2, b, read]), { files: 2, additions: 9, deletions: 1 })
    assert.deepEqual(editTotals([]), { files: 0, additions: 0, deletions: 0 })
  })
})

describe('edited files', () => {
  it('lists each file once, in order, with its own counts', () => {
    const calls = [
      tool('edit', { path: 'b.ts' }, { diff: [hunk(1, 1)] }),
      tool('write', { path: 'a.ts' }, { diff: [hunk(5, 0)] }),
      tool('edit', { path: 'b.ts' }, { diff: [hunk(2, 2)] }),
      tool('edit', { path: '' }, { diff: [hunk(9, 9)] }),
    ]
    assert.deepEqual(editedFiles(calls), [
      { path: 'b.ts', additions: 3, deletions: 3 },
      { path: 'a.ts', additions: 5, deletions: 0 },
    ])
  })
})
