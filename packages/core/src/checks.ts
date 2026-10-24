/**
 * The project's checks (ADR 0095): its typecheck and its tests, which eNCode runs when the agent wants to end a turn
 * that changed code, so that what the agent says is done is what the project's own tools say. They are found in the
 * project's files (package.json, Cargo.toml, go.mod, pytest's and mypy's settings) or named in the `checks` list of a
 * settings file, and run as the agent's own commands are: through the person's rules, the approval policy and the
 * sandbox.
 *
 * The ledger remembers each check's last run, by eNCode or by the agent, and when the code last changed: a run after
 * the last change needs no other, and the runs before a request's first change are what its failures are compared with
 * (the regression guard): a failure that was there before is not the agent's to fix.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** When the agent ends a turn that changed code: `auto` runs the checks and sends it back up to twice, `on` up to four times, `off` never. */
export type CheckGate = 'auto' | 'on' | 'off'

export const isCheckGate = (value: unknown): value is CheckGate => value === 'auto' || value === 'on' || value === 'off'

/** Rounds the checks may send the agent back for, in one turn. */
export const CHECK_ROUNDS: Record<CheckGate, number> = { auto: 2, on: 4, off: 0 }

/** How long one check may run; a test suite that takes longer is not waited for. */
export const CHECK_TIMEOUT_MS = 600_000

/** At most this many commands, typechecks first. */
const MAX_CHECKS = 4

export interface ProjectCheck {
  /** As the shell is given it. */
  command: string
  kind: 'typecheck' | 'test'
  /** Where eNCode found it: "package.json", "Cargo.toml", "settings". */
  source: string
}

const TYPECHECK = /\b(?:tsc|typecheck|type-check|check-types|types:check|vet|mypy|pyright|cargo check|deno check)\b/i

/** A command named in a settings file, as a check: a typecheck when it reads like one. */
export function checkOf(command: string, source = 'settings'): ProjectCheck {
  return { command: command.trim(), kind: TYPECHECK.test(command) ? 'typecheck' : 'test', source }
}

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun'

async function readText(file: string, max = 1024 * 1024): Promise<string | undefined> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > max) return undefined
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

async function managerOf(root: string, declared: unknown): Promise<Manager> {
  const named = typeof declared === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(declared)?.[1] : undefined
  if (named) return named as Manager
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn'
  if ((await exists(path.join(root, 'bun.lockb'))) || (await exists(path.join(root, 'bun.lock')))) return 'bun'
  return 'npm'
}

/** `npm run x`, `pnpm run x`, `yarn x`, `bun run x`: `bun test` would be bun's own runner, not the script. */
const runScript = (manager: Manager, script: string) => (manager === 'yarn' ? `yarn ${script}` : `${manager} run ${script}`)
const runTests = (manager: Manager) => (manager === 'bun' ? 'bun run test' : `${manager} test`)
const execBin: Record<Manager, string> = { npm: 'npx --no-install', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'types:check', 'tsc']
/** npm init's test script, which only fails. */
const PLACEHOLDER = /no test specified/i
/** A script that waits for changes never ends. */
const WATCHES = /(?:^|\s)--watch\b|\bwatch\b/

async function nodeChecks(root: string): Promise<ProjectCheck[]> {
  const text = await readText(path.join(root, 'package.json'))
  if (text === undefined) return []
  let manifest: { scripts?: Record<string, unknown>; packageManager?: unknown }
  try {
    manifest = JSON.parse(text)
  } catch {
    return []
  }
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
  const manager = await managerOf(root, manifest.packageManager)
  const out: ProjectCheck[] = []
  const typecheck = TYPECHECK_SCRIPTS.find((name) => typeof scripts[name] === 'string' && !WATCHES.test(scripts[name] as string))
  if (typecheck) out.push({ command: runScript(manager, typecheck), kind: 'typecheck', source: 'package.json' })
  else {
    // No script, but TypeScript is installed and the root's tsconfig compiles something itself (not only references).
    const config = await readText(path.join(root, 'tsconfig.json'))
    if (config !== undefined && !/"references"\s*:/.test(config) && (await exists(path.join(root, 'node_modules', 'typescript', 'package.json')))) {
      out.push({ command: `${execBin[manager]} tsc --noEmit`, kind: 'typecheck', source: 'tsconfig.json' })
    }
  }
  const test = scripts.test
  if (typeof test === 'string' && test.trim() && !PLACEHOLDER.test(test) && !WATCHES.test(test)) out.push({ command: runTests(manager), kind: 'test', source: 'package.json' })
  return out
}

async function rustChecks(root: string): Promise<ProjectCheck[]> {
  if (!(await exists(path.join(root, 'Cargo.toml')))) return []
  return [
    { command: 'cargo check --all-targets', kind: 'typecheck', source: 'Cargo.toml' },
    { command: 'cargo test', kind: 'test', source: 'Cargo.toml' },
  ]
}

async function goChecks(root: string): Promise<ProjectCheck[]> {
  if (!(await exists(path.join(root, 'go.mod')))) return []
  return [
    { command: 'go vet ./...', kind: 'typecheck', source: 'go.mod' },
    { command: 'go test ./...', kind: 'test', source: 'go.mod' },
  ]
}

async function pythonChecks(root: string, platform: NodeJS.Platform): Promise<ProjectCheck[]> {
  const python = platform === 'win32' ? 'python' : 'python3'
  const [pyproject, setup, tox, pytestIni, mypyIni, conftest] = await Promise.all([
    readText(path.join(root, 'pyproject.toml')),
    readText(path.join(root, 'setup.cfg')),
    readText(path.join(root, 'tox.ini')),
    exists(path.join(root, 'pytest.ini')),
    exists(path.join(root, 'mypy.ini')),
    exists(path.join(root, 'conftest.py')),
  ])
  const out: ProjectCheck[] = []
  if (mypyIni || /^\[tool\.mypy\]/m.test(pyproject ?? '') || /^\[mypy\]/m.test(setup ?? '')) {
    out.push({ command: `${python} -m mypy .`, kind: 'typecheck', source: mypyIni ? 'mypy.ini' : pyproject && /^\[tool\.mypy\]/m.test(pyproject) ? 'pyproject.toml' : 'setup.cfg' })
  }
  const pytest =
    pytestIni ? 'pytest.ini'
    : /^\[tool\.pytest/m.test(pyproject ?? '') ? 'pyproject.toml'
    : /^\[tool:pytest\]/m.test(setup ?? '') ? 'setup.cfg'
    : /^\[pytest\]/m.test(tox ?? '') ? 'tox.ini'
    : conftest ? 'conftest.py'
    : undefined
  if (pytest) out.push({ command: `${python} -m pytest -q`, kind: 'test', source: pytest })
  return out
}

/**
 * The project's checks: those a settings file names (an empty list turns them off), or those found in the project's
 * files, typechecks first, at most four. They are looked for in `dir`, where the commands will run, and then in each
 * folder above it up to `top`: the nearest that has any is the project the agent works in, as npm, cargo and go find it.
 */
export async function detectChecks(dir: string, options: { platform: NodeJS.Platform; configured?: readonly string[]; top?: string }): Promise<ProjectCheck[]> {
  if (options.configured) return options.configured.filter((command) => command.trim()).slice(0, MAX_CHECKS).map((command) => checkOf(command))
  const top = path.resolve(options.top ?? dir)
  for (let at = path.resolve(dir); ; ) {
    const found = (await Promise.all([nodeChecks(at), rustChecks(at), goChecks(at), pythonChecks(at, options.platform)])).flat()
    if (found.length) return [...found.filter((check) => check.kind === 'typecheck'), ...found.filter((check) => check.kind === 'test')].slice(0, MAX_CHECKS)
    const up = path.dirname(at)
    if (at === top || up === at || !isWithin(top, up)) return []
    at = up
  }
}

/** Whether `inner` is `outer` or inside it. */
export function isWithin(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// ------------------------------------------------------------------ what failed

const IDENTITIES = 200

/**
 * The failures an output names, each as a line that stays the same when lines move: a compiler's errors by file, code
 * and message, a test runner's failing tests by name. Null when the output names none in a form eNCode reads.
 */
export function failuresIn(output: string): string[] | null {
  const found = new Set<string>()
  const add = (text: string) => {
    if (found.size < IDENTITIES) found.add(text.replace(/\s+/g, ' ').trim())
  }
  const lines = output.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\x1b\[[0-9;]*m/g, '')
    let match: RegExpExecArray | null
    // tsc: src/a.ts(3,5): error TS2322: ...   or, pretty: src/a.ts:3:5 - error TS2322: ...
    if ((match = /^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/.exec(line)) || (match = /^(.+?):\d+:\d+ - error (TS\d+): (.+)$/.exec(line))) add(`${match[1]}: ${match[2]} ${match[3]}`)
    // node:test, mocha and jest's marks: ✖ name (1.2ms), ✕ name (5 ms), × name 5ms
    else if ((match = /^\s*[✖✕×]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/.exec(line))) {
      if (!/^failing tests:?$/i.test(match[1])) add(match[1])
    }
    // vitest and jest: FAIL  src/a.test.ts > suite > name
    else if ((match = /^\s*FAIL\s+(.+)$/.exec(line))) add(match[1])
    // pytest's summary: FAILED tests/test_a.py::test_x - AssertionError
    else if ((match = /^(?:FAILED|ERROR) (\S+)/.exec(line))) add(match[1])
    // cargo test: test tests::adds ... FAILED
    else if ((match = /^test (\S+) \.\.\. FAILED$/.exec(line))) add(match[1])
    // rustc: error[E0308]: mismatched types, then --> src/main.rs:3:5
    else if ((match = /^error(\[E\d+\])?: (.+)$/.exec(line))) {
      const where = /^\s*--> (.+?):\d+:\d+/.exec(lines[index + 1] ?? '')
      if (where) add(`${where[1]}: ${match[1] ?? ''} ${match[2]}`)
    }
    // go test: --- FAIL: TestName (0.00s); go vet and build: ./a.go:3:5: message
    else if ((match = /^\s*--- FAIL: (\S+)/.exec(line))) add(match[1])
    else if ((match = /^(\S+\.go):\d+(?::\d+)?: (.+)$/.exec(line))) add(`${match[1]}: ${match[2]}`)
    // mypy: src/a.py:3: error: message  [code]
    else if ((match = /^(\S+\.pyi?):\d+(?::\d+)?: error: (.+)$/.exec(line))) add(`${match[1]}: ${match[2]}`)
  }
  return found.size ? [...found] : null
}

// ------------------------------------------------------------------ the ledger

/** A command as it is compared: spaces collapsed, and `npm run test` the same as `npm test`. */
export function sameCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(npm|pnpm|bun) run test\b/, '$1 test')
    .replace(/^yarn run /, 'yarn ')
}

/** Commands that check the code: tests, typechecks, builds, linters. A reply that says they pass needs one to have passed. */
export const CHECK_LIKE =
  /\b(?:test|tests|spec|pytest|jest|vitest|mocha|ava|tap|tsc|typecheck|type-check|check|build|compile|vet|mypy|pyright|lint|eslint|cargo|go (?:test|vet|build)|dotnet|mvn|gradle|make|ctest|phpunit|rspec|unittest)\b/i

export interface CheckRun {
  ok: boolean
  failures: string[] | null
  /** The ledger's count of code changes when it ran. */
  seq: number
}

/**
 * A session's record of its checks' runs and of when its code changed, by its agent or its subagents. Shared by every
 * turn, kept as the loop is rebuilt.
 */
export class CheckLedger {
  private seq = 0
  private readonly runs = new Map<string, CheckRun>()
  /** The count at the last passing run of a command that checks the code; -1 when none passed. */
  private passedAt = -1
  /** The count when the request started, and the runs as they stood at its first change. */
  private startedAt = 0
  private base: ReadonlyMap<string, CheckRun> | undefined

  /** A request starts: the runs before its first change are what its failures are compared with. */
  startRequest(): void {
    this.startedAt = this.seq
    this.base = undefined
    this.wroteFiles = false
  }

  private wroteFiles = false

  /** A tool changed a file, code or not: the scan and the Reviewer have something to read (ADR 0096). */
  wrote(): void {
    this.wroteFiles = true
  }

  /** Whether any file changed since the request started. */
  get wroteInRequest(): boolean {
    return this.wroteFiles
  }

  /** The agent changed code. */
  changed(): void {
    if (this.seq === this.startedAt) this.base = new Map(this.runs)
    this.seq++
  }

  /** Whether code changed since the request started. */
  get changedInRequest(): boolean {
    return this.seq > this.startedAt
  }

  /** Its last run before the request's first change. */
  before(command: string): CheckRun | undefined {
    return (this.base ?? this.runs).get(sameCommand(command))
  }

  /** A command ran to its end, by the agent or by eNCode. */
  ran(command: string, ok: boolean, output: string): void {
    this.runs.set(sameCommand(command), { ok, failures: ok ? [] : failuresIn(output), seq: this.seq })
    if (ok && CHECK_LIKE.test(command)) this.passedAt = this.seq
  }

  /** Its last run, before or after the last change. */
  last(command: string): CheckRun | undefined {
    return this.runs.get(sameCommand(command))
  }

  /** Its run since the code last changed, if there was one. */
  current(command: string): CheckRun | undefined {
    const run = this.last(command)
    return run && run.seq === this.seq ? run : undefined
  }

  /** Whether a command that checks the code passed since the code last changed. */
  get verified(): boolean {
    return this.passedAt === this.seq
  }
}

/** What a session gives its main agent: the checks as they stand now, and the ledger. */
export interface ProjectChecks {
  list(): Promise<ProjectCheck[]>
  ledger: CheckLedger
}

// ------------------------------------------------------------------ telling the agent

const shown = (items: readonly string[], most = 8) =>
  items.length > most ? `${items.slice(0, most).join('; ')}; and ${items.length - most} more` : items.join('; ')

/** What the agent is told when bigger work starts in a project with tests, before any test changed (ADR 0097). */
export function testsFirstReminder(command: string): string {
  return [
    `This is bigger work, and the project has tests (\`${command}\`). Write the tests first:`,
    '- add or change tests for what this work adds or fixes, the edge cases with it;',
    '- run them, and see the new ones fail for the reason you expect;',
    '- then change the code until they pass, and run the whole suite once at the end.',
    'Leave out a part that cannot be tested, and say so in your reply.',
  ].join('\n')
}

/**
 * How a failing check compares with its last run before the request: what is new is the agent's to fix. Undefined
 * when every failure was there before, so the agent is not sent back for them.
 */
export function regression(run: CheckRun, before: CheckRun | undefined): { text: string } | undefined {
  if (!before) return { text: 'eNCode has no run of it from before this request to compare with, so some failures may be older than your changes.' }
  if (before.ok) return { text: 'It passed before this request, so your changes broke it.' }
  if (!run.failures || !before.failures) return { text: 'It failed before this request too; eNCode cannot tell which failures are new.' }
  const earlier = new Set(before.failures)
  const fresh = run.failures.filter((failure) => !earlier.has(failure))
  const old = run.failures.filter((failure) => earlier.has(failure))
  if (!fresh.length) return undefined
  return { text: [`New since this request: ${shown(fresh)}.`, old.length ? `Failing before it too, not yours unless asked: ${shown(old)}.` : ''].filter(Boolean).join(' ') }
}

export function checksReminder(failed: { check: ProjectCheck; output?: string; compared: string }, passed: readonly ProjectCheck[], skipped: readonly ProjectCheck[]): string {
  const head = failed.output !== undefined ? `eNCode ran the project's checks after your changes.` : `Your last run of the project's checks after your changes failed.`
  const lines = [head]
  if (passed.length) lines.push(`Passed: ${passed.map((check) => `\`${check.command}\``).join(', ')}.`)
  lines.push(`\`${failed.check.command}\` failed${failed.output !== undefined ? ':' : '.'}`)
  if (failed.output !== undefined) lines.push(failed.output)
  lines.push(failed.compared)
  if (skipped.length) lines.push(`Not run until this passes: ${skipped.map((check) => `\`${check.command}\``).join(', ')}.`)
  lines.push('Fix what your changes broke, then finish. If a failure is expected or not caused by your changes, say so in your reply instead.')
  return lines.join('\n')
}
