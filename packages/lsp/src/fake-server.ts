/**
 * Test support: a small language server written in JavaScript and run by the Node that runs the tests, so nothing has
 * to be found on a PATH. It speaks the real wire format over its standard input and output. A line with ERROR in it
 * is an error, one with WARN a warning; `function name` declares a symbol. Only the tests import this.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fromChildProcess, type ServerProcess } from './client'

export const FAKE_SERVER = String.raw`
const fs = require('node:fs')
const mode = process.argv[2] || ''
const extra = process.env.FAKE_LSP_EXTRA || ''
const docs = new Map()
const pending = new Map()
let buffer = Buffer.alloc(0)
let nextId = 1

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]))
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const log = (message) => notify('window/logMessage', { type: 3, message })
function ask(method, params) {
  const id = 'srv' + nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve) => pending.set(id, resolve))
}

function toPath(uri) {
  let rest = decodeURIComponent(uri.replace(/^file:\/\//, ''))
  if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1).replace(/\//g, '\\')
  return rest
}
function toUri(file) {
  if (/^[A-Za-z]:/.test(file)) return 'file:///' + file.replace(/\\/g, '/').split('/').map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/')
  return 'file://' + file.split('/').map(encodeURIComponent).join('/')
}

/** Every document the server knows: the open ones, and the extra file on disk the tests name. */
function texts() {
  const all = new Map()
  if (extra && fs.existsSync(extra)) all.set(toUri(extra), { text: fs.readFileSync(extra, 'utf8'), version: null })
  for (const [uri, doc] of docs) all.set(uri, doc)
  return all
}

function diagnosticsOf(text) {
  const out = []
  text.split(/\r?\n/).forEach((line, index) => {
    const error = line.indexOf('ERROR')
    if (error >= 0) out.push({ range: { start: { line: index, character: error }, end: { line: index, character: error + 5 } }, severity: 1, message: 'Something is wrong here', source: 'fake', code: 'E1' })
    const warn = line.indexOf('WARN')
    if (warn >= 0) out.push({ range: { start: { line: index, character: warn }, end: { line: index, character: warn + 4 } }, severity: 2, message: 'This could be better', source: 'fake' })
  })
  return out
}

function publish(uri) {
  const doc = docs.get(uri)
  if (!doc) return
  const params = { uri, diagnostics: diagnosticsOf(doc.text) }
  if (mode !== 'noversion') params.version = doc.version
  if (mode === 'twice') {
    notify('textDocument/publishDiagnostics', { uri, diagnostics: [], version: params.version })
    setTimeout(() => notify('textDocument/publishDiagnostics', params), 40)
  } else if (mode === 'slow') setTimeout(() => notify('textDocument/publishDiagnostics', params), 400)
  else notify('textDocument/publishDiagnostics', params)
}

function wordAt(text, position) {
  const line = text.split(/\r?\n/)[position.line] || ''
  const re = /[A-Za-z_]\w*/g
  let match
  while ((match = re.exec(line))) {
    if (position.character >= match.index && position.character <= match.index + match[0].length) return { word: match[0], range: { start: { line: position.line, character: match.index }, end: { line: position.line, character: match.index + match[0].length } } }
  }
  return null
}

function occurrences(word) {
  const out = []
  for (const [uri, doc] of texts()) {
    doc.text.split(/\r?\n/).forEach((line, index) => {
      const re = new RegExp('\\b' + word + '\\b', 'g')
      let match
      while ((match = re.exec(line))) out.push({ uri, version: doc.version, range: { start: { line: index, character: match.index }, end: { line: index, character: match.index + word.length } } })
    })
  }
  return out
}

function functions(uri, text) {
  const out = []
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /function (\w+)/.exec(line)
    if (match) {
      const at = match.index + 9
      out.push({ name: match[1], uri, line: index, range: { start: { line: index, character: at }, end: { line: index, character: at + match[1].length } } })
    }
  })
  return out
}

const capabilities = {
  textDocumentSync: { openClose: true, change: mode === 'incremental' ? 2 : 1, save: { includeText: false } },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  callHierarchyProvider: true,
  renameProvider: { prepareProvider: true },
  codeActionProvider: { resolveProvider: true },
  executeCommandProvider: { commands: ['fake.fixAll'] },
}
if (mode === 'pull') capabilities.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false }
if (mode === 'bare') for (const key of Object.keys(capabilities)) if (key !== 'textDocumentSync') delete capabilities[key]

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    if (resolve) resolve(message.result !== undefined ? message.result : { error: message.error })
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      if (mode === 'hang') return
      log('init ' + JSON.stringify({ rootUri: params.rootUri, options: params.initializationOptions || null }))
      return reply(id, { capabilities, serverInfo: { name: 'fake', version: '1' } })
    case 'initialized': {
      const config = await ask('workspace/configuration', { items: [{ section: 'fake.option' }, { section: 'missing.part' }] })
      log('config ' + JSON.stringify(config))
      const choice = await ask('window/showMessageRequest', { type: 3, message: 'Pick one', actions: [{ title: 'A' }] })
      log('choice ' + JSON.stringify(choice))
      if (mode === 'rogue') {
        const answer = await ask('workspace/applyEdit', { edit: { changes: {} } })
        log('rogue ' + JSON.stringify(answer))
      }
      return
    }
    case 'textDocument/didOpen':
      if (mode === 'crash') {
        process.stderr.write('boom: the fake server fell over\n')
        process.exit(1)
      }
      docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version })
      if (mode !== 'pull') publish(params.textDocument.uri)
      log('open ' + params.textDocument.uri.split('/').pop())
      return
    case 'textDocument/didChange': {
      const doc = docs.get(params.textDocument.uri)
      if (!doc) return
      for (const change of params.contentChanges) {
        if (!change.range) doc.text = change.text
        else {
          const lines = doc.text.split('\n')
          const offset = (position) => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character
          doc.text = doc.text.slice(0, offset(change.range.start)) + change.text + doc.text.slice(offset(change.range.end))
        }
      }
      doc.version = params.textDocument.version
      if (mode !== 'pull') publish(params.textDocument.uri)
      return
    }
    case 'textDocument/didSave':
      log('save ' + params.textDocument.uri.split('/').pop())
      return
    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri)
      log('close ' + params.textDocument.uri.split('/').pop())
      return
    case 'workspace/didChangeWatchedFiles':
      log('watched ' + params.changes.map((change) => change.type + ':' + change.uri.split('/').pop()).join(','))
      return
    case 'workspace/didChangeConfiguration':
      log('settings ' + JSON.stringify(params.settings))
      return
    case 'textDocument/diagnostic': {
      const doc = docs.get(params.textDocument.uri)
      return reply(id, { kind: 'full', items: doc ? diagnosticsOf(doc.text) : [] })
    }
    case 'textDocument/hover': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      return reply(id, found ? { contents: { kind: 'markdown', value: '**' + found.word + '**' } } : null)
    }
    case 'textDocument/definition': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      if (!found) return reply(id, null)
      const all = []
      for (const [uri, other] of texts()) for (const fn of functions(uri, other.text)) if (fn.name === found.word) all.push({ uri, range: fn.range })
      return reply(id, mode === 'links' ? all.map((item) => ({ targetUri: item.uri, targetRange: item.range, targetSelectionRange: item.range })) : all)
    }
    case 'textDocument/references': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      return reply(id, found ? occurrences(found.word).map((item) => ({ uri: item.uri, range: item.range })) : [])
    }
    case 'textDocument/documentSymbol': {
      const doc = docs.get(params.textDocument.uri)
      if (!doc) return reply(id, [])
      return reply(id, functions(params.textDocument.uri, doc.text).map((fn) => ({ name: fn.name, kind: 12, range: { start: { line: fn.line, character: 0 }, end: { line: fn.line + 1, character: 0 } }, selectionRange: fn.range, children: [{ name: 'inner', kind: 13, range: fn.range, selectionRange: fn.range }] })))
    }
    case 'workspace/symbol': {
      const out = []
      for (const [uri, doc] of texts()) for (const fn of functions(uri, doc.text)) if (fn.name.includes(params.query)) out.push({ name: fn.name, kind: 12, location: { uri, range: fn.range }, containerName: 'module' })
      return reply(id, out)
    }
    case 'textDocument/prepareCallHierarchy': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      return reply(id, found ? [{ name: found.word, kind: 12, uri: params.textDocument.uri, range: found.range, selectionRange: found.range }] : null)
    }
    case 'callHierarchy/incomingCalls':
    case 'callHierarchy/outgoingCalls': {
      const end = method === 'callHierarchy/incomingCalls' ? 'from' : 'to'
      const item = { name: end === 'from' ? 'caller' : 'callee', kind: 12, uri: params.item.uri, range: params.item.range, selectionRange: params.item.range }
      return reply(id, [{ [end]: item, fromRanges: [] }])
    }
    case 'textDocument/prepareRename': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      return reply(id, found ? found.range : null)
    }
    case 'textDocument/rename': {
      if (params.newName === 'bad') return fail(id, -32803, 'That name cannot be used')
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      if (!found) return reply(id, null)
      const byUri = new Map()
      for (const item of occurrences(found.word)) {
        const entry = byUri.get(item.uri) || { textDocument: { uri: item.uri, version: item.version }, edits: [] }
        entry.edits.push({ range: item.range, newText: params.newName })
        byUri.set(item.uri, entry)
      }
      if (mode === 'stale') for (const entry of byUri.values()) if (entry.textDocument.version !== null) entry.textDocument.version -= 1
      const changes = [...byUri.values()]
      if (mode === 'move') {
        // The file is renamed after the symbol, and an index that names it is made.
        const uri = params.textDocument.uri
        const moved = uri.replace(/[^/]+$/, params.newName + '.fk')
        const index = uri.replace(/[^/]+$/, 'index.fk')
        changes.push({ kind: 'rename', oldUri: uri, newUri: moved })
        changes.push({ textDocument: { uri: moved, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '-- moved\n' }] })
        changes.push({ kind: 'create', uri: index, options: { ignoreIfExists: true } })
        changes.push({ textDocument: { uri: index, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'use ' + params.newName + '\n' }] })
        changes.push({ kind: 'delete', uri: uri.replace(/[^/]+$/, 'old.fk'), options: { ignoreIfNotExists: true } })
      }
      return reply(id, { documentChanges: changes })
    }
    case 'textDocument/codeAction': {
      const uri = params.textDocument.uri
      const doc = docs.get(uri)
      if (!doc) return reply(id, [])
      const lines = doc.text.split(/\r?\n/)
      const out = []
      for (let line = params.range.start.line; line <= params.range.end.line; line++) {
        const at = (lines[line] || '').indexOf('ERROR')
        if (at >= 0) out.push({ title: 'Replace ERROR with OK', kind: 'quickfix', isPreferred: true, diagnostics: params.context.diagnostics, edit: { changes: { [uri]: [{ range: { start: { line, character: at }, end: { line, character: at + 5 } }, newText: 'OK' }] } } })
      }
      out.push({ title: 'Fix everything in the file', kind: 'source.fixAll', command: { title: 'Fix all', command: 'fake.fixAll', arguments: [uri] } })
      out.push({ title: 'Add a note at the top', kind: 'refactor', data: { uri } })
      out.push({ title: 'Not now', kind: 'refactor', disabled: { reason: 'It is Tuesday' } })
      out.push({ title: 'Run a bare command', command: 'fake.fixAll', arguments: [uri] })
      return reply(id, out)
    }
    case 'codeAction/resolve':
      return reply(id, Object.assign({}, params, { edit: { changes: { [params.data.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// note\n' }] } } }))
    case 'workspace/executeCommand': {
      if (params.command !== 'fake.fixAll') return fail(id, -32601, 'no such command')
      const uri = params.arguments[0]
      const doc = docs.get(uri)
      const edits = []
      doc.text.split(/\r?\n/).forEach((line, index) => {
        const at = line.indexOf('ERROR')
        if (at >= 0) edits.push({ range: { start: { line: index, character: at }, end: { line: index, character: at + 5 } }, newText: 'OK' })
      })
      const answer = await ask('workspace/applyEdit', { label: 'Fix all', edit: { documentChanges: [{ textDocument: { uri, version: doc.version }, edits }] } })
      return reply(id, { applied: answer.applied, failureReason: answer.failureReason || null })
    }
    case 'shutdown':
      if (mode === 'deaf') return
      return reply(id, null)
    case 'exit':
      return process.exit(0)
    default:
      if (id !== undefined) fail(id, -32601, 'Unhandled ' + method)
  }
}

if (mode === 'nostart') {
  process.stderr.write('cannot start: no project found\n')
  process.exit(2)
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8')
    buffer = buffer.subarray(end + 4 + length)
    void handle(JSON.parse(body))
  }
})
process.stdin.on('end', () => process.exit(0))
`

export interface FakeServer {
  dir: string
  script: string
  /** Starts the server in `mode`, with `extra` as a file it reads from the disk. */
  start(mode?: string, options?: { extra?: string; cwd?: string }): ServerProcess
  dispose(): Promise<void>
}

export async function fakeServer(): Promise<FakeServer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'encode-lsp-fake-'))
  const script = path.join(dir, 'server.cjs')
  await writeFile(script, FAKE_SERVER)
  const children: ReturnType<typeof spawn>[] = []
  return {
    dir,
    script,
    start(mode = '', options = {}) {
      const child = spawn(process.execPath, [script, mode], {
        cwd: options.cwd ?? dir,
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...(options.extra ? { FAKE_LSP_EXTRA: options.extra } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      children.push(child)
      return fromChildProcess(child)
    },
    async dispose() {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true })
    },
  }
}
