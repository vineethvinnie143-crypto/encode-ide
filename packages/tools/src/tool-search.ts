/**
 * ToolSearch: tools from outside eNCode (MCP servers) can be dozens, and a definition is paid for on every step
 * whether the model needs it or not. Once the definitions of such tools are long (registry.ts), the request lists
 * their names here, in this tool's description, and carries a definition only after the model asked for it.
 *
 * What a conversation has loaded is read from the conversation itself (`loadedTools`): a ToolSearch call loads what
 * its query finds, and a call to a deferred tool loads that tool. Nothing is kept beside the messages, so a session
 * that was closed and opened again, a rewind and a compaction leave the tool list in step with what the model has
 * seen.
 */
import type { Message } from '@encode/providers'
import type { ToolRegistry } from './registry'
import { TOOL_SEARCH } from './registry'
import type { Tool } from './types'

const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10
/** Definitions one search may bring in: a few tools with enormous schemas must not undo the saving. */
const MAX_LOADED_CHARS = 24_000
/** Names listed in the description; beyond this the model is told to search by words. */
const MAX_LISTED_CHARS = 6_000
const NOISE = new Set(['tool', 'tools', 'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'use', 'mcp'])

interface ToolSearchInput extends Record<string, unknown> {
  query: string
  max_results?: number
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** `mcp__github__create_issue` is the tool create_issue of the server github. Other names have no server. */
function split(name: string): { server?: string; short: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? { server: match[1], short: match[2] } : { short: name }
}

function limitOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(value))) : DEFAULT_RESULTS
}

function score(tool: Tool, query: readonly string[]): number {
  const { server, short } = split(tool.definition.name)
  const parts = new Set(words(short))
  const lower = short.toLowerCase()
  const home = new Set(server ? words(server) : [])
  const about = new Set(words(tool.definition.description.slice(0, 400)))
  let total = 0
  for (const word of query) {
    if (parts.has(word)) total += 4
    else if (word.length >= 4 && lower.includes(word)) total += 3
    if (home.has(word)) total += 2
    if (about.has(word)) total += 1
  }
  return total
}

/**
 * The deferred tools a query finds. `select:a,b` names tools exactly (with or without the `mcp__server__` prefix);
 * anything else is words, matched against names, servers and descriptions. Deterministic for a registry, so it can be
 * repeated over a conversation to learn what was loaded.
 */
export function searchDeferred(registry: ToolRegistry, query: string, limit: unknown = DEFAULT_RESULTS): Tool[] {
  const candidates = registry.deferred()
  const max = limitOf(limit)
  let found: Tool[]
  const select = /^\s*select:(.*)$/is.exec(query)
  if (select) {
    const wanted = select[1].split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
    found = []
    for (const name of wanted) {
      const exact = candidates.find((tool) => tool.definition.name.toLowerCase() === name)
      const shorts = candidates.filter((tool) => split(tool.definition.name).short.toLowerCase() === name)
      const hit = exact ?? (shorts.length === 1 ? shorts[0] : undefined)
      if (hit && !found.includes(hit)) found.push(hit)
    }
  } else {
    const terms = [...new Set(words(query).filter((word) => word.length > 1 && !NOISE.has(word)))]
    found = candidates
      .map((tool, index) => ({ tool, index, points: score(tool, terms) }))
      .filter((item) => item.points > 0)
      .sort((a, b) => b.points - a.points || a.index - b.index)
      .map((item) => item.tool)
  }
  const out: Tool[] = []
  let chars = 0
  for (const tool of found.slice(0, max)) {
    chars += JSON.stringify(tool.definition).length
    if (out.length && chars > MAX_LOADED_CHARS) break
    out.push(tool)
  }
  return out
}

/** The deferred tools this conversation has loaded: those its ToolSearch calls found and those it called. */
export function loadedTools(messages: readonly Message[], registry: ToolRegistry): Set<string> {
  const loaded = new Set<string>()
  if (!registry.deferred().length) return loaded
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-use') continue
      if (block.name === TOOL_SEARCH) {
        const input = block.input as { query?: unknown; max_results?: unknown }
        if (typeof input.query === 'string') for (const tool of searchDeferred(registry, input.query, input.max_results)) loaded.add(tool.definition.name)
      } else if (registry.isDeferred(block.name)) loaded.add(block.name)
    }
  }
  return loaded
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence
}

/** The names the description lists, grouped by server: `github: create_issue, list_issues`. */
function nameList(tools: readonly Tool[]): string {
  const groups = new Map<string, string[]>()
  for (const tool of tools) {
    const { server, short } = split(tool.definition.name)
    const key = server ?? ''
    groups.set(key, [...(groups.get(key) ?? []), short])
  }
  const lines = [...groups].map(([server, names]) => (server ? `${server}: ${names.join(', ')}` : names.join(', ')))
  const text = lines.join('\n')
  if (text.length <= MAX_LISTED_CHARS) return text
  let kept = 0
  let shown = 0
  for (const line of lines) {
    if (kept + line.length > MAX_LISTED_CHARS) break
    kept += line.length + 1
    shown++
  }
  return `${lines.slice(0, shown).join('\n')}\n… and the tools of ${lines.length - shown} more servers: search by words to find them.`
}

/** The tool that loads deferred tools. Register it only when `registry.deferred()` is not empty. */
export function createToolSearchTool(registry: ToolRegistry): Tool<ToolSearchInput> {
  return {
    definition: {
      name: TOOL_SEARCH,
      description: [
        'Loads tools that are not in your tool list yet. Their definitions are left out of every request to keep it short; only their names are below.',
        '',
        '- query: words about what you need ("github issue", "slack message"), or "select:name1,name2" to load exact tools. Load everything a task needs in one call.',
        '- The tools it finds are in your tool list from the next step on; call them as you call any tool. Read a tool\'s parameters before you call it.',
        '- max_results: how many tools to load (default 5, at most 10).',
        '',
        'Tools that can be loaded, by server:',
        nameList(registry.deferred()),
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 300, description: 'Words about the tool you need, or select:name1,name2.' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'How many tools to load. Default 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    kind: 'interaction',
    readOnly: true,
    access: () => ({ type: 'none' }),
    describe: (input) => ({ title: 'Find tools', detail: input.query }),
    async run(input) {
      const found = searchDeferred(registry, input.query, input.max_results)
      if (!found.length) {
        return {
          ok: false,
          content: `No tool matches "${input.query.slice(0, 100)}". Try other words, or select:name to load a tool by name. Tools that can be loaded:\n${nameList(registry.deferred())}`,
        }
      }
      const lines = found.map((tool) => `- ${tool.definition.name}: ${firstSentence(tool.definition.description)}`)
      return {
        ok: true,
        content: `Loaded ${found.length === 1 ? '1 tool' : `${found.length} tools`}. ${found.length === 1 ? 'It is' : 'They are'} in your tool list from the next step on, with ${found.length === 1 ? 'its' : 'their'} parameters; call ${found.length === 1 ? 'it' : 'them'} directly.\n${lines.join('\n')}`,
        display: { output: found.map((tool) => tool.definition.name).join(', ') },
      }
    },
  }
}

/** Registers ToolSearch when some tools are deferred, once every tool is in. Returns whether it did. */
export function addToolSearch(registry: ToolRegistry): boolean {
  if (registry.has(TOOL_SEARCH) || !registry.deferred().length) return false
  registry.register(createToolSearchTool(registry))
  return true
}
