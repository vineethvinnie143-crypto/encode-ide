/**
 * Glob and Grep, with Claude Code's contracts. Both walk the tree the same
 * way (see walk.ts): .gitignore honoured, .git and node_modules skipped,
 * directory links not followed. Results are newest first, so the files the
 * user is working on come up before the rest.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { globBase, globMatcher, globToRegExp } from './glob'
import { displayPath, realPathOf, resolveInputPath, toPosix } from './paths'
import { decodeText, looksLikeText, MAX_TEXT_FILE_BYTES, plural, SNIFF_BYTES, type DecodedText } from './text'
import type { Tool, ToolContext, ToolOutcome } from './types'
import { walk, type WalkEntry } from './walk'
import { WORKTREES_DIR } from './worktree'

const GLOB_LIMIT = 100
const GREP_DEFAULT_LIMIT = 250
const GREP_MAX_LINE = 500
/** Files read at once. A tree of thousands of small files is bound by the wait for the disk, not by the search. */
const GREP_CONCURRENCY = 16
/** Lines of matches held in memory; a search that finds more stops there and says so. */
const GREP_KEEP_LINES = 100_000
/**
 * Lines of one file a content search shows when it found several (ADR 0133): one file full of matches does not push
 * the others off the page. The rest are counted, and a search of that file alone shows them.
 */
export const GREP_FILE_LINES = 30
const WALK_LIMIT = 200_000

function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

function caseInsensitiveFs(ctx: ToolContext): boolean {
  return ctx.platform === 'win32' || ctx.platform === 'darwin'
}

/** Where the agent works: the root, or a worktree it entered. */
function workdir(ctx: ToolContext): string {
  return ctx.cwd ?? ctx.root
}

/**
 * Leaves out the project's worktrees (`.encode-worktrees`) when a search walks into them from the project: each is
 * a whole copy of the project. A search from inside one, or in it by path, starts below this folder.
 */
function notWorktrees(ctx: ToolContext): (entry: WalkEntry) => boolean {
  const folder = path.join(ctx.root, WORKTREES_DIR)
  const same = caseInsensitiveFs(ctx) ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
  return (entry) => !entry.isDirectory || !same(entry.absolute, folder)
}

function searchRoot(input: { path?: unknown }, ctx: ToolContext): string {
  const raw = typeof input.path === 'string' ? input.path.trim() : ''
  return raw ? resolveInputPath(raw, { root: workdir(ctx), home: ctx.home, platform: ctx.platform }) : workdir(ctx)
}

function shownPath(file: string, ctx: ToolContext): string {
  return displayPath(file, { root: workdir(ctx), platform: ctx.platform })
}

async function newestFirst(entries: WalkEntry[], signal: AbortSignal): Promise<WalkEntry[]> {
  const times = new Map<WalkEntry, number>()
  const batch = 64
  for (let index = 0; index < entries.length; index += batch) {
    if (signal.aborted) throw signal.reason
    await Promise.all(
      entries.slice(index, index + batch).map(async (entry) => {
        try {
          times.set(entry, (await fs.stat(entry.absolute)).mtimeMs)
        } catch {
          times.set(entry, 0)
        }
      }),
    )
  }
  return [...entries].sort((a, b) => times.get(b)! - times.get(a)! || (a.relative < b.relative ? -1 : 1))
}

async function directoryOrFailure(dir: string, ctx: ToolContext): Promise<ToolOutcome | undefined> {
  try {
    const stats = await fs.stat(dir)
    return stats.isDirectory() ? undefined : fail(`${shownPath(dir, ctx)} is a file, not a directory.`)
  } catch {
    return fail(`${shownPath(dir, ctx)} does not exist.`)
  }
}

// ---------------------------------------------------------------------------
// Glob

interface GlobInput extends Record<string, unknown> {
  pattern: string
  path?: string
}

export const globTool: Tool<GlobInput> = {
  brief: 'Finds files by glob pattern ("**/*.ts", "src/**/*.{ts,tsx}"), newest first, at most 100, under path (default: the workspace root). Files .gitignore ignores, .git and node_modules are left out.',
  definition: {
    name: 'Glob',
    description: [
      'Finds files by name pattern, in a tree of any size.',
      '',
      '- Patterns like "**/*.ts", "src/**/*.{ts,tsx}" or "*.json". `**` crosses directories; `*` stays within one.',
      '- Returns matching file paths, most recently modified first, at most 100.',
      '- path is the directory to search (default: the workspace root).',
      '- Files ignored by .gitignore, .git and node_modules are left out.',
      '- For an open-ended search that may take several rounds of looking, use the Task tool instead.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, description: 'The glob pattern to match file paths against.' },
        path: { type: 'string', description: 'The directory to search. Omit it to search the workspace root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  async access(input, ctx) {
    return { type: 'read', paths: [await realPathOf(searchRoot(input, ctx))] }
  },
  describe(input, ctx) {
    const dir = searchRoot(input, ctx)
    return { title: `Find ${input.pattern}${dir === workdir(ctx) ? '' : ` in ${shownPath(dir, ctx)}`}` }
  },
  async run(input, ctx) {
    let dir = searchRoot(input, ctx)
    let pattern = input.pattern.trim()
    // An absolute pattern names its own directory.
    if (path.isAbsolute(pattern) || /^[a-zA-Z]:[\\/]/.test(pattern)) {
      const { base, rest } = globBase(toPosix(pattern))
      dir = path.resolve(base || '/')
      pattern = rest
    }
    const problem = await directoryOrFailure(dir, ctx)
    if (problem) return problem
    const { base, rest } = globBase(pattern)
    const start = base ? path.join(dir, base) : dir
    const matcher = globToRegExp(rest, { caseInsensitive: caseInsensitiveFs(ctx) })
    const kept = notWorktrees(ctx)
    const result = await walk({
      dir: start,
      ignoreRoot: workdir(ctx),
      caseInsensitive: caseInsensitiveFs(ctx),
      include: (entry) => kept(entry) && (entry.isDirectory || matcher.test(entry.relative)),
      limit: WALK_LIMIT,
      signal: ctx.signal,
      ...(ctx.offLimits ? { offLimits: ctx.offLimits } : {}),
    })
    if (!result.files.length) return { ok: true, content: 'No files found.' }
    const sorted = await newestFirst(result.files, ctx.signal)
    const shown = sorted.slice(0, GLOB_LIMIT).map((entry) => shownPath(entry.absolute, ctx))
    const more = sorted.length > GLOB_LIMIT || result.truncated
    return {
      ok: true,
      content: shown.join('\n') + (more ? `\n(Showing the ${GLOB_LIMIT} newest of ${result.truncated ? 'more than ' : ''}${sorted.length} matches. Narrow the pattern or the path to see the rest.)` : ''),
      display: { output: plural(sorted.length, 'file') },
    }
  },
}

// ---------------------------------------------------------------------------
// Grep

interface GrepInput extends Record<string, unknown> {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
  '-n'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
  multiline?: boolean
  head_limit?: number
  offset?: number
}

/** File types for Grep's `type`, after ripgrep's names. */
export const FILE_TYPES: Record<string, string[]> = {
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.c++', '*.hpp', '*.hh', '*.hxx', '*.h', '*.inl'],
  cs: ['*.cs', '*.csx'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  dart: ['*.dart'],
  docker: ['Dockerfile', 'Dockerfile.*', '*.dockerfile'],
  elixir: ['*.ex', '*.exs'],
  go: ['*.go'],
  html: ['*.html', '*.htm', '*.xhtml'],
  java: ['*.java'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue'],
  json: ['*.json', '*.jsonc', '*.json5'],
  kotlin: ['*.kt', '*.kts'],
  lua: ['*.lua'],
  md: ['*.md', '*.mdx', '*.markdown'],
  markdown: ['*.md', '*.mdx', '*.markdown'],
  php: ['*.php'],
  ps: ['*.ps1', '*.psm1', '*.psd1'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  r: ['*.r', '*.R', '*.rmd'],
  rb: ['*.rb', '*.gemspec', 'Gemfile', 'Rakefile'],
  ruby: ['*.rb', '*.gemspec', 'Gemfile', 'Rakefile'],
  rust: ['*.rs'],
  scala: ['*.scala', '*.sc'],
  sh: ['*.sh', '*.bash', '*.zsh', '*.ksh'],
  sql: ['*.sql'],
  svelte: ['*.svelte'],
  swift: ['*.swift'],
  toml: ['*.toml'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  typescript: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  vue: ['*.vue'],
  xml: ['*.xml', '*.xsd', '*.xsl', '*.svg'],
  yaml: ['*.yaml', '*.yml'],
  zig: ['*.zig'],
}

/** A JavaScript regex from ripgrep-style syntax: a leading (?i) and (?s) become flags. */
export function grepRegex(pattern: string, options: { ignoreCase: boolean; multiline: boolean }): RegExp {
  let source = pattern
  let flags = 'g'
  const inline = /^\(\?([is]+)\)/.exec(source)
  if (inline) {
    source = source.slice(inline[0].length)
    if (inline[1].includes('i')) flags += 'i'
    if (inline[1].includes('s')) flags += 's'
  }
  if (options.ignoreCase && !flags.includes('i')) flags += 'i'
  if (options.multiline) flags += flags.includes('s') ? 'm' : 'sm'
  try {
    return new RegExp(source, `${flags}u`)
  } catch {
    return new RegExp(source, flags)
  }
}

function clip(line: string): string {
  return line.length > GREP_MAX_LINE ? `${line.slice(0, GREP_MAX_LINE)}… [${line.length} characters]` : line
}

interface FileMatches {
  file: WalkEntry
  count: number
  /** The lines to show for this file, without its name (content mode only). */
  block: ContentLines
}

/** A file's lines in a content search: each as it shows under the file's name, and what follows the name when on its own line. */
interface ContentLines {
  rows: string[]
  /** ':' for a match, '-' for context, '' for the `--` between groups. */
  seps: string[]
}

/**
 * A file's text for searching, or undefined when it is too big, cannot be read or is binary. A binary
 * file is given up on after its first 8 KB, so a tree of images and archives is not read whole.
 */
async function readForSearch(file: string): Promise<DecodedText | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = await handle.stat()
    if (!size || size > MAX_TEXT_FILE_BYTES) return undefined
    const bytes = Buffer.allocUnsafe(size)
    const fill = async (from: number, to: number) => {
      while (from < to) {
        const { bytesRead } = await handle.read(bytes, from, to - from, from)
        if (!bytesRead) break
        from += bytesRead
      }
      return from
    }
    const head = await fill(0, Math.min(size, SNIFF_BYTES))
    if (!looksLikeText(bytes.subarray(0, head))) return undefined
    return decodeText(bytes.subarray(0, await fill(head, size)))
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Runs `work` on every item, `limit` at a time, taking them in order; the first failure or an abort stops the rest. */
async function eachInPool<T>(items: readonly T[], limit: number, signal: AbortSignal, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed) {
      if (signal.aborted) throw signal.reason
      const index = next++
      if (index >= items.length) return
      try {
        await work(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The lines Grep prints for one file: each match with its context, groups apart marked by `--`. */
function contentLines(found: { lines: number[]; split: string[] }, before: number, after: number, numbers: boolean): ContentLines {
  const shown = new Set<number>()
  for (const line of found.lines) {
    for (let index = Math.max(0, line - before); index <= Math.min(found.split.length - 1, line + after); index++) shown.add(index)
  }
  const hits = new Set(found.lines)
  const out: ContentLines = { rows: [], seps: [] }
  let previous = -2
  for (const index of [...shown].sort((a, b) => a - b)) {
    if ((before || after) && previous >= 0 && index > previous + 1) {
      out.rows.push('--')
      out.seps.push('')
    }
    const separator = hits.has(index) ? ':' : '-'
    out.rows.push(`${numbers ? `${index + 1}${separator}` : ''}${clip(found.split[index])}`)
    out.seps.push(separator)
    previous = index
  }
  return out
}

/**
 * A content search's lines (ADR 0133). When some file has several, each file's name heads its lines, as ripgrep's
 * --heading prints them, rather than starting each; a file's lines past GREP_FILE_LINES are counted when there are
 * other files. Otherwise one line a file, `name:line:text`. `heads` says, for each line, which line holds its file's
 * name, so a page that starts inside a file can say whose lines they are.
 */
function contentOutput(matches: readonly FileMatches[], name: (match: FileMatches) => string): { out: string[]; heads: number[] } {
  const out: string[] = []
  const heads: number[] = []
  if (!matches.some((match) => match.block.rows.length > 1)) {
    for (const match of matches) {
      out.push(...match.block.rows.map((row, index) => (match.block.seps[index] ? `${name(match)}${match.block.seps[index]}${row}` : row)))
    }
    return { out, heads: out.map(() => -1) }
  }
  for (const match of matches) {
    if (out.length) {
      out.push('')
      heads.push(-1)
    }
    const head = out.length
    let { rows, seps } = match.block
    let more = 0
    if (matches.length > 1 && rows.length > GREP_FILE_LINES) {
      const cut = seps[GREP_FILE_LINES - 1] ? GREP_FILE_LINES : GREP_FILE_LINES - 1
      more = seps.slice(cut).filter((sep) => sep === ':').length
      rows = rows.slice(0, cut)
      seps = seps.slice(0, cut)
    }
    const lines = [name(match), ...rows, ...(more ? [`… (${plural(more, 'more matching line')} here; Grep this file alone for them)`] : [])]
    out.push(...lines)
    heads.push(...lines.map(() => head))
  }
  return { out, heads }
}

function matchLines(text: string, regex: RegExp, multiline: boolean): { lines: number[]; count: number; split: string[] } {
  const split = text.split(/\r?\n/)
  if (!multiline) {
    const lines: number[] = []
    let count = 0
    for (let index = 0; index < split.length; index++) {
      regex.lastIndex = 0
      const found = split[index].match(regex)
      if (found) {
        lines.push(index)
        count += found.length
      }
    }
    return { lines, count, split }
  }
  // Across lines: every line a match touches counts.
  const starts: number[] = [0]
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1)
  const lineAt = (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low
  }
  const touched = new Set<number>()
  let count = 0
  regex.lastIndex = 0
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    count++
    const first = lineAt(match.index)
    const last = lineAt(match.index + Math.max(0, match[0].length - 1))
    for (let line = first; line <= last; line++) touched.add(line)
    if (!match[0].length) regex.lastIndex++
  }
  return { lines: [...touched].sort((a, b) => a - b), count, split }
}

export const grepTool: Tool<GrepInput> = {
  brief:
    'Searches file contents with a JavaScript regular expression (close to ripgrep\'s; escape literal braces). Narrow with glob or type. output_mode: files_with_matches (default, newest first), content (matching lines; -n, -A/-B/-C, -i) or count. multiline lets "." match newlines. head_limit and offset page the output. Files .gitignore ignores are skipped.',
  definition: {
    name: 'Grep',
    description: [
      'Searches file contents with a regular expression.',
      '',
      '- Use Grep for every content search; do not run grep or rg through Bash.',
      '- Regular expressions follow JavaScript syntax, close to ripgrep\'s: "log.*Error", "function\\s+\\w+". Escape literal braces and parentheses.',
      '- Narrow the files with glob ("*.ts", "src/**/*.{ts,tsx}") or type ("js", "py", "rust", "go", "java"...).',
      '- output_mode: "files_with_matches" (the default) lists the files, newest first; "content" shows the matching lines; "count" counts matches per file.',
      '- With "content": -n adds line numbers (default true), -A/-B/-C add lines of context after, before, or around each match, and -i ignores case.',
      '- A pattern matches within one line unless multiline is true, where "." also matches newlines.',
      '- head_limit keeps the first N lines or entries; offset skips that many first. Files ignored by .gitignore are not searched.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, description: 'The regular expression to search for.' },
        path: { type: 'string', description: 'A file or directory to search. Default: the workspace root.' },
        glob: { type: 'string', description: 'Only search files whose path matches this glob.' },
        type: { type: 'string', description: 'Only search files of this type, such as js, ts, py, rust or go.' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'What to return. Default files_with_matches.' },
        '-i': { type: 'boolean', description: 'Ignore case.' },
        '-n': { type: 'boolean', description: 'Show line numbers (content mode). Default true.' },
        '-A': { type: 'integer', minimum: 0, description: 'Lines to show after each match (content mode).' },
        '-B': { type: 'integer', minimum: 0, description: 'Lines to show before each match (content mode).' },
        '-C': { type: 'integer', minimum: 0, description: 'Lines to show before and after each match (content mode).' },
        multiline: { type: 'boolean', description: 'Let a match span lines; "." matches newlines. Default false.' },
        head_limit: { type: 'integer', minimum: 1, description: 'Keep only the first N output lines or entries.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many output lines or entries first.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  kind: 'read',
  readOnly: true,
  check(input) {
    if (input.type && !FILE_TYPES[input.type.toLowerCase()]) return `type must be one of: ${Object.keys(FILE_TYPES).join(', ')}.`
    try {
      grepRegex(input.pattern, { ignoreCase: false, multiline: Boolean(input.multiline) })
    } catch (error) {
      return `pattern is not a valid regular expression: ${(error as Error).message}.`
    }
    return undefined
  },
  async access(input, ctx) {
    return { type: 'read', paths: [await realPathOf(searchRoot(input, ctx))] }
  },
  describe(input, ctx) {
    const target = searchRoot(input, ctx)
    return { title: `Search for ${input.pattern}${target === workdir(ctx) ? '' : ` in ${shownPath(target, ctx)}`}` }
  },
  async run(input, ctx) {
    const target = searchRoot(input, ctx)
    let stats
    try {
      stats = await fs.stat(target)
    } catch {
      return fail(`${shownPath(target, ctx)} does not exist.`)
    }
    const mode = input.output_mode ?? 'files_with_matches'
    const multiline = Boolean(input.multiline)
    const regex = grepRegex(input.pattern, { ignoreCase: Boolean(input['-i']), multiline })
    const insensitive = caseInsensitiveFs(ctx)
    const globs = input.glob ? [input.glob] : []
    const types = input.type ? FILE_TYPES[input.type.toLowerCase()] ?? [] : []
    const byGlob = globs.length ? globMatcher(globs, { caseInsensitive: insensitive, matchBase: true }) : undefined
    const byType = types.length ? globMatcher(types, { caseInsensitive: insensitive, matchBase: true }) : undefined

    let candidates: WalkEntry[]
    let truncatedWalk = false
    if (stats.isFile()) {
      candidates = [{ absolute: target, relative: path.basename(target), isDirectory: false, isSymlink: false }]
    } else {
      const kept = notWorktrees(ctx)
      const result = await walk({
        dir: target,
        ignoreRoot: workdir(ctx),
        caseInsensitive: insensitive,
        include: (entry) => kept(entry) && (entry.isDirectory || ((!byGlob || byGlob(entry.relative)) && (!byType || byType(entry.relative)))),
        limit: WALK_LIMIT,
        signal: ctx.signal,
        ...(ctx.offLimits ? { offLimits: ctx.offLimits } : {}),
      })
      candidates = result.files
      truncatedWalk = result.truncated
    }

    // Content comes out in path order, so the files are taken in that order and a search that finds too
    // much stops at a prefix; the other modes are put in order afterwards, newest first.
    const inContent = mode === 'content'
    const order = inContent ? [...candidates].sort((a, b) => (a.relative < b.relative ? -1 : 1)) : candidates
    const before = input['-B'] ?? input['-C'] ?? 0
    const after = input['-A'] ?? input['-C'] ?? 0
    const numbers = input['-n'] ?? true
    const found: (FileMatches | undefined)[] = new Array(order.length)
    let kept = 0
    let stoppedEarly = false
    await eachInPool(order, GREP_CONCURRENCY, ctx.signal, async (file, index) => {
      if (inContent && kept >= GREP_KEEP_LINES) {
        stoppedEarly = true
        return
      }
      const decoded = await readForSearch(file.absolute)
      if (!decoded) return
      const hit = matchLines(decoded.text, regex, multiline)
      if (!hit.count) return
      const block = inContent ? contentLines(hit, before, after, numbers) : { rows: [], seps: [] }
      kept += block.rows.length
      found[index] = { file, count: hit.count, block }
    })
    const matches = found.filter((match): match is FileMatches => match !== undefined)

    if (!matches.length) return { ok: true, content: truncatedWalk ? 'No matches in the files searched (the tree was too large to search completely; narrow path or glob).' : 'No matches found.' }

    const ordered = inContent
      ? matches
      : await (async () => {
          const files = await newestFirst(matches.map((match) => match.file), ctx.signal)
          const byFile = new Map(matches.map((match) => [match.file, match]))
          return files.map((file) => byFile.get(file)!)
        })()

    const name = (match: FileMatches) => shownPath(match.file.absolute, ctx)
    const { out, heads } =
      mode === 'content'
        ? contentOutput(ordered, name)
        : { out: mode === 'files_with_matches' ? ordered.map(name) : ordered.map((match) => `${name(match)}:${match.count}`), heads: [] }

    const offset = input.offset ?? 0
    const limit = input.head_limit ?? GREP_DEFAULT_LIMIT
    const page = out.slice(offset, offset + limit)
    const remaining = out.length - offset - page.length
    // A page that starts inside a file's lines says whose they are.
    const head = heads[offset] ?? -1
    if (head >= 0 && head !== offset) page.unshift(`${out[head]} (continued)`)
    else if (page[0] === '' && heads.length) page.shift()
    const total = inContent ? plural(ordered.reduce((sum, match) => sum + match.count, 0), 'match', 'matches') : plural(ordered.length, 'file')
    const tail = remaining > 0 ? `\n(${stoppedEarly ? 'at least ' : ''}${remaining} more ${inContent ? 'lines' : 'entries'}; raise offset or head_limit, or narrow the search.)` : ''
    const stopped = stoppedEarly ? `\n(The search stopped after ${plural(kept, 'line')} of matches; narrow the pattern, path or glob.)` : ''
    return {
      ok: true,
      content: (page.length ? page.join('\n') : '(offset is past the end of the results)') + tail + stopped + (truncatedWalk ? '\n(The tree was too large to search completely; narrow path or glob.)' : ''),
      display: { output: total },
    }
  },
}
