import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createWorktreeGit, isWorktreeName, type WorktreeGit } from './worktrees'

let home: string
let counter = 0
let gitPath: string

/** git with no settings of the machine's own: an empty global file, none of the system's. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !key.toUpperCase().startsWith('GIT_')) env[key] = value
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: environment(), encoding: 'utf8' }).trim()
}

function makeRepo(commit = true): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(home, `repo${counter++}-`)))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  if (commit) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'first')
  }
  return dir
}

function hook(dir: string, name: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho ran > "${marker.split(path.sep).join('/')}"\n`, { mode: 0o755 })
}

let worktrees: WorktreeGit

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-worktrees-')))
  fs.writeFileSync(path.join(home, 'gitconfig'), '')
  gitPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  worktrees = createWorktreeGit({ git: () => gitPath, env: environment })
})

after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('worktrees of a project', () => {
  it('take names that are one plain segment and a valid branch name', () => {
    for (const name of ['fix-login', 'v2.1', 'a_b', 'X']) assert.ok(isWorktreeName(name), name)
    for (const name of ['', '-x', '.hidden', 'a/b', 'a..b', 'x.lock', 'x.', 'a b', 'a\\b', 'x'.repeat(65)]) assert.ok(!isWorktreeName(name), name)
  })

  it('say why none can be made: no git, no repository, a folder inside one, no commit yet', async () => {
    const none = createWorktreeGit({ git: () => null })
    assert.match((await none.unavailable(home))!, /git was not found/)
    const plain = fs.mkdtempSync(path.join(home, 'plain-'))
    assert.match((await worktrees.unavailable(plain))!, /not a git repository/)
    const repo = makeRepo()
    fs.mkdirSync(path.join(repo, 'sub'))
    assert.match((await worktrees.unavailable(path.join(repo, 'sub')))!, /inside the repository at/)
    assert.match((await worktrees.unavailable(makeRepo(false)))!, /no commit yet/)
    assert.equal(await worktrees.unavailable(repo), undefined)
  })

  it('are made in .encode-worktrees on a branch of their own, kept out of the project status once', async () => {
    const repo = makeRepo()
    const base = git(repo, 'rev-parse', 'HEAD')
    const made = await worktrees.create(repo, 'fix-login')
    // The folder's real path: on Windows a temporary folder may be named by its short form (RUNNER~1).
    assert.deepEqual(made, { name: 'fix-login', path: path.join(fs.realpathSync.native(repo), '.encode-worktrees', 'fix-login'), branch: 'encode/fix-login', base, from: 'main' })
    assert.equal(fs.readFileSync(path.join(made.path, 'a.txt'), 'utf8'), 'one\n')
    assert.equal(git(made.path, 'symbolic-ref', '--short', 'HEAD'), 'encode/fix-login')
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the project shows nothing new')
    await worktrees.create(repo, 'second')
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(exclude.split('\n').filter((line) => line === '/.encode-worktrees/').length, 1)
  })

  it('refuse a name that is taken, as a folder or as a branch, and one that is not a name', async () => {
    const repo = makeRepo()
    await worktrees.create(repo, 'taken')
    await assert.rejects(worktrees.create(repo, 'taken'), /is there already/)
    git(repo, 'branch', 'encode/branch-only')
    await assert.rejects(worktrees.create(repo, 'branch-only'), /The branch encode\/branch-only is there already/)
    await assert.rejects(worktrees.create(repo, '../out'), /cannot name a worktree/)
    assert.ok(!fs.existsSync(path.join(path.dirname(repo), 'out')))
  })

  it('start no hook, from .git/hooks or from a folder the project names', async () => {
    const repo = makeRepo()
    const marker = path.join(home, `hook-${counter++}`)
    hook(path.join(repo, '.git', 'hooks'), 'post-checkout', marker)
    hook(path.join(repo, '.git', 'hooks'), 'reference-transaction', marker)
    const made = await worktrees.create(repo, 'quiet')
    git(repo, 'config', 'core.hooksPath', '.husky')
    hook(path.join(repo, '.husky'), 'post-checkout', marker)
    hook(path.join(repo, '.husky'), 'reference-transaction', marker)
    await worktrees.create(repo, 'quiet-too')
    await worktrees.remove(repo, made, { force: false })
    assert.ok(!fs.existsSync(marker), 'no hook ran')
    // The same hook runs for git used by hand, so the test proves something.
    git(repo, 'checkout', '-q', '-b', 'by-hand')
    assert.ok(fs.existsSync(marker))
  })

  it('tell what would be lost: changes not committed, and commits no other branch has', async () => {
    const repo = makeRepo()
    const made = await worktrees.create(repo, 'work')
    assert.deepEqual(await worktrees.work(made), { changed: [], commits: 0 })
    fs.writeFileSync(path.join(made.path, 'a.txt'), 'two\n')
    fs.writeFileSync(path.join(made.path, 'new.txt'), 'new\n')
    assert.deepEqual((await worktrees.work(made)).changed.sort(), ['a.txt', 'new.txt'])
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-q', '-m', 'work')
    assert.deepEqual(await worktrees.work(made), { changed: [], commits: 1 })
    // Merged into main, the commit is no longer lost with the branch.
    git(repo, 'merge', '-q', '--ff-only', 'encode/work')
    assert.deepEqual(await worktrees.work(made), { changed: [], commits: 0 })
  })

  it('are removed with their branch, and the folder of worktrees goes once it is empty', async () => {
    const repo = makeRepo()
    const made = await worktrees.create(repo, 'gone')
    fs.writeFileSync(path.join(made.path, 'a.txt'), 'changed\n')
    await assert.rejects(worktrees.remove(repo, made, { force: false }), /modified or untracked files|contains modified/)
    assert.ok(fs.existsSync(made.path))
    await worktrees.remove(repo, made, { force: true })
    assert.ok(!fs.existsSync(made.path))
    assert.ok(!fs.existsSync(path.join(repo, '.encode-worktrees')))
    assert.equal(git(repo, 'branch', '--list', 'encode/gone'), '')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  })

  it('are taken off the list when their folder was deleted by hand', async () => {
    const repo = makeRepo()
    const made = await worktrees.create(repo, 'by-hand')
    fs.rmSync(made.path, { recursive: true, force: true })
    await worktrees.remove(repo, made, { force: false })
    assert.equal(git(repo, 'branch', '--list', 'encode/by-hand'), '')
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  })
})

describe('the seed of an attempt (best of N)', () => {
  it('copies the uncommitted work in and commits it as the base, links dependencies and copies .env files', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\ndist/\n')
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'old\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'ignore')
    // The person's work, not committed: a change, a new file in a new folder, a deletion.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one, changed\n')
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'src', 'new.ts'), 'export const x = 1\n')
    fs.rmSync(path.join(repo, 'gone.txt'))
    // What git ignores: installed packages, the environment, a build.
    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=local\n')
    fs.mkdirSync(path.join(repo, 'dist'))
    fs.writeFileSync(path.join(repo, 'dist', 'out.js'), 'built\n')

    const made = await worktrees.create(repo, 'best-1')
    const seed = await worktrees.seed(repo, made)
    assert.deepEqual(seed.linked, ['node_modules'])
    assert.equal(fs.readFileSync(path.join(made.path, 'a.txt'), 'utf8'), 'one, changed\n')
    assert.equal(fs.readFileSync(path.join(made.path, 'src', 'new.ts'), 'utf8'), 'export const x = 1\n')
    assert.ok(!fs.existsSync(path.join(made.path, 'gone.txt')))
    assert.equal(fs.readFileSync(path.join(made.path, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1\n')
    assert.equal(fs.readFileSync(path.join(made.path, '.env'), 'utf8'), 'TOKEN=local\n')
    assert.ok(!fs.existsSync(path.join(made.path, 'dist')), 'a build is not copied')
    assert.equal(git(made.path, 'rev-parse', 'HEAD'), seed.base)
    assert.equal(git(made.path, 'log', '-1', '--format=%an'), 'eNCode')
    assert.deepEqual(await worktrees.changes(made, seed), [], 'the seed is not the attempt\'s work, nor are its links')
    const status = git(repo, 'status', '--porcelain').split('\n').map((line) => line.trim()).sort()
    assert.deepEqual(status, ['?? src/', 'D gone.txt', 'M a.txt'], 'the project is untouched')

    // The attempt's work: a change, a new file, a deletion, and a commit it should not have made.
    fs.writeFileSync(path.join(made.path, 'a.txt'), 'one, by the attempt\n')
    fs.writeFileSync(path.join(made.path, 'b.txt'), 'new\n')
    fs.rmSync(path.join(made.path, 'src', 'new.ts'))
    fs.writeFileSync(path.join(made.path, 'node_modules', 'left-pad', 'extra.js'), 'x\n')
    git(made.path, 'add', 'b.txt')
    git(made.path, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'attempt')
    assert.deepEqual(await worktrees.changes(made, seed), [
      { path: 'a.txt', kind: 'modified' },
      { path: 'b.txt', kind: 'added' },
      { path: 'src/new.ts', kind: 'deleted' },
    ])
    assert.equal((await worktrees.original(made, seed, 'a.txt'))?.toString('utf8'), 'one, changed\n')
    assert.equal((await worktrees.original(made, seed, 'src/new.ts'))?.toString('utf8'), 'export const x = 1\n')
    assert.equal(await worktrees.original(made, seed, 'b.txt'), null)

    // Removing it never reaches through the link into the project's packages.
    await worktrees.unlink(made, seed)
    await worktrees.remove(repo, made, { force: true })
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'left-pad', 'index.js')))
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'left-pad', 'extra.js')), 'a write through the link lands in the project')
  })

  it('refuses more uncommitted work than an attempt copies', async () => {
    const repo = makeRepo()
    fs.mkdirSync(path.join(repo, 'many'))
    for (let index = 0; index < 2_001; index++) fs.writeFileSync(path.join(repo, 'many', `f${index}.txt`), '')
    const made = await worktrees.create(repo, 'best-big')
    await assert.rejects(worktrees.seed(repo, made), /2001 files changed since the last commit; attempts copy at most 2000/)
    await worktrees.remove(repo, made, { force: true })
  })
})
