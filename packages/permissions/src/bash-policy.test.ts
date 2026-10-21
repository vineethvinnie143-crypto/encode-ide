import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { parseBash, staticValue, type BashCommand, type BashScript, type BashWord } from './bash-grammar'
import { assessBashCommand, gitBashToWindows, type BashContext } from './bash-policy'
import { confirmOnDisk, type DiskProbe } from './disk'
import { gitSafetyProblem, withGitSafety } from './environment'
import { isInside } from './paths'

const SAFE_ENV = withGitSafety({ PATH: '/usr/bin:/bin', HOME: '/home/u' }, false)
const POSIX: BashContext = { root: '/ws', cwd: '/ws', home: '/home/u', platform: 'posix', env: SAFE_ENV, trusted: true }
const WINDOWS: BashContext = {
  root: 'C:\\ws',
  cwd: 'C:\\ws',
  home: 'C:\\Users\\u',
  platform: 'win32',
  env: withGitSafety({ Path: 'C:\\Windows\\System32', HOME: '/c/Users/u' }, true),
  trusted: true,
}

function verdict(line: string, context: BashContext = POSIX) {
  return assessBashCommand(line, context)
}

const ALLOWED = [
  'ls',
  'ls -la src',
  'pwd',
  'echo hello world',
  'echo "$HOME" $PWD $? $#',
  'echo "files: $(ls | wc -l)"',
  'echo `pwd`',
  'printf "%s\\n" a b',
  'cat README.md | grep foo | wc -l',
  'cd src && ls && cat a.ts',
  'cd -- src; ls',
  'cd ./src || cd lib',
  '[ -f package.json ] && cat package.json',
  'test -d src || echo missing',
  'grep -rn "TODO" src',
  "rg -n 'useState' --glob '*.tsx'",
  "find . -name '*.ts' -not -path './node_modules/*'",
  'sort notes.txt | uniq -c',
  'diff <(sort a.txt) <(sort b.txt)',
  'ls 2>/dev/null',
  'ls >/dev/null 2>&1',
  'cat a.txt >&2',
  'cat < package.json',
  'wc -l < /dev/null',
  "cat <<'EOF'\nhello $USER `rm -rf ~`\nEOF",
  'cat <<EOF\nplain text\nEOF',
  'cat <<< "$HOME"',
  'command -v git',
  'type ls',
  'sha256sum package.json',
  'head -n 5 README.md; tail -n 3 README.md',
  'git status',
  'git log --oneline -n 5 | cat',
  'git show HEAD:src/a.ts',
  'git diff HEAD~1 -- src',
  'sleep 1 & ls',
  '(cd src && ls)',
  '{ ls; pwd; }',
  'node --version',
  ': nothing to do',
  '! grep -q x a.txt',
  'ls # trailing comment',
]

const ASKED: Array<[string, RegExp]> = [
  ['rm -rf build', /rm is not on the read-only list/],
  ['ls *.ts', /wildcard \*/],
  ['cat src/?.ts', /wildcard \?/],
  ['cat $FILE', /\$FILE/],
  ['cat "$HOME/.ssh/id_rsa"', /\$HOME/],
  ['echo $AWS_SECRET_ACCESS_KEY', /may hold a secret/],
  ['echo "${GITHUB_TOKEN}"', /may hold a secret/],
  ['FOO=1 ls', /sets FOO/],
  ['X=1', /sets X/],
  ['echo hi > out.txt', /writes its output/],
  ['ls 2> err.txt', /writes its output/],
  ['echo hi >| out.txt', /writes its output/],
  ['ls &> log.txt', /writes its output/],
  ['echo hi >& out.txt', /writes its output/],
  ['cat <> a.txt', /writes its output/],
  ['{ echo pwned; } > ~/.bashrc', /writes its output/],
  ['(echo x) >> notes.txt', /writes its output/],
  ['cat < ../secret', /outside the workspace/],
  ['cat <<EOF\n$(rm -rf x)\nEOF', /here-document/],
  ['cat <<EOF\n$HOME\nEOF', /here-document/],
  ['$(echo rm) -rf x', /only known when the line runs/],
  ['ls $(rm -rf x)', /rm is not on the read-only list/],
  ['echo "$(curl https://example.com)"', /curl is not on the read-only list/],
  ['echo $(cat ../secret)', /outside the workspace/],
  ['echo "$(< ../secret)"', /outside the workspace/],
  ['cat $(ls)', /passes the output/],
  ['ls `rm x`', /rm is not on the read-only list/],
  ['cat <(cat ../x)', /outside the workspace/],
  ['cat a<(ls)', /inside a word/],
  ['eval ls', /eval/],
  ['source x.sh', /source/],
  ['. ./x.sh', /runs \./],
  ['exec ls', /exec/],
  ['builtin echo hi', /builtin/],
  ['command ls', /command/],
  ['export FOO=1', /state/],
  ['unset PATH', /state/],
  ['alias ls=rm', /state/],
  ['printf -v x hi', /sets a variable/],
  ['cd ..', /outside the workspace/],
  ['cd', /home directory/],
  ['cd -', /goes back/],
  ['cd -P src', /follows links/],
  ['cd src; cd ..; ls', /outside the workspace/],
  ['cd src && cd ../.. && ls', /outside the workspace/],
  ['(cd .. && ls)', /outside the workspace/],
  ['ls ~', /outside the workspace/],
  ['cat ~/.ssh/id_rsa', /outside the workspace/],
  ['cat /etc/passwd', /outside the workspace/],
  ['[ -f ../x ]', /outside the workspace/],
  ['test -e "$X"', /\$X/],
  ['ls -L', /uses -L/],
  ['/bin/ls', /by path/],
  ['./script.sh', /by path/],
  ['bash -c ls', /bash is not on the read-only list/],
  ['sh x.sh', /sh is not on the read-only list/],
  ['xargs cat < list.txt', /xargs is not on the read-only list/],
  ['env', /env is not on the read-only list/],
  ['printenv', /printenv is not on the read-only list/],
  ['jq -n env', /jq is not on the read-only list/],
  ['sha256sum -c sums.txt', /uses -c/],
  ['git push', /git push/],
  ['git -c core.pager=sh log', /git options/],
  ['git show HEAD:../secret', /git history/],
  ['git show HEAD:/etc/passwd', /git history/],
  ['git log -p -- ../other', /outside the workspace/],
  ['if true; then ls; fi', /if/],
  ['for f in a b; do cat $f; done', /for/],
  ['while true; do ls; done', /while/],
  ['f() { ls; }', /function/],
  ['ls {a,b}', /brace/],
  ['echo $((1+2))', /arithmetic|\$\(\(/],
  ['cat ~root/.bashrc', /~root|~user|other users/],
  ['ls\r', /control or invisible/],
  ['ls \u202ecod.exe', /control or invisible/],
  ['echo \u200b', /control or invisible/],
  ['', /empty/],
  ['   ', /empty/],
  [`echo ${'a'.repeat(9000)}`, /too long/],
  ['echo "unterminated', /./],
]

describe('assessBashCommand', () => {
  it('runs read-only lines unasked', () => {
    for (const line of ALLOWED) {
      const result = verdict(line)
      assert.equal(result.decision, 'allow', `${JSON.stringify(line)}: ${result.reason}`)
    }
  })

  it('asks for everything else, with a reason', () => {
    for (const [line, reason] of ASKED) {
      const result = verdict(line)
      assert.equal(result.decision, 'ask', `expected ask: ${JSON.stringify(line)}`)
      assert.match(result.reason, reason, JSON.stringify(line))
    }
  })

  it('reports the paths, programs and directories the caller must check on disk', () => {
    const result = verdict('cd src && cat a.ts | grep x; git log -- lib')
    assert.equal(result.decision, 'allow')
    assert.deepEqual(result.programs.sort(), ['cat', 'git', 'grep'])
    for (const expected of ['/ws', '/ws/src', '/ws/src/a.ts', '/ws/a.ts', '/ws/lib', '/ws/src/lib']) {
      assert.ok(result.paths.includes(expected), `missing ${expected} in ${result.paths}`)
    }
    assert.deepEqual(result.cwds?.sort(), ['/ws', '/ws/src'])
  })

  it('keeps the unfolded form of a path that goes through ..', () => {
    // On macOS and Linux `link/..` is the parent of wherever link points, not /ws.
    const result = verdict('cat link/../notes.txt && cd sub/.. && ls')
    assert.equal(result.decision, 'allow')
    for (const expected of ['/ws/notes.txt', '/ws/link/../notes.txt', '/ws/sub/..']) {
      assert.ok(result.paths.includes(expected), `missing ${expected} in ${result.paths}`)
    }
  })

  it('asks before git in a folder the user has not trusted', () => {
    assert.match(verdict('git status', { ...POSIX, trusted: false }).reason, /not trusted/)
    assert.match(verdict('git log', { ...POSIX, trusted: undefined }).reason, /not trusted/)
    assert.equal(verdict('ls', { ...POSIX, trusted: false }).decision, 'allow')
  })

  it('asks when the environment could make a read-only line run something else', () => {
    const withEnv = (extra: Record<string, string>) => ({ ...POSIX, env: { ...SAFE_ENV, ...extra } })
    assert.match(verdict('ls', withEnv({ BASH_ENV: '/ws/evil.sh' })).reason, /BASH_ENV/)
    assert.match(verdict('ls', withEnv({ LD_PRELOAD: '/ws/x.so' })).reason, /LD_PRELOAD/)
    assert.match(verdict('ls', withEnv({ 'BASH_FUNC_ls%%': '() { rm -rf ~; }' })).reason, /BASH_FUNC_ls/)
    assert.match(verdict('ls', withEnv({ SHELLOPTS: 'xtrace' })).reason, /SHELLOPTS/)
    assert.match(verdict('git status', withEnv({ GIT_DIR: '/elsewhere' })).reason, /GIT_DIR/)
    assert.match(verdict('git status', withEnv({ GIT_TRACE2: '/ws/out' })).reason, /GIT_TRACE2/)
    assert.match(verdict('rg x', withEnv({ RIPGREP_CONFIG_PATH: '/ws/rc' })).reason, /RIPGREP_CONFIG_PATH/)
    assert.match(verdict('node --version', withEnv({ NODE_OPTIONS: '--require=/ws/x.js' })).reason, /NODE_OPTIONS/)
    // Variables only one program reads do not matter to the others.
    assert.equal(verdict('ls', withEnv({ GIT_DIR: '/elsewhere', NODE_OPTIONS: '-r x' })).decision, 'allow')
    // Empty is unset.
    assert.equal(verdict('ls', withEnv({ BASH_ENV: '' })).decision, 'allow')
    assert.match(verdict('cd lib', withEnv({ CDPATH: '/' })).reason, /CDPATH/)
    assert.equal(verdict('cd ./lib', withEnv({ CDPATH: '/' })).decision, 'allow')
  })

  it("runs git only with eNCode's git safety settings in effect", () => {
    const base = { PATH: '/usr/bin' }
    assert.match(verdict('git status', { ...POSIX, env: base }).reason, /safety settings/)
    assert.match(verdict('git status', { ...POSIX, env: undefined }).reason, /safety settings/)
    // An earlier command lowered the count, so git ignores the settings.
    assert.match(verdict('git status', { ...POSIX, env: { ...SAFE_ENV, GIT_CONFIG_COUNT: '1' } }).reason, /safety settings/)
    // Or added a key of its own after them.
    const extra = { ...SAFE_ENV, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.fsmonitor', GIT_CONFIG_VALUE_2: '/ws/x' }
    assert.match(verdict('git status', { ...POSIX, env: extra }).reason, /safety settings/)
    const pager = { ...SAFE_ENV, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.pager', GIT_CONFIG_VALUE_2: 'sh' }
    assert.match(verdict('git status', { ...POSIX, env: pager }).reason, /core\.pager/)
    // Keys beyond the count are ignored by git, and so here.
    assert.equal(verdict('git status', { ...POSIX, env: { ...SAFE_ENV, GIT_CONFIG_KEY_9: 'core.pager' } }).decision, 'allow')
    assert.equal(gitSafetyProblem(withGitSafety({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' }, false), false) !== null, true)
  })

  it('asks when the line starts outside the workspace', () => {
    assert.equal(verdict('ls', { ...POSIX, cwd: '/' }).decision, 'ask')
    assert.equal(verdict('ls', { ...POSIX, cwd: '/ws/sub' }).decision, 'allow')
  })

  it('reads Git Bash paths on Windows', () => {
    assert.equal(gitBashToWindows('/c/Users/u'), 'C:\\Users\\u')
    assert.equal(gitBashToWindows('/d'), 'D:\\')
    assert.equal(gitBashToWindows('src/a.ts'), 'src/a.ts')
    assert.ok(!isInside('C:\\', gitBashToWindows('/tmp/x'), path.win32))
    assert.equal(verdict('cat /c/ws/src/a.ts', WINDOWS).decision, 'allow')
    assert.equal(verdict('cat C:/ws/src/a.ts', WINDOWS).decision, 'allow')
    assert.equal(verdict('cd /c/ws/src && ls', WINDOWS).decision, 'allow')
    assert.equal(verdict('git.exe status', WINDOWS).decision, 'allow')
    assert.match(verdict('cat /c/Users/u/.ssh/id_rsa', WINDOWS).reason, /outside the workspace/)
    assert.match(verdict('cat ~/.ssh/id_rsa', WINDOWS).reason, /outside the workspace/)
    assert.match(verdict('cat /tmp/x', WINDOWS).reason, /outside the workspace/)
    assert.match(verdict('cat /etc/passwd', { ...WINDOWS, root: 'C:\\' }).reason, /outside the workspace/)
    assert.match(verdict('cat D:/secret', WINDOWS).reason, /outside the workspace/)
    assert.match(verdict('cat //server/share/x', WINDOWS).reason, /outside the workspace/)
    assert.equal(verdict('ls', { ...WINDOWS, cwd: '/c/ws/src' }).decision, 'allow')
  })

  /** Every redirection that opens a file for writing, with its target, anywhere in the line. */
  function writtenTargets(script: BashScript): string[] {
    const found: string[] = []
    const visitWord = (word: BashWord) => {
      for (const part of word.parts) if (part.kind === 'command' || part.kind === 'process') visitScript(part.script)
    }
    const visitCommand = (command: BashCommand) => {
      for (const redirect of command.redirects) {
        visitWord(redirect.target)
        const target = staticValue(redirect.target) ?? '?'
        const duplicate = (redirect.operator === '>&' || redirect.operator === '<&') && /^(\d+|-)$/.test(target)
        if (['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(redirect.operator) && !duplicate) found.push(target)
      }
      if (command.kind === 'simple') {
        for (const word of command.words) visitWord(word)
        for (const assignment of command.assignments) visitWord(assignment.value)
      } else visitScript(command.body)
    }
    const visitScript = (inner: BashScript) => {
      for (const list of inner.lists) for (const pipeline of list.pipelines) pipeline.commands.forEach(visitCommand)
    }
    visitScript(script)
    return found
  }

  /** Commands that may appear in an allowed line, judged independently of the policy tables. */
  const MAY_RUN_UNASKED = new Set([
    'ls', 'cat', 'head', 'tail', 'wc', 'cd', 'echo', 'pwd', 'printf', 'true', 'false', 'grep', 'sort', 'uniq',
    'git', 'test', '[', ']', 'node', 'type', 'command', ':', 'find', 'diff', 'rg', 'exit',
  ])

  it('never lets a writing or unlisted command, a redirect to a file or an outside path through', async () => {
    // Mostly words that keep a line read-only, so that many generated lines are allowed and get checked.
    const word = gen.weighted(
      [4, gen.oneOf('ls', 'cat', 'echo', 'cd', 'git', 'status', 'log', 'grep', 'sort', 'a.txt', 'src', '-n', '"a b"', 'test', '-f')],
      [
        1,
        gen.oneOf(
          'rm', 'mv', 'cp', 'touch', 'env', 'export', 'push', 'node', '--version', '-e', 'curl', '-f', '-rn', 'find',
          '-exec', '-delete', '-o', '..', '../x', '/etc/passwd', '~', '~/x', '$HOME', '$X', '"$X"', '$(ls)', '$(rm x)',
          '`ls`', '*', 'eval', 'source', '.', 'exec', 'command', '-v', '[', ']', 'X=1', '{', '}', '(', ')', '<(ls)',
          '\\;', 'if', 'then', 'fi', 'printf', '/dev/null', '2', '&1',
        ),
      ],
    )
    const glue = gen.oneOf(' ', ' ', ' ', ' ', ';', ' && ', ' || ', ' | ', ' > ', ' >> ', ' < ', ' 2>&1 ', ' & ', '\n')
    const lines = gen.map(gen.array(gen.tuple(word, glue), 1), (parts) => parts.flat().join(''))
    await check(
      lines,
      (line) => {
        const result = assessBashCommand(line, POSIX)
        if (result.decision !== 'allow') return
        const parsed = parseBash(line)
        assert.ok(parsed.ok, 'allowed a line bash cannot read')
        for (const program of result.programs) assert.ok(MAY_RUN_UNASKED.has(program), `allowed ${program}`)
        for (const target of result.paths) assert.ok(isInside('/ws', target, path.posix), `allowed ${target}`)
        for (const target of writtenTargets(parsed.script)) assert.equal(target, '/dev/null', 'allowed a write')
      },
      { runs: 3000 },
    )
  })
})

describe('confirmOnDisk', () => {
  /** A fake filesystem: links map a path prefix to its target; programs map a name to its files. */
  function probe(links: Record<string, string>, programs: Record<string, string[]> = {}, entries: string[] = []): DiskProbe {
    const resolve = (absolute: string): string => {
      const parts = absolute.split('/').filter(Boolean)
      let current = '/'
      for (const part of parts) {
        if (part === '..') current = path.posix.dirname(current)
        else if (part !== '.') current = path.posix.join(current, part)
        if (links[current]) current = links[current]
      }
      return current
    }
    return {
      rootReal: '/ws',
      realPath: async (absolute) => resolve(absolute),
      locate: (program) => programs[program] ?? [],
      exists: async (absolute) => entries.includes(absolute),
    }
  }

  async function confirm(line: string, disk: DiskProbe, context: BashContext = POSIX) {
    return confirmOnDisk(assessBashCommand(line, context), context.root, disk, path.posix)
  }

  it('lets a line through when nothing on disk leads elsewhere', async () => {
    const disk = probe({}, { cat: ['/usr/bin/cat'], git: ['/usr/bin/git'] }, ['/ws/.git'])
    assert.equal((await confirm('cat a.txt && git status', disk)).decision, 'allow')
  })

  it('catches a link out of the workspace, including one walked through with ..', async () => {
    const disk = probe({ '/ws/link': '/home/u/projects' }, { cat: ['/usr/bin/cat'] })
    assert.match((await confirm('cat link/id_rsa', disk)).reason, /leads outside the workspace/)
    // Lexically /ws/.ssh/id_rsa; the kernel reads /home/u/.ssh/id_rsa.
    assert.match((await confirm('cat link/../.ssh/id_rsa', disk)).reason, /leads outside the workspace/)
    assert.match((await confirm('cd link/.. && cat .ssh/id_rsa', disk)).reason, /leads outside the workspace/)
  })

  it('catches a program that would start from inside the workspace', async () => {
    const disk = probe({}, { git: ['/ws/bin/git'] }, ['/ws/.git'])
    assert.match((await confirm('git status', disk)).reason, /from inside the workspace/)
    const relative = probe({}, { cat: ['bin/cat'] })
    assert.match((await confirm('cat a.txt', relative)).reason, /from inside the workspace/)
  })

  it('asks when git would use a repository that starts above the workspace', async () => {
    const elsewhere = probe({}, { git: ['/usr/bin/git'] }, ['/home/.git'])
    assert.equal((await confirm('git status', elsewhere)).decision, 'allow')
    const above = probe({}, { git: ['/usr/bin/git'] }, ['/.git'])
    assert.match((await confirm('git log -p', above)).reason, /starts above the workspace/)
    const inside = probe({}, { git: ['/usr/bin/git'] }, ['/ws/.git', '/.git'])
    assert.equal((await confirm('git log -p', inside)).decision, 'allow')
  })

  it('asks when the disk cannot be read', async () => {
    const broken: DiskProbe = { ...probe({}), realPath: async () => { throw new Error('EACCES') } }
    assert.match((await confirm('cat a.txt', broken)).reason, /could not be checked on disk/)
  })

  it('returns an ask verdict as it is', async () => {
    const result = await confirm('rm x', probe({}))
    assert.match(result.reason, /rm is not on the read-only list/)
  })
})
