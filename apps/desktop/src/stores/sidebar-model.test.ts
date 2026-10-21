import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionSummary } from '@shared/types'
import {
  activityGroups,
  adjacentRecent,
  attentionCount,
  buildSidebar,
  canSwitchProject,
  isBusy,
  nextAttention,
  projectName,
  rootKey,
  rowStatus,
  sameRoot,
  visibleOrder,
} from './sidebar-model'

const NOW = new Date(2026, 9, 22, 15, 0).getTime()
const HOUR = 3_600_000

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    createdAt: 0,
    updatedAt: NOW - HOUR,
    projectRoot: 'C:\\work\\app',
    pinned: false,
    archived: false,
    unread: false,
    preview: '',
    entryCount: 2,
    ...patch,
  }
}

describe('folders', () => {
  it('compares them the way Windows does', () => {
    assert.equal(rootKey('C:\\Work\\App\\'), 'c:/work/app')
    assert.equal(sameRoot('C:\\Work\\App', 'c:/work/app/'), true)
    assert.equal(sameRoot('C:\\Work\\App', 'C:\\Work\\Other'), false)
    assert.equal(sameRoot(null, null), false)
    assert.equal(projectName('C:\\Work\\App\\'), 'App')
    assert.equal(projectName('/home/me/app'), 'app')
  })
})

describe('row status', () => {
  it('shows what the session needs, most urgent first', () => {
    const unread = session('a', { unread: true })
    assert.equal(rowStatus(unread, 'awaiting-approval'), 'approval')
    assert.equal(rowStatus(unread, 'awaiting-user'), 'approval')
    assert.equal(rowStatus(unread, 'running-tool'), 'running')
    assert.equal(rowStatus(unread, 'thinking'), 'running')
    assert.equal(rowStatus(unread, 'idle'), 'unread')
    assert.equal(rowStatus(session('b'), 'done'), 'idle')
    assert.equal(rowStatus(session('b'), undefined), 'idle')
  })

  it('counts running and waiting sessions as busy', () => {
    for (const status of ['thinking', 'running-tool', 'awaiting-approval', 'awaiting-user'] as const) assert.equal(isBusy(status), true, status)
    for (const status of ['idle', 'done', 'error', undefined] as const) assert.equal(isBusy(status), false, String(status))
  })
})

describe('sidebar', () => {
  const sessions = [
    session('old', { updatedAt: NOW - 50 * HOUR }),
    session('new', { updatedAt: NOW - HOUR }),
    session('pinned', { pinned: true, updatedAt: NOW - 90 * HOUR }),
    session('archived', { archived: true }),
    session('other', { projectRoot: 'D:\\code\\site', updatedAt: NOW - 2 * HOUR }),
    session('loose', { projectRoot: null, updatedAt: NOW - 3 * HOUR }),
    session('same folder, other spelling', { projectRoot: 'c:/work/app/', updatedAt: NOW - 4 * HOUR }),
  ]

  it('groups sessions by project, newest first, with pinned and project-less ones apart', () => {
    const model = buildSidebar(sessions, { workspaceRoot: 'C:\\work\\app', recentRoots: ['E:\\old\\thing'] })
    assert.deepEqual(model.pinned.map((item) => item.id), ['pinned'])
    assert.deepEqual(model.recents.map((item) => item.id), ['loose'])
    assert.deepEqual(model.projects.map((project) => project.name), ['app', 'site', 'thing'])
    assert.deepEqual(model.projects[0].sessions.map((item) => item.id), ['new', 'same folder, other spelling', 'old'])
    assert.deepEqual(model.projects[2].sessions, [], 'a folder opened before shows even without sessions')
    assert.equal(
      [...model.pinned, ...model.recents, ...model.projects.flatMap((project) => project.sessions)].some((item) => item.id === 'archived'),
      false,
    )
  })

  it('lists the open folder first even when it has no sessions', () => {
    const model = buildSidebar([session('x', { projectRoot: 'D:\\code\\site' })], { workspaceRoot: 'C:\\empty', recentRoots: [] })
    assert.deepEqual(model.projects.map((project) => project.name), ['empty', 'site'])
  })

  it('filters by title or project name and hides empty projects while filtering', () => {
    const byTitle = buildSidebar(sessions, { workspaceRoot: 'C:\\work\\app', recentRoots: ['E:\\old\\thing'], filter: ' NEW ' })
    assert.deepEqual(byTitle.projects.map((project) => project.name), ['app'])
    assert.deepEqual(byTitle.projects[0].sessions.map((item) => item.id), ['new'])
    const byProject = buildSidebar(sessions, { workspaceRoot: null, recentRoots: [], filter: 'site' })
    assert.deepEqual(byProject.projects.map((project) => project.name), ['site'])
    assert.deepEqual(byProject.pinned, [])
  })

  it('lists session ids top to bottom, without those in collapsed projects', () => {
    const model = buildSidebar(sessions, { workspaceRoot: 'C:\\work\\app', recentRoots: [] })
    assert.deepEqual(visibleOrder(model), ['pinned', 'new', 'same folder, other spelling', 'old', 'other', 'loose'])
    assert.deepEqual(visibleOrder(model, new Set([rootKey('C:\\work\\app')])), ['pinned', 'other', 'loose'])
  })
})

describe('activity', () => {
  const sessions = [
    session('waiting', { updatedAt: NOW - 5 * HOUR }),
    session('busy', { updatedAt: NOW - 4 * HOUR }),
    session('unread', { unread: true, updatedAt: NOW - 3 * HOUR }),
    session('today', { updatedAt: NOW - 2 * HOUR }),
    session('earlier', { updatedAt: NOW - 30 * HOUR }),
    session('archived', { unread: true, archived: true }),
  ]
  const statuses = { waiting: 'awaiting-approval', busy: 'running-tool' } as const

  it('puts each session in the first group it fits, in the spec order', () => {
    const groups = activityGroups(sessions, statuses, NOW)
    assert.deepEqual(
      groups.map((group) => [group.title, group.sessions.map((item) => item.id)]),
      [
        ['Needs approval', ['waiting']],
        ['Running', ['busy']],
        ['Unread', ['unread']],
        ['Today', ['today']],
        ['Earlier', ['earlier']],
      ],
    )
  })

  it('leaves out empty groups', () => {
    assert.deepEqual(activityGroups([session('a', { updatedAt: NOW })], {}, NOW).map((group) => group.id), ['today'])
    assert.deepEqual(activityGroups([], {}, NOW), [])
  })

  it('finds the next session that needs you, waiting before unread, never the open one', () => {
    assert.equal(nextAttention(sessions, statuses, 'today'), 'waiting')
    assert.equal(nextAttention(sessions, statuses, 'waiting'), 'unread')
    assert.equal(nextAttention([session('a'), session('b')], {}, 'a'), undefined)
    assert.equal(attentionCount(sessions, statuses), 2, 'waiting and unread; archived ones do not count')
  })
})

describe('moving between recent sessions', () => {
  const sessions = [
    session('a', { updatedAt: 30 }),
    session('b', { updatedAt: 20 }),
    session('c', { updatedAt: 10 }),
    session('gone', { updatedAt: 99, archived: true }),
  ]
  it('goes to the next older session and wraps at both ends', () => {
    assert.equal(adjacentRecent(sessions, 'a', 1), 'b')
    assert.equal(adjacentRecent(sessions, 'c', 1), 'a')
    assert.equal(adjacentRecent(sessions, 'a', -1), 'c')
    assert.equal(adjacentRecent(sessions, 'b', -1), 'a')
    assert.equal(adjacentRecent(sessions, 'nothing', 1), 'a')
    assert.equal(adjacentRecent([], 'a', 1), undefined)
  })
})

describe('switching project', () => {
  const busy = { a: 'running-tool' } as const
  it('is allowed while nothing runs, or within the same project, or without a project', () => {
    assert.deepEqual(canSwitchProject('D:\\other', 'C:\\app', {}), { ok: true })
    assert.deepEqual(canSwitchProject('d:/OTHER', 'C:\\app', { a: 'done', b: 'idle' }), { ok: true })
    assert.deepEqual(canSwitchProject('c:/app/', 'C:\\app', busy), { ok: true })
    assert.deepEqual(canSwitchProject(null, 'C:\\app', busy), { ok: true })
  })

  it('is refused while any session runs or waits, because the agent works in the open folder', () => {
    for (const status of ['thinking', 'running-tool', 'awaiting-approval', 'awaiting-user'] as const) {
      const check = canSwitchProject('D:\\other', 'C:\\app', { a: status })
      assert.equal(check.ok, false, status)
      assert.match(check.reason ?? '', /still working/)
    }
  })
})
