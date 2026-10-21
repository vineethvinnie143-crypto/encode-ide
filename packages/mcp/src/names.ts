import { createHash } from 'node:crypto'

/**
 * Names. A tool of an MCP server reaches the model as mcp__server__tool, and
 * permission rules are written the same way, so the pieces must not be able
 * to blur into each other: a server name has no double underscore, and a
 * tool name is made to fit what every model provider accepts (letters,
 * digits, _ and -, at most 64 characters) without ever landing on a name
 * another tool already has.
 */

export const MAX_TOOL_NAME = 64

/** Why a server cannot have this name, or null. */
export function serverNameProblem(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) return 'use 1 to 48 letters, digits, - or _, starting with a letter or digit'
  if (name.includes('__')) return 'a name cannot hold two underscores in a row, since mcp__server__tool uses them to tell its parts apart'
  return null
}

/** A tool's name as permission rules spell it: anything outside letters, digits, _ and - becomes _. */
export function ruleToolName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]/g, '_')
}

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 6)

/**
 * The name the model sees: mcp__server__tool. A name that is too long is cut
 * and ends in a hash of the original; a name another tool already holds (two
 * tools whose names differ only in characters that became _) gets the hash too.
 */
export function modelToolName(server: string, tool: string, taken: ReadonlySet<string>): string {
  const full = `mcp__${server}__${ruleToolName(tool)}`
  const tag = shortHash(`${server}\u0000${tool}`)
  let name = full.length > MAX_TOOL_NAME ? `${full.slice(0, MAX_TOOL_NAME - 7)}_${tag}` : full
  if (!taken.has(name)) return name
  name = `${full.slice(0, MAX_TOOL_NAME - 7)}_${tag}`
  for (let n = 2; taken.has(name); n++) name = `${full.slice(0, MAX_TOOL_NAME - 7 - String(n).length)}_${tag}${n}`.slice(0, MAX_TOOL_NAME)
  return name
}
