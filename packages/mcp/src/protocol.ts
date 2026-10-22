/**
 * What servers send, reduced to what eNCode uses, with every limit applied
 * on the way in. A server is somebody else's program: its descriptions end
 * up in the model's context and its results in the conversation, so text is
 * stripped of control and invisible characters (the usual hiding place for
 * instructions the user cannot see), lengths are capped, and anything that
 * does not have the expected shape is dropped with a reason, not guessed at.
 */

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_VERSION = SUPPORTED_VERSIONS[0]

export interface ServerCapabilities {
  tools?: { listChanged: boolean }
  resources?: { subscribe: boolean; listChanged: boolean }
  prompts?: { listChanged: boolean }
  logging?: boolean
}

export interface ServerInfo {
  name: string
  title?: string
  version: string
  protocolVersion: string
  capabilities: ServerCapabilities
  /** Instructions the server asks to be shown to the model; untrusted text. */
  instructions?: string
}

export interface McpTool {
  /** As the server calls it. */
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  /** What the server claims about itself; shown to the user, never trusted. */
  hints: { readOnly?: boolean; destructive?: boolean }
}

export interface McpResource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export interface McpResourceTemplate {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface McpPromptArgument {
  name: string
  description?: string
  required: boolean
}

export interface McpPrompt {
  name: string
  title?: string
  description?: string
  arguments: McpPromptArgument[]
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string }
  | { type: 'audio'; mediaType: string; bytes: number }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; bytes?: number }
  | { type: 'link'; uri: string; name: string; description?: string }

export interface McpToolResult {
  content: McpContent[]
  isError: boolean
}

export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: McpContent
}

export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
}

// ---------------------------------------------------------------------------
// Limits

export const LIMITS = {
  name: 128,
  title: 200,
  description: 2048,
  instructions: 4096,
  schemaBytes: 64 * 1024,
  uri: 2048,
  textBlock: 1_000_000,
  blocks: 200,
  imageChars: 7 * 1024 * 1024,
  pages: 100,
  items: 5000,
} as const

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Control characters (other than tab, line feed and carriage return), the
 * zero-width and direction-changing characters, the Unicode tag block and
 * the interlinear annotation marks. Built from code points, not written out,
 * so the source itself holds no invisible characters.
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
]
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`, 'gu')

/** Text from a server made safe to show and to give a model; undefined when the value is not text. */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(HIDDEN, '').replace(/\r\n?/g, '\n').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optional(value: unknown, max: number): string | undefined {
  const text = cleanText(value, max)
  return text ? text : undefined
}

// ---------------------------------------------------------------------------
// Parsers: each returns the value, or a string saying why the item is unusable.

export function parseInitializeResult(raw: unknown): ServerInfo | string {
  if (!isObject(raw)) return 'The server answered the handshake with something that is not an object.'
  if (typeof raw.protocolVersion !== 'string' || !raw.protocolVersion) return 'The server did not say which protocol version it speaks.'
  const info = isObject(raw.serverInfo) ? raw.serverInfo : {}
  const caps = isObject(raw.capabilities) ? raw.capabilities : {}
  const tools = isObject(caps.tools) ? { listChanged: caps.tools.listChanged === true } : undefined
  const resources = isObject(caps.resources) ? { subscribe: caps.resources.subscribe === true, listChanged: caps.resources.listChanged === true } : undefined
  const prompts = isObject(caps.prompts) ? { listChanged: caps.prompts.listChanged === true } : undefined
  return {
    name: cleanText(info.name, LIMITS.title) || 'server',
    ...(optional(info.title, LIMITS.title) ? { title: optional(info.title, LIMITS.title) } : {}),
    version: cleanText(info.version, 64) || '',
    protocolVersion: raw.protocolVersion,
    capabilities: { ...(tools ? { tools } : {}), ...(resources ? { resources } : {}), ...(prompts ? { prompts } : {}), ...(isObject(caps.logging) ? { logging: true } : {}) },
    ...(optional(raw.instructions, LIMITS.instructions) ? { instructions: optional(raw.instructions, LIMITS.instructions) } : {}),
  }
}

export function parseTool(raw: unknown): McpTool | string {
  if (!isObject(raw)) return 'not an object'
  if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) return `"${String(raw.name).slice(0, 40)}" is not a usable tool name`
  const schema = raw.inputSchema
  if (!isObject(schema)) return `${raw.name} has no input schema`
  if (schema.type !== undefined && schema.type !== 'object') return `${raw.name}'s input schema does not describe an object`
  if (JSON.stringify(schema).length > LIMITS.schemaBytes) return `${raw.name}'s input schema is larger than ${LIMITS.schemaBytes / 1024} KB`
  const annotations = isObject(raw.annotations) ? raw.annotations : {}
  return {
    name: raw.name,
    ...(optional(raw.title, LIMITS.title) ? { title: optional(raw.title, LIMITS.title) } : {}),
    description: cleanText(raw.description, LIMITS.description) ?? '',
    inputSchema: { ...schema, type: 'object' },
    hints: {
      ...(typeof annotations.readOnlyHint === 'boolean' ? { readOnly: annotations.readOnlyHint } : {}),
      ...(typeof annotations.destructiveHint === 'boolean' ? { destructive: annotations.destructiveHint } : {}),
    },
  }
}

export function parseResource(raw: unknown): McpResource | string {
  if (!isObject(raw)) return 'not an object'
  const uri = cleanText(raw.uri, LIMITS.uri)
  if (!uri) return 'a resource without a URI'
  return {
    uri,
    name: cleanText(raw.name, LIMITS.title) || uri,
    ...(optional(raw.title, LIMITS.title) ? { title: optional(raw.title, LIMITS.title) } : {}),
    ...(optional(raw.description, LIMITS.description) ? { description: optional(raw.description, LIMITS.description) } : {}),
    ...(optional(raw.mimeType, 100) ? { mimeType: optional(raw.mimeType, 100) } : {}),
    ...(typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0 ? { size: raw.size } : {}),
  }
}

export function parseResourceTemplate(raw: unknown): McpResourceTemplate | string {
  if (!isObject(raw)) return 'not an object'
  const uriTemplate = cleanText(raw.uriTemplate, LIMITS.uri)
  if (!uriTemplate) return 'a resource template without a URI template'
  return {
    uriTemplate,
    name: cleanText(raw.name, LIMITS.title) || uriTemplate,
    ...(optional(raw.title, LIMITS.title) ? { title: optional(raw.title, LIMITS.title) } : {}),
    ...(optional(raw.description, LIMITS.description) ? { description: optional(raw.description, LIMITS.description) } : {}),
    ...(optional(raw.mimeType, 100) ? { mimeType: optional(raw.mimeType, 100) } : {}),
  }
}

export function parsePrompt(raw: unknown): McpPrompt | string {
  if (!isObject(raw)) return 'not an object'
  if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) return `"${String(raw.name).slice(0, 40)}" is not a usable prompt name`
  const args: McpPromptArgument[] = []
  if (Array.isArray(raw.arguments)) {
    for (const item of raw.arguments.slice(0, 50)) {
      if (!isObject(item) || typeof item.name !== 'string' || !TOOL_NAME.test(item.name)) continue
      args.push({
        name: item.name,
        ...(optional(item.description, LIMITS.description) ? { description: optional(item.description, LIMITS.description) } : {}),
        required: item.required === true,
      })
    }
  }
  return {
    name: raw.name,
    ...(optional(raw.title, LIMITS.title) ? { title: optional(raw.title, LIMITS.title) } : {}),
    ...(optional(raw.description, LIMITS.description) ? { description: optional(raw.description, LIMITS.description) } : {}),
    arguments: args,
  }
}

/** One content block of a tool result, resource or prompt message. */
export function parseContent(raw: unknown): McpContent {
  if (!isObject(raw)) return { type: 'text', text: '[the server sent a content block that is not an object]' }
  switch (raw.type) {
    case 'text': {
      const text = typeof raw.text === 'string' ? raw.text.replace(HIDDEN, '') : ''
      return { type: 'text', text: text.length > LIMITS.textBlock ? `${text.slice(0, LIMITS.textBlock)}\n[cut: the server sent more than ${LIMITS.textBlock} characters]` : text }
    }
    case 'image': {
      const mediaType = typeof raw.mimeType === 'string' ? raw.mimeType.toLowerCase() : ''
      const data = typeof raw.data === 'string' ? raw.data : ''
      if (!IMAGE_TYPES.has(mediaType)) return { type: 'text', text: `[an image of type ${cleanText(mediaType, 40) || 'unknown'} was left out]` }
      if (!data || data.length > LIMITS.imageChars || !BASE64.test(data)) return { type: 'text', text: '[an image was left out: it is empty, too large or not base64]' }
      return { type: 'image', mediaType: mediaType as ImageMediaType, data }
    }
    case 'audio':
      return { type: 'audio', mediaType: cleanText(raw.mimeType, 100) || 'audio', bytes: typeof raw.data === 'string' ? Math.floor((raw.data.length * 3) / 4) : 0 }
    case 'resource_link': {
      const uri = cleanText(raw.uri, LIMITS.uri)
      if (!uri) return { type: 'text', text: '[a resource link without a URI was left out]' }
      return { type: 'link', uri, name: cleanText(raw.name, LIMITS.title) || uri, ...(optional(raw.description, LIMITS.description) ? { description: optional(raw.description, LIMITS.description) } : {}) }
    }
    case 'resource': {
      const resource = isObject(raw.resource) ? raw.resource : {}
      const uri = cleanText(resource.uri, LIMITS.uri) || 'unknown'
      const mimeType = optional(resource.mimeType, 100)
      if (typeof resource.text === 'string') {
        const text = resource.text.replace(HIDDEN, '')
        return { type: 'resource', uri, ...(mimeType ? { mimeType } : {}), text: text.length > LIMITS.textBlock ? `${text.slice(0, LIMITS.textBlock)}\n[cut]` : text }
      }
      return { type: 'resource', uri, ...(mimeType ? { mimeType } : {}), ...(typeof resource.blob === 'string' ? { bytes: Math.floor((resource.blob.length * 3) / 4) } : {}) }
    }
    default:
      return { type: 'text', text: `[the server sent a content block of type ${cleanText(raw.type, 40) || 'unknown'}, which eNCode does not read]` }
  }
}

export function parseCallResult(raw: unknown): McpToolResult | string {
  if (!isObject(raw)) return 'The server answered the tool call with something that is not an object.'
  const blocks = Array.isArray(raw.content) ? raw.content : []
  const content: McpContent[] = blocks.slice(0, LIMITS.blocks).map(parseContent)
  if (blocks.length > LIMITS.blocks) content.push({ type: 'text', text: `[${blocks.length - LIMITS.blocks} more content blocks were left out]` })
  if (!content.some((block) => block.type === 'text') && raw.structuredContent !== undefined) {
    let text: string | undefined
    try {
      text = JSON.stringify(raw.structuredContent)
    } catch {
      text = undefined
    }
    if (text) content.push({ type: 'text', text: text.length > LIMITS.textBlock ? `${text.slice(0, LIMITS.textBlock)}\n[cut]` : text })
  }
  return { content, isError: raw.isError === true }
}

export function parseReadResult(raw: unknown): McpContent[] | string {
  if (!isObject(raw) || !Array.isArray(raw.contents)) return 'The server answered the read with something that is not a list of contents.'
  return raw.contents.slice(0, LIMITS.blocks).map((item) => {
    if (!isObject(item)) return parseContent(item)
    const uri = cleanText(item.uri, LIMITS.uri) || 'unknown'
    const mimeType = optional(item.mimeType, 100)
    if (typeof item.text === 'string') {
      const text = item.text.replace(HIDDEN, '')
      return { type: 'resource', uri, ...(mimeType ? { mimeType } : {}), text: text.length > LIMITS.textBlock ? `${text.slice(0, LIMITS.textBlock)}\n[cut]` : text } as McpContent
    }
    if (typeof item.blob === 'string') {
      if (mimeType && IMAGE_TYPES.has(mimeType.toLowerCase()) && item.blob.length <= LIMITS.imageChars && BASE64.test(item.blob)) {
        return parseContent({ type: 'image', mimeType, data: item.blob })
      }
      return { type: 'resource', uri, ...(mimeType ? { mimeType } : {}), bytes: Math.floor((item.blob.length * 3) / 4) }
    }
    return { type: 'resource', uri, ...(mimeType ? { mimeType } : {}) }
  })
}

export function parsePromptResult(raw: unknown): McpPromptResult | string {
  if (!isObject(raw) || !Array.isArray(raw.messages)) return 'The server answered the prompt request with something that is not a list of messages.'
  const messages: McpPromptMessage[] = []
  for (const item of raw.messages.slice(0, LIMITS.blocks)) {
    if (!isObject(item) || (item.role !== 'user' && item.role !== 'assistant')) continue
    messages.push({ role: item.role, content: parseContent(item.content) })
  }
  return { ...(optional(raw.description, LIMITS.description) ? { description: optional(raw.description, LIMITS.description) } : {}), messages }
}
