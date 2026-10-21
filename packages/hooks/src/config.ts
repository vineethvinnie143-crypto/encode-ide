/**
 * Hook configuration in Claude Code's format, from the `hooks` key of a
 * settings file:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 30 }] }
 *     ],
 *     "Stop": [{ "hooks": [{ "type": "command", "command": "npm test" }] }]
 *   }
 *
 * The matcher is a regular expression over the whole tool name (or, for
 * SessionStart and PreCompact, over the source or trigger); empty or `*`
 * matches everything. Entries that are not valid are skipped with a problem,
 * so one typo does not disable the other hooks.
 */

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'PreCompact',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/** Events whose matcher means something; for the others it is ignored. */
const MATCHED_EVENTS = new Set<HookEventName>(['PreToolUse', 'PostToolUse', 'SessionStart', 'PreCompact'])

export interface CommandHook {
  command: string
  /** Seconds. */
  timeout: number
}

export interface HookMatcher {
  /** As written; empty for "everything". */
  source: string
  test(value: string): boolean
}

export interface HookGroup {
  event: HookEventName
  matcher: HookMatcher
  hooks: CommandHook[]
  /** Where the group came from, for messages: the settings scope. */
  origin: string
}

export const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 600

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function compileMatcher(source: string): HookMatcher | string {
  const trimmed = source.trim()
  if (!trimmed || trimmed === '*') return { source: '', test: () => true }
  try {
    const regex = new RegExp(`^(?:${trimmed})$`)
    return { source: trimmed, test: (value) => regex.test(value) }
  } catch (error) {
    return `matcher ${JSON.stringify(source)} is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`
  }
}

/** Reads one settings file's `hooks` value. */
export function parseHooksConfig(raw: unknown, origin: string): { groups: HookGroup[]; problems: string[] } {
  const groups: HookGroup[] = []
  const problems: string[] = []
  if (raw === undefined) return { groups, problems }
  if (!isObject(raw)) return { groups, problems: ['hooks must be an object of event names'] }
  for (const [event, entries] of Object.entries(raw)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(`hooks.${event} is not an event eNCode runs hooks for (${HOOK_EVENTS.join(', ')})`)
      continue
    }
    const name = event as HookEventName
    if (!Array.isArray(entries)) {
      problems.push(`hooks.${event} must be a list`)
      continue
    }
    for (const [index, entry] of entries.entries()) {
      const where = `hooks.${event}[${index}]`
      if (!isObject(entry)) {
        problems.push(`${where} must be an object with a hooks list`)
        continue
      }
      let matcher: HookMatcher = { source: '', test: () => true }
      if (entry.matcher !== undefined) {
        if (typeof entry.matcher !== 'string') {
          problems.push(`${where}.matcher must be a string`)
          continue
        }
        if (MATCHED_EVENTS.has(name)) {
          const compiled = compileMatcher(entry.matcher)
          if (typeof compiled === 'string') {
            problems.push(`${where}: ${compiled}`)
            continue
          }
          matcher = compiled
        }
      }
      if (!Array.isArray(entry.hooks)) {
        problems.push(`${where}.hooks must be a list`)
        continue
      }
      const hooks: CommandHook[] = []
      for (const [position, hook] of entry.hooks.entries()) {
        const at = `${where}.hooks[${position}]`
        if (!isObject(hook) || hook.type !== 'command') {
          problems.push(`${at} must be {"type": "command", "command": "..."}; other hook types are not supported`)
          continue
        }
        if (typeof hook.command !== 'string' || !hook.command.trim()) {
          problems.push(`${at}.command must be a non-empty string`)
          continue
        }
        let timeout = DEFAULT_TIMEOUT_SECONDS
        if (hook.timeout !== undefined) {
          if (typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout) || hook.timeout <= 0) {
            problems.push(`${at}.timeout must be a positive number of seconds`)
            continue
          }
          timeout = Math.min(hook.timeout, MAX_TIMEOUT_SECONDS)
        }
        hooks.push({ command: hook.command, timeout })
      }
      if (hooks.length) groups.push({ event: name, matcher, hooks, origin })
    }
  }
  return { groups, problems }
}
