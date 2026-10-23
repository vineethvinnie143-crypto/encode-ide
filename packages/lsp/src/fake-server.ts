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

/** Folding: each brace block, ending on its closing brace, and each block comment over more than one line. */
function foldingRanges(text) {
  const out = []
  const open = []
  let comment = -1
  text.split(/\r?\n/).forEach((line, index) => {
    if (comment < 0 && line.includes('/*') && !line.includes('*/')) comment = index
    else if (comment >= 0 && line.includes('*/')) {
      if (index > comment) out.push({ startLine: comment, endLine: index, kind: 'comment' })
      comment = -1
    }
    for (let at = 0; at < line.length; at++) {
      if (line[at] === '{') open.push(index)
      else if (line[at] === '}' && open.length) {
        const start = open.pop()
        if (index > start) out.push({ startLine: start, endLine: index, endCharacter: at + 1 })
      }
    }
  })
  return out
}

/** Inlay hints in lines from to to: ': number' after a name a number is put in (let n = 5). */
function inlayHints(text, from, to) {
  const out = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (index < from || index > to) return
    for (const match of line.matchAll(/\b(?:let|const|var) (\w+) = \d/g)) out.push({ position: { line: index, character: match.index + match[0].length - 4 }, label: ': number', kind: 1, paddingLeft: false })
  })
  return out
}

/** The legend the semantic tokens below are numbered by. */
const SEMANTIC_LEGEND = { tokenTypes: ['function', 'parameter', 'class'], tokenModifiers: ['declaration', 'deprecated'] }

/** Semantic tokens: every use of a function the file declares, deprecated when its name starts with 'old'. */
function semanticTokens(text) {
  const names = new Set(functions('', text).map((fn) => fn.name))
  const data = []
  let lastLine = 0
  let lastChar = 0
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\w+/g)) {
      if (!names.has(match[0])) continue
      const deltaLine = index - lastLine
      data.push(deltaLine, deltaLine ? match.index : match.index - lastChar, match[0].length, 0, match[0].startsWith('old') ? 2 : 0)
      lastLine = index
      lastChar = match.index
    }
  })
  return { data }
}

/** Formatting: leading tabs become spaces (when spaces are asked for), and the spaces at a line's end go. */
function formatEdits(text, options, range) {
  const edits = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (range && (index < range.start.line || index > range.end.line)) return
    const lead = /^\t+/.exec(line)
    const indent = lead ? lead[0].length : 0
    if (lead && options.insertSpaces) edits.push({ range: { start: { line: index, character: 0 }, end: { line: index, character: indent } }, newText: ' '.repeat(options.tabSize * indent) })
    const trail = /[ \t]+$/.exec(line)
    if (trail && trail.index >= indent) edits.push({ range: { start: { line: index, character: trail.index }, end: { line: index, character: line.length } }, newText: '' })
  })
  return edits
}

const capabilities = {
  textDocumentSync: { openClose: true, change: mode === 'incremental' ? 2 : 1, save: { includeText: false } },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  callHierarchyProvider: true,
  foldingRangeProvider: true,
  inlayHintProvider: true,
  semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true },
  renameProvider: { prepareProvider: true },
  codeActionProvider: { resolveProvider: true },
  executeCommandProvider: { commands: ['fake.fixAll'] },
  completionProvider: { triggerCharacters: ['.'], allCommitCharacters: [';'], resolveProvider: true },
  signatureHelpProvider: { triggerCharacters: ['('], retriggerCharacters: [','] },
  documentHighlightProvider: true,
  documentFormattingProvider: true,
  documentRangeFormattingProvider: true,
  documentOnTypeFormattingProvider: { firstTriggerCharacter: ';', moreTriggerCharacter: ['}'] },
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
      if (mode === 'env') log('env ' + Object.keys(process.env).sort().join(',') + ' cwd ' + process.cwd())
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
      // An older server's flat list, one of its entries in another file.
      if (doc.text.includes('flat-symbols')) {
        const flat = functions(params.textDocument.uri, doc.text).flatMap((fn) => [
          { name: fn.name, kind: 12, location: { uri: params.textDocument.uri, range: { start: { line: fn.line, character: 0 }, end: { line: fn.line + 1, character: 0 } } } },
          { name: 'inner', kind: 13, location: { uri: params.textDocument.uri, range: fn.range }, containerName: fn.name },
        ])
        return reply(id, [...flat.reverse(), { name: 'elsewhere', kind: 12, location: { uri: 'file:///elsewhere.fk', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }])
      }
      return reply(id, functions(params.textDocument.uri, doc.text).map((fn) => ({ name: fn.name, kind: 12, range: { start: { line: fn.line, character: 0 }, end: { line: fn.line + 1, character: 0 } }, selectionRange: fn.range, children: [{ name: 'inner', kind: 13, range: fn.range, selectionRange: fn.range }] })))
    }
    case 'textDocument/foldingRange': {
      const doc = docs.get(params.textDocument.uri)
      return reply(id, doc ? foldingRanges(doc.text) : null)
    }
    case 'textDocument/inlayHint': {
      const doc = docs.get(params.textDocument.uri)
      return reply(id, doc ? inlayHints(doc.text, params.range.start.line, params.range.end.line) : null)
    }
    case 'textDocument/semanticTokens/full': {
      const doc = docs.get(params.textDocument.uri)
      return reply(id, doc ? semanticTokens(doc.text) : null)
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
      const item = { name: end === 'from' ? 'caller' : 'callee', kind: 12, uri: params.item.uri, range: params.item.range, selectionRange: params.item.range, detail: params.item.name }
      return reply(id, [{ [end]: item, fromRanges: [params.item.selectionRange] }])
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
    case 'textDocument/completion': {
      const doc = docs.get(params.textDocument.uri)
      if (!doc) return reply(id, null)
      const line = doc.text.split(/\r?\n/)[params.position.line] || ''
      let start = params.position.character
      while (start > 0 && /\w/.test(line[start - 1])) start--
      let end = params.position.character
      while (end < line.length && /\w/.test(line[end])) end++
      const at = (character) => ({ line: params.position.line, character })
      if (params.context && params.context.triggerCharacter === '.') {
        return reply(id, [
          { label: 'length', kind: 10, detail: 'number', textEdit: { range: { start: at(start), end: at(params.position.character) }, newText: 'length' } },
          { label: 'push', kind: 2, detail: '(item) => number', insertText: 'push($1)', insertTextFormat: 2 },
        ])
      }
      const names = []
      for (const [uri, other] of texts()) for (const fn of functions(uri, other.text)) if (!names.includes(fn.name)) names.push(fn.name)
      const items = names.map((name) => ({ label: name, kind: 3, labelDetails: { detail: '()' }, insertText: name + '($1)', insertTextFormat: 2, sortText: '1' + name }))
      items.push({ label: 'function', kind: 14, sortText: '2function' })
      items.push({ label: 'helper', kind: 3, labelDetails: { description: './helpers' }, sortText: '3helper', data: { name: 'helper' } })
      items.push({ label: 'oldThing', kind: 6, tags: [1], sortText: '4oldThing' })
      return reply(id, { isIncomplete: mode === 'incomplete', itemDefaults: { editRange: { insert: { start: at(start), end: at(params.position.character) }, replace: { start: at(start), end: at(end) } }, commitCharacters: ['('] }, items })
    }
    case 'completionItem/resolve': {
      const item = Object.assign({}, params, { documentation: { kind: 'markdown', value: '**' + params.label + '** does a thing.' } })
      if (params.data && params.data.name === 'helper') item.additionalTextEdits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import helper\n' }]
      return reply(id, item)
    }
    case 'textDocument/signatureHelp': {
      const doc = docs.get(params.textDocument.uri)
      const line = doc ? doc.text.split(/\r?\n/)[params.position.line] || '' : ''
      const before = line.slice(0, params.position.character)
      const open = before.lastIndexOf('(')
      if (open < 0) return reply(id, null)
      const name = (/(\w+)\s*$/.exec(before.slice(0, open)) || [])[1]
      if (!name) return reply(id, null)
      const label = name + '(a: number, b: string)'
      const commas = (before.slice(open + 1).match(/,/g) || []).length
      return reply(id, { signatures: [{ label, documentation: 'Calls ' + name + '.', parameters: [{ label: [name.length + 1, name.length + 10], documentation: 'the first' }, { label: 'b: string' }] }], activeSignature: 0, activeParameter: Math.min(commas, 1) })
    }
    case 'textDocument/documentHighlight': {
      const doc = docs.get(params.textDocument.uri)
      const found = doc && wordAt(doc.text, params.position)
      if (!found) return reply(id, [])
      const out = []
      doc.text.split(/\r?\n/).forEach((line, index) => {
        const re = new RegExp('\\b' + found.word + '\\b', 'g')
        let match
        while ((match = re.exec(line))) out.push({ range: { start: { line: index, character: match.index }, end: { line: index, character: match.index + found.word.length } }, kind: line.slice(0, match.index).endsWith('function ') ? 3 : 2 })
      })
      return reply(id, out)
    }
    case 'textDocument/formatting':
    case 'textDocument/rangeFormatting': {
      const doc = docs.get(params.textDocument.uri)
      if (!doc) return reply(id, null)
      if (doc.text.includes('FORMAT_FAILS')) return fail(id, -32603, 'The formatter broke')
      return reply(id, formatEdits(doc.text, params.options, method === 'textDocument/rangeFormatting' ? params.range : null))
    }
    case 'textDocument/onTypeFormatting': {
      // The spaces before the character typed go: "a = 1  ;" becomes "a = 1;".
      const doc = docs.get(params.textDocument.uri)
      const line = doc ? doc.text.split(/\r?\n/)[params.position.line] || '' : ''
      const before = line.slice(0, params.position.character - 1)
      const spaces = /\s+$/.exec(before)
      if (!spaces) return reply(id, [])
      return reply(id, [{ range: { start: { line: params.position.line, character: spaces.index }, end: { line: params.position.line, character: before.length } }, newText: '' }])
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
      const running = children.filter((child) => child.exitCode === null && child.signalCode === null)
      for (const child of running) child.kill('SIGKILL')
      // Windows keeps a folder busy while a process that ran in it is still going away.
      await Promise.all(running.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(resolve, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })))
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}
