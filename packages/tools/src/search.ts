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
import { decodeText, plural } from './text'
import type { Tool, ToolContext, ToolOutcome } from './types'
import { walk, type WalkEntry } from './walk'

const GLOB_LIMIT = 100
const GREP_DEFAULT_LIMIT = 250
const GREP_MAX_FILE_BYTES = 20 * 1024 * 1024
const GREP_MAX_LINE = 500
const WALK_LIMIT = 200_000

function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

function caseInsensitiveFs(ctx: ToolContext): boolean {
  return ctx.platform === 'win32' || ctx.platform === 'darwin'
}

function searchRoot(input: { path?: unknown }, ctx: ToolContext): string {
  const raw = typeof input.path === 'string' ? input.path.trim() : ''
  return raw ? resolveInputPath(raw, ctx) : ctx.root
}

function shownPath(file: string, ctx: ToolContext): string {
  return displayPath(file, ctx)
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
    return { title: `Find ${input.pattern}${dir === ctx.root ? '' : ` in ${shownPath(dir, ctx)}`}` }
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
    const result = await walk({
      dir: start,
      ignoreRoot: ctx.root,
      caseInsensitive: caseInsensitiveFs(ctx),
      include: (entry) => entry.isDirectory || matcher.test(entry.relative),
      limit: WALK_LIMIT,
      signal: ctx.signal,
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
  /** 0-based line indexes that match. */
  lines: number[]
  count: number
  text: string[]
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
    return { title: `Search for ${input.pattern}${target === ctx.root ? '' : ` in ${shownPath(target, ctx)}`}` }
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
      const result = await walk({
        dir: target,
        ignoreRoot: ctx.root,
        caseInsensitive: insensitive,
        include: (entry) => entry.isDirectory || ((!byGlob || byGlob(entry.relative)) && (!byType || byType(entry.relative))),
        limit: WALK_LIMIT,
        signal: ctx.signal,
      })
      candidates = result.files
      truncatedWalk = result.truncated
    }

    const matches: FileMatches[] = []
    for (const file of candidates) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      let bytes: Buffer
      try {
        const size = (await fs.stat(file.absolute)).size
        if (size > GREP_MAX_FILE_BYTES) continue
        bytes = await fs.readFile(file.absolute)
      } catch {
        continue
      }
      const decoded = decodeText(bytes)
      if (!decoded) continue
      const found = matchLines(decoded.text, regex, multiline)
      if (found.count) matches.push({ file, lines: found.lines, count: found.count, text: found.split })
    }

    if (!matches.length) return { ok: true, content: truncatedWalk ? 'No matches in the files searched (the tree was too large to search completely; narrow path or glob).' : 'No matches found.' }

    const ordered = mode === 'content' ? matches.sort((a, b) => (a.file.relative < b.file.relative ? -1 : 1)) : await (async () => {
      const files = await newestFirst(matches.map((match) => match.file), ctx.signal)
      const byFile = new Map(matches.map((match) => [match.file, match]))
      return files.map((file) => byFile.get(file)!)
    })()

    const name = (match: FileMatches) => shownPath(match.file.absolute, ctx)
    let out: string[]
    if (mode === 'files_with_matches') {
      out = ordered.map(name)
    } else if (mode === 'count') {
      out = ordered.map((match) => `${name(match)}:${match.count}`)
    } else {
      const before = input['-B'] ?? input['-C'] ?? 0
      const after = input['-A'] ?? input['-C'] ?? 0
      const numbers = input['-n'] ?? true
      out = []
      for (const match of ordered) {
        const shownLines = new Set<number>()
        for (const line of match.lines) {
          for (let index = Math.max(0, line - before); index <= Math.min(match.text.length - 1, line + after); index++) shownLines.add(index)
        }
        const hits = new Set(match.lines)
        let previous = -2
        for (const index of [...shownLines].sort((a, b) => a - b)) {
          if ((before || after) && previous >= 0 && index > previous + 1) out.push('--')
          const separator = hits.has(index) ? ':' : '-'
          out.push(`${name(match)}${numbers ? `${separator}${index + 1}` : ''}${separator}${clip(match.text[index])}`)
          previous = index
        }
      }
    }

    const offset = input.offset ?? 0
    const limit = input.head_limit ?? GREP_DEFAULT_LIMIT
    const page = out.slice(offset, offset + limit)
    const remaining = out.length - offset - page.length
    const total = mode === 'content' ? plural(ordered.reduce((sum, match) => sum + match.count, 0), 'match', 'matches') : plural(ordered.length, 'file')
    const tail = remaining > 0 ? `\n(${remaining} more ${mode === 'content' ? 'lines' : 'entries'}; raise offset or head_limit, or narrow the search.)` : ''
    return {
      ok: true,
      content: (page.length ? page.join('\n') : '(offset is past the end of the results)') + tail + (truncatedWalk ? '\n(The tree was too large to search completely; narrow path or glob.)' : ''),
      display: { output: total },
    }
  },
}
