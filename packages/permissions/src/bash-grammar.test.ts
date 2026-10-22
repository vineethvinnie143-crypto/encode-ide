import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen, prng } from '@encode/testkit'
import { parseBash, simpleCommands, staticValue, type BashScript, type BashSimpleCommand } from './bash-grammar'

function script(line: string): BashScript {
  const parsed = parseBash(line)
  if (!parsed.ok) assert.fail(`expected ${JSON.stringify(line)} to parse, got: ${parsed.reason}`)
  return parsed.script
}

function commands(line: string): BashSimpleCommand[] {
  return simpleCommands(script(line))
}

/** Each simple command's words, with `?` for a word that is only known at run time. */
function argv(line: string): string[][] {
  return commands(line).map((command) => command.words.map((word) => staticValue(word) ?? '?'))
}

function reason(line: string): string {
  const parsed = parseBash(line)
  if (parsed.ok) assert.fail(`expected ${JSON.stringify(line)} to be refused`)
  return parsed.reason
}

describe('bash grammar', () => {
  it('reads lists, pipelines and background jobs', () => {
    assert.deepEqual(argv('a 1; b && c || d & e'), [['a', '1'], ['b'], ['c'], ['d'], ['e']])
    const lists = script('a; b && c || d & e').lists
    assert.deepEqual(
      lists.map((list) => [list.operators, list.background]),
      [[[], false], [['&&', '||'], true], [[], false]],
    )
    assert.deepEqual(argv('cat a | grep x |& wc -l'), [['cat', 'a'], ['grep', 'x'], ['wc', '-l']])
    assert.deepEqual(argv('ls\npwd\n\n'), [['ls'], ['pwd']])
    assert.deepEqual(argv('sleep 1 & ls'), [['sleep', '1'], ['ls']])
    assert.equal(script('! grep x f').lists[0].pipelines[0].negated, true)
  })

  it('lets &&, || and | continue on the next line', () => {
    assert.deepEqual(argv('a &&\n  b ||\n\n c |\n d'), [['a'], ['b'], ['c'], ['d']])
  })

  it('removes quotes the way bash does', () => {
    assert.deepEqual(argv(`echo 'a b' "c d" e\\ f '' "" x"y"'z'`), [['echo', 'a b', 'c d', 'e f', '', '', 'xyz']])
    assert.deepEqual(argv(String.raw`echo "a\$b\"c\\d\e" 'x\y'`), [['echo', 'a$b"c\\d\\e', 'x\\y']])
    assert.deepEqual(argv('ec\\\nho a\\\n b'), [['echo', 'a', 'b']])
    assert.deepEqual(argv('echo "two\nlines"'), [['echo', 'two\nlines']])
  })

  it('decodes $\'…\' strings', () => {
    assert.deepEqual(argv(String.raw`cat $'\x2fetc\x2fpasswd' $'a\tb' $'\101é\'' $'\cA'`), [
      ['cat', '/etc/passwd', 'a\tb', "Aé'", '\x01'],
    ])
    assert.match(reason(String.raw`cat $'../..\0/ws'`), /NUL/)
    assert.match(reason(String.raw`cat $'\x00'`), /NUL/)
  })

  it('treats reserved words as plain words outside command position', () => {
    assert.deepEqual(argv('echo if then done }'), [['echo', 'if', 'then', 'done', '}']])
    assert.deepEqual(argv('{ls'), [['{ls']])
  })

  it('reads comments only at the start of a word', () => {
    assert.deepEqual(argv('ls # rm -rf /'), [['ls']])
    assert.deepEqual(argv('echo a#b # c\npwd'), [['echo', 'a#b'], ['pwd']])
    assert.deepEqual(argv('ls;# x\npwd'), [['ls'], ['pwd']])
  })

  it('finds commands inside substitutions, before the command that uses them', () => {
    assert.deepEqual(argv('echo $(git rev-parse HEAD) `date`'), [['git', 'rev-parse', 'HEAD'], ['date'], ['echo', '?', '?']])
    assert.deepEqual(argv('echo "$(cat "$(ls)")"'), [['ls'], ['cat', '?'], ['echo', '?']])
    assert.deepEqual(argv('diff <(git show a) <(git show b)'), [['git', 'show', 'a'], ['git', 'show', 'b'], ['diff', '?', '?']])
    assert.deepEqual(argv('cat > >(tee log)'), [['tee', 'log'], ['cat']])
    assert.deepEqual(argv('x=$(rm -rf ~) ls'), [['rm', '-rf', '?'], ['ls']])
    assert.deepEqual(argv('ls > $(touch f)'), [['touch', 'f'], ['ls']])
    assert.deepEqual(argv('echo `echo \\`date\\``'), [['date'], ['echo', '?'], ['echo', '?']])
    assert.deepEqual(argv('echo "`id`"'), [['id'], ['echo', '?']])
  })

  it('reads subshells and brace groups', () => {
    assert.deepEqual(argv('(cd src && ls) > out; { pwd; echo x; } 2>/dev/null'), [['cd', 'src'], ['ls'], ['pwd'], ['echo', 'x']])
    const [subshell, group] = script('(ls) > out; { pwd; }').lists.map((list) => list.pipelines[0].commands[0])
    assert.equal(subshell.kind, 'subshell')
    assert.deepEqual(subshell.redirects.map((redirect) => redirect.operator), ['>'])
    assert.equal(group.kind, 'group')
  })

  it('reads parameters and keeps their words dynamic', () => {
    const [command] = commands('echo $HOME ${USER} $1 $? "$@" ${10} $ a$')
    assert.deepEqual(
      command.words.slice(1).map((word) => word.parts.map((part) => (part.kind === 'param' ? `$${part.name}` : part.kind))),
      [['$HOME'], ['$USER'], ['$1'], ['$?'], ['literal', '$@'], ['$10'], ['literal'], ['literal']],
    )
    assert.deepEqual(argv('echo $ a$'), [['echo', '$', 'a$']])
  })

  it('reads redirections, with and without descriptors', () => {
    const [command] = commands('ls >out 2>&1 <in >>log &>all &>>both 2>/dev/null 3<>rw >|clobber 1>&-')
    assert.deepEqual(
      command.redirects.map((redirect) => [redirect.fd ?? null, redirect.operator, staticValue(redirect.target)]),
      [
        [null, '>', 'out'],
        [2, '>&', '1'],
        [null, '<', 'in'],
        [null, '>>', 'log'],
        [null, '&>', 'all'],
        [null, '&>>', 'both'],
        [2, '>', '/dev/null'],
        [3, '<>', 'rw'],
        [null, '>|', 'clobber'],
        [1, '>&', '-'],
      ],
    )
    assert.deepEqual(argv('echo a2>x'), [['echo', 'a2']])
    assert.deepEqual(commands('> created').map((command) => command.redirects.length), [1])
  })

  it('reads here-documents after the line that starts them', () => {
    const [cat, echo] = commands("cat <<EOF && echo done\nhello $USER\n  EOF\nEOF\npwd")
    assert.deepEqual(cat.redirects[0].heredoc, { delimiter: 'EOF', quoted: false, body: 'hello $USER\n  EOF' })
    assert.equal(staticValue(echo.words[1]), 'done')
    assert.deepEqual(argv("cat <<EOF && echo done\nhello\nEOF\npwd"), [['cat'], ['echo', 'done'], ['pwd']])

    const [quoted] = commands("cat <<'E O' > f\n$(rm -rf ~)\nE O")
    assert.deepEqual(quoted.redirects[0].heredoc, { delimiter: 'E O', quoted: true, body: '$(rm -rf ~)' })
    assert.equal(commands('cat <<\\EOF\nx\nEOF')[0].redirects[0].heredoc?.quoted, true)

    const [stripped] = commands('cat <<-EOF\n\tindented\n\tEOF\nls')
    assert.equal(stripped.redirects[0].heredoc?.body, 'indented')

    // Two documents on one line are read in order.
    const [both] = commands('cat <<A <<B\n1\nA\n2\nB')
    assert.deepEqual(both.redirects.map((redirect) => redirect.heredoc?.body), ['1', '2'])

    // A document whose && continues the line starts right after the first newline.
    assert.deepEqual(argv('cat <<EOF &&\nbody\nEOF\necho hi'), [['cat'], ['echo', 'hi']])
    // Inside a substitution.
    assert.deepEqual(argv('x=$(cat <<EOF\nhi\nEOF\n) ls'), [['cat'], ['ls']])
  })

  it('refuses here-documents that bash could end somewhere else', () => {
    assert.match(reason('cat <<EOF\nE\\\nOF\nrm -rf ~\nEOF'), /here-document/)
    // In a quoted document a trailing backslash is just text.
    assert.equal(commands("cat <<'EOF'\nE\\\nOF\nEOF")[0].redirects[0].heredoc?.body, 'E\\\nOF')
    assert.equal(commands('cat <<EOF\na\\\\\nEOF')[0].redirects[0].heredoc?.body, 'a\\\\')
  })

  it('reads assignments before the command name only', () => {
    const [prefixed] = commands('FOO=bar BAZ+=1 ls FOO=x')
    assert.deepEqual(prefixed.assignments.map((assignment) => [assignment.name, staticValue(assignment.value)]), [
      ['FOO', 'bar'],
      ['BAZ', '1'],
    ])
    assert.deepEqual(prefixed.words.map(staticValue), ['ls', 'FOO=x'])
    assert.deepEqual(commands('FOO=').map((command) => [command.assignments.length, command.words.length]), [[1, 0]])
    assert.deepEqual(argv('"FOO"=bar'), [['FOO=bar']])
  })

  it('reads tilde prefixes', () => {
    const tilde = (line: string) =>
      commands(line)[0].words.slice(1).map((word) => word.parts.map((part) => (part.kind === 'literal' ? part.value : part.kind)).join('|'))
    assert.deepEqual(tilde('cat ~ ~/x a~ "~" ~"x"'), ['tilde', 'tilde|/x', 'a~', '~', '~|x'])
    assert.deepEqual(tilde('echo a=~/x b=c:~/y --x=~/z'), ['a=|tilde|/x', 'b=c:|tilde|/y', '--x=~/z'])
  })

  it('marks unquoted globs', () => {
    const kinds = (line: string) => commands(line)[0].words.slice(1).map((word) => word.parts.map((part) => part.kind).join('|'))
    assert.deepEqual(kinds(`ls *.ts a?b x[ab]y '*' "?" \\* [ ]`), [
      'glob|literal',
      'literal|glob|literal',
      'literal|glob|literal',
      'literal',
      'literal',
      'literal',
      'literal',
      'literal',
    ])
  })

  it('refuses constructs it does not read', () => {
    const unsupported: Array<[string, RegExp]> = [
      ['for f in *; do cat $f; done', /for/],
      ['if true; then ls; fi', /if/],
      ['while true; do ls; done', /while/],
      ['case x in x) ls;; esac', /case/],
      ['[[ -f x ]] && ls', /\[\[/],
      ['((x = 1))', /arithmetic/],
      ['echo $((1 + 2))', /arithmetic/],
      ['echo $[1 + 2]', /arithmetic/],
      ['echo ${x:-y}', /parameter expansion/],
      ['echo ${!x}', /parameter expansion/],
      ['echo ${x@P}', /parameter expansion/],
      ['echo ${#x}', /parameter expansion/],
      ['echo {a,b}', /brace/],
      ['echo x{1..3}', /brace/],
      ['cat ~root/.ssh/id_rsa', /~root/],
      ['cd ~-', /~-/],
      ['f() { ls; }', /function/],
      ['function f { ls; }', /function/],
      ['a[0]=1 ls', /array/],
      ['ls {fd}>out', /named file descriptor/],
      ['time ls', /time/],
      ['coproc ls', /coproc/],
    ]
    for (const [line, pattern] of unsupported) assert.match(reason(line), pattern, line)
  })

  it('refuses text bash itself rejects', () => {
    for (const line of [
      "echo 'unterminated",
      'echo "unterminated',
      'echo `unterminated',
      'ls &&',
      '| ls',
      '; ls',
      'ls ;;',
      '( )',
      '{ }',
      'ls )',
      '(ls',
      '{ ls; ',
      'ls >',
      'echo $(ls',
      'ls & ;',
      'echo foo(bar)',
      "echo $'unterminated",
    ]) {
      assert.match(reason(line), /./, line)
    }
  })

  it('refuses nesting deeper than it reads', () => {
    const deep = 'echo ' + '$('.repeat(40) + 'ls' + ')'.repeat(40)
    assert.match(reason(deep), /nest/)
    const shallow = 'echo ' + '$('.repeat(10) + 'ls' + ')'.repeat(10)
    assert.equal(commands(shallow).length, 11)
  })

  it('keeps the text of each command without here-document bodies', () => {
    assert.deepEqual(
      commands("git status --short && cat <<'X'\nsecret\nX").map((command) => command.text),
      ['git status --short', "cat <<'X'"],
    )
  })

  it('finds every command of a generated line, whatever quoting the words use', async () => {
    const word = gen.map(
      gen.tuple(gen.string('abc./-_=:%@+,', 1, 6), gen.oneOf<'plain' | 'single' | 'double' | 'escaped' | 'ansi'>('plain', 'single', 'double', 'escaped', 'ansi')),
      ([text, style]) => {
        const safe = text.replace(/^[=]+/, 'x')
        switch (style) {
          case 'plain':
            return { source: safe, value: safe }
          case 'single':
            return { source: `'${safe} '`, value: `${safe} ` }
          case 'double':
            return { source: `"${safe} $"`, value: `${safe} $` }
          case 'escaped':
            return { source: safe.replace(/./g, (char) => `\\${char}`), value: safe }
          case 'ansi':
            return { source: `$'${safe}\\t'`, value: `${safe}\t` }
        }
      },
    )
    const command = gen.array(word, 1, 4)
    const line = gen.array(gen.tuple(command, gen.oneOf(' ; ', ' && ', ' || ', ' | ', '\n', ' & ', ' |& ')), 1, 5)
    await check(line, (pieces) => {
      // A name that looks like an assignment is read as one, so generated commands start with a fixed name.
      const source = pieces
        .map(([words, separator], index) => `cmd${index} ${words.map((w) => w.source).join(' ')}${index < pieces.length - 1 ? separator : ''}`)
        .join('')
      const expected = pieces.map(([words], index) => [`cmd${index}`, ...words.map((w) => w.value)])
      assert.deepEqual(argv(source), expected, source)
    })
  })
})

/** Bash itself, when this machine has it: /bin/bash, or Git Bash on Windows. */
function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
          .filter((dir): dir is string => Boolean(dir))
          .map((dir) => path.join(dir, 'Git', 'bin', 'bash.exe'))
      : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']
  return candidates.find((file) => fs.existsSync(file)) ?? null
}

interface GeneratedWord {
  source: string
  value: string
}

/** One piece of a word in a random quoting style, with the text bash turns it into. */
const segment = gen.pick<GeneratedWord>(
  gen.map(gen.string('abcXYZ019._/,:%@+-', 1, 5), (text) => ({ source: text, value: text })),
  gen.map(gen.string(`ab "\\$\`*?;|&#()<>{}[]~!=\n\t`, 0, 6), (text) => ({ source: `'${text}'`, value: text })),
  gen.map(gen.array(gen.oneOf<[string, string]>(['a', 'a'], [' ', ' '], ['\\"', '"'], ['\\\\', '\\'], ['\\$', '$'], ['\\`', '`'], ['\\x', '\\x'], ["'", "'"], ['*', '*'], [';', ';'], ['\n', '\n'], ['#', '#']), 0, 6), (pairs) => ({
    source: `"${pairs.map(([source]) => source).join('')}"`,
    value: pairs.map(([, value]) => value).join(''),
  })),
  gen.map(gen.array(gen.oneOf<[string, string]>(['a', 'a'], ['\\n', '\n'], ['\\t', '\t'], ['\\\\', '\\'], ["\\'", "'"], ['\\x41', 'A'], ['\\101', 'A'], ['"', '"'], ['$', '$'], [' ', ' ']), 0, 5), (pairs) => ({
    source: `$'${pairs.map(([source]) => source).join('')}'`,
    value: pairs.map(([, value]) => value).join(''),
  })),
  gen.map(gen.string(`a;|&()<> "'$\`*?#~{}`, 1, 3), (text) => ({ source: text.replace(/./g, (char) => `\\${char}`), value: text })),
)

const generatedWord = gen.map(gen.array(segment, 1, 3), (segments) => ({
  source: segments.map((piece) => piece.source).join(''),
  value: segments.map((piece) => piece.value).join(''),
}))

interface GeneratedLine {
  source: string
  /** Every command's argv, in order. */
  expected: string[][]
  /** Whether bash runs every command: no `||`, and every function succeeds. */
  runsAll: boolean
}

const generatedLine = gen.map(
  gen.array(gen.tuple(gen.array(generatedWord, 0, 3), gen.oneOf(' ; ', ' && ', ' || ', ' | ', '\n', ' |& '), gen.oneOf('', ' # note', ' <<EOF\nbody $(x)\nEOF', " <<'Q'\n$(y)\nQ")), 1, 4),
  (pieces): GeneratedLine => {
    let source = ''
    pieces.forEach(([words, separator, trailer], index) => {
      source += `cmd${index}${words.map((word) => ` ${word.source}`).join('')}`
      // A comment or here-document ends the line, so it can only come before a newline or at the end.
      const last = index === pieces.length - 1
      if (trailer && (last || separator === '\n' || !trailer.startsWith(' #'))) {
        if (trailer.startsWith(' <<')) {
          const [start, ...rest] = trailer.split('\n')
          source += start + (last ? '' : separator) + '\n' + rest.join('\n')
          if (!last) source += '\n'
          return
        }
        if (last || separator === '\n') source += trailer
      }
      if (!last) source += separator
    })
    return {
      source,
      expected: pieces.map(([words], index) => [`cmd${index}`, ...words.map((word) => word.value)]),
      runsAll: !pieces.slice(0, -1).some(([, separator]) => separator.includes('||')),
    }
  },
)

describe('bash grammar against bash', () => {
  const bash = findBash()

  it('agrees with the generator on every generated line', async () => {
    await check(generatedLine, (line) => {
      assert.deepEqual(argv(line.source), line.expected, line.source)
    })
  })

  it('reads every word the way bash passes it to the program', { skip: bash ? false : 'bash is not installed' }, async () => {
    const random = prng(Number(process.env.ENCODE_PROPERTY_SEED) || 0x5eed)
    const lines = Array.from({ length: 120 }, (_, index) => generatedLine(random, Math.round((index / 119) * 30)))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-bash-'))
    try {
      const names = new Set(lines.flatMap((line) => line.expected.map(([name]) => name)))
      // Each call writes its own file, so the members of a pipeline cannot interleave their records.
      const functions = [...names]
        .map((name) => `${name}() { local r=${name} a; for a in "$@"; do r+=$'\\037'"$a"; done; printf '%s' "$r" > "$OUT/$BASHPID.$((++CALLS))"; }`)
        .join('\n')
      const cases = lines.map((line, index) => {
        fs.writeFileSync(path.join(dir, `case${index}.sh`), `${line.source}\n`)
        return `OUT=out${index}; mkdir "$OUT"; . ./case${index}.sh; wait`
      })
      fs.writeFileSync(path.join(dir, 'run.sh'), `CALLS=0\n${functions}\n${cases.join('\n')}\n`)
      execFileSync(bash!, ['--noprofile', '--norc', 'run.sh'], {
        cwd: dir,
        // Git Bash needs the Windows environment; BASH_ENV would run a file before the script.
        env: { ...process.env, BASH_ENV: '', ENV: '', HOME: dir, LC_ALL: 'C' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const runs = lines.map((_, index) =>
        fs.readdirSync(path.join(dir, `out${index}`)).map((file) => fs.readFileSync(path.join(dir, `out${index}`, file), 'latin1').split('\x1f')),
      )
      assert.ok(runs.flat().length > lines.length, 'bash ran the generated commands')
      lines.forEach((line, index) => {
        const ran = runs[index].map((args) => JSON.stringify(args)).sort()
        const parsed = argv(line.source).map((args) => JSON.stringify(args.map((arg) => Buffer.from(arg, 'utf8').toString('latin1'))))
        if (line.runsAll) assert.deepEqual(ran, [...parsed].sort(), line.source)
        else for (const run of ran) assert.ok(parsed.includes(run), `bash ran ${run}, which the parser did not see, in ${JSON.stringify(line.source)}`)
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
