import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { assessCommand, type CommandContext } from './command-policy'
import { isInside } from './paths'
import { commandName, parseLine } from './shell-grammar'
import path from 'node:path'

const POSIX: CommandContext = { root: '/ws', cwd: '/ws', home: '/home/u', platform: 'posix' }
const WINDOWS: CommandContext = { root: 'C:\\ws', cwd: 'C:\\ws', home: 'C:\\Users\\u', platform: 'win32' }

function decide(line: string, context: CommandContext = POSIX): string {
  return assessCommand(line, context).decision
}

const ALLOWED = [
  'ls',
  'ls -la src',
  'dir',
  'pwd',
  'echo hello world',
  'cat README.md',
  'type README.md',
  'head -n 5 README.md',
  'tail -n 20 src/a.ts',
  'cat README.md | grep foo | wc -l',
  'cd src && ls && cat a.ts',
  'where git',
  'grep -rn "TODO" src',
  'rg -n "useState" --glob "*.tsx"',
  'find . -name "*.ts" -not -path "./node_modules/*"',
  'sort notes.txt | uniq -c',
  'diff a.txt b.txt',
  'stat package.json',
  'tree -L 2',
  'du -sh src',
  'node --version',
  'python3 --version',
  'git status',
  'git status --porcelain -b',
  'git -P log --oneline -n 20',
  'git --no-pager diff HEAD~1 -- src',
  'git log --format="%h %s" -5',
  'git show HEAD:src/a.ts',
  'git diff main...feature --stat',
  'git blame -L 10,20 src/a.ts',
  'git branch',
  'git branch -a -v',
  'git branch --list "feat/*"',
  'git tag',
  'git tag -l "v1.*"',
  'git remote -v',
  'git remote get-url origin',
  'git stash list',
  'git stash show -p',
  'git rev-parse --show-toplevel',
  'git ls-files -m',
  'git grep -n foo',
  'git diff --text HEAD~1',
  'grep -rn --exclude=*.min.js foo src',
  'du -sh --exclude=node_modules .',
  'git --version',
  'git',
  '""',
]

const ASKED: Array<[string, RegExp]> = [
  ['rm -rf build', /rm changes files/],
  ['ls; rm x', /rm changes files/],
  ['ls && del x', /rm changes files/],
  ['mkdir x', /changes files/],
  ['touch a', /changes files/],
  ['cp a b', /changes files/],
  ['move a b', /changes files/],
  ['echo hi > out.txt', /writes its output/],
  ['echo hi >> out.txt', /writes its output/],
  ['cat a | sort > b', /writes its output/],
  ['cat ../secret', /outside the workspace/],
  ['cat ~/.ssh/id_rsa', /outside the workspace/],
  ['ls ~', /outside the workspace/],
  ['cat /etc/passwd', /outside the workspace/],
  ['head -n 1 src/../../x', /outside the workspace/],
  ['cd ..', /outside the workspace/],
  ['cd', /home directory/],
  ['cd src && cd ../.. && ls', /outside the workspace/],
  // `cd src` may fail, and then `cd ..` leaves the workspace.
  ['cd src; cd ..; ls', /outside the workspace/],
  ['env', /environment/],
  ['export TOKEN=x', /environment/],
  ['set', /environment/],
  ['unset PATH', /environment/],
  ['curl https://example.com', /not on the read-only list/],
  ['npm test', /npm is not on the read-only list/],
  ['npm run build', /npm is not on the read-only list/],
  ['npm -v', /npm is not on the read-only list/],
  ['tsc', /only version queries/],
  ['tsc -p .', /only version queries/],
  ['node script.js', /only version queries/],
  ['node -e "require(1)"', /only version queries/],
  ['python -v', /only version queries/],
  ['./run.sh', /by path/],
  ['bin/tool', /by path/],
  ['.hidden', /by path/],
  ['git push', /git push/],
  ['git commit -m x', /git commit/],
  ['git checkout main', /git checkout/],
  ['git config --list', /git config/],
  ['git -c core.pager=x log', /git options/],
  ['git -C /tmp status', /git options/],
  ['git --git-dir=/x status', /git options/],
  ['git branch newname', /creates a git branch/],
  ['git branch -D main', /uses -D/],
  ['git branch --delete x', /--delete/],
  ['git tag v1', /creates a git tag/],
  ['git tag -a v1 -m x', /uses -a/],
  ['git diff --output=x', /--output/],
  ['git log --ext-diff -p', /--ext-diff/],
  ['git diff --no-index a b', /--no-index/],
  ['git log -Oorder.txt', /uses -O/],
  ['git show --textconv HEAD:a', /--textconv/],
  ['git grep -O foo', /uses -O/],
  ['git remote add x y', /remote/],
  ['git stash', /stash/],
  ['git stash pop', /stash/],
  ['git log -- ../other', /outside the workspace/],
  ['find . -exec cat {} +', /-exec/],
  ['find . -delete', /-delete/],
  ['find / -name x', /outside the workspace/],
  ['find -L . -name x', /-L/],
  ['sort -o out.txt in.txt', /uses -o/],
  ['sort --output=out.txt in.txt', /--output/],
  ['sort --compress-program=sh x', /--compress-program/],
  // getopt_long and git take unambiguous prefixes of long options.
  ['sort --compress-prog=sh x', /--compress-program/],
  ['sort --out=a.txt a.txt', /--output/],
  ['grep --deref foo -r .', /--dereference-recursive/],
  ['grep --exclude-f=list foo -r .', /--exclude-from/],
  ['git diff --out=x', /--output/],
  ['git log --ext -p', /--ext-diff/],
  ['git show --textc HEAD:a', /--textconv/],
  ['git grep --textconv foo', /--textconv/],
  ['uniq in.txt out.txt', /output to a file/],
  ['rg --pre cat x', /--pre/],
  ['rg -L foo', /uses -L/],
  ['grep -f patterns.txt x', /uses -f/],
  ['grep -rf patterns.txt x', /uses -f/],
  ['grep -R foo .', /uses -R/],
  ['diff -r a b', /uses -r/],
  ['tree -o out.txt', /uses -o/],
  ['du -L .', /uses -L/],
  ['stat /', /outside the workspace/],
  ['readlink -f ..', /outside the workspace/],
  ['cat x | tee y', /tee is not on the read-only list/],
  ['echo "unterminated', /unterminated quote/],
  ['ls\nrm x', /control or invisible/],
  ['ls\r', /control or invisible/],
  ['ls \u202ecod.exe', /control or invisible/],
  ['echo \u200b', /control or invisible/],
  ['GIT status', /not on the read-only list/],
  ['', /empty/],
  ['   ', /empty/],
  [`echo ${'a'.repeat(3000)}`, /too long/],
]

describe('assessCommand', () => {
  it('runs read-only lines unasked', () => {
    for (const line of ALLOWED) {
      const verdict = assessCommand(line, POSIX)
      assert.equal(verdict.decision, 'allow', `${line}: ${verdict.reason}`)
    }
  })

  it('asks for everything else, with a reason', () => {
    for (const [line, reason] of ASKED) {
      const verdict = assessCommand(line, POSIX)
      assert.equal(verdict.decision, 'ask', `expected ask: ${JSON.stringify(line)}`)
      assert.match(verdict.reason, reason, JSON.stringify(line))
    }
  })

  it('reports the paths and programs the caller must check on disk', () => {
    const verdict = assessCommand('cd src && cat a.ts | grep x; git log -- lib', POSIX)
    assert.equal(verdict.decision, 'allow')
    assert.deepEqual(verdict.programs.sort(), ['git', 'grep'])
    for (const expected of ['/ws', '/ws/src', '/ws/src/a.ts', '/ws/a.ts', '/ws/lib', '/ws/src/lib']) {
      assert.ok(verdict.paths.includes(expected), `missing ${expected} in ${verdict.paths}`)
    }
  })

  it('keeps the unfolded form of paths that go through .., for the realpath check', () => {
    // On macOS and Linux the kernel walks `..` from where `link` points, so /ws/link/../x may not be /ws/x.
    const verdict = assessCommand('cat link/../x.txt && cd sub/.. && ls', POSIX)
    assert.equal(verdict.decision, 'allow')
    for (const expected of ['/ws/x.txt', '/ws/link/../x.txt', '/ws/sub/..']) {
      assert.ok(verdict.paths.includes(expected), `missing ${expected} in ${verdict.paths}`)
    }
    assert.deepEqual(verdict.cwds?.sort(), ['/ws', '/ws/sub/..'])
  })

  it('asks when the line starts outside the workspace', () => {
    assert.equal(decide('ls', { ...POSIX, cwd: '/' }), 'ask')
    assert.equal(decide('ls', { ...POSIX, cwd: '/ws/sub' }), 'allow')
  })

  it('follows Windows rules on Windows', () => {
    assert.equal(decide('git.exe status', WINDOWS), 'allow')
    assert.equal(decide('GIT status', WINDOWS), 'allow')
    assert.equal(decide('findstr foo src\\a.ts', WINDOWS), 'allow')
    assert.equal(decide('dir src', WINDOWS), 'allow')
    assert.equal(decide('git.cmd status', WINDOWS), 'ask')
    assert.equal(decide('type C:\\Windows\\win.ini', WINDOWS), 'ask')
    assert.equal(decide('dir \\\\attacker\\share', WINDOWS), 'ask')
    assert.equal(decide('type \\Windows\\win.ini', WINDOWS), 'ask')
    assert.equal(decide('type D:secret.txt', WINDOWS), 'ask')
    assert.equal(decide('sort /O out.txt in.txt', WINDOWS), 'ask')
    assert.equal(decide('cat ~\\.ssh\\id_rsa', WINDOWS), 'ask')
    assert.equal(decide('C:\\tools\\x.exe', WINDOWS), 'ask')
  })

  /** Commands that may appear in an allowed line, judged independently of the policy tables. */
  const MAY_RUN_UNASKED = new Set([
    'ls', 'cat', 'head', 'tail', 'wc', 'which', 'cd', 'echo', 'pwd', 'help', 'clear', 'date', 'whoami', 'history',
    'ver', 'exit', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'findstr', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
    'comm', 'stat', 'file', 'du', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'uname', 'nl', 'rev', 'fold',
    'column', 'printf', 'true', 'false', 'node', 'python', 'python3', 'tsc', 'git',
  ])

  it('never lets a writing or unlisted command, a redirect or an outside path through', async () => {
    const word = gen.oneOf(
      'ls', 'cat', 'rm', 'mv', 'cp', 'touch', 'mkdir', 'echo', 'cd', 'env', 'export', 'git', 'status', 'push',
      'log', 'node', '--version', '-e', 'curl', 'grep', '-f', '-rn', 'find', '-exec', '-delete', 'sort', '-o',
      'uniq', 'a.txt', 'b.txt', 'src', '..', '../x', '/etc/passwd', '~', '~/x', 'del', 'dir', 'type', '-la',
    )
    const glue = gen.oneOf(' ', ' ', ' ', ' ', ';', ' && ', ' || ', ' | ', ' > ', ' >> ', '"', "'", '\t')
    const lines = gen.map(gen.array(gen.tuple(word, glue), 1), (parts) => parts.flat().join(''))
    await check(
      lines,
      (line) => {
        const verdict = assessCommand(line, POSIX)
        if (verdict.decision !== 'allow') return
        for (const statement of parseLine(line)) {
          for (const segment of statement.segments) {
            assert.equal(segment.redirect, undefined, 'allowed a redirect')
            const name = commandName(segment.tokens[0])
            assert.ok(MAY_RUN_UNASKED.has(name), `allowed ${name}`)
          }
        }
        for (const target of verdict.paths) assert.ok(isInside('/ws', target, path.posix), `allowed ${target}`)
      },
      { runs: 2000 },
    )
  })
})
