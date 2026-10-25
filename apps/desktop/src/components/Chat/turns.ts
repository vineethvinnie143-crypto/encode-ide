/**
 * How a conversation is laid out as turns: your message, a work log of what
 * the agent did (folded once it is done), and its reply. A message you sent
 * while the agent worked starts a new part of the turn, with its own work log
 * and reply. Pure, so the rules are unit tested.
 */
import type { AgentStatus, ConversationEntry, RequestUsage } from '@shared/types'

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

/** A call eNCode made itself, not the agent. */
const isOwn = (entry: ConversationEntry) => entry.kind === 'tool' && entry.tool?.by === 'encode'

/** The parts of a turn's entries after your request: a message sent while the agent worked starts the next one. */
function partsOf(id: string, startedAt: number, body: readonly ConversationEntry[], active: boolean): TurnPart[] {
  const chunks: { steer: ConversationEntry | null; entries: ConversationEntry[] }[] = [{ steer: null, entries: [] }]
  for (const entry of body) {
    if (entry.kind === 'steer') chunks.push({ steer: entry, entries: [] })
    else chunks[chunks.length - 1].entries.push(entry)
  }
  return chunks.map(({ steer, entries }, index) => {
    // The reply follows the agent's last step. eNCode's own checks after it (ADR 0095) belong to the work, not the reply.
    let lastTool = -1
    entries.forEach((entry, position) => {
      if (entry.kind === 'tool' && !isOwn(entry)) lastTool = position
    })
    const after = entries.slice(lastTool + 1)
    const start = steer?.createdAt ?? startedAt
    // A part ended when the next message was taken: that is right after its last step.
    const end = chunks[index + 1]?.steer?.createdAt ?? entries[entries.length - 1]?.createdAt ?? start
    return {
      id: steer?.id ?? id,
      steer,
      log: [...entries.slice(0, lastTool + 1), ...after.filter(isOwn)],
      reply: after.filter((entry) => !isOwn(entry)),
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
    const replied = new Set(reply)
    return {
      id: group[0].id,
      user,
      log: body.filter((entry) => !replied.has(entry)),
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

/** The last turn with a search that a free key would have made work: the one that offers to add the key (ADR 0123). */
export function latestSearchOffer<T extends Pick<Turn, 'log'>>(turns: readonly T[]): T | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index].log.some((entry) => entry.tool?.offer === 'search-key')) return turns[index]
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

/**
 * The work log as the agent told it (ADR 0126): its words between steps, the notices among them, and each batch of steps
 * between two of those as one block, which the chat folds to a line.
 */
export type LogBlock =
  | { type: 'text'; entry: ConversationEntry }
  | { type: 'notice'; entry: ConversationEntry }
  | { type: 'batch'; entries: ConversationEntry[] }

export function logBlocks(log: readonly ConversationEntry[]): LogBlock[] {
  const blocks: LogBlock[] = []
  let steps: ConversationEntry[] = []
  const close = () => {
    if (steps.length) blocks.push({ type: 'batch', entries: steps })
    steps = []
  }
  for (const entry of log) {
    if (entry.kind === 'tool' && entry.tool) {
      steps.push(entry)
      continue
    }
    // A call with no words before it keeps its batch going.
    if (entry.kind === 'assistant' && !entry.text?.trim() && !entry.streaming) continue
    close()
    blocks.push({ type: entry.kind === 'assistant' ? 'text' : 'notice', entry })
  }
  close()
  return blocks
}

export const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file

/** "loop.ts", "loop.ts and ui.ts", or "3 files": the files some steps touched, by name while there are one or two. */
function filesOf(steps: readonly ConversationEntry[]): string {
  const files = [...new Set(steps.map((step) => (step.tool && toolPath(step.tool.input)) || step.id))]
  return files.length <= 2 ? files.map(baseName).join(' and ') : `${files.length} files`
}

const TASK_LIST = new Set(['TodoWrite', 'todo_write'])

/**
 * What a batch of steps did, in the order each kind began, naming one or two files: "Read loop.ts, ran 2 commands",
 * "Edited prompt.ts and ui.ts". The line a folded batch shows once it is done (ADR 0126).
 */
export function batchSummary(steps: readonly ConversationEntry[]): string {
  const kinds = new Map<StepKind, ConversationEntry[]>()
  for (const step of steps) {
    if (!step.tool) continue
    const kind = stepKind(step.tool.name)
    kinds.set(kind, [...(kinds.get(kind) ?? []), step])
  }
  const parts: string[] = []
  for (const [kind, list] of kinds) {
    const count = list.length
    switch (kind) {
      case 'read':
        parts.push(`read ${filesOf(list)}`)
        break
      case 'edit':
        parts.push(`edited ${filesOf(list)}`)
        break
      case 'search':
        parts.push(count === 1 ? 'searched the code' : `searched the code ${count} times`)
        break
      case 'shell': {
        const commands = list.filter((step) => isCommandTool(step.tool!.name)).length
        if (commands) parts.push(commands === 1 ? 'ran a command' : `ran ${commands} commands`)
        if (commands < count) parts.push(list.some((step) => step.tool!.name === 'KillShell') ? 'stopped a command' : 'read command output')
        break
      }
      case 'web':
        parts.push(count > 1 ? `used the web ${count} times` : /search/i.test(list[0].tool!.name) ? 'searched the web' : 'fetched a page')
        break
      case 'subagent':
        parts.push(count === 1 ? 'delegated a task' : `delegated ${count} tasks`)
        break
      case 'ask':
        parts.push(count === 1 ? 'asked you a question' : `asked you ${count} questions`)
        break
      case 'computer':
        parts.push(count === 1 ? 'used the computer' : `used the computer ${count} times`)
        break
      default: {
        const tasks = list.filter((step) => TASK_LIST.has(step.tool!.name)).length
        if (tasks) parts.push('updated the task list')
        if (tasks < count) parts.push(count - tasks === 1 ? 'used a tool' : `used ${count - tasks} tools`)
      }
    }
  }
  const text = parts.join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
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

/**
 * What the agent is doing while its turn runs, in the words of the line under its latest step (ADR 0116), and whether
 * the dice beside them rolls: it rests while the agent waits on the person. `writing` is true while the answer after
 * the last step streams in.
 */
export function workPhase(status: AgentStatus | undefined, log: readonly ConversationEntry[], writing = false): { words: string; rolling: boolean } {
  if (status === 'awaiting-approval') return { words: 'Waiting for your approval', rolling: false }
  if (status === 'awaiting-user') return { words: 'Waiting for your answer', rolling: false }
  if (status === 'running-tool') return log.some((entry) => entry.tool?.state === 'reviewing') ? { words: 'Reviewing', rolling: true } : { words: 'Working', rolling: true }
  return { words: writing ? 'Writing' : 'Thinking', rolling: true }
}

/** "0:18", "12:05", "1:03:09": a running clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${seconds}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

/** Added and removed lines across a turn's edits, and the files they touch: each file's net change (editedFiles). */
export function editTotals(entries: readonly ConversationEntry[]): { files: number; additions: number; deletions: number } {
  const keyed = netChanges(entries, (entry) => (entry.tool && toolPath(entry.tool.input)) || entry.id)
  let additions = 0
  let deletions = 0
  for (const file of keyed) {
    additions += file.additions
    deletions += file.deletions
  }
  return { files: keyed.length, additions, deletions }
}

export interface EditedFile {
  path: string
  additions: number
  deletions: number
}

/** The files a set of entries changed, in order of first change, with their added and removed lines. */
export function editedFiles(entries: readonly ConversationEntry[]): EditedFile[] {
  return netChanges(entries, (entry) => (entry.tool && toolPath(entry.tool.input)) ?? '')
}

/** A line of a file as edits leave it: its place in the file before the first edit, or NEW for a line an edit added. */
const NEW = -1

/**
 * Each file's change from before its first edit to after its last, from the edits' own hunks: a line added and then
 * removed again counts for nothing, and a line rewritten twice counts once. Hunks place their lines in the file as it
 * was before that edit (`oldStart` is the first old line, also for an empty side), so the edits are replayed on a list
 * of where each line came from. A file whose hunks do not fit what came before is summed edit by edit instead.
 */
function netChanges(entries: readonly ConversationEntry[], keyOf: (entry: ConversationEntry) => string): EditedFile[] {
  const files = new Map<string, { lines: number[]; nextOld: number; deletions: number; summed: EditedFile; fits: boolean }>()
  for (const entry of entries) {
    const diff = entry.tool?.diff
    if (!diff?.length) continue
    const path = keyOf(entry)
    if (!path) continue
    let file = files.get(path)
    if (!file) {
      file = { lines: [], nextOld: 0, deletions: 0, summed: { path, additions: 0, deletions: 0 }, fits: true }
      files.set(path, file)
    }
    for (const hunk of diff) {
      for (const line of hunk.lines) {
        if (line.type === 'add') file.summed.additions += 1
        else if (line.type === 'del') file.summed.deletions += 1
      }
    }
    if (file.fits) file.fits = replay(file, diff)
  }
  return [...files.values()].map((file) =>
    file.fits ? { path: file.summed.path, additions: file.lines.filter((line) => line === NEW).length, deletions: file.deletions } : file.summed,
  )
}

/** Applies one edit's hunks to the lines of a file, last hunk first so the earlier places still hold; false when they do not fit. */
function replay(file: { lines: number[]; nextOld: number; deletions: number }, diff: NonNullable<NonNullable<ConversationEntry['tool']>['diff']>): boolean {
  const hunks = [...diff].sort((a, b) => b.oldStart - a.oldStart)
  for (const hunk of hunks) {
    const at = hunk.oldStart - 1
    const taken = hunk.lines.filter((line) => line.type !== 'add').length
    if (at < 0 || taken !== hunk.oldLines) return false
    // Lines past what the edits have touched are the file's own, in order.
    while (file.lines.length < at + taken) file.lines.push(file.nextOld++)
    const before = file.lines.slice(at, at + taken)
    const after: number[] = []
    let next = 0
    for (const line of hunk.lines) {
      if (line.type === 'add') after.push(NEW)
      else if (line.type === 'ctx') after.push(before[next++]!)
      else if (before[next++]! !== NEW) file.deletions += 1
    }
    file.lines = file.lines.slice(0, at).concat(after, file.lines.slice(at + taken))
  }
  return true
}
