/**
 * How a conversation is laid out as turns: your message, a work log of what
 * the agent did (folded once it is done), and its reply. Pure, so the rules
 * are unit tested.
 */
import type { ConversationEntry } from '@shared/types'

export type StepKind = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'subagent' | 'ask' | 'other'

// The agent's tools follow Claude Code's names (Read, Bash, ...). The lower-case names are those of
// earlier builds, which sessions imported from them still carry.
const KINDS: Record<string, StepKind> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'subagent',
  AskUserQuestion: 'ask',
  read: 'read',
  read_file: 'read',
  glob: 'search',
  list_files: 'search',
  grep: 'search',
  search_files: 'search',
  write: 'edit',
  write_file: 'edit',
  edit: 'edit',
  replace_in_file: 'edit',
  pwsh: 'shell',
  run_command: 'shell',
  web_fetch: 'web',
  web_search: 'web',
  task: 'subagent',
  ask_user_question: 'ask',
  ask_followup_question: 'ask',
}

export function stepKind(toolName: string): StepKind {
  return KINDS[toolName] ?? 'other'
}

/** Tools that start a command, as opposed to reading the output of one or stopping one. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'pwsh', 'run_command'])
export const isCommandTool = (toolName: string): boolean => COMMAND_TOOLS.has(toolName)

/** Tools that start a subagent. */
export const isSubagentTool = (toolName: string): boolean => toolName === 'Task' || toolName === 'task'

/** The file a tool call works on: Claude Code's tools call it `file_path`, earlier builds' `path`. */
export function toolPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.path
  return value === undefined || value === null ? undefined : String(value)
}

export interface Turn {
  /** The id of the first entry: stable while the turn grows. */
  id: string
  /** Your message; null for entries that came before any (a notice at the start of a session). */
  user: ConversationEntry | null
  /** Everything up to and including the last tool call: commentary, steps and notices between them. */
  log: ConversationEntry[]
  /** What the agent wrote after its last tool call: the answer. */
  reply: ConversationEntry[]
  startedAt: number
  endedAt: number
  /** The turn the agent is working on right now. */
  active: boolean
}

/** Splits a conversation into turns at each of your messages. */
export function buildTurns(entries: readonly ConversationEntry[], running: boolean): Turn[] {
  const groups: ConversationEntry[][] = []
  for (const entry of entries) {
    if (entry.kind === 'user' || !groups.length) groups.push([entry])
    else groups[groups.length - 1].push(entry)
  }
  return groups.map((group, index) => {
    const user = group[0].kind === 'user' ? group[0] : null
    const body = user ? group.slice(1) : group
    let lastTool = -1
    body.forEach((entry, position) => {
      if (entry.kind === 'tool') lastTool = position
    })
    return {
      id: group[0].id,
      user,
      log: body.slice(0, lastTool + 1),
      reply: body.slice(lastTool + 1),
      startedAt: group[0].createdAt,
      endedAt: group[group.length - 1].createdAt,
      active: running && index === groups.length - 1,
    }
  })
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** "Read 4 files, ran 2 commands, edited 1 file": what a run of steps did, in the order it began. */
export function summarizeSteps(steps: readonly ConversationEntry[]): string {
  const counts = new Map<StepKind, number>()
  const edited = new Set<string>()
  for (const step of steps) {
    const tool = step.tool
    if (!tool) continue
    const kind = stepKind(tool.name)
    if (kind === 'edit') {
      const path = toolPath(tool.input) ?? step.id
      if (edited.has(path)) continue
      edited.add(path)
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const [kind, count] of counts) {
    switch (kind) {
      case 'read':
        parts.push(`read ${plural(count, 'file')}`)
        break
      case 'search':
        parts.push(`searched ${plural(count, 'time')}`)
        break
      case 'edit':
        parts.push(`edited ${plural(count, 'file')}`)
        break
      case 'shell':
        parts.push(`ran ${plural(count, 'command')}`)
        break
      case 'web':
        parts.push(`used the web ${plural(count, 'time')}`)
        break
      case 'subagent':
        parts.push(`delegated ${plural(count, 'task')}`)
        break
      case 'ask':
        parts.push(`asked ${plural(count, 'question')}`)
        break
      default:
        parts.push(`used ${plural(count, 'other tool')}`)
    }
  }
  const text = parts.join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

export type LogItem =
  | { type: 'text'; entry: ConversationEntry }
  | { type: 'notice'; entry: ConversationEntry }
  | { type: 'step'; entry: ConversationEntry }
  | { type: 'group'; kind: StepKind; entries: ConversationEntry[] }

/** Kinds whose neighbouring steps fold into one line ("Read 4 files"), because each is small. */
const GROUPED: readonly StepKind[] = ['read', 'search', 'web']

/** The work log's rows: commentary, steps, and runs of two or more reads, searches or web calls as one group. */
export function logItems(log: readonly ConversationEntry[]): LogItem[] {
  const items: LogItem[] = []
  for (const entry of log) {
    if (entry.kind === 'assistant') {
      if (entry.text?.trim() || entry.streaming) items.push({ type: 'text', entry })
      continue
    }
    if (entry.kind !== 'tool' || !entry.tool) {
      items.push({ type: 'notice', entry })
      continue
    }
    const kind = stepKind(entry.tool.name)
    const previous = items[items.length - 1]
    if (GROUPED.includes(kind)) {
      if (previous?.type === 'group' && previous.kind === kind) {
        previous.entries.push(entry)
        continue
      }
      if (previous?.type === 'step' && previous.entry.tool && stepKind(previous.entry.tool.name) === kind) {
        items[items.length - 1] = { type: 'group', kind, entries: [previous.entry, entry] }
        continue
      }
    }
    items.push({ type: 'step', entry })
  }
  return items
}

/** The tool calls of a turn, in order. */
export function stepsOf(turn: Pick<Turn, 'log'>): ConversationEntry[] {
  return turn.log.filter((entry) => entry.kind === 'tool' && entry.tool)
}

/** "45s", "2m 14s", "1h 3m". Under a second counts as 1s. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "0:18", "12:05", "1:03:09": a running clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${seconds}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

/** Added and removed lines across a turn's edits, and the files they touch. */
export function editTotals(entries: readonly ConversationEntry[]): { files: number; additions: number; deletions: number } {
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  for (const entry of entries) {
    const diff = entry.tool?.diff
    if (!diff?.length) continue
    files.add((entry.tool && toolPath(entry.tool.input)) ?? entry.id)
    for (const hunk of diff) {
      for (const line of hunk.lines) {
        if (line.type === 'add') additions += 1
        else if (line.type === 'del') deletions += 1
      }
    }
  }
  return { files: files.size, additions, deletions }
}

export interface EditedFile {
  path: string
  additions: number
  deletions: number
}

/** The files a set of entries changed, in order of first change, with their added and removed lines. */
export function editedFiles(entries: readonly ConversationEntry[]): EditedFile[] {
  const files = new Map<string, EditedFile>()
  for (const entry of entries) {
    const diff = entry.tool?.diff
    if (!diff?.length) continue
    const path = String(entry.tool?.input.path ?? '')
    if (!path) continue
    const current = files.get(path) ?? { path, additions: 0, deletions: 0 }
    for (const hunk of diff) {
      for (const line of hunk.lines) {
        if (line.type === 'add') current.additions += 1
        else if (line.type === 'del') current.deletions += 1
      }
    }
    files.set(path, current)
  }
  return [...files.values()]
}
