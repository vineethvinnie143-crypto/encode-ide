import path from 'node:path'
import { parseBash, type BashCommand, type BashScript, type BashWord } from './bash-grammar'
import { compilePattern, normalizeForMatch, type CompiledPattern, type PatternBase } from './path-pattern'
import { parsePwsh } from './pwsh-grammar'

/**
 * Permission rules in Claude Code's syntax, from settings files:
 *
 *   Bash                     every shell command
 *   Bash(npm test)           exactly that command
 *   Bash(npm run test:*)     that command, alone or with more arguments
 *   Bash(git * main)         `*` stands for any text
 *   Read(./.env)             reading paths that match (path-pattern.ts)
 *   Edit(src/**)             creating, changing or deleting matching paths
 *   WebFetch(domain:x.com)   fetching from x.com or a subdomain of it
 *   WebSearch, Task(name), Skill(name), any other tool name
 *   mcp__server, mcp__server__tool, mcp__server__*
 *
 * Deny beats ask beats allow. A shell line is split into its commands
 * (the parts joined by ;, &&, ||, | and the commands inside $(...)): one
 * denied or asked command decides the line, and an allow needs a rule for
 * every command. Words known only when the line runs can satisfy a
 * prefix or `*` but never a literal word, and a line that writes a file by
 * redirection is never allowed by a Bash rule (the write is not the rule's
 * to grant). A line the grammar cannot read is never allowed by a rule;
 * for deny and ask it is scanned as text.
 */

export type RuleBehavior = 'allow' | 'ask' | 'deny'

/** Where a rule came from; shown when it decides. */
export type RuleSource = 'user' | 'project' | 'local' | 'cli' | 'session' | 'managed'

export interface PermissionRule {
  behavior: RuleBehavior
  /** The tool name, or `mcp__server` for every tool of a server. */
  tool: string
  /** The text between the parentheses, if any. */
  specifier?: string
  source: RuleSource
  /** The rule as written. */
  text: string
}

export type RuleParse = { ok: true; rule: PermissionRule } | { ok: false; reason: string }

const TOOL_NAME = /^[A-Za-z][\w-]*$/

/** Tools whose path rules are Edit or Read rules, as in Claude Code. */
const PATH_RULE_ALIASES: Record<string, 'Read' | 'Edit'> = {
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Grep: 'Read',
  Glob: 'Read',
  LS: 'Read',
}

export function parseRule(text: string, behavior: RuleBehavior, source: RuleSource): RuleParse {
  const trimmed = text.trim()
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: `${JSON.stringify(text)} contains control characters` }
  const match = /^([^()\s]+)(?:\((.*)\))?$/s.exec(trimmed)
  if (!match) return { ok: false, reason: `${JSON.stringify(text)} is not a rule: write Tool or Tool(specifier)` }
  const [, written, specifier] = match
  if (!TOOL_NAME.test(written)) return { ok: false, reason: `${JSON.stringify(written)} is not a tool name` }
  const tool = specifier !== undefined && Object.hasOwn(PATH_RULE_ALIASES, written) ? PATH_RULE_ALIASES[written] : written
  if (tool.startsWith('mcp__') && specifier !== undefined) {
    return { ok: false, reason: `MCP rules name the tool, as mcp__server__tool, without parentheses` }
  }
  if (specifier !== undefined && !specifier.trim()) return { ok: false, reason: `${JSON.stringify(text)} has empty parentheses` }
  return { ok: true, rule: { behavior, tool, specifier: specifier?.trim(), source, text: trimmed } }
}

/** What a rule is asked about: one tool call, described by what it would touch. */
export type RuleQuery =
  | { type: 'command'; line: string; cwd: string; dialect: 'bash' | 'pwsh' }
  | { type: 'read'; paths: string[] }
  | { type: 'write'; paths: string[] }
  | { type: 'web'; url: string }
  | { type: 'mcp'; server: string; tool: string }
  | { type: 'tool'; tool: string; specifier?: string }

export interface RuleVerdict {
  decision: RuleBehavior
  /** The rule that decided. */
  rule: PermissionRule
  /** Short, user-facing. */
  reason: string
}

const ORDER: readonly RuleBehavior[] = ['deny', 'ask', 'allow']

interface CompiledRule {
  rule: PermissionRule
  /** For Read and Edit rules. */
  pattern?: CompiledPattern
  /** For Bash rules: tests one command's canonical text. */
  command?: (canonical: string) => boolean
  /** For Bash rules: the literal words a line must contain for a deny or ask rule to apply to text it cannot read. */
  words?: string[]
}

/** Marks a word whose value is only known at run time inside a command's canonical text. */
const DYNAMIC = '\u0000'

export class RuleSet {
  private readonly compiled: CompiledRule[]
  /** Rules that could not be read, with the reason; shown in settings so a typo is not silently ignored. */
  readonly problems: string[] = []

  constructor(
    rules: readonly PermissionRule[],
    private readonly base: PatternBase,
  ) {
    this.compiled = []
    for (const rule of rules) {
      const compiled = this.compile(rule)
      if (compiled) this.compiled.push(compiled)
    }
  }

  /** Every rule, deny first. */
  get rules(): PermissionRule[] {
    return ORDER.flatMap((behavior) => this.compiled.filter((entry) => entry.rule.behavior === behavior).map((entry) => entry.rule))
  }

  private compile(rule: PermissionRule): CompiledRule | null {
    const { tool, specifier } = rule
    if ((tool === 'Read' || tool === 'Edit') && specifier !== undefined) {
      // Deny and ask rules match the name wherever it is; an allow stays inside the workspace.
      const pattern = compilePattern(specifier, this.base, { anywhere: rule.behavior !== 'allow' })
      if (!pattern) {
        this.problems.push(`${rule.text}: the path cannot be anchored`)
        return null
      }
      return { rule, pattern }
    }
    if (tool === 'Bash' && specifier !== undefined) {
      return { rule, command: commandMatcher(specifier), words: literalWords(specifier) }
    }
    return { rule }
  }

  /** The first rule that decides the query, deny before ask before allow; null when none applies. */
  evaluate(query: RuleQuery): RuleVerdict | null {
    for (const behavior of ORDER) {
      const candidates = this.compiled.filter((entry) => entry.rule.behavior === behavior)
      if (!candidates.length) continue
      const hit = this.match(query, candidates, behavior)
      if (hit) return { decision: behavior, rule: hit.rule, reason: `${describe(behavior)} by ${hit.rule.source} rule ${hit.rule.text}` }
    }
    return null
  }

  private match(query: RuleQuery, rules: CompiledRule[], behavior: RuleBehavior): CompiledRule | null {
    switch (query.type) {
      case 'read':
      case 'write':
        return this.matchPaths(query.type === 'read' ? 'Read' : 'Edit', query.paths, rules, behavior)
      case 'web': {
        const host = hostOf(query.url)
        return rules.find(({ rule }) => rule.tool === 'WebFetch' && (rule.specifier === undefined || (host !== null && domainMatches(rule.specifier, host)))) ?? null
      }
      case 'mcp':
        return rules.find(({ rule }) => mcpMatches(rule.tool, query.server, query.tool)) ?? null
      case 'tool':
        return rules.find(({ rule }) => rule.tool === query.tool && (rule.specifier === undefined || rule.specifier === query.specifier)) ?? null
      case 'command':
        return this.matchCommand(query, rules, behavior)
    }
  }

  /** Any path matching decides deny and ask; allow needs every path to match. */
  private matchPaths(tool: 'Read' | 'Edit', paths: string[], rules: CompiledRule[], behavior: RuleBehavior): CompiledRule | null {
    const relevant = rules.filter(({ rule }) => rule.tool === tool)
    if (!relevant.length || !paths.length) return null
    const normalized = paths.map((target) => normalizeForMatch(target, this.base.windows))
    const whole = relevant.find(({ pattern }) => !pattern)
    if (behavior !== 'allow') {
      if (whole) return whole
      for (const target of normalized) {
        const hit = relevant.find(({ pattern }) => pattern?.test(target))
        if (hit) return hit
      }
      return null
    }
    if (whole) return whole
    let first: CompiledRule | null = null
    for (const target of normalized) {
      const hit = relevant.find(({ pattern }) => pattern?.test(target))
      if (!hit) return null
      first ??= hit
    }
    return first
  }

  private matchCommand(
    query: Extract<RuleQuery, { type: 'command' }>,
    rules: CompiledRule[],
    behavior: RuleBehavior,
  ): CompiledRule | null {
    const relevant = rules.filter(({ rule }) => rule.tool === 'Bash')
    if (!relevant.length) return null
    const whole = relevant.find(({ command }) => !command)
    const split = splitCommands(query.line, query.dialect)
    if (behavior !== 'allow') {
      if (whole) return whole
      if (!split) {
        // Unreadable: a rule applies when its literal words all appear in the line, in order.
        const tokens = query.line.split(/[\s;&|()<>`$'"{}]+/).filter(Boolean)
        return relevant.find(({ words }) => words?.length && containsInOrder(tokens, words)) ?? null
      }
      for (const command of split.commands) {
        for (const view of denyViews(command, query.dialect)) {
          const hit = relevant.find((entry) => entry.command?.(canonical(view)))
          if (hit) return hit
        }
      }
      return null
    }
    if (!split || split.writes || !split.commands.length) return null
    if (whole) return whole
    let first: CompiledRule | null = null
    for (const command of split.commands) {
      const hit = relevant.find((entry) => entry.command?.(canonical(command)))
      if (!hit) return null
      first ??= hit
    }
    return first
  }
}

function describe(behavior: RuleBehavior): string {
  return behavior === 'deny' ? 'Denied' : behavior === 'ask' ? 'Asks' : 'Allowed'
}

function containsInOrder(tokens: string[], words: string[]): boolean {
  let index = 0
  for (const token of tokens) {
    if (token === words[index]) index++
    if (index === words.length) return true
  }
  return false
}

/** The literal words of a Bash rule before its first wildcard. */
function literalWords(specifier: string): string[] {
  const text = specifier.endsWith(':*') ? specifier.slice(0, -2) : specifier
  const literal = text.split('*')[0]
  const words = literal.trim().split(/\s+/).filter(Boolean)
  // A word cut by the wildcard (`git ch*`) is not a whole word.
  if (text.includes('*') && !/\s$/.test(literal) && words.length) words.pop()
  return words
}

/**
 * Tests a command's canonical text (its words joined by single spaces, with
 * DYNAMIC for each word known only at run time) against a Bash rule.
 */
function commandMatcher(specifier: string): (canonical: string) => boolean {
  const prefix = specifier.endsWith(':*')
  const text = (prefix ? specifier.slice(0, -2) : specifier).trim().replace(/\s+/g, ' ')
  // Literal parts never match DYNAMIC; `*` matches anything, run-time words included.
  const body = text
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[\\s\\S]*')
  const regex = new RegExp(prefix ? `^${body}(?: [\\s\\S]*)?$` : `^${body}$`)
  return (canonical) => regex.test(canonical)
}

interface SplitLine {
  /** Each command's words: values, or DYNAMIC for a word known only when the line runs. */
  commands: string[][]
  /** True when a command redirects output to a file. */
  writes: boolean
}

/** A command's text as rules see it: its words joined by single spaces. */
function canonical(words: string[]): string {
  return words.join(' ')
}

/** Splits a line into the commands it runs; null when the grammar cannot read it. */
export function splitCommands(line: string, dialect: 'bash' | 'pwsh'): SplitLine | null {
  if (dialect === 'pwsh') {
    const parsed = parsePwsh(line)
    if (!parsed.ok) return null
    const commands: string[][] = []
    let writes = false
    for (const statement of parsed.script.statements) {
      for (const pipeline of statement.pipelines) {
        for (const command of pipeline.commands) {
          commands.push([command.name.value, ...command.args.map((arg) => arg.value)])
          if (command.redirects.some((redirect) => redirect.target)) writes = true
        }
      }
    }
    return { commands, writes }
  }
  const parsed = parseBash(line)
  if (!parsed.ok) return null
  const commands: string[][] = []
  let writes = false
  const wordText = (word: BashWord) => {
    let value = ''
    for (const part of word.parts) {
      if (part.kind === 'literal') value += part.value
      else if (part.kind === 'tilde') value += '~'
      else return DYNAMIC
    }
    return value
  }
  const visitWord = (word: BashWord) => {
    for (const part of word.parts) if (part.kind === 'command' || part.kind === 'process') visitScript(part.script)
  }
  const visitCommand = (command: BashCommand) => {
    for (const redirect of command.redirects) {
      visitWord(redirect.target)
      const target = wordText(redirect.target)
      if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(redirect.operator) && target !== '/dev/null') writes = true
      if (redirect.operator === '>&' && !/^(\d+|-)$/.test(target)) writes = true
    }
    if (command.kind !== 'simple') {
      visitScript(command.body)
      return
    }
    for (const assignment of command.assignments) visitWord(assignment.value)
    for (const word of command.words) visitWord(word)
    const words = [
      ...command.assignments.map((assignment) => `${assignment.name}=${wordText(assignment.value)}`),
      ...command.words.map(wordText),
    ]
    if (words.length) commands.push(words)
  }
  const visitScript = (script: BashScript) => {
    for (const list of script.lists) for (const pipeline of list.pipelines) pipeline.commands.forEach(visitCommand)
  }
  visitScript(parsed.script)
  return { commands, writes }
}

/** Programs that run the command given in their arguments. */
const WRAPPERS = new Set(['env', 'nohup', 'nice', 'timeout', 'time', 'command', 'exec', 'sudo', 'doas', 'xargs', 'stdbuf', 'ionice', 'chrt', 'setsid', 'builtin'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd'])

/**
 * The commands a deny or ask rule should also see in `words`: the command
 * as written, the command its wrapper runs (`sudo rm`, `env X=1 rm`,
 * `timeout 5 rm`, `xargs rm`), and the commands of a `bash -c '...'`
 * script. Approximate on purpose: it only ever makes deny and ask rules
 * apply more often.
 */
function denyViews(words: string[], dialect: 'bash' | 'pwsh', depth = 0): string[][] {
  const views = [words]
  if (depth > 4) return views
  let index = 0
  while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index++
  if (index > 0 && index < words.length) views.push(...denyViews(words.slice(index), dialect, depth + 1))
  const head = (words[index] ?? '').toLowerCase().replace(/\.exe$/, '').replace(/^.*[\\/]/, '')
  if (WRAPPERS.has(head)) {
    let next = index + 1
    // Skip the wrapper's options, assignments and numbers (timeout 5, nice -n 10).
    while (next < words.length && /^(-|[A-Za-z_]\w*=|\d)/.test(words[next])) next++
    if (next < words.length) views.push(...denyViews(words.slice(next), dialect, depth + 1))
  }
  if (SHELLS.has(head)) {
    const flag = words.findIndex((word, position) => position > index && /^(-c|-command|\/c|-encodedcommand)$/i.test(word))
    const script = flag === -1 ? undefined : words[flag + 1]
    if (script && script !== DYNAMIC) {
      const inner = splitCommands(script, head === 'pwsh' || head === 'powershell' ? 'pwsh' : 'bash')
      if (inner) for (const command of inner.commands) views.push(...denyViews(command, dialect, depth + 1))
    }
  }
  // A head that is a path names the program at its end: /usr/bin/curl is curl.
  const bare = words[index]?.replace(/^.*[\\/]/, '')
  if (bare && bare !== words[index]) views.push([bare, ...words.slice(index + 1)])
  return views
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

/** `domain:example.com` covers example.com and its subdomains. */
function domainMatches(specifier: string, host: string): boolean {
  const match = /^domain:(.+)$/i.exec(specifier.trim())
  if (!match) return false
  const domain = match[1].trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}

/** `mcp__server` covers every tool of the server; `mcp__server__*` the same; `mcp__server__tool` one tool. */
function mcpMatches(ruleTool: string, server: string, tool: string): boolean {
  if (!ruleTool.startsWith('mcp__')) return false
  const rest = ruleTool.slice(5)
  if (rest === server || rest === `${server}__*`) return true
  return rest === `${server}__${tool}`
}

/**
 * Paths a line may touch, for Read and Edit deny and ask rules: every word
 * of every command that is not an option, resolved against the directory the
 * line starts in. A heuristic that only adds matches: a rule that protects
 * `.env` also stops `cat .env`, which the shell policy would otherwise allow.
 */
export function wordsAsPaths(line: string, dialect: 'bash' | 'pwsh', cwd: string, home: string, windows: boolean): string[] {
  const split = splitCommands(line, dialect)
  if (!split) return []
  const api = windows ? path.win32 : path.posix
  const out = new Set<string>()
  for (const words of split.commands) {
    for (const word of words.slice(1)) {
      if (!word || word.includes(DYNAMIC)) continue
      // An option's value (--file=.env) and a revision's path (HEAD:.env) are paths too.
      const candidates = word.startsWith('-')
        ? word.includes('=') ? [word.replace(/^[^=]*=/, '')] : []
        : [word, word.replace(/^[^=]*=/, ''), word.replace(/^[^:]*:(?![\\/])/, '')]
      for (const candidate of candidates) {
        if (!candidate) continue
        const expanded = candidate === '~' ? home : /^~[\\/]/.test(candidate) ? api.join(home, candidate.slice(2)) : candidate
        out.add(api.resolve(cwd, expanded))
      }
    }
  }
  return [...out]
}
