/**
 * A session in a terminal: the agent's events as lines. The reply streams as it is written; each tool call is one
 * line when it starts and one when it ends; notices, errors, the task list and a proposed plan get a few lines each.
 * Everything from the session goes through `plain` (text.ts) first. Writes go to one sink, so tests read the lines.
 */
import path from 'node:path'
import type { AgentEventBody, ApprovalRequest, AskRequest, ConversationEntry, DiffHunk, RequestUsage, TodoItem } from '@encode/core'
import { counted, firstLine, plain, type Style } from './text'

export interface RendererOptions {
  style: Style
  /** The folder the session works in: paths inside it are shown relative to it. */
  root: string
  write(text: string): void
  /** Leave out the reply's text (print mode writes the reply itself) and keep only what the agent does. */
  quietReply?: boolean
}

const BULLET = '•'
const ELBOW = '└'
/** The fields that say what a tool call is about, in the order they are looked for. */
const SUBJECTS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name'] as const
const DIFF_LINES = 40

/** "src/a.ts" for a path inside the folder, the path as given otherwise. */
export function shownPath(value: string, root: string): string {
  if (!path.isAbsolute(value)) return value
  const relative = path.relative(root, value)
  if (relative === '') return '.'
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : value
}

/** A tool call in a few words: its name and what it is about. */
export function describeTool(tool: NonNullable<ConversationEntry['tool']>, root: string): string {
  for (const field of SUBJECTS) {
    const value = tool.input[field]
    if (typeof value !== 'string' || !value.trim()) continue
    const shown = field.endsWith('path') ? shownPath(value, root) : value
    return `${tool.name} ${firstLine(shown, 100)}`
  }
  return tool.name
}

export function diffCounts(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) for (const line of hunk.lines) line.type === 'add' ? added++ : line.type === 'del' ? removed++ : undefined
  return { added, removed }
}

/** What a finished call came to, in one line. */
export function toolOutcome(tool: NonNullable<ConversationEntry['tool']>): { ok: boolean; text: string } {
  const output = plain(tool.output ?? '').trim()
  if (tool.state === 'rejected') return { ok: false, text: output ? `declined: ${firstLine(output, 100)}` : 'declined' }
  if (tool.ok === false || tool.state === 'error') return { ok: false, text: firstLine(output || 'failed', 140) }
  if (tool.diff?.length) {
    const { added, removed } = diffCounts(tool.diff)
    return { ok: true, text: `+${added} -${removed}` }
  }
  if (!output) return { ok: true, text: 'done' }
  const lines = output.split('\n').filter((line) => line.trim())
  // A command says how it went at the end (a test runner's summary); anything else says it at the start.
  const shown = tool.name === 'Bash' || tool.name === 'BashOutput' ? lines.at(-1)! : lines[0]!
  return { ok: true, text: `${firstLine(shown, 100)}${lines.length > 1 ? ` (${counted(lines.length, 'line')})` : ''}` }
}

/** "12.3k" for token counts. */
export function tokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count)
}

/** What a request used, in one line. */
export function usageLine(usage: RequestUsage | undefined, durationMs: number): string {
  const parts: string[] = []
  if (usage && usage.calls > 0) {
    parts.push(`${tokens(usage.inputTokens)} in${usage.cachedTokens ? ` (${tokens(usage.cachedTokens)} cached)` : ''}`, `${tokens(usage.outputTokens)} out`)
    if (usage.cost !== undefined) parts.push(`$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`)
  }
  parts.push(`${(durationMs / 1000).toFixed(1)} s`)
  return parts.join(' · ')
}

export function diffText(hunks: readonly DiffHunk[], style: Style, max = DIFF_LINES): string[] {
  const out: string[] = []
  let total = 0
  for (const hunk of hunks) total += hunk.lines.length
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (out.length >= max) {
        out.push(style.dim(`    ... ${counted(total - max, 'more line')}`))
        return out
      }
      const text = plain(line.text).replace(/\t/g, '  ')
      out.push(line.type === 'add' ? style.green(`    + ${text}`) : line.type === 'del' ? style.red(`    - ${text}`) : style.dim(`      ${text}`))
    }
  }
  return out
}

/** An approval as lines to read before answering. */
export function approvalLines(request: ApprovalRequest, style: Style): string[] {
  const lines = [style.bold(`${style.yellow('?')} ${plain(request.title)}`)]
  const detail = plain(request.detail).trim()
  if (detail) for (const line of detail.split('\n').slice(0, 12)) lines.push(`  ${line}`)
  if (request.reason) lines.push(style.dim(`  ${firstLine(request.reason, 200)}`))
  for (const warning of request.warnings ?? []) lines.push(style.yellow(`  ! ${firstLine(warning, 200)}`))
  if (request.review?.reason) lines.push(style.dim(`  Reviewer: ${firstLine(request.review.reason, 200)}`))
  if (request.preview?.length) lines.push(...diffText(request.preview, style))
  return lines
}

/** A question as lines, its options numbered from 1. */
export function askLines(request: AskRequest, style: Style): string[] {
  const lines = [style.bold(`${style.cyan('?')} ${plain(request.question).trim()}`)]
  request.options?.forEach((option, index) => lines.push(`  ${index + 1}. ${firstLine(option, 200)}`))
  return lines
}

const TODO_MARK: Record<TodoItem['status'], string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }

export class Renderer {
  /** The entry whose text is streaming, and whether the cursor is at the start of a line. */
  private streaming: string | null = null
  private atLineStart = true
  private readonly streamed = new Set<string>()
  private readonly toolsShown = new Map<string, 'started' | 'ended'>()
  private readonly entriesShown = new Set<string>()
  private lastRow: string | null = null
  private todos = ''
  private inWorktree = false
  /** What the latest request has used, from the person's own entry. */
  usage: RequestUsage | undefined

  constructor(private readonly o: RendererOptions) {}

  private out(text: string): void {
    if (!text) return
    this.o.write(text)
    this.atLineStart = text.endsWith('\n')
  }

  /** Starts a fresh line, ending any streamed text. */
  breakLine(): void {
    if (!this.atLineStart) this.out('\n')
    this.streaming = null
  }

  line(text = ''): void {
    this.breakLine()
    this.out(`${text}\n`)
  }

  event(event: AgentEventBody): void {
    switch (event.type) {
      case 'delta':
        if (this.o.quietReply) return
        if (this.streaming !== event.entryId) {
          this.breakLine()
          this.out('\n')
          this.streaming = event.entryId
          this.streamed.add(event.entryId)
          this.lastRow = null
        }
        this.out(plain(event.text))
        return
      case 'entry':
        this.entry(event.entry)
        return
      case 'todos':
        this.showTodos(event.todos)
        return
      case 'plan':
        if (!event.plan) return
        this.line()
        this.line(this.o.style.bold('Proposed plan'))
        for (const text of plain(event.plan.plan).trim().split('\n')) this.line(`  ${text}`)
        return
      case 'mode':
        this.line(this.o.style.dim(`  Mode: ${event.mode}`))
        return
      case 'worktree':
        // A request says where it works as it starts; only a move is worth a line.
        if (Boolean(event.worktree) === this.inWorktree) return
        this.inWorktree = Boolean(event.worktree)
        this.line(this.o.style.dim(event.worktree ? `  Working in the worktree ${plain(event.worktree.name)} (${plain(event.worktree.branch)})` : '  Working in the project folder again'))
        return
      case 'error':
        // An error with an entry is shown with the entry.
        if (!event.entryId) this.line(this.o.style.red(`x ${firstLine(event.message, 300)}`))
        return
      default:
        return
    }
  }

  private entry(entry: ConversationEntry): void {
    const style = this.o.style
    switch (entry.kind) {
      case 'user':
        if (entry.usage) this.usage = entry.usage
        return
      case 'assistant': {
        if (this.o.quietReply || entry.streaming || this.streamed.has(entry.id) || this.entriesShown.has(entry.id)) return
        const text = plain(entry.text ?? '').trim()
        if (!text) return
        this.entriesShown.add(entry.id)
        this.line()
        this.line(text)
        return
      }
      case 'tool': {
        const tool = entry.tool
        if (!tool || tool.name === 'TodoWrite') return
        const shown = this.toolsShown.get(entry.id)
        const finished = tool.state === 'done' || tool.state === 'error' || tool.state === 'rejected'
        if (!shown) {
          if (this.streaming) this.out('\n')
          this.line(`${style.dim(BULLET)} ${tool.by === 'encode' ? style.dim('check ') : ''}${plain(describeTool(tool, this.o.root))}`)
          this.toolsShown.set(entry.id, 'started')
          this.lastRow = entry.id
        }
        if (finished && this.toolsShown.get(entry.id) !== 'ended') {
          this.toolsShown.set(entry.id, 'ended')
          const outcome = toolOutcome(tool)
          // Another row came in between: say which call this ends.
          const which = this.lastRow === entry.id ? '' : `${plain(describeTool(tool, this.o.root))}: `
          this.line(`  ${style.dim(ELBOW)} ${outcome.ok ? style.dim(`${which}${outcome.text}`) : style.red(`${which}${outcome.text}`)}`)
          for (const warning of tool.warnings ?? []) this.line(style.yellow(`    ! ${firstLine(warning, 160)}`))
          this.lastRow = null
        }
        return
      }
      case 'notice': {
        if (this.entriesShown.has(entry.id) || entry.streaming) return
        this.entriesShown.add(entry.id)
        const text = plain(entry.text ?? '').trim()
        if (text) this.line(style.dim(`  ${text.split('\n').join('\n  ')}`))
        if (entry.suggestion?.state === 'open') {
          this.line(style.dim(`  For ${plain(entry.suggestion.file)}:`))
          for (const line of entry.suggestion.lines) this.line(`    ${firstLine(line, 200)}`)
        }
        return
      }
      case 'error': {
        if (this.entriesShown.has(entry.id)) return
        this.entriesShown.add(entry.id)
        this.line(style.red(`x ${plain(entry.text ?? 'Something went wrong.').trim()}`))
        if (entry.details) this.line(style.dim(`  ${firstLine(entry.details, 300)}`))
        return
      }
      default:
        return
    }
  }

  private showTodos(todos: TodoItem[]): void {
    const key = todos.map((todo) => `${todo.status}:${todo.text}`).join('\n')
    if (key === this.todos) return
    this.todos = key
    if (!todos.length) return
    const style = this.o.style
    this.line(style.dim('  Tasks'))
    for (const todo of todos) {
      const text = `  ${TODO_MARK[todo.status]} ${firstLine(todo.text, 120)}`
      this.line(todo.status === 'completed' ? style.dim(text) : todo.status === 'in_progress' ? style.bold(text) : text)
    }
  }
}
