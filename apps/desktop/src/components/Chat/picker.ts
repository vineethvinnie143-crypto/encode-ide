/**
 * The message box's pickers: a slash command as the first word of the message, `@` for a file and `$` for a skill
 * where a word starts. Pure, so the rules are unit tested.
 */
import { matchPrepared, matchScore, normalize, prepare, type Prepared } from '../../palette/model'

export type PickerKind = 'slash' | 'file' | 'skill'

/** The word the caret is in, when it opens a picker. */
export interface Trigger {
  kind: PickerKind
  /** Where the word starts (at its `/`, `@` or `$`) and ends (before the next space), in the draft. */
  start: number
  end: number
  /** What is typed after the sign, up to the caret. */
  query: string
}

/** Skill names as the Skill tool and `$` know them. */
const SKILL_NAME = /^[\w.-]*$/

export function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null
  // A slash command is the message's first word, and only while the caret is in it.
  if (text.startsWith('/')) {
    const space = text.search(/\s/)
    const end = space === -1 ? text.length : space
    // A word with another slash in it is a path ("/etc/hosts"), not a command.
    if (caret >= 1 && caret <= end) return /^\/[\w-]*$/.test(text.slice(0, end)) ? { kind: 'slash', start: 0, end, query: text.slice(1, caret) } : null
  }
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const sign = text[start]
  if (sign !== '@' && sign !== '$') return null
  let end = caret
  while (end < text.length && !/\s/.test(text[end])) end++
  const query = text.slice(start + 1, caret)
  if (sign === '$') return SKILL_NAME.test(query) ? { kind: 'skill', start, end, query } : null
  // "@" then a quote is a path with spaces in it, written by the picker: it is not reopened.
  return query.startsWith('"') ? null : { kind: 'file', start, end, query }
}

/** The draft with the trigger's word replaced by `insert` and one space after it, and where the caret goes. */
export function replaceTrigger(text: string, trigger: Pick<Trigger, 'start' | 'end'>, insert: string): { text: string; caret: number } {
  const before = text.slice(0, trigger.start)
  const after = text.slice(trigger.end)
  const spaced = after.startsWith(' ') ? after : ` ${after}`
  return { text: `${before}${insert}${spaced}`, caret: before.length + insert.length + 1 }
}

/** How a file is named in a message: `@src/app.ts`, quoted when the path has a space. */
export function fileMention(path: string): string {
  return /\s/.test(path) ? `@"${path.replace(/"/g, '')}"` : `@${path}`
}

/** The command and what follows it, when the message is a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : null
}

export interface SlashCommand {
  name: string
  aliases?: readonly string[]
  /** What it takes after its name, as shown: "[request]". A command with none runs as soon as it is picked. */
  args?: string
  description: string
}

/** eNCode's slash commands, in the order the list shows them before anything is typed. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'plan', args: '[request]', description: 'Plan mode on or off; with a request, plan it first' },
  { name: 'goal', args: '[goal | clear]', description: "Set, see or clear the session's goal" },
  { name: 'compact', description: 'Compact older history to free context' },
  { name: 'model', description: 'Choose the model' },
  { name: 'policy', aliases: ['permissions'], description: 'Choose what eNCode may do without asking' },
  { name: 'status', description: 'Model, permissions, context and tokens of this session' },
  { name: 'diff', description: 'Open the Review tab' },
  { name: 'undo', description: 'Put back the files of the last request that changed some' },
  { name: 'rewind', description: 'Go back to an earlier message' },
  { name: 'init', description: 'Write project instructions (AGENTS.md) for this project' },
  { name: 'new', description: 'Start a new session in this project' },
  { name: 'fork', description: 'Copy this session into a new one' },
  { name: 'rename', args: '[name]', description: 'Rename this session' },
  { name: 'pin', description: 'Pin or unpin this session' },
  { name: 'archive', description: 'Archive this session' },
  { name: 'export', description: 'Export this session as a ZIP' },
  { name: 'mcp', description: 'MCP servers and their state' },
  { name: 'skills', description: 'Your skills, which $ calls in a message' },
  { name: 'settings', description: 'Open Settings' },
  { name: 'shortcuts', description: 'Keyboard shortcuts' },
  { name: 'feedback', args: '[text]', description: 'Send feedback about eNCode' },
  { name: 'stop', description: 'Stop the agent' },
]

export function findSlash(name: string): SlashCommand | undefined {
  const wanted = name.toLowerCase()
  return SLASH_COMMANDS.find((command) => command.name === wanted || command.aliases?.includes(wanted))
}

export interface SkillLike {
  name: string
  description: string
}

/** A row of a picker. */
export interface PickerOption {
  id: string
  kind: 'command' | 'skill' | 'file'
  /** The command or skill name, or the file's path. */
  name: string
  description?: string
  args?: string
}

const ranked = <T>(items: readonly T[], score: (item: T) => number, limit: number): T[] =>
  items
    .map((item, order) => ({ item, order, score: score(item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.item)

/** Slash commands, then the skills, for what follows the `/`. A name counts most, a description a little. */
export function slashOptions(query: string, skills: readonly SkillLike[]): PickerOption[] {
  const commands = ranked(
    SLASH_COMMANDS,
    (command) => (query ? Math.max(...[command.name, ...(command.aliases ?? [])].map((name) => matchScore(query, name)), matchScore(query, command.description) * 0.4) : 0),
    SLASH_COMMANDS.length,
  ).map((command): PickerOption => ({ id: `command:${command.name}`, kind: 'command', name: command.name, description: command.description, ...(command.args ? { args: command.args } : {}) }))
  return [...commands, ...skillOptions(query, skills, 20)]
}

/** Skills for what follows a `$`. */
export function skillOptions(query: string, skills: readonly SkillLike[], limit = 50): PickerOption[] {
  return ranked(skills, (skill) => (query ? Math.max(matchScore(query, skill.name), matchScore(query, skill.description) * 0.4) : 0), limit).map((skill) => ({
    id: `skill:${skill.name}`,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
  }))
}

/** A file list made ready for matching at every key. */
export interface FileIndex {
  paths: readonly string[]
  names: readonly Prepared[]
  full: readonly Prepared[]
}

export function indexFiles(paths: readonly string[]): FileIndex {
  return {
    paths,
    names: paths.map((path) => prepare(path.slice(path.lastIndexOf('/') + 1))),
    full: paths.map((path) => prepare(path)),
  }
}

/** Files for what follows an `@`: the file's name counts most, then its path. Before anything is typed, the files open in the editor come first. */
export function fileOptions(query: string, index: FileIndex, open: readonly string[] = [], limit = 50): PickerOption[] {
  const q = normalize(query)
  let paths: string[]
  if (!q) {
    const known = new Set(index.paths)
    const first = open.filter((path) => known.has(path))
    const shown = new Set(first)
    paths = [...first, ...index.paths.filter((path) => !shown.has(path))].slice(0, limit)
  } else {
    const order = index.paths.map((_, position) => position)
    paths = ranked(
      order,
      (position) => {
        const name = matchPrepared(q, index.names[position])
        const full = matchPrepared(q, index.full[position])
        return Math.max(name, full >= 0 ? full * 0.8 : -1)
      },
      limit,
    ).map((position) => index.paths[position])
  }
  return paths.map((path) => ({ id: `file:${path}`, kind: 'file', name: path }))
}
