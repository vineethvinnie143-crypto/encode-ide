import { isVirtualModelId, VIRTUAL_MODEL_IDS, type VirtualModelId } from '@encode/gateway-protocol'
import type { RequestLimits } from './config'
import { GatewayError } from './errors'

/**
 * The cost firewall. A client request is rebuilt field by field from an
 * allowlist; nothing it sends is forwarded by reference. The client cannot
 * name a model, add fallback models, choose providers, enable plugins or web
 * search, or attach files, so every request the gateway makes is one OpenRouter
 * serves for free. `assertFreeOnly` checks the final upstream body once more,
 * right before it is sent.
 */

export type TextPart = { type: 'text'; text: string }
export type ImagePart = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
export type Content = string | Array<TextPart | ImagePart>

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type Message =
  | { role: 'system'; content: string | TextPart[]; name?: string }
  | { role: 'user'; content: Content; name?: string }
  | { role: 'assistant'; content: string | TextPart[] | null; tool_calls?: ToolCall[]; reasoning?: string; name?: string }
  | { role: 'tool'; tool_call_id: string; content: string | TextPart[] }

export interface Tool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
}

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; description?: string; schema?: Record<string, unknown>; strict?: boolean } }

export interface Reasoning {
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  max_tokens?: number
  exclude?: boolean
  enabled?: boolean
}

/** What the proxy forwards; it adds model, models, stream, stream_options and user itself. */
export interface UpstreamFields {
  messages: Message[]
  max_tokens: number
  tools?: Tool[]
  tool_choice?: ToolChoice
  parallel_tool_calls?: boolean
  temperature?: number
  top_p?: number
  stop?: string | string[]
  seed?: number
  response_format?: ResponseFormat
  reasoning?: Reasoning
}

export interface SanitizedChat {
  virtualModel: VirtualModelId
  stream: boolean
  fields: UpstreamFields
  needsTools: boolean
  needsImages: boolean
}

/** Keys an upstream body may carry. Anything else means a bug let a client field through. */
const UPSTREAM_KEYS = new Set([
  'model',
  'models',
  'messages',
  'max_tokens',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'response_format',
  'reasoning',
  'stream',
  'stream_options',
  'user',
])

/** `vendor/model:free` with nothing else after the name: no `:online`, `:nitro` or other variant, and no router ids. */
const FREE_MODEL_ID = /^(?!openrouter\/)[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}:free$/

export function isFreeModelId(id: unknown): id is string {
  return typeof id === 'string' && FREE_MODEL_ID.test(id)
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const MESSAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_PARTS = 512
const MAX_STOP = 4

function fail(path: string, problem: string): never {
  throw new GatewayError('invalid_request', `${path} ${problem}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length > max) fail(path, `must be at most ${max} characters`)
  return value
}

function textParts(raw: unknown, path: string): string | TextPart[] {
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) fail(path, 'must be a string or an array of text parts')
  if (raw.length > MAX_PARTS) fail(path, `must have at most ${MAX_PARTS} parts`)
  return raw.map((part, index) => {
    const at = `${path}[${index}]`
    if (!isRecord(part) || part.type !== 'text') fail(at, 'must be a text part')
    if (typeof part.text !== 'string') fail(`${at}.text`, 'must be a string')
    return { type: 'text', text: part.text }
  })
}

function imageUrl(raw: unknown, path: string): ImagePart['image_url'] {
  const value = typeof raw === 'string' ? { url: raw } : raw
  if (!isRecord(value) || typeof value.url !== 'string') fail(path, 'must have a url')
  const url = value.url
  if (url.startsWith('data:')) {
    if (!DATA_IMAGE.test(url)) fail(`${path}.url`, 'must be a base64 PNG, JPEG, GIF or WebP data URL')
  } else {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail(`${path}.url`, 'is not a URL')
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(`${path}.url`, 'must be an https URL without credentials')
  }
  const detail = value.detail
  if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') fail(`${path}.detail`, 'must be auto, low or high')
  return detail === undefined ? { url } : { url, detail }
}

function userContent(raw: unknown, path: string): Content {
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) fail(path, 'must be a string or an array of content parts')
  if (raw.length > MAX_PARTS) fail(path, `must have at most ${MAX_PARTS} parts`)
  return raw.map((part, index): TextPart | ImagePart => {
    const at = `${path}[${index}]`
    if (!isRecord(part)) fail(at, 'must be an object')
    if (part.type === 'text') {
      if (typeof part.text !== 'string') fail(`${at}.text`, 'must be a string')
      return { type: 'text', text: part.text }
    }
    if (part.type === 'image_url') return { type: 'image_url', image_url: imageUrl(part.image_url, `${at}.image_url`) }
    fail(`${at}.type`, 'must be text or image_url')
  })
}

function toolCalls(raw: unknown, path: string): ToolCall[] {
  if (!Array.isArray(raw)) fail(path, 'must be an array')
  return raw.map((call, index) => {
    const at = `${path}[${index}]`
    if (!isRecord(call)) fail(at, 'must be an object')
    if (call.type !== undefined && call.type !== 'function') fail(`${at}.type`, 'must be function')
    const id = optionalString(call.id, `${at}.id`, 256)
    if (!id) fail(`${at}.id`, 'is required')
    const fn = call.function
    if (!isRecord(fn)) fail(`${at}.function`, 'must be an object')
    // Names in history were written by a model and may not follow the rules for definitions; keep them as they are.
    const name = optionalString(fn.name, `${at}.function.name`, 256)
    if (!name) fail(`${at}.function.name`, 'is required')
    const args = fn.arguments
    const text = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args)
    return { id, type: 'function', function: { name, arguments: text } }
  })
}

function message(raw: unknown, path: string): Message {
  if (!isRecord(raw)) fail(path, 'must be an object')
  const name = optionalString(raw.name, `${path}.name`, 64)
  if (name !== undefined && !MESSAGE_NAME.test(name)) fail(`${path}.name`, 'may use only letters, digits, _ and -')
  const named = name === undefined ? {} : { name }
  switch (raw.role) {
    case 'system':
    case 'developer':
      // Not every free provider knows the developer role; the system role means the same to all of them.
      return { role: 'system', content: textParts(raw.content, `${path}.content`), ...named }
    case 'user':
      return { role: 'user', content: userContent(raw.content, `${path}.content`), ...named }
    case 'assistant': {
      const calls = raw.tool_calls === undefined || raw.tool_calls === null ? undefined : toolCalls(raw.tool_calls, `${path}.tool_calls`)
      const content = raw.content === undefined || raw.content === null ? (calls?.length ? null : '') : textParts(raw.content, `${path}.content`)
      const reasoning = optionalString(raw.reasoning, `${path}.reasoning`, Number.MAX_SAFE_INTEGER)
      return {
        role: 'assistant',
        content,
        ...(calls?.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...named,
      }
    }
    case 'tool': {
      const id = optionalString(raw.tool_call_id, `${path}.tool_call_id`, 256)
      if (!id) fail(`${path}.tool_call_id`, 'is required')
      return { role: 'tool', tool_call_id: id, content: textParts(raw.content ?? '', `${path}.content`) }
    }
    default:
      fail(`${path}.role`, 'must be system, developer, user, assistant or tool')
  }
}

function tools(raw: unknown, limits: RequestLimits): Tool[] {
  if (!Array.isArray(raw)) fail('tools', 'must be an array')
  if (raw.length > limits.maxTools) fail('tools', `must have at most ${limits.maxTools} entries`)
  const seen = new Set<string>()
  return raw.map((tool, index) => {
    const at = `tools[${index}]`
    if (!isRecord(tool) || tool.type !== 'function') fail(`${at}.type`, 'must be function')
    const fn = tool.function
    if (!isRecord(fn)) fail(`${at}.function`, 'must be an object')
    if (typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name)) fail(`${at}.function.name`, 'must be 1 to 64 letters, digits, _ or -')
    if (seen.has(fn.name)) fail(`${at}.function.name`, 'repeats another tool name')
    seen.add(fn.name)
    const description = optionalString(fn.description, `${at}.function.description`, 16_384)
    if (fn.parameters !== undefined && !isRecord(fn.parameters)) fail(`${at}.function.parameters`, 'must be a JSON Schema object')
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') fail(`${at}.function.strict`, 'must be a boolean')
    return {
      type: 'function',
      function: {
        name: fn.name,
        ...(description !== undefined ? { description } : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters as Record<string, unknown> } : {}),
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      },
    }
  })
}

function toolChoice(raw: unknown, names: Set<string>): ToolChoice {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw
  if (isRecord(raw) && raw.type === 'function' && isRecord(raw.function) && typeof raw.function.name === 'string') {
    if (!names.has(raw.function.name)) fail('tool_choice.function.name', 'must name one of the tools')
    return { type: 'function', function: { name: raw.function.name } }
  }
  fail('tool_choice', 'must be auto, none, required or a function choice')
}

function boundedNumber(raw: unknown, path: string, min: number, max: number, minExclusive = false): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw > max || raw < min || (minExclusive && raw === min)) {
    fail(path, `must be a number from ${min}${minExclusive ? ' (exclusive)' : ''} to ${max}`)
  }
  return raw
}

function positiveInteger(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) fail(path, 'must be a positive whole number')
  return raw
}

function stop(raw: unknown): string | string[] {
  if (typeof raw === 'string') {
    if (raw.length > 256) fail('stop', 'must be at most 256 characters')
    return raw
  }
  if (!Array.isArray(raw) || raw.length > MAX_STOP) fail('stop', `must be a string or up to ${MAX_STOP} strings`)
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 256) fail(`stop[${index}]`, 'must be a string of at most 256 characters')
    return entry
  })
}

function responseFormat(raw: unknown): ResponseFormat {
  if (!isRecord(raw)) fail('response_format', 'must be an object')
  if (raw.type === 'text' || raw.type === 'json_object') return { type: raw.type }
  if (raw.type === 'json_schema') {
    const schema = raw.json_schema
    if (!isRecord(schema) || typeof schema.name !== 'string' || !TOOL_NAME.test(schema.name)) {
      fail('response_format.json_schema.name', 'must be 1 to 64 letters, digits, _ or -')
    }
    if (schema.schema !== undefined && !isRecord(schema.schema)) fail('response_format.json_schema.schema', 'must be an object')
    if (schema.strict !== undefined && typeof schema.strict !== 'boolean') fail('response_format.json_schema.strict', 'must be a boolean')
    const description = optionalString(schema.description, 'response_format.json_schema.description', 4096)
    return {
      type: 'json_schema',
      json_schema: {
        name: schema.name,
        ...(description !== undefined ? { description } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema as Record<string, unknown> } : {}),
        ...(schema.strict !== undefined ? { strict: schema.strict } : {}),
      },
    }
  }
  fail('response_format.type', 'must be text, json_object or json_schema')
}

function reasoning(raw: unknown, maxTokens: number): Reasoning {
  if (!isRecord(raw)) fail('reasoning', 'must be an object')
  const out: Reasoning = {}
  if (raw.effort !== undefined) {
    if (raw.effort !== 'minimal' && raw.effort !== 'low' && raw.effort !== 'medium' && raw.effort !== 'high') {
      fail('reasoning.effort', 'must be minimal, low, medium or high')
    }
    out.effort = raw.effort
  }
  if (raw.max_tokens !== undefined) out.max_tokens = Math.min(positiveInteger(raw.max_tokens, 'reasoning.max_tokens'), maxTokens)
  for (const key of ['exclude', 'enabled'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') fail(`reasoning.${key}`, 'must be a boolean')
    out[key] = raw[key] as boolean
  }
  return out
}

/** Rebuilds a client's chat request from the fields the gateway allows. Throws `invalid_request` or `model_not_found`. */
export function sanitizeChatRequest(raw: unknown, limits: RequestLimits): SanitizedChat {
  if (!isRecord(raw)) fail('The request body', 'must be a JSON object')
  if (!isVirtualModelId(raw.model)) {
    throw new GatewayError('model_not_found', `Unknown model. The free tier serves ${VIRTUAL_MODEL_IDS.join(' and ')}.`)
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) fail('messages', 'must be a non-empty array')
  if (raw.messages.length > limits.maxMessages) fail('messages', `must have at most ${limits.maxMessages} entries`)
  const messages = raw.messages.map((entry, index) => message(entry, `messages[${index}]`))

  const requested = raw.max_tokens ?? raw.max_completion_tokens
  const maxTokens = requested === undefined || requested === null ? limits.defaultOutputTokens : Math.min(positiveInteger(requested, 'max_tokens'), limits.maxOutputTokens)

  const fields: UpstreamFields = { messages, max_tokens: maxTokens }
  if (raw.tools !== undefined && raw.tools !== null) {
    const list = tools(raw.tools, limits)
    if (list.length) fields.tools = list
  }
  if (raw.tool_choice !== undefined && raw.tool_choice !== null && fields.tools) {
    fields.tool_choice = toolChoice(raw.tool_choice, new Set(fields.tools.map((tool) => tool.function.name)))
  }
  if (raw.parallel_tool_calls !== undefined && fields.tools) {
    if (typeof raw.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls', 'must be a boolean')
    fields.parallel_tool_calls = raw.parallel_tool_calls
  }
  if (raw.temperature !== undefined && raw.temperature !== null) fields.temperature = boundedNumber(raw.temperature, 'temperature', 0, 2)
  if (raw.top_p !== undefined && raw.top_p !== null) fields.top_p = boundedNumber(raw.top_p, 'top_p', 0, 1, true)
  if (raw.stop !== undefined && raw.stop !== null) fields.stop = stop(raw.stop)
  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== 'number' || !Number.isSafeInteger(raw.seed)) fail('seed', 'must be a whole number')
    fields.seed = raw.seed
  }
  if (raw.response_format !== undefined && raw.response_format !== null) fields.response_format = responseFormat(raw.response_format)
  if (raw.reasoning !== undefined && raw.reasoning !== null) fields.reasoning = reasoning(raw.reasoning, maxTokens)
  if (raw.stream !== undefined && raw.stream !== null && typeof raw.stream !== 'boolean') fail('stream', 'must be a boolean')

  const history = messages.some((entry) => entry.role === 'tool' || (entry.role === 'assistant' && entry.tool_calls?.length))
  const needsImages = messages.some(
    (entry) => entry.role === 'user' && Array.isArray(entry.content) && entry.content.some((part) => part.type === 'image_url'),
  )
  return {
    virtualModel: raw.model,
    stream: raw.stream === true,
    fields,
    needsTools: Boolean(fields.tools) || history,
    needsImages,
  }
}

/**
 * The last check before a request leaves for OpenRouter: only `:free` model
 * ids, at most `maxModels` of them, function tools only, no image or text part
 * of an unknown kind, and no key outside the allowlist. A failure here is a
 * gateway bug, never a client error, and the request is not sent.
 */
export function assertFreeOnly(body: Record<string, unknown>, maxModels: number): void {
  for (const key of Object.keys(body)) {
    if (!UPSTREAM_KEYS.has(key)) throw new Error(`cost firewall: unexpected upstream field ${key}`)
  }
  if (!isFreeModelId(body.model)) throw new Error('cost firewall: model is not a :free id')
  const models = body.models
  if (!Array.isArray(models) || models.length < 1 || models.length > maxModels || models[0] !== body.model) {
    throw new Error('cost firewall: models must start with model and stay within the fallback limit')
  }
  if (!models.every(isFreeModelId)) throw new Error('cost firewall: a fallback model is not a :free id')
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => !isRecord(tool) || tool.type !== 'function'))) {
    throw new Error('cost firewall: only function tools may be sent')
  }
  if (!Array.isArray(body.messages)) throw new Error('cost firewall: messages missing')
  for (const entry of body.messages) {
    const content = isRecord(entry) ? entry.content : undefined
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isRecord(part) || (part.type !== 'text' && part.type !== 'image_url')) throw new Error('cost firewall: unexpected content part')
    }
  }
}
