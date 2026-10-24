/**
 * EnterWorktree and ExitWorktree in a session: where the agent works afterwards (relative paths, searches, its shell and
 * its subagents' shells), what the log keeps across a restart, a reset and a rewind, and what the model is told.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import type { ManagedShell, WorktreeInfo, WorktreeWork } from '@encode/tools'
import { createScriptedClient, type ScriptedStep } from './scripted'
import { closeHarnesses, sessionHarness, stubManagedShell, type SessionHarness } from './testing'
import type { WorktreeGit } from './worktrees'

after(closeHarnesses)

const textOf = (message: Message): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? JSON.stringify(block.content) : '')).join('\n')
const allText = (request: CompletionRequest): string => request.payload.messages.map(textOf).join('\n')
const lastUser = (request: CompletionRequest): string => textOf(request.payload.messages.at(-1)!)

/** git as far as the session sees it: folders made and removed for real, branches and work kept in memory. */
function fakeGit(options: { unavailable?: string; work?: WorktreeWork } = {}) {
  const made: WorktreeInfo[] = []
  const removed: { name: string; force: boolean }[] = []
  const git: WorktreeGit = {
    unavailable: async () => options.unavailable,
    async create(root, name) {
      const folder = path.join(root, '.encode-worktrees', name)
      await fs.mkdir(folder, { recursive: true })
      // What the branch holds: the project's files.
      for (const entry of await fs.readdir(root)) {
        if (entry === '.encode-worktrees') continue
        await fs.cp(path.join(root, entry), path.join(folder, entry), { recursive: true })
      }
      const info: WorktreeInfo = { name, path: await fs.realpath(folder), branch: `encode/${name}`, base: 'a'.repeat(40), from: 'main' }
      made.push(info)
      return info
    },
    work: async () => options.work ?? { changed: [], commits: 0 },
    async remove(_root, worktree, { force }) {
      removed.push({ name: worktree.name, force })
      await fs.rm(worktree.path, { recursive: true, force: true })
    },
  }
  return { git, made, removed }
}

/** A shell that only keeps its working directory, and says where each subagent's started. */
function placeShell(log: { dir: string; base: boolean }[]) {
  return (root: string): ManagedShell => {
    let cwd = root
    return {
      ...stubManagedShell(root),
      state: () => ({ cwd, env: {}, dialect: 'bash' }),
      setCwd: async (dir, options) => {
        cwd = path.resolve(root, dir)
        log.push({ dir: cwd, base: Boolean(options?.base) })
        return true
      },
    }
  }
}

async function harness(steps: ScriptedStep[], options: { git?: WorktreeGit; shells?: { dir: string; base: boolean }[]; sub?: ScriptedStep[] } = {}): Promise<SessionHarness & { main: CompletionRequest[] }> {
  const main: CompletionRequest[] = []
  const mainClient = createScriptedClient((_request, index) => steps[Math.min(index, steps.length - 1)])
  const subSteps = options.sub ?? [{ text: 'SUB' }]
  const subClient = createScriptedClient((_request, index) => subSteps[Math.min(index, subSteps.length - 1)])
  const h = await sessionHarness({
    files: { 'a.txt': 'from the checkout\n', 'src/one.ts': 'export const one = 1\n' },
    settings: { policy: 'full-access' },
    createShell: placeShell(options.shells ?? []),
    env: {
      client: {
        budget: (role) => mainClient.budget(role),
        complete: (request) => {
          if (request.agent) return subClient.complete(request)
          main.push(request)
          return mainClient.complete(request)
        },
      },
      ...(options.git ? { worktrees: options.git } : {}),
    },
  })
  return Object.assign(h, { main })
}

const enter = (name = 'fix') => ({ name: 'EnterWorktree', input: { name } })

describe('a worktree in a session', () => {
  it('is offered only where eNCode can make one', async () => {
    const without = await harness([{ text: 'ok' }])
    await without.session.start({ text: 'hi', mode: 'code' })
    // Deferred: ToolSearch's description names it.
    const names = (request: CompletionRequest) => JSON.stringify(request.payload.tools)
    assert.doesNotMatch(names(without.main[0]), /EnterWorktree/)
    const { git } = fakeGit()
    const offered = await harness([{ text: 'ok' }], { git })
    await offered.session.start({ text: 'hi', mode: 'code' })
    assert.match(names(offered.main[0]), /EnterWorktree/)
  })

  it('moves the agent into it: relative paths, the shell and the header follow, and the log keeps it', async () => {
    const { git, made } = fakeGit()
    const shells: { dir: string; base: boolean }[] = []
    const h = await harness([{ calls: [enter('fix')] }, { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }, { calls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'from the checkout', new_string: 'from the worktree' } }] }, { text: 'done' }], { git, shells })
    const end = await h.session.start({ text: 'work apart', mode: 'code' })
    assert.equal(end.kind, 'done')
    assert.equal(made.length, 1)
    const where = made[0].path
    assert.match(allText(h.main[1]), /You now work in the worktree \.encode-worktrees\/fix .*on branch encode\/fix from aaaaaaaaaa, which main was on/)
    // The edit went to the worktree's copy; the person's checkout is untouched.
    assert.equal(await fs.readFile(path.join(where, 'a.txt'), 'utf8'), 'from the worktree\n')
    assert.equal(await fs.readFile(path.join(h.root, 'a.txt'), 'utf8'), 'from the checkout\n')
    assert.deepEqual(shells.at(-1), { dir: where, base: true })
    assert.deepEqual(h.of('worktree').at(-1)?.worktree, { name: 'fix', branch: 'encode/fix', path: where })
    assert.equal(h.session.summary().worktree, 'fix')
    // Told by the tool's result, so no reminder repeats it.
    assert.doesNotMatch(lastUser(h.main[2]), /You work in the git worktree/)

    // After a restart the shell is back in it before anything runs, and the model, told before, is not told again.
    shells.length = 0
    const reopened = await h.reopen()
    await reopened.start({ text: 'more', mode: 'code' })
    assert.deepEqual(shells[0], { dir: where, base: true })
    assert.doesNotMatch(lastUser(h.main.at(-1)!), /worktree/)
    assert.equal(reopened.summary().worktree, 'fix')
  })

  it('lets go of a worktree whose folder was removed, and tells the agent and the person', async () => {
    const { git, made } = fakeGit()
    const shells: { dir: string; base: boolean }[] = []
    const h = await harness([{ calls: [enter('gone')] }, { text: 'in' }, { text: 'back' }], { git, shells })
    await h.session.start({ text: 'go', mode: 'code' })
    await fs.rm(made[0].path, { recursive: true, force: true })
    shells.length = 0
    const reopened = await h.reopen()
    await reopened.start({ text: 'next', mode: 'code' })
    assert.deepEqual(shells[0], { dir: h.root, base: true })
    assert.match(lastUser(h.main.at(-1)!), new RegExp(`You no longer work in a worktree\\. Relative paths, Glob, Grep and Bash start at the workspace root, ${h.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, again`))
    assert.ok(reopened.history().entries.some((entry) => entry.kind === 'notice' && entry.text === 'The worktree gone is gone, so the agent works in the project folder again.'))
    assert.equal(reopened.summary().worktree, undefined)
  })

  it('is left kept or removed, and is not removed with work in it unless the agent says to discard it', async () => {
    const { git, removed } = fakeGit({ work: { changed: ['a.txt', 'b.txt'], commits: 2 } })
    const shells: { dir: string; base: boolean }[] = []
    const h = await harness(
      [
        { calls: [enter('keepme')] },
        { calls: [{ name: 'ExitWorktree', input: { action: 'remove' } }] },
        { calls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] },
        { calls: [enter('drop')] },
        { calls: [{ name: 'ExitWorktree', input: { action: 'remove', discard_changes: true } }] },
        { text: 'done' },
      ],
      { git, shells },
    )
    await h.session.start({ text: 'go', mode: 'code' })
    assert.match(allText(h.main[2]), /The worktree keepme was not removed\. It has 2 changed files not committed \(a\.txt, b\.txt\) and 2 commits only on its branch\..*ask the user before you remove it with discard_changes true/)
    assert.match(allText(h.main[3]), /Left the worktree \.encode-worktrees\/keepme; it stays, with its branch encode\/keepme\. You work in the project folder again/)
    assert.match(allText(h.main[5]), /Removed the worktree \.encode-worktrees\/drop and its branch encode\/drop/)
    assert.deepEqual(removed, [{ name: 'drop', force: true }])
    assert.deepEqual(shells.at(-1), { dir: h.root, base: true })
    assert.equal(h.session.summary().worktree, undefined)
    assert.equal(h.of('worktree').at(-1)?.worktree, null)
  })

  it('is refused with the reason when none can be made, and a second one while in one', async () => {
    const none = await harness([{ calls: [enter()] }, { text: 'ok' }], { git: fakeGit({ unavailable: 'The project is not a git repository, so there is no worktree to make.' }).git })
    await none.session.start({ text: 'go', mode: 'code' })
    assert.match(allText(none.main[1]), /not a git repository/)
    const { git } = fakeGit()
    const twice = await harness([{ calls: [enter('one')] }, { calls: [enter('two')] }, { text: 'ok' }], { git })
    await twice.session.start({ text: 'go', mode: 'code' })
    assert.match(allText(twice.main[2]), /You already work in the worktree one\. ExitWorktree first/)
  })

  it('is where a subagent starts, and a subagent cannot enter or leave one', async () => {
    const { git, made } = fakeGit()
    const shells: { dir: string; base: boolean }[] = []
    const h = await harness([{ calls: [enter('sub')] }, { calls: [{ name: 'Task', input: { description: 'Look', prompt: 'look around', subagent_type: 'general-purpose' } }] }, { text: 'done' }], {
      git,
      shells,
      sub: [{ calls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] }, { text: 'SUB' }],
    })
    await h.session.start({ text: 'go', mode: 'code' })
    // The main agent's shell moved first; the subagent's own shell was put in the worktree as it was made.
    assert.equal(shells.filter((entry) => entry.dir === made[0].path).length, 2)
    assert.equal(h.session.summary().worktree, 'sub')
  })

  it('stays through a reset, and the new conversation is told where it works', async () => {
    const { git, made } = fakeGit()
    const h = await harness([{ calls: [enter('stay')] }, { text: 'in' }, { text: 'fresh' }], { git })
    await h.session.start({ text: 'go', mode: 'code' })
    await h.session.reset()
    assert.equal(h.session.summary().worktree, 'stay')
    await h.session.start({ text: 'again', mode: 'code' })
    assert.match(lastUser(h.main.at(-1)!), new RegExp(`You work in the git worktree ${made[0].path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, on branch encode/stay`))
    const reopened = await h.reopen()
    assert.equal(reopened.summary().worktree, 'stay')
  })

  it('is left when the conversation is rewound to before it was entered; its folder stays', async () => {
    const { git, made } = fakeGit()
    const shells: { dir: string; base: boolean }[] = []
    const h = await harness([{ text: 'first' }, { calls: [enter('later')] }, { text: 'in' }, { text: 'again' }], { git, shells })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.start({ text: 'two', mode: 'code' })
    assert.equal(h.session.summary().worktree, 'later')
    const second = h.session.history().entries.filter((entry) => entry.kind === 'user')[1]
    await h.session.rewind(second.id)
    assert.equal(h.session.summary().worktree, undefined)
    assert.deepEqual(shells.at(-1), { dir: h.root, base: true })
    assert.ok((await fs.stat(made[0].path)).isDirectory())
    // The conversation that remains never entered it, so there is nothing to tell.
    await h.session.start({ text: 'two again', mode: 'code' })
    assert.doesNotMatch(lastUser(h.main.at(-1)!), /worktree/)
  })

  it('is left out of searches from the project folder', async () => {
    const { git } = fakeGit()
    const h = await harness([{ calls: [enter('copy')] }, { calls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] }, { calls: [{ name: 'Glob', input: { pattern: '**/*.ts' } }] }, { calls: [{ name: 'Grep', input: { pattern: 'one', output_mode: 'files_with_matches' } }] }, { text: 'done' }], { git })
    await h.session.start({ text: 'go', mode: 'code' })
    const glob = lastUser(h.main[3])
    assert.match(glob, /src\/one\.ts/)
    assert.doesNotMatch(glob, /encode-worktrees/)
    assert.doesNotMatch(lastUser(h.main[4]), /encode-worktrees/)
  })
})

/** fakeGit, with what a chat's worktree changed since it was made: its files against the project's when it was made. */
function bringingGit() {
  const base = new Map<string, Map<string, Buffer>>()
  const { git, made } = fakeGit()
  const walk = async (folder: string, prefix = ''): Promise<string[]> => {
    const out: string[] = []
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name === '.encode-worktrees') continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...(await walk(path.join(folder, entry.name), relative)))
      else out.push(relative)
    }
    return out
  }
  const create = git.create.bind(git)
  git.create = async (root, name, signal) => {
    const info = await create(root, name, signal)
    const files = new Map<string, Buffer>()
    for (const file of await walk(info.path)) files.set(file, await fs.readFile(path.join(info.path, file)))
    base.set(info.path, files)
    return info
  }
  git.changes = async (worktree) => {
    const was = base.get(worktree.path)!
    const now = await walk(worktree.path)
    const changes: { path: string; kind: 'added' | 'modified' | 'deleted' }[] = []
    for (const file of now) {
      const bytes = await fs.readFile(path.join(worktree.path, file))
      if (!was.has(file)) changes.push({ path: file, kind: 'added' })
      else if (!was.get(file)!.equals(bytes)) changes.push({ path: file, kind: 'modified' })
    }
    for (const file of was.keys()) if (!now.includes(file)) changes.push({ path: file, kind: 'deleted' })
    return changes
  }
  git.original = async (worktree, _seed, file) => base.get(worktree.path)?.get(file) ?? null
  return { git, made }
}

describe('a worktree from the chat (ADR 0105)', () => {
  it('is entered and left by the person, never while a request runs, and the model hears of it with the next request', async () => {
    const { git, made } = bringingGit()
    const h = await harness([{ text: 'ok' }], { git })
    const entered = await h.session.worktreeAction({ action: 'enter', name: 'side-work' })
    assert.deepEqual(entered, { ok: true, worktree: { name: 'side-work', branch: 'encode/side-work', path: made[0].path } })
    assert.equal(h.session.summary().worktree, 'side-work')
    await h.session.start({ text: 'go on', mode: 'code' })
    assert.match(lastUser(h.main.at(-1)!), /You work in the git worktree .*side-work/)
    const again = await h.session.worktreeAction({ action: 'enter' })
    assert.equal(again.ok, false)

    const left = await h.session.worktreeAction({ action: 'leave' })
    assert.deepEqual(left, { ok: true, worktree: null })
    await fs.access(made[0].path)
    await h.session.start({ text: 'and now', mode: 'code' })
    assert.match(lastUser(h.main.at(-1)!), /You no longer work in a worktree/)
    assert.equal((await h.session.worktreeAction({ action: 'bring' })).ok, false, 'there is no worktree to bring in')
  })

  it('brings what the worktree changed into the project, and stops at a file the project changed meanwhile unless forced', async () => {
    const { git, made } = bringingGit()
    const h = await harness([{ text: 'ok' }], { git })
    await h.session.worktreeAction({ action: 'enter', name: 'feature' })
    const where = made[0].path
    await fs.writeFile(path.join(where, 'a.txt'), 'from the worktree\n')
    await fs.writeFile(path.join(where, 'new.txt'), 'new\n')
    await fs.writeFile(path.join(where, 'src', 'one.ts'), 'export const one = 2\n')
    // The person changed one file in the project meanwhile, and another only in its line ends.
    await fs.writeFile(path.join(h.root, 'src', 'one.ts'), 'export const one = 3\n')
    await fs.writeFile(path.join(h.root, 'a.txt'), 'from the checkout\r\n')

    const refused = await h.session.worktreeAction({ action: 'bring' })
    assert.deepEqual(refused, { ok: false, error: 'src/one.ts was changed in the project after the worktree was made.', conflicts: ['src/one.ts'] })
    assert.equal(await fs.readFile(path.join(h.root, 'a.txt'), 'utf8'), 'from the checkout\r\n', 'nothing was written')

    const brought = await h.session.worktreeAction({ action: 'bring', force: true })
    assert.equal(brought.ok, true)
    assert.deepEqual(brought.ok && [...(brought.files ?? [])].sort(), ['a.txt', 'new.txt', 'src/one.ts'])
    assert.equal(await fs.readFile(path.join(h.root, 'new.txt'), 'utf8'), 'new\n')
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'one.ts'), 'utf8'), 'export const one = 2\n')
    assert.equal(h.session.summary().worktree, 'feature', 'the session still works in the worktree')

    await h.session.start({ text: 'next', mode: 'code' })
    assert.match(lastUser(h.main.at(-1)!), /The user copied what the worktree feature changed into the project folder/)
  })
})
