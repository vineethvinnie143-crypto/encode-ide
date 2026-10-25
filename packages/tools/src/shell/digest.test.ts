import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collapseProgress } from '../text'
import { BUILD_WARNINGS, commandsOf, DIFF_SHOWN_CHARS, digestOutput, FAILED_WHOLE_CHARS, STACK_FRAMES } from './digest'

const range = (count: number) => Array.from({ length: count }, (_, index) => index)

/** node --test's TAP when its output is not a terminal: a suite of passing tests, one failing test, a nested failing suite. */
function tap(passing: number): string {
  const test = (indent: string, n: number, name: string) => [`${indent}# Subtest: ${name}`, `${indent}ok ${n} - ${name}`, `${indent}  ---`, `${indent}  duration_ms: 0.18`, `${indent}  type: 'test'`, `${indent}  ...`]
  const frames = range(9).map((n) => `        Frame${n}.run (node:internal/test_runner/test:${1000 + n}:25)`)
  return [
    'TAP version 13',
    '# Subtest: math',
    ...range(passing).flatMap((n) => test('    ', n + 1, `adds ${n}`)),
    '    # Subtest: divides',
    `    not ok ${passing + 1} - divides`,
    '      ---',
    '      duration_ms: 1.55',
    "      type: 'test'",
    "      location: '/work/a.test.mjs:5:3'",
    "      failureType: 'testCodeFailure'",
    '      error: |-',
    '        Expected values to be strictly equal:',
    '        ',
    '        0.5 !== 0.25',
    '        ',
    "      code: 'ERR_ASSERTION'",
    '      expected: 0.25',
    '      actual: 0.5',
    '      stack: |-',
    ...frames,
    '      ...',
    `    1..${passing + 1}`,
    'not ok 1 - math',
    '  ---',
    "  type: 'suite'",
    "  error: '1 subtest failed'",
    '  ...',
    '# Subtest: passing suite',
    ...test('    ', 1, 'one'),
    '    1..1',
    'ok 2 - passing suite',
    '  ---',
    "  type: 'suite'",
    '  ...',
    '1..2',
    `# tests ${passing + 2}`,
    '# suites 2',
    `# pass ${passing + 1}`,
    '# fail 1',
    '# duration_ms 132.03',
  ].join('\n')
}

/** The same run as the spec reporter prints it. */
function spec(passing: number): string {
  return [
    '▶ math',
    ...range(passing).map((n) => `  ✔ adds ${n} (0.08ms)`),
    '  ✖ divides (0.62ms)',
    '  ▶ nested',
    '    ✔ works (0.06ms)',
    '  ✔ nested (0.18ms)',
    '✖ math (5.07ms)',
    '▶ passing suite',
    '  ✔ one (0.39ms)',
    '✔ passing suite (1.12ms)',
    `ℹ tests ${passing + 3}`,
    `ℹ pass ${passing + 2}`,
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at a.test.mjs:5:3',
    '✖ divides (0.62ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  0.5 !== 0.25',
    ...range(8).map((n) => `      at Frame${n} (file:///work/a.test.mjs:${n + 5}:30)`),
  ].join('\n')
}

describe('which commands a digest is for (ADR 0133)', () => {
  it('splits a line into its commands, and gives up on one that pipes', () => {
    assert.deepEqual(commandsOf('cd app && CI=1 pnpm test; echo done'), ['cd app', 'pnpm test', 'echo done'])
    assert.deepEqual(commandsOf('npm test || true'), ['npm test', 'true'])
    assert.equal(commandsOf('npm test | tail -20'), undefined)
    assert.deepEqual(commandsOf(`git log --grep='a|b'`), [`git log --grep=""`])
  })

  it('knows a test run by its summary, whatever started it, and leaves alone what shows a file or pipes it on', () => {
    const output = tap(200)
    assert.equal(digestOutput('node scripts/run-tests.js', output, 1)?.kind, 'tests')
    assert.equal(digestOutput('cd app && pnpm -s test', output, 1)?.kind, 'tests')
    assert.equal(digestOutput('cat results.tap', output, 1), undefined)
    assert.equal(digestOutput('node --test | tee out.txt', output, 1), undefined)
    assert.equal(digestOutput('node scripts/run.js', 'line\n'.repeat(2_000), 0), undefined, 'no summary, no known command')
  })

  it('leaves a short output alone, a failed one under 8,000 characters too, and one the digest would not halve', () => {
    assert.equal(digestOutput('node --test', tap(5), 0), undefined)
    const failed = tap(25)
    assert.ok(failed.length > 3_000 && failed.length < FAILED_WHOLE_CHARS)
    assert.ok(digestOutput('node --test', failed, 0), 'a run that passed is digested from 3,000 characters')
    assert.equal(digestOutput('node --test', failed, 1), undefined, 'a failed one goes in whole below 8,000')
    const allFailing = range(120)
      .map((n) => `test tests::t${n} ... FAILED`)
      .concat(['', 'test result: FAILED. 0 passed; 120 failed; 0 ignored'])
      .join('\n')
    assert.equal(digestOutput('cargo test', allFailing.repeat(3), 101), undefined, 'nothing passed, so nothing to leave out')
  })
})

describe('a test run', () => {
  it('in TAP keeps every failure with its error, the first frames of its stack and the totals, and counts what passed', () => {
    const digest = digestOutput('node --test', tap(300), 1)!
    assert.ok(digest.text.length < tap(300).length / 10, `${digest.text.length} characters`)
    for (const kept of ['not ok 301 - divides', '0.5 !== 0.25', 'expected: 0.25', 'actual: 0.5', "location: '/work/a.test.mjs:5:3'", 'not ok 1 - math', '# tests 302', '# pass 301', '# fail 1']) {
      assert.ok(digest.text.includes(kept), kept)
    }
    assert.ok(!digest.text.includes('ok 1 - adds 0'))
    assert.ok(!digest.text.includes('# Subtest: adds 7'))
    assert.ok(digest.text.includes('# Subtest: divides'), 'a failing test keeps its header')
    assert.ok(digest.text.includes(`Frame${STACK_FRAMES - 1}.run`) && !digest.text.includes(`Frame${STACK_FRAMES}.run`))
    assert.ok(digest.text.includes(`… (${9 - STACK_FRAMES} more stack lines)`))
    assert.match(digest.text, /^ {4}… \(300 passing tests\)$/m)
    // The passing suite's own result is not a test: 301 passed, as the totals say.
    assert.match(digest.note, /leaves out the lines of 301 passing tests and the stack frames after the first 5/)
  })

  it('from a spec reporter drops a passing suite with its header and keeps a failing one', () => {
    const digest = digestOutput('pnpm test', spec(500), 1)!
    assert.ok(digest.text.startsWith('▶ math\n  … (500 passing tests)\n  ✖ divides (0.62ms)'), digest.text.slice(0, 120))
    assert.ok(!digest.text.includes('▶ passing suite') && !digest.text.includes('▶ nested'))
    assert.ok(digest.text.includes('✖ math (5.07ms)') && digest.text.includes('ℹ fail 1') && digest.text.includes('0.5 !== 0.25'))
    // A suite's own line is not a test: 502 passed, as the totals say.
    assert.match(digest.note, /502 passing tests/)
  })

  it('from go test -v keeps the failing test with its log and the package result', () => {
    const output = [
      '=== RUN   TestAdd',
      ...range(300).map((n) => `=== RUN   TestAdd/case${n}`),
      '--- PASS: TestAdd (0.00s)',
      ...range(300).map((n) => `    --- PASS: TestAdd/case${n} (0.00s)`),
      '=== RUN   TestBroken',
      '    calc_test.go:14: Add(2, 2) = 4, want 5',
      '--- FAIL: TestBroken (0.00s)',
      'FAIL',
      'FAIL\texample.com/calc\t0.009s',
    ].join('\n')
    const digest = digestOutput('go test -v ./...', output, 1)!
    assert.equal(digest.text, ['… (301 passing tests)', '=== RUN   TestBroken', '    calc_test.go:14: Add(2, 2) = 4, want 5', '--- FAIL: TestBroken (0.00s)', 'FAIL', 'FAIL\texample.com/calc\t0.009s'].join('\n'))
  })

  it('from cargo, pytest, jest and dotnet keeps the failures and the summary', () => {
    const cargo = ['running 502 tests', ...range(500).map((n) => `test tests::t${n} ... ok`), 'test tests::broken ... FAILED', 'test tests::slow ... ignored', '', 'failures:', '', '---- tests::broken stdout ----', "thread 'tests::broken' panicked at src/lib.rs:8:27:", 'assertion `left == right` failed', '', 'test result: FAILED. 500 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.02s'].join('\n')
    const fromCargo = digestOutput('cargo test', cargo, 101)!.text
    assert.ok(fromCargo.includes('test tests::broken ... FAILED') && fromCargo.includes('test tests::slow ... ignored') && fromCargo.includes('test result: FAILED. 500 passed'))
    assert.ok(!fromCargo.includes('tests::t5 ... ok'))

    const pytest = [
      '============================= test session starts ==============================',
      'collected 400 items',
      '',
      ...range(5).map((n) => `tests/test_${n}.py ${'.'.repeat(70)} [ ${String((n + 1) * 18).padStart(2)}%]`),
      `tests/test_b.py ${'.'.repeat(20)}F${'.'.repeat(29)} [100%]`,
      '',
      '=================================== FAILURES ===================================',
      '_________________________________ test_total __________________________________',
      '    def test_total():',
      '>       assert total([1, 2]) == 4',
      'E       assert 3 == 4',
      '=========================== short test summary info ============================',
      'FAILED tests/test_b.py::test_total - assert 3 == 4',
      '========================= 1 failed, 399 passed in 0.52s =========================',
    ].join('\n')
    const fromPytest = digestOutput('python -m pytest', pytest, 1)
    // pytest prints its progress compactly: there is not enough to leave out to halve it.
    assert.equal(fromPytest, undefined)
    const verbose = [...range(400).map((n) => `tests/test_a.py::test_case_${n} PASSED${' '.repeat(20)}[ 50%]`), 'tests/test_b.py::test_total FAILED [100%]', '', '=================================== FAILURES ===================================', 'E       assert 3 == 4', '========================= 1 failed, 400 passed in 0.52s ========================='].join('\n')
    const fromVerbose = digestOutput('pytest -v', verbose, 1)!.text
    assert.ok(fromVerbose.includes('tests/test_b.py::test_total FAILED') && fromVerbose.includes('E       assert 3 == 4') && fromVerbose.includes('1 failed, 400 passed'))
    assert.ok(fromVerbose.startsWith('… (400 passing tests)'))

    const jest = [
      ...range(200).map((n) => `PASS src/module${n}.test.js`),
      'FAIL src/total.test.js',
      '  ● total › adds the items',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '    Expected: 4',
      '    Received: 3',
      '',
      ...range(10).map((n) => `      at Object.<anonymous> (src/total.test.js:${n + 5}:13)`),
      '',
      ...range(200).map((n) => `PASS src/other${n}.test.js`),
      'Test Suites: 1 failed, 400 passed, 401 total',
      'Tests:       1 failed, 900 passed, 901 total',
    ].join('\n')
    const fromJest = digestOutput('npx jest', jest, 1)!
    assert.ok(fromJest.text.includes('FAIL src/total.test.js') && fromJest.text.includes('Received: 3') && fromJest.text.includes('Tests:       1 failed, 900 passed'))
    assert.ok(fromJest.text.includes('… (200 passing test files)'))
    assert.ok(fromJest.text.includes('(src/total.test.js:9:13)') && !fromJest.text.includes('(src/total.test.js:10:13)'), 'five frames')

    const dotnet = [...range(300).map((n) => `  Passed Calc.Tests.Adds${n} [1 ms]`), '  Failed Calc.Tests.Total [3 ms]', '  Error Message:', '   Assert.Equal() Failure: Expected 4, Actual 3', '  Stack Trace:', '     at Calc.Tests.Total() in /src/CalcTests.cs:line 12', '', 'Failed!  - Failed:     1, Passed:   300, Skipped:     0, Total:   301, Duration: 30 ms - Calc.Tests.dll (net8.0)'].join('\n')
    const fromDotnet = digestOutput('dotnet test', dotnet, 1)!.text
    assert.ok(fromDotnet.startsWith('  … (300 passing tests)\n  Failed Calc.Tests.Total [3 ms]') && fromDotnet.includes('Expected 4, Actual 3') && fromDotnet.includes('Failed!  - Failed:     1'))
  })
})

describe('a build', () => {
  const warning = (n: number) => [`warning: unused variable: \`v${n}\``, `  --> src/main.rs:${n + 2}:9`, '   |', `${n + 2} |     let v${n} = ${n};`, '   |         ^^ help: if this is intentional, prefix it with an underscore', '']

  it('keeps every error, the first warnings and its last lines', () => {
    const output = [
      '   Compiling warny v0.1.0 (/work)',
      ...range(40).flatMap(warning),
      'error[E0308]: mismatched types',
      ' --> src/main.rs:44:18',
      '  |',
      '44 |     let x: i32 = "a";',
      '  |                  ^^^ expected `i32`, found `&str`',
      '',
      ...range(40).flatMap((n) => warning(n + 40)),
      'error: could not compile `warny` (bin "warny") due to 1 previous error; 80 warnings emitted',
    ].join('\n')
    const digest = digestOutput('cargo build', output, 101)!
    assert.equal(digest.kind, 'build')
    assert.ok(digest.text.includes('error[E0308]: mismatched types\n --> src/main.rs:44:18') && digest.text.includes('expected `i32`, found `&str`'))
    assert.ok(digest.text.includes(`\`v${BUILD_WARNINGS - 1}\``) && !digest.text.includes(`\`v${BUILD_WARNINGS}\``))
    assert.ok(digest.text.endsWith('error: could not compile `warny` (bin "warny") due to 1 previous error; 80 warnings emitted'))
    assert.match(digest.note, /^The build printed 2 errors and 80 warnings; the digest keeps the errors, the first 10 warnings and the last 8 lines, and leaves out [\d,]+ other lines\.$/)
    assert.match(digest.text, /^… \([\d,]+ lines left out\)$/m)
  })

  it('keeps the file a linter names before what it found there', () => {
    const file = (n: number) => [`/work/src/file${n}.js`, ...range(4).map((line) => `  ${line + 1}:5  warning  Unexpected console statement  no-console`), '']
    const output = [
      ...range(30).flatMap(file),
      '/work/src/broken.js',
      '  3:5  warning  Unexpected console statement  no-console',
      "  9:1  error    'x' is not defined                no-undef",
      '',
      ...range(30).flatMap((n) => file(n + 30)),
      '✖ 241 problems (1 error, 240 warnings)',
    ].join('\n')
    const digest = digestOutput('pnpm typecheck', output, 1)!
    assert.ok(digest.text.includes("/work/src/broken.js\n  … (1 line left out)\n  9:1  error    'x' is not defined"), digest.text)
    assert.ok(digest.text.endsWith('✖ 241 problems (1 error, 240 warnings)'))
  })

  it('goes in whole when it failed and no error in it can be told apart', () => {
    const output = range(400).map((n) => `[task ${n}] something went sideways`).join('\n')
    assert.equal(digestOutput('make all', output, 2), undefined)
    assert.ok(digestOutput('make all', output, 0), 'one that worked keeps its last lines')
  })
})

describe('an install', () => {
  it('keeps its errors, its first warnings and its last lines', () => {
    const output = [
      ...range(60).map((n) => `npm warn deprecated package${n}@1.0.0: no longer supported`),
      ...range(100).map((n) => `Downloading https://registry.example/pkg${n}.tgz`),
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      '',
      'added 412 packages, and audited 413 packages in 9s',
      'found 0 vulnerabilities',
    ].join('\n')
    const digest = digestOutput('npm install', output, 1)!
    assert.equal(digest.kind, 'install')
    assert.ok(digest.text.includes('npm error ERESOLVE unable to resolve dependency tree') && digest.text.endsWith('found 0 vulnerabilities'))
    assert.ok(digest.text.includes('package4@') && !digest.text.includes('package5@'))
    assert.match(digest.note, /^The install printed 2 errors and 60 warnings; the digest keeps the errors, the first 5 warnings and the last 10 lines/)
  })
})

describe('git', () => {
  const commit = (n: number) => [
    `commit ${n.toString(16).padStart(40, 'a')}${n === 0 ? ' (HEAD -> main, origin/main)' : ''}`,
    'Author: Some One <someone@example.com>',
    `Date:   Sun Oct ${String((n % 28) + 1)} 19:51:15 2026 +0000`,
    '',
    `    Change number ${n}`,
    '',
    '    A body that says why, over a few lines, as a good message does. It runs on for',
    '    a while so the log is long enough to digest.',
    '',
  ]

  it('log shows each commit on one line, and leaves log -p alone', () => {
    const output = range(40).flatMap(commit).join('\n')
    const digest = digestOutput('git --no-pager log -40', output, 0)!
    assert.equal(digest.kind, 'git-log')
    const lines = digest.text.split('\n')
    assert.equal(lines.length, 40)
    assert.equal(lines[0], `${'a'.repeat(10)} (HEAD -> main, origin/main) 2026-10-01 Some One: Change number 0`)
    assert.ok(!digest.text.includes('someone@example.com'))
    assert.equal(digestOutput('git log -p', `${output}\ndiff --git a/x b/x\n`, 0), undefined)
    assert.equal(digestOutput('git log && npm test', output, 0), undefined, 'not with other commands')
  })

  it('diff lists every file first, then the whole diffs that fit, and says which are left out', () => {
    const file = (name: string, lines: number) => [`diff --git a/${name} b/${name}`, 'index 1111111..2222222 100644', `--- a/${name}`, `+++ b/${name}`, `@@ -1,${lines} +1,${lines} @@`, ...range(lines).flatMap((n) => [`-old line ${n} of ${name}`, `+new line ${n} of ${name}`])]
    const output = [...file('src/a.ts', 20), ...file('pnpm-lock.yaml', 2_000), ...file('src/b.ts', 30), 'diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ'].join('\n')
    const digest = digestOutput('git diff', output, 0)!
    assert.equal(digest.kind, 'git-diff')
    const lines = digest.text.split('\n')
    assert.deepEqual(lines.slice(0, 5), [
      '4 files changed, 2,050 insertions(+), 2,050 deletions(-)',
      ' src/a.ts | +20 -20 (shown below)',
      ' pnpm-lock.yaml | +2000 -2000',
      ' src/b.ts | +30 -30 (shown below)',
      ' logo.png | +0 -0 (new, binary) (shown below)',
    ])
    assert.ok(digest.text.includes('+new line 29 of src/b.ts') && !digest.text.includes('of pnpm-lock.yaml'))
    assert.ok(digest.text.length < DIFF_SHOWN_CHARS + 1_000)
    assert.ok(digest.text.endsWith('… (the diffs of the other 1 file are left out)'))
    assert.match(digest.note, /each of the 4 files and shows the whole diff of 3; for another, run git diff on that file\./)
    assert.equal(digestOutput('git diff -- pnpm-lock.yaml', file('pnpm-lock.yaml', 2_000).join('\n'), 0), undefined, 'one file is left to the loop')
  })
})

describe('progress lines', () => {
  it('collapse to the last of them, and lines that differ only in numbers otherwise stay', () => {
    const progress = range(30).map((n) => `Progress: resolved ${n * 10}, reused ${n * 9}, downloaded ${n}, added 0`)
    assert.equal(collapseProgress(['Lockfile is up to date', ...progress, 'Done in 3.2s'].join('\n')), ['Lockfile is up to date', '… (29 progress lines like the one below)', progress.at(-1), 'Done in 3.2s'].join('\n'))
    const bars = range(6).map((n) => `${n * 20}% building ${n}/5 entries`)
    assert.equal(collapseProgress(bars.join('\n')), `… (5 progress lines like the one below)\n${bars.at(-1)}`)
    const errors = range(10).map((n) => `a.ts(${n + 1},14): error TS2322: Type 'string' is not assignable to type 'number'.`).join('\n')
    assert.equal(collapseProgress(errors), errors)
    const tests = range(6).map((n) => `  ✖ applies ${n * 10}% tax`).join('\n')
    assert.equal(collapseProgress(tests), tests)
  })
})
