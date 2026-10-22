/**
 * Tool names the model APIs accept.
 *
 * OpenAI-compatible servers, OpenRouter and Anthropic take a function name of 1 to 64
 * letters, digits, underscores and hyphens, and refuse the whole request for one name
 * outside that (`openrouter:shell`, a dotted name, a long one). eNCode's own tools already
 * fit, and MCP tools are named `mcp__server__tool`, but a name can come from a skill, a
 * plugin, a hook or a server whose tool list changed. So every adapter renames what does not
 * fit on the way out and maps what the model calls back on the way in; core and sessions
 * only ever see the real name.
 *
 * The wire name is a function of the real name alone: the readable part, then a hash of the
 * real name, so it is the same on every request (a prompt cache survives it) and two real
 * names cannot meet in one wire name.
 */
import type { ProviderAdapter, StreamInput, TransportEvent } from './contract'
import type { Message, ModelRequest, ToolDefinition } from './messages'

const ACCEPTED = /^[a-zA-Z0-9_-]{1,64}$/
const HASH_LENGTH = 8
const READABLE_LENGTH = 64 - HASH_LENGTH - 1

/** FNV-1a over the UTF-16 code units, as 8 hex digits. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(HASH_LENGTH, '0')
}

/** True when a model API takes the name as it is. */
export function isAcceptedToolName(name: string): boolean {
  return ACCEPTED.test(name)
}

/** The name to put on the wire for a real tool name: itself when it fits, else a readable form with a hash. */
export function acceptedToolName(name: string): string {
  if (isAcceptedToolName(name)) return name
  const readable = name
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, READABLE_LENGTH)
  return `${readable || 'tool'}_${hashOf(name)}`
}

/** Real names to wire names for one request, and back. */
export class ToolNames {
  private readonly toWire = new Map<string, string>()
  private readonly toReal = new Map<string, string>()

  constructor(reals: Iterable<string>) {
    const names = [...new Set(reals)]
    // Names that fit keep their own, so a renamed one can never take one of them.
    const taken = new Set(names.filter(isAcceptedToolName))
    for (const real of taken) this.toWire.set(real, real)
    for (const real of names) {
      if (taken.has(real)) continue
      const base = acceptedToolName(real)
      let wire = base
      // The hash makes a clash between two real names all but impossible; if one happens, the later name is told apart.
      for (let attempt = 2; taken.has(wire); attempt++) wire = `${base.slice(0, 64 - String(attempt).length - 1)}_${attempt}`
      taken.add(wire)
      this.toWire.set(real, wire)
      this.toReal.set(wire, real)
    }
  }

  /** True when some name had to change. */
  get renamed(): boolean {
    return this.toReal.size > 0
  }

  wire(real: string): string {
    return this.toWire.get(real) ?? real
  }

  /** The real name for what the model called; a name that was never renamed stays as it is. */
  real(wire: string): string {
    return this.toReal.get(wire) ?? wire
  }
}

function usedNames(request: ModelRequest): string[] {
  const names = request.tools.map((tool) => tool.name)
  for (const message of request.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) if (block.type === 'tool-use') names.push(block.name)
  }
  return names
}

/**
 * The request with every tool name the API accepts, and the table to read the reply with.
 * A request whose names all fit comes back as it is.
 */
export function acceptableToolNames(request: ModelRequest): { request: ModelRequest; names: ToolNames } {
  const names = new ToolNames(usedNames(request))
  if (!names.renamed) return { request, names }
  const tools: ToolDefinition[] = request.tools.map((tool) => (names.wire(tool.name) === tool.name ? tool : { ...tool, name: names.wire(tool.name) }))
  const messages: Message[] = request.messages.map((message) => {
    if (message.role !== 'assistant' || !message.content.some((block) => block.type === 'tool-use' && names.wire(block.name) !== block.name)) return message
    return { ...message, content: message.content.map((block) => (block.type === 'tool-use' && names.wire(block.name) !== block.name ? { ...block, name: names.wire(block.name) } : block)) }
  })
  return { request: { ...request, tools, messages }, names }
}

/** An adapter that renames tools for the API and renames the model's calls back. */
export function acceptingToolNames(adapter: ProviderAdapter): ProviderAdapter {
  return {
    type: adapter.type,
    stream(input: StreamInput): AsyncIterable<TransportEvent> {
      const { request, names } = acceptableToolNames(input.request)
      if (!names.renamed) return adapter.stream(input)
      const inner = adapter.stream({ ...input, request })
      return (async function* () {
        for await (const event of inner) yield event.type === 'tool-call' && event.name !== undefined ? { ...event, name: names.real(event.name) } : event
      })()
    },
  }
}
