/**
 * A command's output made smaller by what the command is, before it enters the conversation (ADR 0133). A test run
 * keeps its failures and totals, a build its errors and first warnings, an install its errors and last lines, git log
 * one line a commit, and git diff every file's counts before the diffs that fit. The loop keeps the whole output in a
 * file and says how to read it, and a session whose model reads those files back gets whole outputs from then on.
 *
 * A digest leaves out only lines whose shape it knows: a passing test, a warning past the first few, a progress line.
 * Whatever it does not recognize stays. A failed command whose output is short goes in whole, and so does an output
 * the digest would not halve.
 */

export type DigestKind = 'tests' | 'build' | 'install' | 'git-log' | 'git-diff'

export interface Digest {
  kind: DigestKind
  /** What the model reads in place of the output. */
  text: string
  /** A sentence on what the digest left out, for the note that says where the whole output is. */
  note: string
}

/** A failed command's output shorter than this goes in whole. */
export const FAILED_WHOLE_CHARS = 8_000
/** Outputs shorter than these are left as they are. */
export const DIGEST_MIN_CHARS: Readonly<Record<DigestKind, number>> = { tests: 3_000, build: 3_000, install: 2_000, 'git-log': 4_000, 'git-diff': 25_000 }
/** A digest is used only when it is at most this share of the output. */
const MAX_SHARE = 0.5

/** Stack frames kept of each failure; the rest are counted. */
export const STACK_FRAMES = 5
/** Warnings a build digest keeps, in full, before it only counts them. */
export const BUILD_WARNINGS = 10
/** Lines of a diagnostic kept after its first. */
const BLOCK_LINES = 12
/** The last lines of a build, where its summary is. */
const BUILD_TAIL = 8
/** Warnings and last lines an install digest keeps. */
const INSTALL_WARNINGS = 5
const INSTALL_TAIL = 10
/**
 * Characters a git diff digest takes, its counts and the whole diffs that fit after them: about what the start and end
 * of a long output the loop would show in its place come to (ADR 0093), since a diff is digested only once it is that
 * long. A digest is not shorter than that; it is in a better order.
 */
export const DIFF_SHOWN_CHARS = 14_000

/**
 * The digest of what `command` printed, or undefined when there is none: the command is not one of the kinds, pipes
 * its output on, shows a file, failed with a short output, or the digest would not halve it.
 */
export function digestOutput(command: string, output: string, exitCode: number | null | undefined): Digest | undefined {
  const kind = kindOf(command, output)
  if (!kind || output.length < DIGEST_MIN_CHARS[kind]) return undefined
  const ok = exitCode === 0
  if (!ok && output.length < FAILED_WHOLE_CHARS) return undefined
  const made = DIGESTS[kind](output.split('\n'), ok)
  if (!made || made.text.length > output.length * MAX_SHARE) return undefined
  return { kind, ...made }
}

type Made = { text: string; note: string } | undefined

const DIGESTS: Record<DigestKind, (lines: string[], ok: boolean) => Made> = {
  tests: testsDigest,
  build: buildDigest,
  install: installDigest,
  'git-log': gitLogDigest,
  'git-diff': gitDiffDigest,
}

// What a command is ---------------------------------------------------------------------------------------------------

/** Commands that only set the scene: their output, if any, is not what a digest is about. */
const SCENE = /^(?:cd|pushd|popd|set|export|echo|printf|true|source|\.|Set-Location|Write-Host|Write-Output)\b|^\$env:/i
/** Commands that show a file or filter text: what they print is the thing asked for. */
const VIEWER = /^(?:cat|type|more|less|head|tail|sed|awk|nl|od|xxd|bat|jq|yq|grep|egrep|rg|findstr|sort|uniq|wc|Get-Content|gc|Select-String)\b/i
const GIT = /^git(?:\s+(?:-C\s+\S+|-c\s+\S+|-P|--no-pager|--git-dir=\S+|--work-tree=\S+))*\s+(log|diff|show)\b/
/** Package scripts and runners, with the flags that come before the script's name. */
const RUNNER = String.raw`(?:(?:npx|pnpm|yarn|bunx?|npm)\s+(?:(?:exec|run|-s|--silent|-r|--recursive|-w|--workspaces|--if-present|--filter(?:=|\s+)\S+|-F\s+\S+|-C\s+\S+|--prefix(?:=|\s+)\S+|--workspace(?:=|\s+)\S+)\s+)*)?`
const BUILD = new RegExp(
  String.raw`^${RUNNER}(?:build|compile|typecheck|type-check|check-types|tsc|vue-tsc|vite\s+build|webpack|next\s+build|rollup|esbuild|tsup)\b` +
    String.raw`|^(?:cargo\s+(?:build|check|b|c)\b|go\s+(?:build|vet|install)\b|dotnet\s+(?:build|publish|msbuild)\b|msbuild\b|(?:gcc|g\+\+|clang\+\+|clang|cc|c\+\+|javac|kotlinc|swiftc|rustc)\b|make\b|mingw32-make\b|cmake\s+--build\b|ninja\b|meson\s+compile\b|mvn\b|(?:\.[\\/])?gradlew?(?:\.bat)?\b|swift\s+build\b|zig\s+build\b|mypy\b|pyright\b)`,
  'i',
)
const INSTALL = new RegExp(
  String.raw`^(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:-s|--silent|-w|-r|--filter(?:=|\s+)\S+|-C\s+\S+|--prefix(?:=|\s+)\S+)\s+)*(?:install|i|ci|add|update|up|upgrade|remove|rm|uninstall)\b|yarn$` +
    String.raw`|(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip|uv\s+pip)\s+install\b|uv\s+(?:sync|add)\b|poetry\s+(?:install|add|update)\b|pipenv\s+install\b|conda\s+install\b` +
    String.raw`|cargo\s+(?:add|fetch|install|update)\b|go\s+(?:get|mod\s+(?:download|tidy))\b|dotnet\s+(?:restore|add\s+\S+\s+package|tool\s+install)\b|nuget\s+(?:install|restore)\b` +
    String.raw`|(?:gem|bundle)\s+install\b|composer\s+(?:install|require|update)\b|(?:sudo\s+)?apt(?:-get)?\s+install\b|brew\s+install\b|winget\s+install\b|choco\s+install\b|scoop\s+install\b)`,
  'i',
)

/** The summary line a test runner ends with: by these a test run is known, whatever started it. */
const TEST_SUMMARY = [
  /^# (?:tests|pass|fail) \d+$/m, // TAP: node --test, tap
  /^ℹ (?:tests|pass|fail) \d+$/m, // node --test's spec reporter
  /^Tests:\s+.*\b\d+ total$/m, // jest
  /^\s*Tests\s+(?:\d+ \w+ \| )*\d+ \w+ \(\d+\)/m, // vitest
  /^\s*\d+ passing \(\d+(?:\.\d+)?m?s\)$/m, // mocha
  /^=+ .*\b\d+ (?:passed|failed|errors?)\b.* in [\d.]+s\b.*=+$/m, // pytest
  /^(?:ok|FAIL)\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/m, // go test
  /^test result: (?:ok|FAILED)\. \d+ passed/m, // cargo test
  /^(?:Passed|Failed)!\s+-\s+Failed:\s+\d+/m, // dotnet test
  /^Ran \d+ tests? in [\d.]+s$/m, // python unittest
  /^\s*\d+ (?:passed|failed) \(\d+(?:\.\d+)?m?s\)$/m, // playwright
]

/** The commands a shell line runs, split at &&, ||, ; and line ends; undefined when one pipes into another. */
export function commandsOf(line: string): string[] | undefined {
  // Quoted text neither splits nor pipes.
  const plain = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
  const unpiped = plain.replace(/\|\|/g, ';')
  if (unpiped.includes('|')) return undefined
  return unpiped
    .split(/&&|;|\r?\n/)
    .map((part) =>
      part
        .trim()
        .replace(/^(?:\w+=(?:""|\S*)\s+)+/, '')
        .replace(/^(?:time|env|command)\s+/, ''),
    )
    .filter(Boolean)
}

function kindOf(command: string, output: string): DigestKind | undefined {
  const commands = commandsOf(command)?.filter((part) => !SCENE.test(part))
  if (!commands?.length || commands.some((part) => VIEWER.test(part))) return undefined
  const git = commands.map((part) => GIT.exec(part)?.[1])
  if (git.some(Boolean)) {
    // A git digest rewrites the whole output, so only for git on its own.
    const kinds = new Set(git.map((sub) => (sub === 'log' ? 'git-log' : sub ? 'git-diff' : undefined)))
    return kinds.size === 1 && !kinds.has(undefined) ? [...kinds][0] : undefined
  }
  if (TEST_SUMMARY.some((summary) => summary.test(output))) return 'tests'
  if (commands.some((part) => BUILD.test(part))) return 'build'
  if (commands.some((part) => INSTALL.test(part))) return 'install'
  return undefined
}

// Lines left out ------------------------------------------------------------------------------------------------------

const indentOf = (line: string) => /^\s*/.exec(line)![0]
const many = (count: number, one: string, more = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : more}`

/** The kept lines in order, each run of left-out ones marked by a line that says what it held. */
function joinKept(lines: readonly string[], keep: readonly boolean[], mark: (from: number, to: number) => string | undefined): string {
  const out: string[] = []
  for (let index = 0; index < lines.length; ) {
    if (keep[index]) {
      out.push(lines[index++])
      continue
    }
    let end = index
    while (end < lines.length && !keep[end]) end++
    const note = mark(index, end)
    if (note) out.push(`${indentOf(lines[index])}… (${note})`)
    index = end
  }
  return out.join('\n')
}

/** Keeps the first STACK_FRAMES lines of each run of `at` frames and of each TAP stack; true for each line it left out. */
function trimStacks(lines: readonly string[], keep: boolean[]): boolean[] {
  const trimmed = lines.map(() => false)
  for (let index = 0; index < lines.length; index++) {
    if (!keep[index]) continue
    let end = index
    const yaml = /^(\s*)stack: \|-?$/.exec(lines[index])
    if (yaml) {
      const deeper = yaml[1].length
      end = index + 1
      while (end < lines.length && indentOf(lines[end]).length > deeper && lines[end].trim()) end++
      index++
    } else if (FRAME.test(lines[index])) {
      while (end < lines.length && FRAME.test(lines[end])) end++
    } else continue
    for (let frame = index + STACK_FRAMES; frame < end; frame++) {
      trimmed[frame] = keep[frame]
      keep[frame] = false
    }
    index = end - 1
  }
  return trimmed
}

const FRAME = /^\s+at\s+\S/

// Tests ---------------------------------------------------------------------------------------------------------------

type TestLine =
  | { role: 'pass'; indent: number; name?: string; tests: number; files?: number; yaml?: boolean }
  | { role: 'fail'; indent: number; name: string; yaml?: boolean }
  | { role: 'header'; indent: number; name: string; suite?: boolean }
  | { role: 'noise' }

const TIME = String.raw`(?: \(\d+(?:\.\d+)?\s*m?s\)| \d+(?:\.\d+)?m?s)?`
const TEST_LINES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => TestLine]> = [
  // TAP (node --test when its output is not a terminal, tap): a result, its YAML block, the header before it.
  [/^(\s*)ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/, (m) => ({ role: 'pass', indent: m[1].length, name: m[2], tests: 1, yaml: true })],
  [/^(\s*)not ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/, (m) => ({ role: 'fail', indent: m[1].length, name: m[2], yaml: true })],
  [/^(\s*)# Subtest: (.*)$/, (m) => ({ role: 'header', indent: m[1].length, name: m[2] })],
  [/^\s*1\.\.\d+$/, () => ({ role: 'noise' })],
  // Spec reporters: node --test in a terminal, mocha, jest --verbose, vitest.
  [new RegExp(String.raw`^(\s*)[✔✓√] (.*?)${TIME}$`), (m) => passLine(m[1].length, m[2])],
  [new RegExp(String.raw`^(\s*)[✖✕×] (.*?)${TIME}$`), (m) => ({ role: 'fail', indent: m[1].length, name: m[2] })],
  [/^(\s*)▶ (.*)$/, (m) => ({ role: 'header', indent: m[1].length, name: m[2], suite: true })],
  // jest's line for a test file that passed.
  [/^\s*PASS\s+\S+/, () => ({ role: 'pass', indent: 0, tests: 0, files: 1 })],
  // go test -v.
  [/^(\s*)=== RUN\s+(\S+)/, (m) => ({ role: 'header', indent: m[1].length, name: m[2] })],
  [/^\s*=== (?:PAUSE|CONT|NAME)\s/, () => ({ role: 'noise' })],
  [/^(\s*)--- PASS: (\S+)/, (m) => ({ role: 'pass', indent: m[1].length, name: m[2], tests: 1 })],
  [/^(\s*)--- FAIL: (\S+)/, (m) => ({ role: 'fail', indent: m[1].length, name: m[2] })],
  // pytest: a file's progress dots, and -v's lines.
  [/^(?:\S+\.py )?([.sxX]+)\s*\[\s*\d+%\]$|^\S+\.py ([.sxX]+)$/, (m) => ({ role: 'pass', indent: 0, tests: (m[1] ?? m[2]).length })],
  [/^\S+::\S.*\sPASSED(?:\s+\[\s*\d+%\])?$/, () => ({ role: 'pass', indent: 0, tests: 1 })],
  // cargo test, python's unittest -v, dotnet test, gradle.
  [/^test \S+ \.\.\. ok$/, () => ({ role: 'pass', indent: 0, tests: 1 })],
  [/^test\w* \(.+\) \.\.\. ok$/, () => ({ role: 'pass', indent: 0, tests: 1 })],
  [/^\s*Passed\s+\S.*\[\s*(?:< )?\d+(?:\.\d+)?\s*m?s\]$/, () => ({ role: 'pass', indent: 0, tests: 1 })],
  [/^\S.* > .+ PASSED$/, () => ({ role: 'pass', indent: 0, tests: 1 })],
]

/** A spec reporter's passing line: one test, or a whole file of them as vitest prints it ("src/a.test.ts (30 tests)"). */
function passLine(indent: number, name: string): TestLine {
  const file = /\((\d+) tests?\)$/.exec(name)
  return file ? { role: 'pass', indent, tests: Number(file[1]), files: 1 } : { role: 'pass', indent, name, tests: 1 }
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index
  return -1
}

function testLine(line: string): TestLine | undefined {
  for (const [pattern, role] of TEST_LINES) {
    const match = pattern.exec(line)
    if (match) return role(match)
  }
  return undefined
}

/** Where the YAML block of the TAP result at `index` ends, and whether it says the result is a suite's. */
function yamlBlock(lines: readonly string[], index: number): { end: number; suite: boolean } {
  const indent = indentOf(lines[index])
  if (lines[index + 1] !== `${indent}  ---`) return { end: index + 1, suite: false }
  let end = index + 2
  let suite = false
  while (end < lines.length && lines[end] !== `${indent}  ...`) {
    if (lines[end] === `${indent}  type: 'suite'`) suite = true
    end++
  }
  return { end: Math.min(end + 1, lines.length), suite }
}

/**
 * A test run without its passing tests: every failure with its error, the first frames of its stack, and the totals.
 * A suite's or test's header is held until its result comes, and dropped with it when it passed.
 */
function testsDigest(lines: string[]): Made {
  const keep = lines.map(() => true)
  const tests = new Array<number>(lines.length).fill(0)
  const files = new Array<number>(lines.length).fill(0)
  const open: { index: number; indent: number; name: string; suite?: boolean }[] = []
  let passed = 0
  for (let index = 0; index < lines.length; index++) {
    const line = testLine(lines[index])
    if (!line) continue
    if (line.role === 'header') {
      open.push({ index, indent: line.indent, name: line.name, ...(line.suite ? { suite: true } : {}) })
      continue
    }
    if (line.role === 'noise') {
      keep[index] = false
      continue
    }
    // A result with a name closes its header, found by that name or else by indent.
    let opened = line.name === undefined ? -1 : lastIndex(open, (header) => header.name === line.name)
    if (opened < 0 && line.name !== undefined) opened = lastIndex(open, (header) => header.indent === line.indent)
    // go prints a test's result before its subtests' results, so only the header found is closed.
    const header = opened >= 0 ? open.splice(opened, 1)[0] : undefined
    const block = line.yaml ? yamlBlock(lines, index) : { end: index + 1, suite: false }
    if (line.role === 'pass') {
      if (header) keep[header.index] = false
      for (let drop = index; drop < block.end; drop++) keep[drop] = false
      // A suite's own result is not a test: TAP says so in its YAML, a spec reporter by the header it closes.
      if (!block.suite && !header?.suite) {
        tests[index] = line.tests
        passed += line.tests
      }
      files[index] = line.files ?? 0
    }
    index = block.end - 1
  }
  if (!passed && !files.some(Boolean)) return undefined
  const frames = trimStacks(lines, keep)
  const text = joinKept(lines, keep, (from, to) => {
    let frameCount = 0
    let count = 0
    let fileCount = 0
    for (let index = from; index < to; index++) {
      if (frames[index]) frameCount++
      count += tests[index]
      fileCount += files[index]
    }
    const parts = [frameCount ? many(frameCount, 'more stack line') : '', count ? many(count, 'passing test') : '', fileCount ? many(fileCount, 'passing test file') : '']
    return parts.filter(Boolean).join(', ') || undefined
  })
  const stacks = frames.some(Boolean) ? ` and the stack frames after the first ${STACK_FRAMES} of each failure` : ''
  return { text, note: `The digest leaves out the lines of ${many(passed, 'passing test')}${stacks}; the failures and totals are all there.` }
}

// Builds --------------------------------------------------------------------------------------------------------------

const ERROR_START = [
  /(?:^|[\s:(\]])(?:fatal )?error(?:\[[A-Z]*\d+\])?(?:\s+[A-Z]{1,4}\d{2,5})?\s*:/i, // tsc, cargo, gcc, javac, msbuild, mypy
  /^\s*\d+:\d+\s+error\s/, // eslint's stylish lines
  /^\s*[A-Z]\w*Error\b:?/, // TypeError: …
  /^(?:ERROR|FAILED|BUILD FAILED)\b|^e: /, // webpack, gradle, kotlin
  /^\S+\.go:\d+:\d+: /, // go build and vet say no "error"
]
const WARNING_START = [/(?:^|[\s:(\]])warning(?:\[[A-Z]*\d+\])?(?:\s+[A-Z]{1,4}\d{2,5})?\s*:/i, /^\s*\d+:\d+\s+warning\s/, /^(?:WARNING|WARN)\b|^w: /]
/** A file's name on a line of its own, which a linter or go prints before what it found in that file. */
const FILE_HEADING = /^(?:[A-Za-z]:)?[^\s:]*[\\/][^:]*\.\w{1,6}$|^# \S+$/

const isError = (line: string) => ERROR_START.some((pattern) => pattern.test(line))
const isWarning = (line: string) => WARNING_START.some((pattern) => pattern.test(line))

/** Each diagnostic: its first line, and the lines after it up to a blank line, the next one or BLOCK_LINES. */
function diagnostics(lines: readonly string[], start: (line: string) => 'error' | 'warning' | undefined) {
  const found: { kind: 'error' | 'warning'; from: number; to: number; heading?: number }[] = []
  let heading: number | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) {
      heading = undefined
      continue
    }
    const kind = start(line)
    if (!kind) {
      if (FILE_HEADING.test(line)) heading = index
      continue
    }
    let to = index + 1
    while (to < lines.length && to - index <= BLOCK_LINES && lines[to].trim() && !start(lines[to])) to++
    found.push({ kind, from: index, to, ...(heading !== undefined ? { heading } : {}) })
    index = to - 1
  }
  return found
}

/** A build without the lines that only say it is working: its errors, its first warnings and its last lines. */
function buildDigest(lines: string[], ok: boolean): Made {
  const found = diagnostics(lines, (line) => (isError(line) ? 'error' : isWarning(line) ? 'warning' : undefined))
  const errors = found.filter((block) => block.kind === 'error')
  const warnings = found.filter((block) => block.kind === 'warning')
  // A failed build whose errors cannot be told apart from the rest goes in whole.
  if (!ok && !errors.length) return undefined
  const keep = lines.map(() => false)
  for (const block of [...errors, ...warnings.slice(0, BUILD_WARNINGS)]) {
    for (let index = block.from; index < block.to; index++) keep[index] = true
    if (block.heading !== undefined) keep[block.heading] = true
  }
  keepTail(lines, keep, BUILD_TAIL)
  return {
    text: joinLeftOut(lines, keep),
    note: `The build printed ${printed(errors.length, warnings.length)}; the digest keeps the errors, ${firstOf(warnings.length, BUILD_WARNINGS)} and the last ${BUILD_TAIL} lines, and leaves out ${many(leftOut(lines, keep), 'other line')}.`,
  }
}

const printed = (errors: number, warnings: number) => `${many(errors, 'error')} and ${many(warnings, 'warning')}`
const firstOf = (warnings: number, kept: number) => (warnings > kept ? `the first ${kept} warnings` : 'the warnings')

/** The kept lines with a blank line between kept blocks, and each other run left out counted. */
function joinLeftOut(lines: readonly string[], keep: boolean[]): string {
  for (let index = 1; index < lines.length - 1; index++) if (!lines[index].trim() && keep[index - 1] && keep[index + 1]) keep[index] = true
  return joinKept(lines, keep, (from, to) => {
    const count = lines.slice(from, to).filter((line) => line.trim()).length
    return count ? `${many(count, 'line')} left out` : undefined
  })
}

const leftOut = (lines: readonly string[], keep: readonly boolean[]) => lines.filter((line, index) => !keep[index] && line.trim()).length

/** Keeps the last `count` lines that are not blank. */
function keepTail(lines: readonly string[], keep: boolean[], count: number): void {
  for (let index = lines.length - 1, left = count; index >= 0 && left > 0; index--) {
    if (!lines[index].trim()) continue
    keep[index] = true
    left--
  }
}

// Installs ------------------------------------------------------------------------------------------------------------

const INSTALL_ERROR = /\b(?:error|ERR!|failed|failure|fatal)\b/i
const INSTALL_WARNING = /\b(?:warn|warning|deprecated)\b/i

/** An install without its download and progress lines: its errors, its first warnings and its last lines. */
function installDigest(lines: string[], ok: boolean): Made {
  const found = diagnostics(lines, (line) => (INSTALL_ERROR.test(line) ? 'error' : INSTALL_WARNING.test(line) ? 'warning' : undefined))
  const errors = found.filter((block) => block.kind === 'error')
  const warnings = found.filter((block) => block.kind === 'warning')
  if (!ok && !errors.length) return undefined
  const keep = lines.map(() => false)
  for (const block of [...errors, ...warnings.slice(0, INSTALL_WARNINGS)]) {
    for (let index = block.from; index < Math.min(block.to, block.from + 6); index++) keep[index] = true
  }
  keepTail(lines, keep, INSTALL_TAIL)
  return {
    text: joinLeftOut(lines, keep),
    note: `The install printed ${printed(errors.length, warnings.length)}; the digest keeps the errors, ${firstOf(warnings.length, INSTALL_WARNINGS)} and the last ${INSTALL_TAIL} lines, and leaves out ${many(leftOut(lines, keep), 'other line')}.`,
  }
}

// git log -------------------------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** git's default date ("Sun Oct 25 19:51:15 2026 +0000") as 2026-10-25; an ISO one as its date; another as it is. */
function shortDate(date: string): string {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(date)
  if (iso) return iso[1]
  const plain = /^\w{3} (\w{3}) (\d{1,2}) [\d:]+ (\d{4})/.exec(date)
  const month = plain ? MONTHS.indexOf(plain[1]) : -1
  return plain && month >= 0 ? `${plain[3]}-${String(month + 1).padStart(2, '0')}-${plain[2].padStart(2, '0')}` : date
}

/** git log in its default form, one line a commit: hash, refs, date, author and subject. */
function gitLogDigest(lines: string[]): Made {
  if (lines.some((line) => line.startsWith('diff --git '))) return undefined
  const out: string[] = []
  let commits = 0
  for (let index = 0; index < lines.length; ) {
    const commit = /^commit ([0-9a-f]{7,64})(.*)$/.exec(lines[index])
    if (!commit) {
      if (!commits) out.push(lines[index])
      index++
      continue
    }
    commits++
    let author = ''
    let date = ''
    let subject = ''
    let stat = ''
    let end = index + 1
    for (; end < lines.length && !/^commit [0-9a-f]{7,64}/.test(lines[end]); end++) {
      const line = lines[end]
      const field = /^(Author|Date):\s+(.*)$/.exec(line)
      if (field?.[1] === 'Author') author = field[2].replace(/\s*<[^>]*>$/, '')
      else if (field?.[1] === 'Date') date = shortDate(field[2])
      else if (!subject && /^ {4}\S/.test(line)) subject = line.trim()
      else if (/^\s*\d+ files? changed/.test(line)) stat = ` [${line.trim()}]`
    }
    out.push(`${commit[1].slice(0, 10)}${commit[2].trimEnd()} ${date} ${author}: ${subject}${stat}`)
    index = end
  }
  if (commits < 2) return undefined
  return { text: out.join('\n'), note: `The digest shows each of ${many(commits, 'commit')} on one line: hash, date, author and subject; the rest of each message is left out.` }
}

// git diff ------------------------------------------------------------------------------------------------------------

interface FileDiff {
  path: string
  text: string
  added: number
  removed: number
  flag: string
}

function fileDiff(lines: readonly string[]): FileDiff {
  const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0])
  let path = header?.[2] ?? lines[0].slice('diff --git '.length)
  let added = 0
  let removed = 0
  const flags: string[] = []
  let hunks = false
  for (const line of lines.slice(1)) {
    if (line.startsWith('@@')) hunks = true
    else if (hunks && line.startsWith('+')) added++
    else if (hunks && line.startsWith('-')) removed++
    else if (!hunks) {
      if (line.startsWith('new file mode')) flags.push('new')
      else if (line.startsWith('deleted file mode')) flags.push('deleted')
      else if (line.startsWith('rename from ')) flags.push(`renamed from ${line.slice('rename from '.length)}`)
      else if (line.startsWith('Binary files')) flags.push('binary')
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') path = line.slice(4).replace(/^b\//, '')
    }
  }
  return { path, text: lines.join('\n'), added, removed, flag: flags.length ? ` (${flags.join(', ')})` : '' }
}

/** git diff or show: what changed in each file first, then the whole diffs that fit, then the files left out. */
function gitDiffDigest(lines: string[]): Made {
  const starts = lines.flatMap((line, index) => (line.startsWith('diff --git ') ? [index] : []))
  if (starts.length < 2) return undefined
  const files = starts.map((from, at) => fileDiff(lines.slice(from, starts[at + 1] ?? lines.length)))
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  // The diffs that fit after the counts, in the order git gave them; one too big for what is left is passed over.
  const counts = files.reduce((sum, file) => sum + file.path.length + file.flag.length + 32, 0)
  let room = Math.max(DIFF_SHOWN_CHARS / 4, DIFF_SHOWN_CHARS - counts)
  const shown = files.filter((file) => {
    if (file.text.length > room) return false
    room -= file.text.length
    return true
  })
  if (shown.length === files.length) return undefined
  const out = [...lines.slice(0, starts[0])]
  out.push(`${many(files.length, 'file')} changed, ${many(added, 'insertion')}(+), ${many(removed, 'deletion')}(-)`)
  for (const file of files) out.push(` ${file.path} | +${file.added} -${file.removed}${file.flag}${shown.includes(file) ? ' (shown below)' : ''}`)
  for (const file of shown) out.push('', file.text.replace(/\n+$/, ''))
  out.push('', `… (the diffs of the other ${many(files.length - shown.length, 'file')} are left out)`)
  return {
    text: out.join('\n'),
    note: `The digest lists what changed in each of the ${files.length} files and shows the whole diff of ${shown.length}; for another, run git diff on that file.`,
  }
}
