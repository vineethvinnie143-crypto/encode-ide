import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { withGitSafety } from './environment'
import { isInside } from './paths'
import { parsePwsh, type PwshScript } from './pwsh-grammar'
import { assessPwshCommand, type PwshContext } from './pwsh-policy'

const WINDOWS: PwshContext = {
  root: 'C:\\ws',
  cwd: 'C:\\ws',
  home: 'C:\\Users\\u',
  platform: 'win32',
  env: withGitSafety({ Path: 'C:\\Windows\\System32', PSModulePath: 'C:\\Users\\u\\Documents\\PowerShell\\Modules' }, true),
  trusted: true,
}
const POSIX: PwshContext = { ...WINDOWS, root: '/ws', cwd: '/ws', home: '/home/u', platform: 'posix', env: withGitSafety({}, false) }

function script(line: string): PwshScript {
  const parsed = parsePwsh(line)
  if (!parsed.ok) assert.fail(`expected ${JSON.stringify(line)} to parse, got: ${parsed.reason}`)
  return parsed.script
}

/** Each command as [name, ...argument values]. */
function argv(line: string): string[][] {
  return script(line).statements.flatMap((statement) =>
    statement.pipelines.flatMap((pipeline) => pipeline.commands.map((command) => [command.name.value, ...command.args.map((arg) => arg.value)])),
  )
}

function refusal(line: string): string {
  const parsed = parsePwsh(line)
  if (parsed.ok) assert.fail(`expected ${JSON.stringify(line)} to be refused`)
  return parsed.reason
}

describe('PowerShell grammar', () => {
  it('reads statements, pipelines and chains', () => {
    assert.deepEqual(argv('gci src; gc a.txt | sls foo\nGet-Location'), [['gci', 'src'], ['gc', 'a.txt'], ['sls', 'foo'], ['Get-Location']])
    const chained = script('git status && git log || echo failed').statements
    assert.equal(chained.length, 1)
    assert.deepEqual(chained[0].operators, ['&&', '||'])
    assert.deepEqual(argv('gci `\n  src'), [['gci', 'src']])
    assert.deepEqual(argv('gci # list it\r\ngc a.txt'), [['gci'], ['gc', 'a.txt']])
  })

  it('removes quotes the way PowerShell does', () => {
    assert.deepEqual(argv(`echo 'a b' "c d" 'it''s' "say ""hi""" x'y z'w`), [['echo', 'a b', 'c d', "it's", 'say "hi"', 'xy zw']])
    assert.equal(script("gc '-Path'").statements[0].pipelines[0].commands[0].args[0].quotedStart, true)
    assert.equal(script('gci *.ts').statements[0].pipelines[0].commands[0].args[0].unquotedWildcard, true)
    assert.equal(script("gci '*.ts'").statements[0].pipelines[0].commands[0].args[0].unquotedWildcard, false)
  })

  it('reads redirections', () => {
    const [command] = script('gci 2>&1 > $null *>>$null 3> out.txt').statements[0].pipelines[0].commands
    assert.deepEqual(command.args, [])
    assert.deepEqual(
      command.redirects.map((redirect) => [redirect.stream, redirect.append, redirect.merge, redirect.discard, redirect.target?.value]),
      [['2', false, '1', undefined, undefined], ['1', false, undefined, true, undefined], ['*', true, undefined, true, undefined], ['3', false, undefined, undefined, 'out.txt']],
    )
  })

  it('refuses everything it does not follow', () => {
    const cases: Array<[string, RegExp]> = [
      ['echo $env:TOKEN', /\$/],
      ['echo "$HOME"', /\$/],
      ['echo $(rm x)', /\$/],
      ['gci | % { rm $_ }', /script block|expression/],
      ['gci | Where-Object { $_.Length }', /script block|expression/],
      ['(gci).Count', /expression/],
      ['echo a,b', /array/],
      ['echo @args', /@/],
      ["echo @'\nx\n'@", /@/],
      ['[IO.File]::ReadAllText("x")', /\[/],
      ['& notepad', /&/],
      ['gci &', /&/],
      ['. .\\profile.ps1', /dot-sourced/],
      ['if ($true) { gci }', /keyword|\$|expression/],
      ['foreach ($f in 1) { }', /keyword|expression/],
      ['foreach x', /keyword/],
      ['function f { }', /keyword|script block/],
      ['function', /keyword/],
      ['git --% status', /--%/],
      ['echo `n', /backtick/],
      ['echo "a`tb"', /backtick/],
      ['<# hidden #> gci', /block comment/],
      ['gc < a.txt', /</],
      ['echo \u2018x\u2019', /typographic/],
      ['gci \u2013Recurse', /typographic/],
      ['gci\u00a0-Recurse', /typographic/],
      ["echo 'open", /unterminated/],
      ['gci |', /middle of a pipeline/],
      ['gci && ', /middle of a pipeline/],
      ['| gci', /empty command/],
      ["'gci'", /expression/],
      ['5', /expression/],
      ['gci >', /without a target/],
    ]
    for (const [line, reason] of cases) assert.match(refusal(line), reason, JSON.stringify(line))
  })
})

const ALLOWED = [
  'gci',
  'Get-ChildItem -Recurse -Filter *.ts src',
  'gci src -File -Depth 2',
  'ls -Force',
  'dir src\\lib',
  'Get-Content README.md -TotalCount 20',
  'gc -Path src\\a.ts -Tail 5',
  "cat -LiteralPath 'odd[1].txt'",
  'type package.json',
  'Get-Content README.md | Select-String TODO',
  "Select-String -Pattern 'useState' -Path src\\app.tsx",
  'sls foo README.md -SimpleMatch',
  'gci src | Sort-Object Length -Descending | Select-Object -First 5',
  'gci | Measure-Object -Property Length -Sum',
  'gci | Where-Object Name -like a*',
  'cd src; gci',
  'Set-Location -Path src && gc a.ts',
  'sl ..\\ws\\src',
  'pwd',
  'echo hello world',
  'Write-Output "done" > $null',
  'Write-Host -NoNewline building',
  'Test-Path package.json',
  'Resolve-Path src -Relative',
  'Split-Path src\\a.ts -Leaf',
  'Get-FileHash package.json -Algorithm SHA256',
  'Get-Date -Format yyyy-MM-dd',
  'gci | Format-Table Name -AutoSize',
  'gci 2>&1 | Out-String',
  'gc a.txt -ErrorAction SilentlyContinue',
  'git status',
  'git log --oneline -n 5',
  "git log '--format=%h %s'",
  'git log --format="%h %s"',
  'git show HEAD:src/a.ts',
  'git.exe diff -- src',
  'rg -n TODO src',
  "rg -n 'use.*State' --glob '*.tsx'",
  'node --version',
  'where.exe git',
  'cd..',
]

const ASKED: Array<[string, RegExp]> = [
  ['Remove-Item x', /remove-item is not on the read-only list/i],
  ['rm -Recurse build', /rm is not on the read-only list/],
  ['del x.txt', /del is not on the read-only list/],
  ['Set-Content a.txt hi', /set-content is not on the read-only list/i],
  ['gci > files.txt', /writes its output/],
  ['gci | Out-File x.txt', /out-file is not on the read-only list/i],
  ['gci | Tee-Object x.txt', /tee-object is not on the read-only list/i],
  ['gci | ForEach-Object Delete', /foreach-object is not on the read-only list/i],
  ['iex "rm x"', /iex is not on the read-only list/],
  ['Invoke-WebRequest https://example.com', /not on the read-only list/],
  ['Start-Process notepad', /not on the read-only list/],
  ['gci *.ts', /wildcard/],
  ["gc '*.txt'", /wildcard/],
  ['sls foo *.ts', /wildcard/],
  ['gci -FollowSymlink -Recurse', /-FollowSymlink/],
  ['gci -F src', /more than one parameter/],
  ['gci -Path src -Path lib', /twice/],
  ['gc a.txt b.txt c.txt', /more arguments/],
  ['gci Env:', /drive or provider/],
  ['gc Env:\\GITHUB_TOKEN', /drive or provider/],
  ['gci HKCU:\\Software', /drive or provider/],
  ['gc Microsoft.PowerShell.Core\\FileSystem::C:\\x', /drive or provider/],
  ['gc ..\\secret.txt', /outside the workspace/],
  ['gc ~\\.ssh\\id_rsa', /outside the workspace/],
  ['gc C:\\Windows\\win.ini', /outside the workspace/],
  ['gc \\\\server\\share\\x', /outside the workspace/],
  ['gc D:secret.txt', /outside the workspace/],
  ['gci \\', /outside the workspace/],
  ['cd ..', /outside the workspace/],
  ['cd', /home directory/],
  ['cd -', /cannot see/],
  ['cd\\', /outside the workspace/],
  ['cd src; cd ..\\..; gci', /outside the workspace/],
  ['C:\\tools\\x.exe', /by path/],
  ['.\\build.ps1', /by path|dot-sourced/],
  ['tools\\build.ps1', /by path/],
  ['git push', /git push/],
  ['git -c core.pager=x log', /git options/],
  ['git log \'--format=a"b\'', /more than one argument/],
  ["git log ''", /empty argument/],
  ['git log -- -p', /after --/],
  ['git log -Dmaven.test=1', /more than one argument/],
  ["rg foo 'C:\\a b\\'", /more than one argument/],
  ['rg --pre cat x', /--pre/],
  ['rg foo src\\*.ts', /wildcard/],
  ['cmd /c dir', /cmd is not on the read-only list/],
  ['powershell -Command gci', /powershell is not on the read-only list/],
  ['', /empty/],
]

describe('assessPwshCommand', () => {
  it('runs read-only lines unasked', () => {
    for (const line of ALLOWED) {
      const result = assessPwshCommand(line, { ...WINDOWS, cwd: line === 'cd..' ? 'C:\\ws\\src' : WINDOWS.cwd })
      assert.equal(result.decision, 'allow', `${JSON.stringify(line)}: ${result.reason}`)
    }
  })

  it('asks for everything else, with a reason', () => {
    for (const [line, reason] of ASKED) {
      const result = assessPwshCommand(line, WINDOWS)
      assert.equal(result.decision, 'ask', `expected ask: ${JSON.stringify(line)}`)
      assert.match(result.reason, reason, JSON.stringify(line))
    }
  })

  it('reports the paths, programs and directories the caller must check on disk', () => {
    const result = assessPwshCommand('cd src; gc a.ts | sls x; git log -- lib', WINDOWS)
    assert.equal(result.decision, 'allow')
    assert.deepEqual(result.programs, ['git'])
    for (const expected of ['C:\\ws', 'C:\\ws\\src', 'C:\\ws\\src\\a.ts', 'C:\\ws\\a.ts', 'C:\\ws\\lib', 'C:\\ws\\src\\lib']) {
      assert.ok(result.paths.includes(expected), `missing ${expected} in ${result.paths}`)
    }
  })

  it('asks before git in an untrusted folder or without the safety settings', () => {
    assert.match(assessPwshCommand('git status', { ...WINDOWS, trusted: false }).reason, /not trusted/)
    assert.match(assessPwshCommand('git status', { ...WINDOWS, env: { Path: 'C:\\x' } }).reason, /safety settings/)
    assert.match(assessPwshCommand('git status', { ...WINDOWS, env: { ...WINDOWS.env, git_dir: 'C:\\x' } }).reason, /git_dir/)
  })

  it('asks when PowerShell would load modules from the workspace', () => {
    const env = { ...WINDOWS.env, PSModulePath: 'C:\\Users\\u\\Documents\\PowerShell\\Modules;C:\\ws\\tools\\modules' }
    assert.match(assessPwshCommand('gci', { ...WINDOWS, env }).reason, /modules from inside the workspace/)
  })

  it('checks both rules where PowerShell on macOS and Linux runs the native program', () => {
    assert.equal(assessPwshCommand('ls -la src', POSIX).decision, 'ask') // -la is not a Get-ChildItem parameter
    assert.equal(assessPwshCommand('cat a.txt', POSIX).decision, 'allow')
    assert.deepEqual(assessPwshCommand('cat a.txt', POSIX).programs, ['cat'])
    assert.deepEqual(assessPwshCommand('cat a.txt', WINDOWS).programs, [])
    assert.match(assessPwshCommand('write hello', POSIX).reason, /write is not on the read-only list/)
    assert.equal(assessPwshCommand('write hello', WINDOWS).decision, 'allow')
  })

  it('never lets a writing or unlisted command, a redirect to a file or an outside path through', async () => {
    const word = gen.weighted(
      [4, gen.oneOf('gci', 'gc', 'cd', 'sls', 'echo', 'git', 'status', 'log', 'src', 'a.txt', '-Recurse', '-Path', '-Filter', '"a b"', 'sort')],
      [
        1,
        gen.oneOf(
          'rm', 'del', 'Remove-Item', 'Set-Content', 'Out-File', 'iex', '..', '..\\x', 'C:\\x', '\\\\h\\s', '~', 'Env:',
          '*', "'*'", '-LiteralPath', '-FollowSymlink', 'push', '-c', '--', '-x.y', "''", '$x', '(1)', '{', '@a', '&',
          '>', '2>&1', '$null', 'cd..', 'cd\\', 'Tee-Object', 'ForEach-Object', 'Delete',
        ),
      ],
    )
    const glue = gen.oneOf(' ', ' ', ' ', ' ', ';', ' && ', ' || ', ' | ', '\n')
    const lines = gen.map(gen.array(gen.tuple(word, glue), 1), (parts) => parts.flat().join(''))
    const unasked = new Set([
      'gci', 'gc', 'cd', 'sls', 'echo', 'git', 'sort', 'cd..', 'get-childitem', 'get-content', 'select-string',
    ])
    await check(
      lines,
      (line) => {
        const result = assessPwshCommand(line, WINDOWS)
        if (result.decision !== 'allow') return
        const parsed = parsePwsh(line)
        assert.ok(parsed.ok, 'allowed a line PowerShell cannot be read')
        for (const statement of parsed.script.statements) {
          for (const pipeline of statement.pipelines) {
            for (const command of pipeline.commands) {
              assert.ok(unasked.has(command.name.value.toLowerCase()), `allowed ${command.name.value}`)
              for (const redirect of command.redirects) assert.equal(redirect.target, null, 'allowed a redirect to a file')
            }
          }
        }
        for (const target of result.paths) assert.ok(isInside('C:\\ws', target, path.win32), `allowed ${target}`)
      },
      { runs: 3000 },
    )
  })
})
