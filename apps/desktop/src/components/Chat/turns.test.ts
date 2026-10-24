import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEntry, DiffHunk } from '@shared/types'
import {
  buildTurns,
  editTotals,
  editedFiles,
  formatClock,
  formatDuration,
  formatUsage,
  isCommandTool,
  isSubagentTool,
  logItems,
  reuseTurns,
  stepKind,
  stepsOf,
  summarizeSteps,
  toolPath,
} from './turns'

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

describe('messages sent while the agent worked', () => {
  it('start a new part of the same turn, each with its own steps and reply', () => {
    const user = entry('user', { text: 'tidy a.ts' })
    const read = tool('Read', { file_path: 'a.ts' })
    const steer = entry('steer', { text: 'use tabs' })
    const edit = tool('Edit', { file_path: 'a.ts' }, { diff: [hunk(2, 1)] })
    const answer = entry('assistant', { text: 'Done, with tabs.' })
    const [turn, ...rest] = buildTurns([user, read, steer, edit, answer], false)
    assert.equal(rest.length, 0, 'a steered message is not a new request')
    assert.deepEqual(
      turn.parts.map((part) => [part.id, part.steer?.id ?? null, part.log.map((item) => item.id), part.reply.map((item) => item.id)]),
      [
        [user.id, null, [read.id], []],
        [steer.id, steer.id, [edit.id], [answer.id]],
      ],
    )
    // The turn as a whole: everything before the last answer, which is the answer, and every change in it.
    assert.deepEqual(turn.log.map((item) => item.id), [read.id, steer.id, edit.id])
    assert.deepEqual(turn.reply, [answer])
    assert.deepEqual(editTotals(turn.log), { files: 1, additions: 2, deletions: 1 })
  })

  it('ends a part where the next message was taken, and keeps a reply that came before it', () => {
    const user = entry('user', { text: 'explain' })
    const first = entry('assistant', { text: 'A long answer.' })
    const steer = entry('steer', { text: 'shorter' })
    const second = entry('assistant', { text: 'Short.', streaming: true })
    const [turn] = buildTurns([user, first, steer, second], true)
    const [one, two] = turn.parts
    assert.deepEqual(one.reply, [first])
    assert.deepEqual([one.startedAt, one.endedAt], [user.createdAt, steer.createdAt])
    assert.deepEqual([two.startedAt, two.endedAt], [steer.createdAt, second.createdAt])
    assert.deepEqual([one.active, two.active], [false, true], 'only the part being worked on is live')
    assert.deepEqual(turn.reply, [second])
    assert.deepEqual(turn.log, [first, steer])
  })

  it('show a message just taken as a live part with nothing in it yet', () => {
    const user = entry('user')
    const read = tool('Read', { file_path: 'a.ts' })
    const steer = entry('steer', { text: 'also b.ts' })
    const [turn] = buildTurns([user, read, steer], true)
    const last = turn.parts[1]
    assert.deepEqual([last.log, last.reply, last.active, last.startedAt, last.endedAt], [[], [], true, steer.createdAt, steer.createdAt])
    assert.deepEqual(turn.reply, [])
  })

  it('keep a single part, the turn itself, when there were none', () => {
    const user = entry('user')
    const read = tool('Read', { file_path: 'a.ts' })
    const answer = entry('assistant', { text: 'ok' })
    const [turn] = buildTurns([user, read, answer], false)
    assert.equal(turn.parts.length, 1)
    assert.deepEqual([turn.parts[0].id, turn.parts[0].log, turn.parts[0].reply], [turn.id, turn.log, turn.reply])
  })
})

describe('reusing turns', () => {
  const conversation = () => {
    const user1 = entry('user', { text: 'first' })
    const read = tool('Read', { file_path: 'a.ts' })
    const answer1 = entry('assistant', { text: 'Done.' })
    const user2 = entry('user', { text: 'second' })
    const edit = tool('Edit', { file_path: 'b.ts' })
    const answer2 = entry('assistant', { text: 'Wor', streaming: true })
    return { all: [user1, read, answer1, user2, edit, answer2], answer2 }
  }

  it('hands back the turns that did not change, as the very same objects', () => {
    const { all } = conversation()
    const first = buildTurns(all, true)
    const second = reuseTurns(first, buildTurns([...all], true))
    assert.equal(second[0], first[0])
    assert.equal(second[1], first[1])
  })

  it('replaces only the turn that grew, and keeps its finished work log', () => {
    const { all, answer2 } = conversation()
    const first = buildTurns(all, true)
    const grown = all.map((item) => (item === answer2 ? { ...item, text: 'Working on it' } : item))
    const second = reuseTurns(first, buildTurns(grown, true))
    assert.equal(second[0], first[0], 'the finished turn is untouched')
    assert.notEqual(second[1], first[1])
    assert.equal(second[1].log, first[1].log, 'the steps before the answer are the same array')
    assert.notEqual(second[1].reply, first[1].reply)
    assert.equal(second[1].reply[0].text, 'Working on it')
  })

  it('notices a turn that stopped being live, and a turn that is new', () => {
    const { all } = conversation()
    const first = buildTurns(all, true)
    const stopped = reuseTurns(first, buildTurns(all, false))
    assert.equal(stopped[0], first[0])
    assert.notEqual(stopped[1], first[1])
    assert.equal(stopped[1].active, false)
    const more = [...all, entry('user', { text: 'third' })]
    const grown = reuseTurns(stopped, buildTurns(more, true))
    assert.equal(grown.length, 3)
    assert.equal(grown[0], first[0])
    assert.equal(grown[2].user?.text, 'third')
  })

  it('keeps the finished parts of a steered turn while its last part streams', () => {
    const user = entry('user', { text: 'go' })
    const read = tool('Read', { file_path: 'a.ts' })
    const steer = entry('steer', { text: 'and b.ts' })
    const answer = entry('assistant', { text: 'Rea', streaming: true })
    const first = buildTurns([user, read, steer, answer], true)
    const grown = [user, read, steer, { ...answer, text: 'Read both.' }]
    const second = reuseTurns(first, buildTurns(grown, true))
    assert.notEqual(second[0], first[0])
    assert.equal(second[0].parts[0], first[0].parts[0], 'the part before the message is the same object')
    assert.notEqual(second[0].parts[1], first[0].parts[1])
    assert.equal(second[0].parts[1].log, first[0].parts[1].log)
    assert.equal(reuseTurns(second, buildTurns([...grown], true))[0], second[0], 'nothing changed, so the turn is the same object')
  })

  it('has nothing to reuse the first time', () => {
    const { all } = conversation()
    const turns = buildTurns(all, false)
    assert.equal(reuseTurns([], turns), turns)
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

  it('knows the tools of the agent engine as well as those of earlier builds', () => {
    assert.equal(stepKind('Read'), 'read')
    assert.equal(stepKind('Grep'), 'search')
    assert.equal(stepKind('Glob'), 'search')
    assert.equal(stepKind('Write'), 'edit')
    assert.equal(stepKind('MultiEdit'), 'edit')
    assert.equal(stepKind('Bash'), 'shell')
    assert.equal(stepKind('WebFetch'), 'web')
    assert.equal(stepKind('Task'), 'subagent')
    assert.equal(stepKind('AskUserQuestion'), 'ask')
    assert.equal(stepKind('Computer'), 'computer')
    assert.equal(stepKind('TodoWrite'), 'other')
    assert.equal(isCommandTool('Bash'), true)
    assert.equal(isCommandTool('pwsh'), true)
    assert.equal(isCommandTool('BashOutput'), false)
    assert.equal(isSubagentTool('Task'), true)
    assert.equal(isSubagentTool('task'), true)
    assert.equal(isSubagentTool('Skill'), false)
    assert.equal(toolPath({ file_path: '/w/a.ts' }), '/w/a.ts')
    assert.equal(toolPath({ path: 'a.ts' }), 'a.ts')
    assert.equal(toolPath({ command: 'ls' }), undefined)
  })

  it('counts an edited file once whichever tool and name for the path it used', () => {
    const steps = [
      tool('Read', { file_path: '/w/a' }),
      tool('Edit', { file_path: '/w/a' }),
      tool('MultiEdit', { file_path: '/w/a' }),
      tool('Write', { file_path: '/w/b' }),
      tool('Bash', { command: 'ls' }),
    ]
    assert.equal(summarizeSteps(steps), 'Read 1 file, edited 2 files, ran 1 command')
  })

  it('counts the steps taken on the desktop, one by one, and keeps each as its own row', () => {
    const steps = [tool('Read', { file_path: '/w/a' }), tool('Computer', { action: 'screenshot' }), tool('Computer', { action: 'left_click' }), tool('Computer', { action: 'key' })]
    assert.equal(summarizeSteps(steps), 'Read 1 file, used the computer 3 times')
    assert.equal(summarizeSteps([tool('Computer', { action: 'windows' })]), 'Used the computer 1 time')
    assert.deepEqual(
      logItems(steps).map((item) => item.type),
      ['step', 'step', 'step', 'step'],
    )
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

  it('names files the way the tools do, by file_path', () => {
    const calls = [tool('Edit', { file_path: 'src/utils.ts' }, { diff: [hunk(1, 1)] }), tool('Write', { file_path: '/w/new.txt' }, { diff: [hunk(1, 0)] })]
    assert.deepEqual(editedFiles(calls), [
      { path: 'src/utils.ts', additions: 1, deletions: 1 },
      { path: '/w/new.txt', additions: 1, deletions: 0 },
    ])
  })
})

describe('formatUsage', () => {
  it('says what a request cost in tokens, how much came from the cache, and in dollars when every call said', () => {
    assert.equal(formatUsage(undefined), '')
    assert.equal(formatUsage({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }), '')
    assert.equal(formatUsage({ calls: 1, inputTokens: 800, cachedTokens: 0, outputTokens: 40 }), '840 tokens')
    assert.equal(formatUsage({ calls: 3, inputTokens: 18_000, cachedTokens: 13_000, outputTokens: 432 }), '18.4k tokens · 72% cached')
    assert.equal(formatUsage({ calls: 3, inputTokens: 18_000, cachedTokens: 0, outputTokens: 432, cost: 0.03125 }), '18.4k tokens · $0.031')
    assert.equal(formatUsage({ calls: 2, inputTokens: 9_000, cachedTokens: 0, outputTokens: 100, cost: 0 }), '9.1k tokens · free')
    assert.equal(formatUsage({ calls: 2, inputTokens: 9_000, cachedTokens: 0, outputTokens: 100, cost: 0.004 }), '9.1k tokens · <$0.01')
    assert.equal(formatUsage({ calls: 40, inputTokens: 1_250_000, cachedTokens: 1_000_000, outputTokens: 20_000, cost: 2.5 }), '1.3M tokens · 80% cached · $2.50')
  })
})
