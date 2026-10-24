/**
 * How a conversation is laid out as turns: your message, a work log of what
 * the agent did (folded once it is done), and its reply. A message you sent
 * while the agent worked starts a new part of the turn, with its own work log
 * and reply. Pure, so the rules are unit tested.
 */
import type { ConversationEntry, RequestUsage } from '@shared/types'

export type StepKind = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'subagent' | 'ask' | 'computer' | 'other'

// The agent's tools follow Claude Code's names (Read, Bash, ...). The lower-case names are those of
// earlier builds, which sessions imported from them still carry.
const KINDS: Record<string, StepKind> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'subagent',
  AskUserQuestion: 'ask',
  Computer: 'computer',
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

/** The file a tool call works on: Claude Code's tools call it `file_path` (`notebook_path` for NotebookEdit), earlier builds' `path`. */
export function toolPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.notebook_path ?? input.path
  return value === undefined || value === null ? undefined : String(value)
}

/** A stretch of a turn: what the agent did and wrote after your request, or after a message you sent while it worked. */
export interface TurnPart {
  /** The id of the message that started it, the turn's for the first part: stable while the part grows. */
  id: string
  /** The message you sent while the agent worked that starts this part; null for the first part. */
  steer: ConversationEntry | null
  /** Everything up to and including the part's last tool call: commentary, steps and notices between them. */
  log: ConversationEntry[]
  /** What the agent wrote after that call. */
  reply: ConversationEntry[]
  startedAt: number
  endedAt: number
  /** The part the agent is working on right now. */
  active: boolean
}

export interface Turn {
  /** The id of the first entry: stable while the turn grows. */
  id: string
  /** Your message; null for entries that came before any (a notice at the start of a session). */
  user: ConversationEntry | null
  /** Everything before the answer: the steps of every part, and the messages you sent while the agent worked. */
  log: ConversationEntry[]
  /** What the agent wrote after its last tool call and your last message: the answer. */
  reply: ConversationEntry[]
  /** The turn as it is shown: split at each message you sent while the agent worked, so one part when there was none. */
  parts: TurnPart[]
  startedAt: number
  endedAt: number
  /** The turn the agent is working on right now. */
  active: boolean
}

/** The parts of a turn's entries after your request: a message sent while the agent worked starts the next one. */
function partsOf(id: string, startedAt: number, body: readonly ConversationEntry[], active: boolean): TurnPart[] {
  const chunks: { steer: ConversationEntry | null; entries: ConversationEntry[] }[] = [{ steer: null, entries: [] }]
  for (const entry of body) {
    if (entry.kind === 'steer') chunks.push({ steer: entry, entries: [] })
    else chunks[chunks.length - 1].entries.push(entry)
  }
  return chunks.map(({ steer, entries }, index) => {
    let lastTool = -1
    entries.forEach((entry, position) => {
      if (entry.kind === 'tool') lastTool = position
    })
    const start = steer?.createdAt ?? startedAt
    // A part ended when the next message was taken: that is right after its last step.
    const end = chunks[index + 1]?.steer?.createdAt ?? entries[entries.length - 1]?.createdAt ?? start
    return {
      id: steer?.id ?? id,
      steer,
      log: entries.slice(0, lastTool + 1),
      reply: entries.slice(lastTool + 1),
      startedAt: start,
      endedAt: end,
      active: active && index === chunks.length - 1,
    }
  })
}

/** Splits a conversation into turns at each of your requests, and each turn into parts at the messages sent while the agent worked. */
export function buildTurns(entries: readonly ConversationEntry[], running: boolean): Turn[] {
  const groups: ConversationEntry[][] = []
  for (const entry of entries) {
    if (entry.kind === 'user' || !groups.length) groups.push([entry])
    else groups[groups.length - 1].push(entry)
  }
  return groups.map((group, index) => {
    const user = group[0].kind === 'user' ? group[0] : null
    const body = user ? group.slice(1) : group
    const active = running && index === groups.length - 1
    const parts = partsOf(group[0].id, group[0].createdAt, body, active)
    const reply = parts[parts.length - 1].reply
    return {
      id: group[0].id,
      user,
      log: body.slice(0, body.length - reply.length),
      reply,
      parts,
      startedAt: group[0].createdAt,
      endedAt: group[group.length - 1].createdAt,
      active,
    }
  })
}

/** The latest request that edited files: its change card offers Undo, and /undo takes its changes back. */
export function latestEditTurn<T extends Pick<Turn, 'user' | 'log'>>(turns: readonly T[]): T | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn.user && turn.log.some((entry) => entry.tool?.diff?.length)) return turn
  }
  return null
}

/** The latest request of the conversation. */
export function latestRequest<T extends Pick<Turn, 'user'>>(turns: readonly T[]): T | null {
  for (let index = turns.length - 1; index >= 0; index--) if (turns[index].user) return turns[index]
  return null
}

const sameEntries = (a: readonly ConversationEntry[], b: readonly ConversationEntry[]) => a.length === b.length && a.every((entry, index) => entry === b[index])

/** `next` as the part it was before when nothing in it changed, or with the work log or the reply that did not. */
function reusePart(old: TurnPart | undefined, next: TurnPart): TurnPart {
  if (!old) return next
  const log = sameEntries(old.log, next.log) ? old.log : next.log
  const reply = sameEntries(old.reply, next.reply) ? old.reply : next.reply
  if (log === old.log && reply === old.reply && old.steer === next.steer && old.active === next.active && old.startedAt === next.startedAt && old.endedAt === next.endedAt) {
    return old
  }
  return { ...next, log, reply }
}

/**
 * `next` with every turn that did not change replaced by the object it was before, and, in a turn that did, the
 * parts, work logs and replies that did not. While an answer streams only its own part changes, and the page can
 * then skip all the others (and the finished steps of this one) by comparing the objects. Entries are compared by
 * identity: the stores replace an entry whenever it changes.
 */
export function reuseTurns(previous: readonly Turn[], next: Turn[]): Turn[] {
  if (!previous.length) return next
  const before = new Map(previous.map((turn) => [turn.id, turn]))
  return next.map((turn) => {
    const old = before.get(turn.id)
    if (!old) return turn
    const log = sameEntries(old.log, turn.log) ? old.log : turn.log
    const reply = sameEntries(old.reply, turn.reply) ? old.reply : turn.reply
    const oldParts = new Map(old.parts.map((part) => [part.id, part]))
    const reused = turn.parts.map((part) => reusePart(oldParts.get(part.id), part))
    const parts = reused.length === old.parts.length && reused.every((part, index) => part === old.parts[index]) ? old.parts : reused
    if (
      log === old.log &&
      reply === old.reply &&
      parts === old.parts &&
      old.user === turn.user &&
      old.active === turn.active &&
      old.startedAt === turn.startedAt &&
      old.endedAt === turn.endedAt
    ) {
      return old
    }
    return { ...turn, log, reply, parts }
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
      case 'computer':
        parts.push(`used the computer ${plural(count, 'time')}`)
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

/** "18k tokens · 72% cached · $0.031": what a request cost, for the head of its work log. */
export function formatUsage(usage: RequestUsage | undefined): string {
  if (!usage?.calls) return ''
  const tokens = usage.inputTokens + usage.outputTokens
  const shown = tokens < 1_000 ? String(tokens) : tokens < 1_000_000 ? `${Math.round(tokens / 100) / 10}k` : `${Math.round(tokens / 100_000) / 10}M`
  const parts = [`${shown} tokens`]
  const cached = usage.inputTokens > 0 ? Math.round((usage.cachedTokens / usage.inputTokens) * 100) : 0
  if (cached > 0) parts.push(`${cached}% cached`)
  if (usage.cost !== undefined) parts.push(usage.cost === 0 ? 'free' : usage.cost < 0.01 ? '<$0.01' : `$${usage.cost < 1 ? usage.cost.toFixed(3) : usage.cost.toFixed(2)}`)
  return parts.join(' · ')
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
    const path = (entry.tool && toolPath(entry.tool.input)) ?? ''
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
