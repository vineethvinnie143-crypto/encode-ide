import { pathToFileURL } from 'node:url'
import {
  Connection,
  ErrorCode,
  McpError,
  ProtocolError,
  type Progress,
  type Transport,
} from './jsonrpc'
import {
  LATEST_VERSION,
  LIMITS,
  SUPPORTED_VERSIONS,
  cleanText,
  parseCallResult,
  parseInitializeResult,
  parsePrompt,
  parsePromptResult,
  parseReadResult,
  parseResource,
  parseResourceTemplate,
  parseTool,
  type McpContent,
  type McpPrompt,
  type McpPromptResult,
  type McpResource,
  type McpResourceTemplate,
  type McpTool,
  type McpToolResult,
  type ServerInfo,
} from './protocol'

/**
 * One connection to one server: the handshake, then tools, resources and
 * prompts. Everything the server sends goes through the parsers in
 * protocol.ts. The client answers what a server may ask of it (ping, and
 * the workspace roots when offered) and refuses everything else, so a
 * server cannot make eNCode sample a model or prompt the user.
 */

export class UnsupportedVersionError extends Error {
  constructor(readonly version: string) {
    super(`The server speaks MCP version ${version}, which eNCode does not support (it supports ${SUPPORTED_VERSIONS.join(', ')}).`)
    this.name = 'UnsupportedVersionError'
  }
}

export interface Root {
  path: string
  name?: string
}

export type ChangeKind = 'tools' | 'resources' | 'prompts' | 'resource'

export interface McpClientOptions {
  transport: Transport
  clientInfo: { name: string; title?: string; version: string }
  /** The folders servers may be told about; omit to offer none. */
  roots?: () => Root[]
  /** How long the handshake may take, ms. Default 30 s. */
  connectTimeoutMs?: number
  /** How long a list or read may take, ms. Default 60 s. */
  requestTimeoutMs?: number
  /** The longest a tool call may go without progress, ms. Default 10 minutes. */
  toolTimeoutMs?: number
  /** The longest a tool call may take at all, ms. Default 1 hour. */
  toolMaxMs?: number
  onChanged?: (what: ChangeKind) => void
  onLog?: (level: string, text: string) => void
  /** Trouble that does not end the connection. */
  onNotice?: (text: string) => void
  onClose?: (reason?: Error) => void
}

export interface Listing<T> {
  items: T[]
  /** Entries the server sent that could not be used, with why. */
  problems: string[]
}

export interface CallOptions {
  signal?: AbortSignal
  onProgress?: (progress: Progress) => void
  /** Overrides the client's no-progress timeout for this call, ms. */
  timeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000
const DEFAULT_TOOL_MAX_MS = 60 * 60_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class McpClient {
  private readonly connection: Connection
  private info: ServerInfo | undefined

  constructor(private readonly options: McpClientOptions) {
    this.connection = new Connection(options.transport, {
      request: (method, params) => this.answer(method, params),
      notification: (method, params) => this.heard(method, params),
    })
    this.connection.onclose = (reason) => options.onClose?.(reason)
    options.transport.onerror = (error) => options.onNotice?.(error.message)
  }

  /** What the handshake found out; undefined before `connect`. */
  get server(): ServerInfo | undefined {
    return this.info
  }

  async connect(signal?: AbortSignal): Promise<ServerInfo> {
    const { transport } = this.options
    try {
      await transport.start?.()
      const raw = await this.connection.request(
        'initialize',
        {
          protocolVersion: LATEST_VERSION,
          capabilities: this.options.roots ? { roots: { listChanged: false } } : {},
          clientInfo: this.options.clientInfo,
        },
        { timeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, signal },
      )
      const info = parseInitializeResult(raw)
      if (typeof info === 'string') throw new ProtocolError(info)
      if (!(SUPPORTED_VERSIONS as readonly string[]).includes(info.protocolVersion)) throw new UnsupportedVersionError(info.protocolVersion)
      this.info = info
      transport.setProtocolVersion?.(info.protocolVersion)
      await this.connection.notify('notifications/initialized')
      transport.ready?.()
      return info
    } catch (error) {
      await this.connection.close().catch(() => {})
      throw error
    }
  }

  async listTools(signal?: AbortSignal): Promise<Listing<McpTool>> {
    if (!this.info?.capabilities.tools) return { items: [], problems: [] }
    const listing = await this.list('tools/list', 'tools', parseTool, signal)
    const seen = new Set<string>()
    const items: McpTool[] = []
    for (const tool of listing.items) {
      if (seen.has(tool.name)) listing.problems.push(`${tool.name} is listed twice; the first is used`)
      else {
        seen.add(tool.name)
        items.push(tool)
      }
    }
    return { items, problems: listing.problems }
  }

  async listResources(signal?: AbortSignal): Promise<Listing<McpResource>> {
    if (!this.info?.capabilities.resources) return { items: [], problems: [] }
    return this.list('resources/list', 'resources', parseResource, signal)
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<Listing<McpResourceTemplate>> {
    if (!this.info?.capabilities.resources) return { items: [], problems: [] }
    return this.list('resources/templates/list', 'resourceTemplates', parseResourceTemplate, signal)
  }

  async listPrompts(signal?: AbortSignal): Promise<Listing<McpPrompt>> {
    if (!this.info?.capabilities.prompts) return { items: [], problems: [] }
    return this.list('prompts/list', 'prompts', parsePrompt, signal)
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<McpToolResult> {
    const raw = await this.connection.request(
      'tools/call',
      { name, arguments: args },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        maxTotalMs: this.options.toolMaxMs ?? DEFAULT_TOOL_MAX_MS,
        resetTimeoutOnProgress: true,
        onProgress: options.onProgress,
      },
    )
    const result = parseCallResult(raw)
    if (typeof result === 'string') throw new ProtocolError(result)
    return result
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpContent[]> {
    const raw = await this.connection.request('resources/read', { uri }, { signal, timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS })
    const result = parseReadResult(raw)
    if (typeof result === 'string') throw new ProtocolError(result)
    return result
  }

  async getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<McpPromptResult> {
    const raw = await this.connection.request('prompts/get', { name, arguments: args }, { signal, timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS })
    const result = parsePromptResult(raw)
    if (typeof result === 'string') throw new ProtocolError(result)
    return result
  }

  close(): Promise<void> {
    return this.connection.close()
  }

  // -------------------------------------------------------------------------

  private async list<T>(method: string, key: string, parse: (raw: unknown) => T | string, signal?: AbortSignal): Promise<Listing<T>> {
    const items: T[] = []
    const problems: string[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < LIMITS.pages; page++) {
      const result = await this.connection.request(method, cursor ? { cursor } : {}, { signal, timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS })
      if (!isObject(result) || !Array.isArray(result[key])) throw new ProtocolError(`${method} answered without a "${key}" list.`)
      for (const raw of result[key]) {
        if (items.length >= LIMITS.items) {
          problems.push(`more than ${LIMITS.items} entries; the rest are ignored`)
          return { items, problems }
        }
        const parsed = parse(raw)
        if (typeof parsed === 'string') problems.push(parsed)
        else items.push(parsed)
      }
      const next = result.nextCursor
      // A server that hands back a cursor it already gave would make this loop for ever.
      if (typeof next !== 'string' || !next || cursors.has(next)) break
      cursors.add(next)
      cursor = next
    }
    return { items, problems }
  }

  private async answer(method: string, _params: unknown): Promise<unknown> {
    if (method === 'roots/list' && this.options.roots) {
      return { roots: this.options.roots().map((root) => ({ uri: pathToFileURL(root.path).href, ...(root.name ? { name: root.name } : {}) })) }
    }
    throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`)
  }

  private heard(method: string, params: unknown): void {
    switch (method) {
      case 'notifications/tools/list_changed':
        this.options.onChanged?.('tools')
        break
      case 'notifications/resources/list_changed':
        this.options.onChanged?.('resources')
        break
      case 'notifications/prompts/list_changed':
        this.options.onChanged?.('prompts')
        break
      case 'notifications/resources/updated':
        this.options.onChanged?.('resource')
        break
      case 'notifications/message': {
        if (!isObject(params)) break
        let text: string
        try {
          text = typeof params.data === 'string' ? params.data : JSON.stringify(params.data)
        } catch {
          text = ''
        }
        this.options.onLog?.(cleanText(params.level, 20) || 'info', cleanText(text, 2000) ?? '')
        break
      }
    }
  }
}
