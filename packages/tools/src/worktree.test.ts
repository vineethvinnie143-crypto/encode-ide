import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { readTool } from './files'
import { globTool, grepTool } from './search'
import { tempWorkspace, testContext, textOf } from './testing'
import type { ToolOutcome, WorktreeInfo, Worktrees } from './types'
import { describeWork, enterWorktreeTool, exitWorktreeTool, validWorktreeName, WORKTREES_DIR } from './worktree'

const said = async (outcome: Promise<ToolOutcome> | ToolOutcome): Promise<string> => textOf((await outcome).content)

/** The session's side, as far as the tools see it. */
function worktrees(root: string, options: { refuse?: string; work?: { changed: string[]; commits: number } } = {}) {
  let current: WorktreeInfo | null = null
  const calls: string[] = []
  const service: Worktrees = {
    current: () => current,
    async enter({ name }) {
      calls.push(`enter ${name ?? ''}`)
      if (options.refuse) return { ok: false, reason: options.refuse }
      current = { name: name ?? 'wt-1', path: path.join(root, WORKTREES_DIR, name ?? 'wt-1'), branch: `encode/${name ?? 'wt-1'}`, base: '0123456789abcdef', from: 'main' }
      return { ok: true, worktree: current }
    },
    async exit({ action, discard }) {
      calls.push(`exit ${action}${discard ? ' discard' : ''}`)
      if (!current) return { ok: false, reason: 'You are not in a worktree.' }
      if (action === 'remove' && !discard && options.work) return { ok: false, reason: `The worktree ${current.name} was not removed.`, work: options.work }
      const left = current
      current = null
      return { ok: true, left, removed: action === 'remove' }
    },
  }
  return { service, calls }
}

describe('EnterWorktree and ExitWorktree', () => {
  it('take a name that is one segment and a valid branch name', () => {
    for (const name of ['fix', 'v1.2', 'a_b-c']) assert.ok(validWorktreeName(name), name)
    for (const name of ['../x', 'a/b', '.x', 'x.lock', 'a..b', '-x', 'x.']) assert.ok(!validWorktreeName(name), name)
    assert.match(enterWorktreeTool.check!({ name: '../out' })!, /letters, digits, dots, dashes and underscores/)
    assert.equal(enterWorktreeTool.check!({ name: 'fine' }), undefined)
  })

  it('ask for what git will do, in the project folder', async () => {
    const root = await tempWorkspace()
    const { service } = worktrees(root)
    const ctx = testContext(root, { worktrees: service })
    assert.deepEqual(await enterWorktreeTool.access({ name: 'fix' }, ctx), {
      type: 'command',
      command: `git worktree add -b encode/fix ${path.join(WORKTREES_DIR, 'fix')} HEAD`,
      cwd: root,
      background: false,
    })
    assert.deepEqual(await exitWorktreeTool.access({ action: 'keep' }, ctx), { type: 'none' })
    await enterWorktreeTool.run({ name: 'fix' }, ctx)
    assert.deepEqual(await exitWorktreeTool.access({ action: 'remove', discard_changes: true }, ctx), {
      type: 'command',
      command: `git worktree remove --force ${path.join(WORKTREES_DIR, 'fix')} && git branch -D encode/fix`,
      cwd: root,
      background: false,
    })
    assert.equal((await exitWorktreeTool.describe!({ action: 'remove', discard_changes: true }, ctx)).title, 'Remove worktree fix, discarding its work')
  })

  it('say where the agent works now, and what keeps a worktree from going', async () => {
    const root = await tempWorkspace()
    const { service, calls } = worktrees(root, { work: { changed: ['a.ts', 'b.ts'], commits: 1 } })
    const ctx = testContext(root, { worktrees: service })
    const entered = await enterWorktreeTool.run({ name: 'fix' }, ctx)
    assert.equal(entered.ok, true)
    assert.match(textOf(entered.content), /You now work in the worktree \.encode-worktrees\/fix \(.+\), on branch encode\/fix from 0123456789, which main was on\./)
    assert.match(await said(enterWorktreeTool.run({ name: 'again' }, ctx)), /You already work in the worktree fix\. ExitWorktree first\./)
    const refused = await exitWorktreeTool.run({ action: 'remove' }, ctx)
    assert.equal(refused.ok, false)
    assert.equal(
      textOf(refused.content),
      'The worktree fix was not removed. It has 2 changed files not committed (a.ts, b.ts) and 1 commit only on its branch. Commit and merge what should stay, keep the worktree, or ask the user before you remove it with discard_changes true.',
    )
    assert.match(await said(exitWorktreeTool.run({ action: 'keep' }, ctx)), /Left the worktree \.encode-worktrees\/fix; it stays, with its branch encode\/fix\./)
    assert.match(await said(exitWorktreeTool.run({ action: 'keep' }, ctx)), /You are not in a worktree/)
    assert.deepEqual(calls, ['enter fix', 'exit remove', 'exit keep'])
  })

  it('pass on why none was made, and refuse where there are no worktrees', async () => {
    const root = await tempWorkspace()
    const refused = worktrees(root, { refuse: 'The project is not a git repository, so there is no worktree to make.' })
    assert.match(await said(enterWorktreeTool.run({}, testContext(root, { worktrees: refused.service }))), /not a git repository/)
    assert.match(await said(enterWorktreeTool.run({}, testContext(root))), /Worktrees are not available here/)
  })

  it('count work in plain words', () => {
    assert.equal(describeWork({ changed: ['a'], commits: 0 }), '1 changed file not committed (a)')
    assert.equal(describeWork({ changed: [], commits: 3 }), '3 commits only on its branch')
    assert.equal(describeWork({ changed: ['1', '2', '3', '4', '5', '6'], commits: 0 }), '6 changed files not committed (1, 2, 3, 4, 5, ...)')
  })
})

describe('where the tools start in a worktree', () => {
  it('resolve relative paths and searches from the worktree, and leave worktrees out of a search of the project', async () => {
    const root = await tempWorkspace({
      'a.txt': 'checkout\n',
      'src/one.ts': 'export const one = "checkout"\n',
      '.encode-worktrees/fix/a.txt': 'worktree\n',
      '.encode-worktrees/fix/src/one.ts': 'export const one = "worktree"\n',
    })
    const inside = path.join(root, '.encode-worktrees', 'fix')
    const there = testContext(root, { cwd: inside })
    assert.match(await said(readTool.run({ file_path: 'a.txt' }, there)), /worktree/)
    assert.equal((await said(globTool.run({ pattern: '**/*.ts' }, there))).trim(), 'src/one.ts')
    assert.match(await said(grepTool.run({ pattern: 'worktree', output_mode: 'files_with_matches' }, there)), /src\/one\.ts/)

    const project = testContext(root)
    const found = await said(globTool.run({ pattern: '**/*.ts' }, project))
    assert.match(found, /src\/one\.ts/)
    assert.doesNotMatch(found, /encode-worktrees/)
    assert.doesNotMatch(await said(grepTool.run({ pattern: 'worktree', output_mode: 'files_with_matches' }, project)), /one\.ts/)
    // Asked for by path, a worktree is searched like any folder.
    assert.match(await said(globTool.run({ pattern: '**/*.ts', path: '.encode-worktrees/fix' }, project)), /one\.ts/)
  })
})
