import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Repository, ReviewError, type ReviewSnapshot } from './review'
import { GitRunner } from './runner'

let home: string
let counter = 0

/** git with no settings of the machine's own: an empty global file, none of the system's. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !key.toUpperCase().startsWith('GIT_')) env[key] = value
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: environment(), encoding: 'utf8' })
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(home, `repo${counter++}-`))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  return dir
}

function write(dir: string, file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8')
}

async function open(dir: string, trash?: (file: string) => Promise<void>): Promise<Repository> {
  const repo = await Repository.open((cwd) => new GitRunner({ git: 'git', cwd, env: environment() }), dir, trash ? { trash } : {})
  assert.ok(repo instanceof Repository, 'the folder is a repository')
  return repo as Repository
}

const lines = (count: number, change: (n: number) => string = (n) => `line ${n}`) => Array.from({ length: count }, (_, index) => change(index + 1)).join('\n') + '\n'

function file(snapshot: ReviewSnapshot, name: string) {
  const found = snapshot.files.find((item) => item.path === name)
  assert.ok(found, `${name} is in the review`)
  return found!
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-git-'))
  fs.writeFileSync(path.join(home, 'gitconfig'), '')
})

after(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('a repository under review', () => {
  it('says why a folder is not one', async () => {
    const plain = fs.mkdtempSync(path.join(home, 'plain-'))
    const result = await Repository.open((cwd) => new GitRunner({ git: 'git', cwd, env: environment() }), plain)
    assert.ok(!(result instanceof Repository))
    assert.match((result as { reason: string }).reason, /not in a git repository/)
  })

  it('opened from a folder inside it, lists the whole repository and says where that folder sits', async () => {
    const dir = makeRepo()
    write(dir, 'apps/web/index.ts', 'one\n')
    write(dir, 'README.md', 'readme\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'apps/web/index.ts', 'two\n')
    write(dir, 'README.md', 'changed\n')
    const top = await open(dir)
    assert.equal((await top.review({ kind: 'unstaged' })).repo.folder, '')
    const inner = await open(path.join(dir, 'apps', 'web'))
    const snapshot = await inner.review({ kind: 'unstaged' })
    assert.equal(snapshot.repo.folder, 'apps/web/')
    assert.equal(snapshot.repo.root, path.resolve(git(dir, 'rev-parse', '--show-toplevel').trim()))
    assert.deepEqual(
      snapshot.files.map((item) => item.path),
      ['README.md', 'apps/web/index.ts'],
    )
  })

  it('stages, unstages and reverts single hunks of a file, and leaves the rest', async () => {
    const dir = makeRepo()
    write(dir, 'src/app.ts', lines(30))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'src/app.ts', lines(30, (n) => (n === 3 ? 'line three' : n === 25 ? 'line twenty-five' : `line ${n}`)))
    const repo = await open(dir)

    let unstaged = await repo.review({ kind: 'unstaged' })
    const app = file(unstaged, 'src/app.ts')
    assert.equal(app.change, 'modified')
    assert.equal(app.hunks.length, 2)
    assert.equal(app.hunkActions, true)
    assert.deepEqual([unstaged.added, unstaged.removed], [2, 2])

    await repo.act({ kind: 'unstaged' }, { type: 'stage-hunk', path: 'src/app.ts', hunk: app.hunks[0].id, fingerprint: app.fingerprint })
    assert.match(git(dir, 'diff', '--cached'), /\+line three/)
    assert.doesNotMatch(git(dir, 'diff', '--cached'), /twenty-five/)
    unstaged = await repo.review({ kind: 'unstaged' })
    assert.equal(file(unstaged, 'src/app.ts').hunks.length, 1)
    const staged = await repo.review({ kind: 'staged' })
    assert.equal(file(staged, 'src/app.ts').hunks.length, 1)
    assert.deepEqual(staged.counts, { unstaged: 1, staged: 1 })

    const stagedFile = file(staged, 'src/app.ts')
    await repo.act({ kind: 'staged' }, { type: 'unstage-hunk', path: 'src/app.ts', hunk: stagedFile.hunks[0].id, fingerprint: stagedFile.fingerprint })
    assert.equal(git(dir, 'diff', '--cached'), '')

    unstaged = await repo.review({ kind: 'unstaged' })
    const both = file(unstaged, 'src/app.ts')
    const result = await repo.act({ kind: 'unstaged' }, { type: 'revert-hunk', path: 'src/app.ts', hunk: both.hunks[1].id, fingerprint: both.fingerprint })
    assert.equal(result.undoable, true)
    assert.equal(read(dir, 'src/app.ts'), lines(30, (n) => (n === 3 ? 'line three' : `line ${n}`)))
    assert.equal(repo.undoLabel, 'Reverted a change in app.ts')
    await repo.undo()
    assert.equal(read(dir, 'src/app.ts'), lines(30, (n) => (n === 3 ? 'line three' : n === 25 ? 'line twenty-five' : `line ${n}`)))
  })

  it('refuses a hunk of a file that changed since it was shown, and an undo of a file changed since', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', lines(10))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'a.txt', lines(10, (n) => (n === 5 ? 'five' : `line ${n}`)))
    const repo = await open(dir)
    const shown = file(await repo.review({ kind: 'unstaged' }), 'a.txt')
    write(dir, 'a.txt', lines(10, (n) => (n === 5 ? 'FIVE' : `line ${n}`)))
    await assert.rejects(repo.act({ kind: 'unstaged' }, { type: 'stage-hunk', path: 'a.txt', hunk: shown.hunks[0].id, fingerprint: shown.fingerprint }), (error: unknown) => error instanceof ReviewError && error.code === 'stale')
    assert.equal(git(dir, 'diff', '--cached'), '', 'nothing was staged')

    const fresh = file(await repo.review({ kind: 'unstaged' }), 'a.txt')
    await repo.act({ kind: 'unstaged' }, { type: 'revert-hunk', path: 'a.txt', hunk: fresh.hunks[0].id, fingerprint: fresh.fingerprint })
    write(dir, 'a.txt', 'someone else\n')
    await assert.rejects(repo.undo(), (error: unknown) => error instanceof ReviewError && error.code === 'stale')
    assert.equal(read(dir, 'a.txt'), 'someone else\n')
    assert.equal(repo.undoLabel, null)
  })

  it('keeps an index with LF endings LF when a hunk from a CRLF file is staged (core.autocrlf)', async () => {
    const dir = makeRepo()
    git(dir, 'config', 'core.autocrlf', 'true')
    write(dir, 'win.txt', 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\nten\r\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    assert.equal(git(dir, 'show', 'HEAD:win.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'git keeps it LF')
    write(dir, 'win.txt', 'ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\nTEN\r\n')
    const repo = await open(dir)
    const win = file(await repo.review({ kind: 'unstaged' }), 'win.txt')
    assert.equal(win.hunks.length, 2, 'only the changed lines, not every line ending')
    await repo.act({ kind: 'unstaged' }, { type: 'stage-hunk', path: 'win.txt', hunk: win.hunks[0].id, fingerprint: win.fingerprint })
    assert.equal(git(dir, 'show', ':win.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
    const after = file(await repo.review({ kind: 'unstaged' }), 'win.txt')
    await repo.act({ kind: 'unstaged' }, { type: 'revert-hunk', path: 'win.txt', hunk: after.hunks[0].id, fingerprint: after.fingerprint })
    assert.equal(read(dir, 'win.txt'), 'ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight\r\nnine\r\nten\r\n', 'the file keeps CRLF')
  })

  it('says when only the line endings or the mode changed', async () => {
    const dir = makeRepo()
    write(dir, 'e.txt', 'a\nb\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'e.txt', 'a\r\nb\r\n')
    const repo = await open(dir)
    const ending = file(await repo.review({ kind: 'unstaged' }), 'e.txt')
    assert.equal(ending.hunks.length, 0)
    assert.match(ending.note ?? '', /Only the line endings changed \(LF to CRLF\)/)
    if (process.platform !== 'win32') {
      write(dir, 'e.txt', 'a\nb\n')
      fs.chmodSync(path.join(dir, 'e.txt'), 0o755)
      assert.match(file(await repo.review({ kind: 'unstaged' }), 'e.txt').note ?? '', /now executable/)
    }
  })

  it('treats a new file as one change: staged, unstaged, deleted and put back as a whole', async () => {
    const dir = makeRepo()
    write(dir, 'keep.txt', 'x\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'dir with space/ünï.md', '# Title\n\nText.\n')
    const trashed: string[] = []
    const repo = await open(dir, async (target) => {
      trashed.push(target)
      fs.rmSync(target)
    })
    let shown = file(await repo.review({ kind: 'unstaged' }), 'dir with space/ünï.md')
    assert.equal(shown.change, 'untracked')
    assert.equal(shown.added, 3)
    await repo.act({ kind: 'unstaged' }, { type: 'stage-hunk', path: shown.path, hunk: shown.hunks[0].id, fingerprint: shown.fingerprint })
    const staged = file(await repo.review({ kind: 'staged' }), 'dir with space/ünï.md')
    assert.equal(staged.change, 'added')
    await repo.act({ kind: 'staged' }, { type: 'unstage-file', path: staged.path })
    shown = file(await repo.review({ kind: 'unstaged' }), 'dir with space/ünï.md')
    assert.equal(shown.change, 'untracked')
    await repo.act({ kind: 'unstaged' }, { type: 'revert-file', path: shown.path, fingerprint: shown.fingerprint })
    assert.equal(fs.existsSync(path.join(dir, 'dir with space/ünï.md')), false)
    assert.equal(trashed.length, 1)
    await repo.undo()
    assert.equal(read(dir, 'dir with space/ünï.md'), '# Title\n\nText.\n')
  })

  it('reverts a deleted file, and every change at once, and can take that back', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\n')
    write(dir, 'b.txt', 'b\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    fs.rmSync(path.join(dir, 'a.txt'))
    write(dir, 'b.txt', 'B\n')
    write(dir, 'c.txt', 'c\n')
    const repo = await open(dir)
    const snapshot = await repo.review({ kind: 'unstaged' })
    assert.deepEqual(snapshot.files.map((item) => [item.path, item.change]), [
      ['a.txt', 'deleted'],
      ['b.txt', 'modified'],
      ['c.txt', 'untracked'],
    ])
    const result = await repo.act({ kind: 'unstaged' }, { type: 'revert-all' })
    assert.equal(result.message, 'Reverted 3 files')
    assert.equal(read(dir, 'a.txt'), 'a\n')
    assert.equal(read(dir, 'b.txt'), 'b\n')
    assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false)
    assert.equal((await repo.review({ kind: 'unstaged' })).files.length, 0)
    await repo.undo()
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false)
    assert.equal(read(dir, 'b.txt'), 'B\n')
    assert.equal(read(dir, 'c.txt'), 'c\n')
  })

  it('shows a staged rename with its old name, and unstages it whole', async () => {
    const dir = makeRepo()
    write(dir, 'old.ts', lines(8))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    git(dir, 'mv', 'old.ts', 'new.ts')
    const repo = await open(dir)
    const renamed = file(await repo.review({ kind: 'staged' }), 'new.ts')
    assert.equal(renamed.change, 'renamed')
    assert.equal(renamed.oldPath, 'old.ts')
    assert.equal(renamed.hunks.length, 0)
    assert.match(renamed.note ?? '', /Renamed from old\.ts, unchanged/)
    await repo.act({ kind: 'staged' }, { type: 'unstage-file', path: 'new.ts' })
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '')
  })

  it('blocks single hunks of a file git filters, and of one whitespace is hidden in', async () => {
    const dir = makeRepo()
    write(dir, '.gitattributes', '*.dat filter=custom\n')
    write(dir, 'x.dat', lines(5))
    write(dir, 'y.txt', lines(5))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'x.dat', lines(5, (n) => (n === 2 ? 'two' : `line ${n}`)))
    write(dir, 'y.txt', lines(5, (n) => (n === 2 ? 'two' : `line ${n}`)))
    const repo = await open(dir)
    const snapshot = await repo.review({ kind: 'unstaged' })
    assert.equal(file(snapshot, 'x.dat').hunkActions, false)
    assert.match(file(snapshot, 'x.dat').hunkActionsOff ?? '', /"custom" filter/)
    assert.equal(file(snapshot, 'y.txt').hunkActions, true)
    const hidden = await repo.review({ kind: 'unstaged' }, { context: 3, ignoreWhitespace: true })
    assert.equal(file(hidden, 'y.txt').hunkActions, false)
    const y = file(hidden, 'y.txt')
    await assert.rejects(repo.act({ kind: 'unstaged' }, { type: 'stage-hunk', path: 'y.txt', hunk: y.hunks[0].id, fingerprint: y.fingerprint }, { context: 3, ignoreWhitespace: true }), /Whitespace is hidden/)
  })

  it('shows a branch against its base, the work not yet committed included, and one commit against its parent', async () => {
    const dir = makeRepo()
    write(dir, 'base.txt', lines(4))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base commit')
    git(dir, 'checkout', '-q', '-b', 'feature')
    write(dir, 'feature.txt', 'new\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'add the feature')
    write(dir, 'base.txt', lines(4, (n) => (n === 1 ? 'first' : `line ${n}`)))
    write(dir, 'scratch.txt', 'scratch\n')
    const repo = await open(dir)
    assert.equal(await repo.defaultBase(), 'main')
    const branch = await repo.review({ kind: 'branch' })
    assert.deepEqual(branch.base?.ref, 'main')
    assert.equal(branch.readOnly, true)
    assert.deepEqual(branch.files.map((item) => [item.path, item.change, item.kind, item.added, item.removed]), [
      ['base.txt', 'modified', 'text', 1, 1],
      ['feature.txt', 'added', 'text', 1, 0],
      ['scratch.txt', 'untracked', 'text', 1, 0],
    ])
    await assert.rejects(repo.act(branch.scope, { type: 'stage-all' }), /Nothing can be changed in this view/)
    await assert.rejects(repo.review({ kind: 'branch', base: 'no-such-branch' }), /There is no branch called no-such-branch/)

    const commits = await repo.commits()
    assert.deepEqual(commits.map((commit) => commit.subject), ['add the feature', 'base commit'])
    const one = await repo.review({ kind: 'commit', commit: commits[0].oid })
    assert.equal(one.commit?.subject, 'add the feature')
    assert.deepEqual(one.files.map((item) => [item.path, item.change, item.added]), [['feature.txt', 'added', 1]])
    const root = await repo.review({ kind: 'commit', commit: commits[1].oid })
    assert.deepEqual(root.files.map((item) => [item.path, item.change]), [['base.txt', 'added']], 'the first commit is shown against nothing')
    await assert.rejects(repo.review({ kind: 'commit', commit: '--output=/tmp/x' }), /That is not a commit/)
  })

  it('commits what is staged, or everything, keeps a message’s # lines, and says what it made', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    write(dir, 'a.txt', 'A\n')
    write(dir, 'b.txt', 'b\n')
    const repo = await open(dir)
    await assert.rejects(repo.commit({ message: 'nothing staged' }), /Nothing is staged/)
    await assert.rejects(repo.commit({ message: '   ' }), /Write a commit message/)
    const made = await repo.commit({ message: 'Change a and add b\n\n#42 is fixed by this', all: true })
    assert.equal(made.subject, 'Change a and add b')
    assert.equal(git(dir, 'log', '-1', '--format=%B').trim(), 'Change a and add b\n\n#42 is fixed by this')
    assert.equal(git(dir, 'status', '--porcelain'), '')
    await assert.rejects(repo.push(), /no remote to push to/)
  })

  it('pushes a branch without an upstream to origin and sets it', async () => {
    const remote = fs.mkdtempSync(path.join(home, 'remote-'))
    git(remote, 'init', '-q', '--bare')
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'first')
    git(dir, 'remote', 'add', 'origin', remote)
    const repo = await open(dir)
    assert.deepEqual(await repo.push(), { remote: 'origin', branch: 'main', upstream: true })
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'first')
    write(dir, 'a.txt', 'A\n')
    await repo.commit({ message: 'second', all: true })
    assert.deepEqual(await repo.push(), { remote: 'origin', branch: 'main', upstream: false })
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'second')
    const context = await repo.commitContext()
    assert.deepEqual(context.subjects.slice(0, 2), ['second', 'first'])
  })

  it('writes the staged diff and recent subjects a drafted message is made from', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', lines(5))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'Add a')
    write(dir, 'a.txt', lines(5, (n) => (n === 3 ? 'three' : `line ${n}`)))
    git(dir, 'add', '-A')
    const repo = await open(dir)
    const context = await repo.commitContext()
    assert.deepEqual(context.files, ['modified a.txt (+1 -1)'])
    assert.match(context.diff, /^--- a\.txt\n\+\+\+ a\.txt\n@@ -1,5 \+1,5 @@\n line 1\n line 2\n-line 3\n\+three/)
    assert.deepEqual(context.subjects, ['Add a'])

    // Committing everything: what is not staged yet is part of the message too, and named as such.
    write(dir, 'b.txt', 'new\n')
    const all = await repo.commitContext({ all: true })
    assert.deepEqual(all.files, ['modified a.txt (+1 -1)', 'untracked b.txt (+1 -0) (not staged yet)'])
    assert.match(all.diff, /\+\+\+ b\.txt \(not staged yet\)\n@@ -0,0 \+1 @@\n\+new\n/)

    // A large file is cut to its share, and the others still get theirs.
    write(dir, 'c.txt', lines(4000))
    const cut = await repo.commitContext({ all: true, limit: 3000 })
    assert.ok(cut.diff.length <= 3000, `${cut.diff.length} characters`)
    assert.match(cut.diff, /\+\+\+ c\.txt \(not staged yet\)\n[\s\S]*\(cut short\)\n$/)
    assert.match(cut.diff, /^--- a\.txt\n/)
  })
})
