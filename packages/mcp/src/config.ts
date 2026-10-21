import path from 'node:path'
import { digestOf, type ReadText } from '@encode/config'
import { headerProblem, parseServerUrl } from './http'
import { serverNameProblem } from './names'

/**
 * Which MCP servers there are. They are listed in three files, in Claude
 * Code's format ({ "mcpServers": { name: { command, args, env } or { type,
 * url, headers } } }):
 *
 *   ~/.encode/mcp.json     the user's own servers, trusted as the user is
 *   .mcp.json              the project's servers, as other tools write them
 *   .encode/mcp.json       the project's servers for eNCode
 *
 * The project's files come with the folder, so a server from them runs only
 * after the user approved that exact entry (see manager.ts). A project
 * server never replaces one the user set up under the same name.
 *
 * Entries are kept as written, with ${VAR} and ${VAR:-default} still in
 * them: approval is for the text, the digest covers the text, and the
 * variables are looked up only when the server starts. `variables` names
 * the ones an entry reads, for the approval card.
 */

export type McpScope = 'user' | 'project'

export type ServerSetup =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> }

export interface McpServerEntry {
  name: string
  scope: McpScope
  file: string
  /** As written: variables are not expanded. */
  setup: ServerSetup
  /** sha256 over the name and the setup; what the user approves. */
  digest: string
  /** Environment variables the entry reads, sorted. */
  variables: string[]
}

export interface ParsedMcpFile {
  servers: McpServerEntry[]
  problems: string[]
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_SERVERS = 100
const MAX_ARGS = 200
const MAX_ENTRIES = 100
const MAX_TEXT = 8192
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const KNOWN_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\u0000')
}

function variablesIn(text: string): string[] {
  return [...text.matchAll(VARIABLE)].map((match) => match[1])
}

function stringMap(value: unknown, what: string): Record<string, string> | string {
  if (value === undefined) return {}
  if (!isObject(value)) return `${what} must be an object of text values`
  const entries = Object.entries(value)
  if (entries.length > MAX_ENTRIES) return `${what} has more than ${MAX_ENTRIES} entries`
  const out: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return `${what} cannot have an entry called ${key}`
    if (!plainText(entry)) return `${what}.${key} must be text of at most ${MAX_TEXT} characters`
    out[key] = entry
  }
  return out
}

/** One server's entry as the file wrote it, or why it cannot be used. */
export function parseSetup(raw: unknown): { setup: ServerSetup; notes: string[] } | string {
  if (!isObject(raw)) return 'must be an object'
  const notes = Object.keys(raw)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `"${key.slice(0, 40)}" is not a setting eNCode uses and was ignored`)
  const declared = raw.type
  if (declared !== undefined && typeof declared !== 'string') return '"type" must be text'
  const type = declared === undefined ? (raw.url !== undefined ? 'http' : 'stdio') : declared === 'streamable-http' ? 'http' : declared
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') return `"type" must be stdio, http or sse, not ${JSON.stringify(String(declared).slice(0, 40))}`

  if (type === 'stdio') {
    if (raw.url !== undefined || raw.headers !== undefined) return 'a stdio server has "command", not "url" or "headers"'
    if (!plainText(raw.command, 4096) || !raw.command.trim() || /[\r\n]/.test(raw.command)) return '"command" must be the name of a program, on one line'
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > MAX_ARGS || !raw.args.every((arg) => plainText(arg)))) {
      return `"args" must be a list of at most ${MAX_ARGS} texts`
    }
    const env = stringMap(raw.env, '"env"')
    if (typeof env === 'string') return env
    for (const name of Object.keys(env)) if (!ENV_NAME.test(name)) return `"env" has ${JSON.stringify(name.slice(0, 40))}, which is not a variable name`
    return { setup: { type, command: raw.command, args: (raw.args as string[] | undefined) ?? [], env }, notes }
  }

  if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined) return `a ${type} server has "url" and "headers", not "command", "args" or "env"`
  if (!plainText(raw.url, 4096) || !raw.url.trim()) return '"url" must be an address'
  // An address with variables in it can only be checked once they are filled in.
  if (!variablesIn(raw.url).length) {
    const url = parseServerUrl(raw.url)
    if (typeof url === 'string') return `"url": ${url}`
  }
  const headers = stringMap(raw.headers, '"headers"')
  if (typeof headers === 'string') return headers
  const problem = headerProblem(headers)
  if (problem) return `"headers": ${problem}`
  return { setup: { type, url: raw.url, headers }, notes }
}

function variablesOf(setup: ServerSetup): string[] {
  const texts = setup.type === 'stdio' ? [setup.command, ...setup.args, ...Object.values(setup.env)] : [setup.url, ...Object.values(setup.headers)]
  return [...new Set(texts.flatMap(variablesIn))].sort()
}

/** Parses one file's text. A server that cannot be used is left out with a problem; the others stay. */
export function parseMcpFile(text: string, scope: McpScope, file: string): ParsedMcpFile {
  const problems: string[] = []
  const servers: McpServerEntry[] = []
  if (text.length > MAX_FILE_BYTES) return { servers, problems: [`${file}: the file is larger than 1 MB`] }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { servers, problems: [`${file}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isObject(raw) || !isObject(raw.mcpServers)) return { servers, problems: [`${file}: expected an object with "mcpServers"`] }
  const entries = Object.entries(raw.mcpServers)
  if (entries.length > MAX_SERVERS) problems.push(`${file}: more than ${MAX_SERVERS} servers; the rest are ignored`)
  for (const [name, value] of entries.slice(0, MAX_SERVERS)) {
    const shown = JSON.stringify(name.slice(0, 48))
    const nameProblem = FORBIDDEN_KEYS.has(name) ? 'not a usable name' : serverNameProblem(name)
    if (nameProblem) {
      problems.push(`${file}: the server ${shown} was left out: ${nameProblem}`)
      continue
    }
    const parsed = parseSetup(value)
    if (typeof parsed === 'string') {
      problems.push(`${file}: the server ${shown} was left out: ${parsed}`)
      continue
    }
    for (const note of parsed.notes) problems.push(`${file}: ${shown}: ${note}`)
    servers.push({ name, scope, file, setup: parsed.setup, digest: digestOf({ name, setup: parsed.setup }), variables: variablesOf(parsed.setup) })
  }
  return { servers, problems }
}

/**
 * Fills in ${VAR} and ${VAR:-default}, the way a shell does: a variable that
 * is set (even to nothing) is used as it is, and the default stands in for
 * one that is unset or empty. A variable that is not set and has no default
 * is a problem, so a missing token is reported instead of sent as nothing.
 * Windows compares variable names without case.
 */
export function expandSetup(setup: ServerSetup, env: Record<string, string | undefined>, windows = process.platform === 'win32'): ServerSetup | string {
  const missing = new Set<string>()
  const lookup = (name: string): string | undefined => {
    if (Object.hasOwn(env, name)) return env[name]
    if (!windows) return undefined
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : env[key]
  }
  const expand = (text: string) =>
    text.replace(VARIABLE, (_all, name: string, fallback: string | undefined) => {
      const value = lookup(name)
      if (fallback !== undefined) return value !== undefined && value !== '' ? value : fallback
      if (value !== undefined) return value
      missing.add(name)
      return ''
    })
  const mapValues = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, expand(value)]))
  const result: ServerSetup =
    setup.type === 'stdio'
      ? { type: 'stdio', command: expand(setup.command), args: setup.args.map(expand), env: mapValues(setup.env) }
      : { type: setup.type, url: expand(setup.url), headers: mapValues(setup.headers) }
  if (missing.size) {
    const names = [...missing].sort().join(', ')
    return `the environment variable${missing.size > 1 ? 's' : ''} ${names} ${missing.size > 1 ? 'are' : 'is'} not set (write \${NAME:-default} to give ${missing.size > 1 ? 'them' : 'it'} a default)`
  }
  if (result.type === 'stdio') {
    if (!result.command.trim() || /[\r\n\u0000]/.test(result.command)) return 'the command is empty or not on one line once its variables are filled in'
    const bad = [...result.args, ...Object.values(result.env)].some((text) => text.includes('\u0000'))
    if (bad) return 'an argument or a variable holds a NUL character once its variables are filled in'
  } else {
    const url = parseServerUrl(result.url)
    if (typeof url === 'string') return `the address: ${url}`
    const problem = headerProblem(result.headers)
    if (problem) return `the headers: ${problem}`
  }
  return result
}

export interface LoadedMcpConfig {
  servers: McpServerEntry[]
  problems: string[]
}

export function mcpConfigFiles(home: string, root: string, api: typeof path.posix = path): Array<{ scope: McpScope; file: string }> {
  return [
    { scope: 'user', file: api.join(home, '.encode', 'mcp.json') },
    { scope: 'project', file: api.join(root, '.mcp.json') },
    { scope: 'project', file: api.join(root, '.encode', 'mcp.json') },
  ]
}

/**
 * Reads the three files. The user's servers come first and cannot be
 * shadowed; `.encode/mcp.json` overrides `.mcp.json` for a name both use.
 */
export async function loadMcpConfig(options: { home: string; root: string; read: ReadText; platform?: NodeJS.Platform }): Promise<LoadedMcpConfig> {
  const api = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const problems: string[] = []
  const byName = new Map<string, McpServerEntry>()
  for (const { scope, file } of mcpConfigFiles(options.home, options.root, api)) {
    let text: string | null
    try {
      text = await options.read(file)
    } catch (error) {
      problems.push(`${file}: could not be read: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (text === null) continue
    const parsed = parseMcpFile(text, scope, file)
    problems.push(...parsed.problems)
    for (const entry of parsed.servers) {
      const existing = byName.get(entry.name)
      if (existing?.scope === 'user' && entry.scope === 'project') {
        problems.push(`${file}: the project's server "${entry.name}" was ignored, because you already set up a server with that name in ${existing.file}`)
        continue
      }
      byName.set(entry.name, entry)
    }
  }
  return { servers: [...byName.values()], problems }
}
