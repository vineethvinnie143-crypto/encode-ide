/**
 * eNCode's language server for JSON, CSS, SCSS, Less and HTML, over LSP on its standard input and output (ADR 0085).
 * eNCode starts it with its own Node.js, like the servers it installs; it reads only the documents it is sent and, for
 * a JSON document's own `$schema`, a schema file inside the folder. It fetches nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSONRPC_ERRORS, JsonRpcConnection, RpcFailure } from '@encode/lsp'
import { CssService } from './css/service'
import { HtmlService } from './html/service'
import { parseJson, type JsonNode } from './json/parser'
import type { Schema } from './json/schema'
import { JsonService } from './json/service'
import { Document, type Position } from './text'

/** Larger documents are left alone: reading them on every change would cost more than it gives. */
export const MAX_DOCUMENT_CHARS = 5 * 1024 * 1024
const MAX_SCHEMA_BYTES = 1024 * 1024
const DIAGNOSTICS_DELAY_MS = 150

export const LANGUAGES = ['json', 'jsonc', 'css', 'scss', 'less', 'html'] as const

interface Services {
  json: JsonService
  css: CssService
  html: HtmlService
}

/** A `$schema` that is a file in the folder: read, checked and kept until it changes. */
export function schemaLoader(roots: () => string[]): (documentUri: string, address: string) => Schema | null {
  const cache = new Map<string, { mtime: number; schema: Schema | null }>()
  return (documentUri, address) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !address.startsWith('file:')) return null
    let documentPath: string
    try {
      documentPath = fileURLToPath(documentUri)
    } catch {
      return null
    }
    let file: string
    try {
      file = address.startsWith('file:') ? fileURLToPath(address) : path.resolve(path.dirname(documentPath), address)
    } catch {
      return null
    }
    const inside = roots().some((root) => {
      const relative = path.relative(root, file)
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    })
    if (!inside || !/\.json$/i.test(file)) return null
    try {
      const real = fs.realpathSync(file)
      if (!roots().some((root) => !path.relative(fs.realpathSync(root), real).startsWith('..'))) return null
      const stat = fs.statSync(real)
      if (!stat.isFile() || stat.size > MAX_SCHEMA_BYTES) return null
      const cached = cache.get(real)
      if (cached && cached.mtime === stat.mtimeMs) return cached.schema
      const parsed = parseJson(fs.readFileSync(real, 'utf8'), { comments: true })
      const schema = parsed.root?.type === 'object' ? (toValue(parsed.root) as Schema) : null
      if (cache.size > 64) cache.clear()
      cache.set(real, { mtime: stat.mtimeMs, schema })
      return schema
    } catch {
      return null
    }
  }
}

function toValue(node: JsonNode): unknown {
  if (node.type === 'object') return Object.fromEntries((node.children ?? []).filter((property) => property.children?.[1]).map((property) => [String(property.children![0]!.value), toValue(property.children![1]!)]))
  if (node.type === 'array') return (node.children ?? []).map(toValue)
  return node.value
}

export function startServer(input: Readable, output: Writable, onExit: (code: number) => void): JsonRpcConnection {
  const documents = new Map<string, Document>()
  const timers = new Map<string, NodeJS.Timeout>()
  let roots: string[] = []
  const json = new JsonService(schemaLoader(() => roots))
  const css = new CssService()
  const services: Services = { json, css, html: new HtmlService(css) }
  let shutdown = false

  const serviceFor = (doc: Document) => {
    if (doc.languageId === 'json' || doc.languageId === 'jsonc') return services.json
    if (doc.languageId === 'html') return services.html
    return services.css
  }
  const publish = (uri: string) => {
    const doc = documents.get(uri)
    if (!doc) return
    let diagnostics: unknown[] = []
    if (doc.text.length <= MAX_DOCUMENT_CHARS) {
      try {
        diagnostics = serviceFor(doc).diagnostics(doc)
      } catch (error) {
        connection.notify('window/logMessage', { type: 1, message: `Could not check ${uri}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    connection.notify('textDocument/publishDiagnostics', { uri, version: doc.version, diagnostics })
  }
  const schedule = (uri: string) => {
    clearTimeout(timers.get(uri))
    timers.set(uri, setTimeout(() => {
      timers.delete(uri)
      publish(uri)
    }, DIAGNOSTICS_DELAY_MS))
  }
  const docFor = (params: unknown): Document | null => {
    const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri
    const doc = uri ? documents.get(uri) : undefined
    return doc && doc.text.length <= MAX_DOCUMENT_CHARS ? doc : null
  }
  const positionOf = (params: unknown) => (params as { position: Position }).position

  const connection: JsonRpcConnection = new JsonRpcConnection(input, output, {
    onRequest: (method, params) => {
      if (shutdown && method !== 'shutdown') throw new RpcFailure('The server is shutting down.', JSONRPC_ERRORS.invalidRequest)
      switch (method) {
        case 'initialize': {
          const init = params as { rootUri?: string | null; workspaceFolders?: { uri: string }[] | null }
          const uris = init.workspaceFolders?.map((folder) => folder.uri) ?? (init.rootUri ? [init.rootUri] : [])
          roots = uris.flatMap((uri) => {
            try {
              return [fileURLToPath(uri)]
            } catch {
              return []
            }
          })
          return {
            capabilities: {
              textDocumentSync: { openClose: true, change: 2 },
              completionProvider: { triggerCharacters: ['"', ':', '<', '/', '@', '&', '-', ' ', '=', '.'] },
              hoverProvider: true,
              documentSymbolProvider: true,
              foldingRangeProvider: true,
              documentFormattingProvider: true,
            },
            serverInfo: { name: 'encode-weblang', version: '1' },
          }
        }
        case 'shutdown':
          shutdown = true
          return null
        case 'textDocument/completion': {
          const doc = docFor(params)
          return doc ? { isIncomplete: false, items: serviceFor(doc).completion(doc, positionOf(params)).slice(0, 2000) } : null
        }
        case 'textDocument/hover': {
          const doc = docFor(params)
          return doc ? serviceFor(doc).hover(doc, positionOf(params)) : null
        }
        case 'textDocument/documentSymbol': {
          const doc = docFor(params)
          return doc ? serviceFor(doc).symbols(doc) : null
        }
        case 'textDocument/foldingRange': {
          const doc = docFor(params)
          return doc ? serviceFor(doc).folding(doc) : null
        }
        case 'textDocument/formatting': {
          const doc = docFor(params)
          const options = (params as { options?: { tabSize?: number; insertSpaces?: boolean } }).options ?? {}
          if (!doc || (doc.languageId !== 'json' && doc.languageId !== 'jsonc')) return []
          return services.json.format(doc, { tabSize: options.tabSize ?? 2, insertSpaces: options.insertSpaces ?? true })
        }
        default:
          throw new RpcFailure(`${method} is not something this server does.`, JSONRPC_ERRORS.methodNotFound)
      }
    },
    onNotification: (method, params) => {
      const p = params as { textDocument: { uri: string; languageId?: string; version?: number; text?: string }; contentChanges?: { range?: { start: Position; end: Position }; text: string }[] }
      switch (method) {
        case 'textDocument/didOpen':
          documents.set(p.textDocument.uri, new Document(p.textDocument.uri, p.textDocument.languageId ?? 'json', p.textDocument.version ?? 0, p.textDocument.text ?? ''))
          schedule(p.textDocument.uri)
          break
        case 'textDocument/didChange': {
          const doc = documents.get(p.textDocument.uri)
          if (!doc) break
          doc.apply(p.contentChanges ?? [], p.textDocument.version ?? doc.version + 1)
          schedule(doc.uri)
          break
        }
        case 'textDocument/didClose': {
          const uri = p.textDocument.uri
          documents.delete(uri)
          clearTimeout(timers.get(uri))
          timers.delete(uri)
          services.json.forget(uri)
          services.css.forget(uri)
          services.html.forget(uri)
          connection.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] })
          break
        }
        case 'exit':
          onExit(shutdown ? 0 : 1)
          break
        default:
          break
      }
    },
    onClose: () => onExit(shutdown ? 0 : 1),
  })
  return connection
}

/** For tests: a document URI for a path. */
export function fileUri(file: string): string {
  return pathToFileURL(file).href
}
