import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { CheckLedger, checkOf, detectChecks, failuresIn, regression, sameCommand } from './checks'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-checks-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), text)
  }
  return dir
}

const found = async (files: Record<string, string>, platform: NodeJS.Platform = 'linux', configured?: string[]) =>
  (await detectChecks(await project(files), { platform, ...(configured ? { configured } : {}) })).map((check) => `${check.kind}: ${check.command} (${check.source})`)

describe("the project's checks", () => {
  it("are the package's typecheck and test scripts, run by its package manager", async () => {
    const scripts = JSON.stringify({ scripts: { typecheck: 'tsc -b', test: 'vitest run', dev: 'vite' } })
    assert.deepEqual(await found({ 'package.json': scripts, 'pnpm-lock.yaml': '' }), ['typecheck: pnpm run typecheck (package.json)', 'test: pnpm test (package.json)'])
    assert.deepEqual(await found({ 'package.json': scripts, 'yarn.lock': '' }), ['typecheck: yarn typecheck (package.json)', 'test: yarn test (package.json)'])
    assert.deepEqual(await found({ 'package.json': scripts, 'bun.lock': '' }), ['typecheck: bun run typecheck (package.json)', 'test: bun run test (package.json)'], "bun test would be bun's own runner")
    assert.deepEqual(await found({ 'package.json': scripts }), ['typecheck: npm run typecheck (package.json)', 'test: npm test (package.json)'])
    const declared = JSON.stringify({ packageManager: 'pnpm@9.12.0', scripts: { 'type-check': 'tsc', test: 'jest' } })
    assert.deepEqual(await found({ 'package.json': declared, 'package-lock.json': '' }), ['typecheck: pnpm run type-check (package.json)', 'test: pnpm test (package.json)'])
  })

  it("leave out npm init's placeholder, scripts that watch, and a tsconfig with nothing to compile or no TypeScript", async () => {
    assert.deepEqual(await found({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), [])
    assert.deepEqual(await found({ 'package.json': JSON.stringify({ scripts: { test: 'jest --watch', typecheck: 'tsc --watch' } }) }), [])
    const ts = { 'package.json': '{}', 'tsconfig.json': '{ "compilerOptions": {} }' }
    assert.deepEqual(await found(ts), [], 'TypeScript is not installed')
    assert.deepEqual(await found({ ...ts, 'node_modules/typescript/package.json': '{}' }), ['typecheck: npx --no-install tsc --noEmit (tsconfig.json)'])
    assert.deepEqual(await found({ ...ts, 'tsconfig.json': '{ "files": [], "references": [{ "path": "a" }] }', 'node_modules/typescript/package.json': '{}' }), [])
    assert.deepEqual(await found({ 'package.json': 'not json' }), [])
  })

  it('are found for Rust, Go and Python, typechecks first', async () => {
    assert.deepEqual(await found({ 'Cargo.toml': '[package]' }), ['typecheck: cargo check --all-targets (Cargo.toml)', 'test: cargo test (Cargo.toml)'])
    assert.deepEqual(await found({ 'go.mod': 'module x' }), ['typecheck: go vet ./... (go.mod)', 'test: go test ./... (go.mod)'])
    const pyproject = '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.mypy]\nstrict = true\n'
    assert.deepEqual(await found({ 'pyproject.toml': pyproject }), ['typecheck: python3 -m mypy . (pyproject.toml)', 'test: python3 -m pytest -q (pyproject.toml)'])
    assert.deepEqual(await found({ 'conftest.py': '' }, 'win32'), ['test: python -m pytest -q (conftest.py)'])
    assert.deepEqual(await found({ 'pyproject.toml': '[project]\nname = "x"\n' }), [], 'neither pytest nor mypy is set up')
    const both = await found({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'go.mod': 'module x' })
    assert.deepEqual(both, ['typecheck: go vet ./... (go.mod)', 'test: npm test (package.json)', 'test: go test ./... (go.mod)'])
  })

  it('are those of the nearest project at or above where they run, within the workspace', async () => {
    const root = await project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'web/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'web/pnpm-lock.yaml': '', 'web/src/a.ts': '', 'docs/a.md': '' })
    const at = async (dir: string, top = root) => (await detectChecks(path.join(root, dir), { platform: 'linux', top })).map((check) => check.command)
    assert.deepEqual(await at('web/src'), ['pnpm test'], "web's own")
    assert.deepEqual(await at('docs'), ['npm test'], "the root's, from a folder without one")
    assert.deepEqual(await at('docs', path.join(root, 'docs')), [], 'never above the workspace')
  })

  it('are those a settings file names instead, at most four, and none for an empty list', async () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }
    assert.deepEqual(await found(files, 'linux', ['make lint-types', 'make test']), ['test: make lint-types (settings)', 'test: make test (settings)'])
    assert.deepEqual(await found(files, 'linux', ['pnpm exec tsc -b', 'pnpm test']), ['typecheck: pnpm exec tsc -b (settings)', 'test: pnpm test (settings)'])
    assert.deepEqual(await found(files, 'linux', []), [])
    assert.equal((await found(files, 'linux', ['a', 'b', 'c', 'd', 'e'])).length, 4)
    assert.equal(checkOf('  mypy src ').command, 'mypy src')
  })
})

describe('what a check says failed', () => {
  it('reads compilers by file, code and message, and test runners by test', () => {
    assert.deepEqual(
      failuresIn('src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\nsrc/b.ts:9:1 - error TS2304: Cannot find name \'x\'.\nFound 2 errors.'),
      ["src/a.ts: TS2322 Type 'string' is not assignable to type 'number'.", "src/b.ts: TS2304 Cannot find name 'x'."],
    )
    assert.deepEqual(failuresIn('▶ parser\n  ✔ reads a number (0.5ms)\n  ✖ reads a string (1.2ms)\n✖ failing tests:\n\ntest at a.test.ts:3:1\n✖ reads a string (1.2ms)'), ['reads a string'], 'the summary heading is no test')
    assert.deepEqual(failuresIn(' FAIL  src/sum.test.ts > sum > adds\n × adds 3ms'), ['src/sum.test.ts > sum > adds', 'adds'])
    assert.deepEqual(failuresIn('  ✕ adds two numbers (5 ms)'), ['adds two numbers'])
    assert.deepEqual(failuresIn('=== short test summary info ===\nFAILED tests/test_a.py::test_x - AssertionError: 1 != 2\nERROR tests/test_b.py'), ['tests/test_a.py::test_x', 'tests/test_b.py'])
    assert.deepEqual(failuresIn('test tests::adds ... FAILED\nerror[E0308]: mismatched types\n --> src/main.rs:3:5'), ['tests::adds', 'src/main.rs: [E0308] mismatched types'])
    assert.deepEqual(failuresIn('--- FAIL: TestAdd (0.00s)\n./sum.go:3:5: undefined: x'), ['TestAdd', './sum.go: undefined: x'])
    assert.deepEqual(failuresIn('src/a.py:3: error: Incompatible return value  [return-value]'), ['src/a.py: Incompatible return value [return-value]'])
    assert.deepEqual(failuresIn('\x1b[31m✖ colored (2ms)\x1b[39m'), ['colored'])
    assert.equal(failuresIn('Something went wrong.\nExit code 1'), null)
  })
})

describe('the ledger of runs', () => {
  it('knows which runs are since the last change, and what stood before the request changed anything', () => {
    const ledger = new CheckLedger()
    ledger.startRequest()
    ledger.ran('npm run test', false, '✖ adds (1ms)')
    assert.deepEqual(ledger.current('npm test')?.failures, ['adds'], '`npm run test` is `npm test`')
    assert.equal(ledger.changedInRequest, false)
    ledger.changed()
    assert.equal(ledger.changedInRequest, true)
    assert.equal(ledger.current('npm test'), undefined, 'the change made it stale')
    ledger.ran('npm test', false, '✖ adds (1ms)\n✖ subtracts (1ms)')
    assert.deepEqual(ledger.before('npm test')?.failures, ['adds'], 'the run before the first change')
    ledger.changed()
    assert.deepEqual(ledger.before('npm test')?.failures, ['adds'], 'a later change keeps the request’s baseline')
    ledger.startRequest()
    assert.deepEqual(ledger.before('npm test')?.failures, ['adds', 'subtracts'], 'a new request compares with the last run')
  })

  it('counts a passing check since the last change as verified', () => {
    const ledger = new CheckLedger()
    assert.equal(ledger.verified, false)
    ledger.ran('ls src', true, 'a.ts')
    assert.equal(ledger.verified, false, 'ls checks nothing')
    ledger.ran('pnpm -r typecheck', true, '')
    assert.equal(ledger.verified, true)
    ledger.changed()
    assert.equal(ledger.verified, false)
    ledger.ran('cargo test', false, 'test a ... FAILED')
    assert.equal(ledger.verified, false)
    ledger.ran('cargo test', true, 'ok')
    assert.equal(ledger.verified, true)
    assert.equal(sameCommand(' yarn   run  test '), 'yarn test')
  })
})

describe('a failure compared with the runs before the request', () => {
  const run = (failures: string[] | null, ok = false) => ({ ok, failures, seq: 0 })
  it('is the agent’s when it is new, and not when every failure was there before', () => {
    assert.match(regression(run(['a']), undefined)!.text, /no run of it from before this request/)
    assert.match(regression(run(['a']), run([], true))!.text, /passed before this request, so your changes broke it/)
    assert.match(regression(run(null), run(['a']))!.text, /cannot tell which failures are new/)
    assert.equal(regression(run(['a', 'b']), run(['a', 'b', 'c'])), undefined)
    assert.equal(regression(run(['b', 'c']), run(['a', 'b']))!.text, 'New since this request: c. Failing before it too, not yours unless asked: b.')
  })
})
