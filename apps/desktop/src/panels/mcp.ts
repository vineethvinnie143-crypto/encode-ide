/**
 * What the MCP screen and the banner above the composer say, as data and pure functions so the wording and the rules
 * about what to offer are unit tested. The components in components/mcp draw it.
 */
import type { McpNewServer, McpReport, McpServerState, McpServerView } from '@shared/types'

export type McpTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** A server's state as a chip. */
export const STATE_CHIPS: Record<McpServerState, { label: string; tone: McpTone }> = {
  connected: { label: 'Connected', tone: 'success' },
  connecting: { label: 'Starting', tone: 'accent' },
  'needs-approval': { label: 'Needs approval', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  disabled: { label: 'Turned off', tone: 'neutral' },
  stopped: { label: 'Not running', tone: 'neutral' },
}

export const SCOPE_LABELS: Record<McpServerView['scope'], string> = {
  user: 'Yours',
  project: 'This project',
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** "3 tools, 1 resource": what a running server offers; empty while it offers nothing yet. */
export function offerLine(server: McpServerView): string {
  const parts: string[] = []
  if (server.tools.length) parts.push(plural(server.tools.length, 'tool'))
  if (server.resources) parts.push(plural(server.resources, 'resource'))
  if (server.prompts) parts.push(plural(server.prompts, 'prompt'))
  if (server.hasInstructions) parts.push('instructions for the agent')
  if (parts.length === 0 && server.state === 'connected') return 'It offers nothing yet'
  return parts.join(', ')
}

/** The line above the list: how many servers are in each state that matters. */
export function summaryLine(report: McpReport): string {
  if (report.servers.length === 0) return 'No servers set up'
  const count = (state: McpServerState) => report.servers.filter((server) => server.state === state).length
  const parts: string[] = []
  if (count('connected')) parts.push(`${count('connected')} running`)
  if (count('connecting')) parts.push(`${count('connecting')} starting`)
  if (count('needs-approval')) parts.push(`${count('needs-approval')} waiting for you`)
  if (count('failed')) parts.push(`${count('failed')} failed`)
  const quiet = count('disabled') + count('stopped')
  if (quiet) parts.push(`${quiet} not running`)
  return parts.join(', ')
}

export type McpCardAction =
  | { kind: 'approve'; label: string; primary: true; /** Why it cannot be pressed yet, or absent when it can. */ blocked?: string }
  | { kind: 'restart'; label: string }
  | { kind: 'turn-off'; label: string }
  | { kind: 'turn-on'; label: string }
  | { kind: 'forget'; label: string }

/**
 * What a server's card offers. Nothing is offered while the settings cannot be trusted (nothing runs). A project's
 * server that waits for approval can be approved once the folder is trusted; any server can be turned off, and a
 * project's can have its approval taken back.
 */
export function cardActions(server: McpServerView, report: Pick<McpReport, 'trusted' | 'broken'>): McpCardAction[] {
  if (report.broken) return []
  const actions: McpCardAction[] = []
  switch (server.state) {
    case 'needs-approval':
      actions.push({ kind: 'approve', label: 'Approve and start', primary: true, ...(report.trusted ? {} : { blocked: 'Trust this folder first (Settings, Permissions).' }) })
      actions.push({ kind: 'turn-off', label: 'Turn off' })
      break
    case 'disabled':
      actions.push({ kind: 'turn-on', label: 'Turn on' })
      break
    case 'connecting':
      actions.push({ kind: 'turn-off', label: 'Turn off' })
      break
    default:
      actions.push({ kind: 'restart', label: 'Restart' })
      actions.push({ kind: 'turn-off', label: 'Turn off' })
      if (server.scope === 'project') actions.push({ kind: 'forget', label: 'Take back approval' })
  }
  return actions
}

/** The project servers that wait for the person, which is what the banner is about. */
export function waitingServers(report: McpReport | null): McpServerView[] {
  if (!report || report.broken) return []
  return report.servers.filter((server) => server.scope === 'project' && server.state === 'needs-approval')
}

/** A line for the banner above the composer, or null when no server of the folder waits for the person. */
export function mcpBannerOf(report: McpReport | null): { text: string; action: string } | null {
  const waiting = waitingServers(report)
  if (waiting.length === 0) return null
  const names = waiting.map((server) => server.name)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  return {
    text: names.length === 1 ? `This folder asks to run an MCP server (${shown}). It starts only if you approve it.` : `This folder asks to run ${names.length} MCP servers (${shown}). They start only if you approve them.`,
    action: 'Review',
  }
}

/**
 * What a dismissal of the banner is remembered under: the folder and exactly what waits in it, so that a server that
 * changed, or a new one, brings the banner back.
 */
export function bannerKey(report: McpReport): string {
  const waiting = waitingServers(report)
    .map((server) => `${server.name}:${server.digest}`)
    .sort()
  return `${report.root}\n${waiting.join('\n')}`
}

/** The words for the approval card of a project's server: what approving lets it do. */
export function approvalWarning(server: McpServerView): string {
  const remote = /^https?:\/\//i.test(server.summary)
  return remote
    ? 'Approving lets eNCode connect to this address and use the tools it offers. Everything the agent sends to its tools goes to that server.'
    : 'Approving lets eNCode run this command on your computer, with your rights, whenever a chat in this folder is open.'
}

/** The environment variables the entry reads or sets, one sentence, or an empty string. */
export function environmentLine(server: McpServerView): string {
  const parts: string[] = []
  if (server.envNames.length) parts.push(`sets ${server.envNames.join(', ')}`)
  if (server.headerNames.length) parts.push(`sends the headers ${server.headerNames.join(', ')}`)
  if (server.variables.length) parts.push(`reads ${server.variables.join(', ')} from your environment`)
  return parts.length ? `It ${parts.join(', and ')}.` : ''
}

/** The Add server form as typed. */
export interface McpServerForm {
  kind: 'stdio' | 'http' | 'sse'
  commandLine: string
  env: string
  url: string
  headers: string
}

/**
 * A command line split into words the way the Add form shows them: at spaces, with "double" or 'single' quotes keeping
 * a word whole. Nothing is expanded; the words go into the file as they are. Returns the words or why they cannot be used.
 */
export function splitCommandLine(text: string): string[] | string {
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) return `A ${quote === '"' ? 'double' : 'single'} quote is not closed.`
  if (started) words.push(word)
  if (!words.length) return 'Write the program to start, e.g. npx -y @modelcontextprotocol/server-filesystem .'
  return words
}

/** `NAME=value` lines (variables) or `Name: value` lines (headers); blank lines are skipped. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> | string {
  const pairs: Record<string, string> = {}
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const at = line.indexOf(separator)
    const key = at > 0 ? line.slice(0, at).trim() : ''
    if (!key) return `Line ${index + 1} needs ${separator === '=' ? 'NAME=value' : 'Name: value'}.`
    if (Object.hasOwn(pairs, key)) return `${key} is there twice.`
    pairs[key] = line.slice(at + 1).trim()
  }
  return pairs
}

/** The form as the server entry eNCode writes, or why it cannot be one yet. The host checks it again. */
export function newServerOf(form: McpServerForm): McpNewServer | string {
  if (form.kind === 'stdio') {
    const words = splitCommandLine(form.commandLine)
    if (typeof words === 'string') return words
    const env = parsePairs(form.env, '=')
    if (typeof env === 'string') return `Environment: ${env}`
    return { type: 'stdio', command: words[0]!, args: words.slice(1), env }
  }
  const url = form.url.trim()
  if (!url) return 'Write the server’s address, e.g. https://mcp.example.com/mcp'
  const headers = parsePairs(form.headers, ':')
  if (typeof headers === 'string') return `Headers: ${headers}`
  return { type: form.kind, url, headers }
}

/** Names whose values are written out rather than read from ${NAME}: in a project's file, everyone who has it sees them. */
export function writtenValues(server: McpNewServer): string[] {
  const values = server.type === 'stdio' ? server.env : server.headers
  return Object.entries(values)
    .filter(([, value]) => value !== '' && !/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(value))
    .map(([key]) => key)
}
