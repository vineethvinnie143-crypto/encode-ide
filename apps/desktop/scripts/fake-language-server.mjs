/**
 * A small language server for the end-to-end smoke: the real wire format (JSON-RPC 2.0 framed by Content-Length
 * headers) on standard input and output, standard error for logs. It keeps the text of the documents it is given and
 * reports an error on each line with ERROR in it and a warning on each line with WARN in it.
 *
 * It also answers the editor the way a real server does, from the words of its documents: suggestions (the words, a
 * `log` snippet and `greet`, which brings an import once filled in), the parameters of a call to a `function` it
 * has seen, hover, definitions (the `function` line), references and the other places of a word.
 *
 *   node scripts/fake-language-server.mjs --stdio [--marker=file]
 *
 * With a marker file, the server appends a line when it starts, one for each document it is given or loses, and one
 * when it is told to exit, so that the smoke can tell that the app started it, kept it on the editor's text and
 * stopped it.
 */
import fs from 'node:fs'

const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const marker = option('marker')
const mark = (text) => {
  if (marker) fs.appendFileSync(marker, `${text}\n`)
}

const docs = new Map()
let buffer = Buffer.alloc(0)
let shutdown = false

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const nameOf = (uri) => decodeURIComponent(uri.split('/').pop() ?? uri)

function diagnosticsOf(text) {
  const out = []
  text.split(/\r?\n/).forEach((line, index) => {
    const error = line.indexOf('ERROR')
    if (error >= 0) out.push({ range: { start: { line: index, character: error }, end: { line: index, character: error + 5 } }, severity: 1, message: 'Something is wrong here', source: 'fake-ts', code: 'E1' })
    const warn = line.indexOf('WARN')
    if (warn >= 0) out.push({ range: { start: { line: index, character: warn }, end: { line: index, character: warn + 4 } }, severity: 2, message: 'This could be better', source: 'fake-ts', code: 'W1' })
  })
  return out
}

function publish(uri) {
  const doc = docs.get(uri)
  if (doc) notify('textDocument/publishDiagnostics', { uri, version: doc.version, diagnostics: diagnosticsOf(doc.text) })
}

// ------------------------------------------------------------ what the editor asks

const WORD = /[A-Za-z_$][\w$]*/g
const lineOf = (uri, line) => (docs.get(uri)?.text ?? '').split(/\r?\n/)[line] ?? ''

/** The word at a position, with where it starts and ends on its line. */
function wordAt(uri, { line, character }) {
  const text = lineOf(uri, line)
  for (const match of text.matchAll(WORD)) {
    if (match.index <= character && character <= match.index + match[0].length) return { word: match[0], start: match.index, end: match.index + match[0].length }
  }
  return null
}

/** Every whole-word place of `word` in the open documents, by document. */
function placesOf(word, only) {
  const out = []
  for (const [uri, doc] of docs) {
    if (only && uri !== only) continue
    doc.text.split(/\r?\n/).forEach((text, line) => {
      for (const match of text.matchAll(WORD)) {
        if (match[0] === word) out.push({ uri, line, start: match.index, end: match.index + word.length, text })
      }
    })
  }
  return out
}

/** `function name(a: number, b: number): number` as the server read it, or null. */
function declaration(name) {
  for (const [uri, doc] of docs) {
    const lines = doc.text.split(/\r?\n/)
    for (let line = 0; line < lines.length; line++) {
      const match = new RegExp(`function\\s+(${name})\\s*\\(([^)]*)\\)(\\s*:\\s*[^{]+)?`).exec(lines[line])
      if (match) {
        const start = match.index + match[0].indexOf(name)
        return { uri, line, start, end: start + name.length, params: match[2].split(',').map((item) => item.trim()).filter(Boolean), returns: (match[3] ?? '').replace(/^\s*:\s*/, '').trim() }
      }
    }
  }
  return null
}

const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } })

function completion({ textDocument, position }) {
  const text = lineOf(textDocument.uri, position.line)
  let from = position.character
  while (from > 0 && /[\w$]/.test(text[from - 1])) from--
  const prefix = text.slice(from, position.character)
  const words = new Set()
  for (const doc of docs.values()) for (const match of doc.text.matchAll(WORD)) if (match[0] !== prefix) words.add(match[0])
  const items = [...words].map((word) => {
    const found = declaration(word)
    return found ? { label: word, kind: 3, detail: `function ${word}(${found.params.join(', ')})${found.returns ? `: ${found.returns}` : ''}`, labelDetails: { detail: `(${found.params.join(', ')})` } } : { label: word, kind: 6 }
  })
  items.push({ label: 'log', kind: 15, detail: 'console.log(value)', insertTextFormat: 2, insertText: 'console.log(${1:value})$0', filterText: 'log' })
  // Filled in only when asked: its documentation and the import it needs.
  items.push({ label: 'greet', kind: 3, labelDetails: { description: './greet' }, data: { item: 'greet' } })
  return { isIncomplete: false, items }
}

function resolveItem(item) {
  if (item.data?.item !== 'greet') return item
  return {
    ...item,
    detail: 'function greet(name: string): string',
    documentation: { kind: 'markdown', value: 'Says hello to **someone**.\n\n```ts\ngreet("Ada")\n```' },
    additionalTextEdits: [{ range: range(0, 0, 0), newText: "import { greet } from './greet'\n" }],
  }
}

function signatureHelp({ textDocument, position }) {
  const before = lineOf(textDocument.uri, position.line).slice(0, position.character)
  // The innermost call still open before the cursor.
  let depth = 0
  for (let index = before.length - 1; index >= 0; index--) {
    const char = before[index]
    if (char === ')') depth++
    else if (char === '(') {
      if (depth) {
        depth--
        continue
      }
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(before.slice(0, index))?.[1]
      const found = name ? declaration(name) : null
      if (!found) return null
      const label = `${name}(${found.params.join(', ')})${found.returns ? `: ${found.returns}` : ''}`
      let offset = name.length + 1
      const parameters = found.params.map((param, at) => {
        const start = offset
        offset += param.length + 2
        return { label: [start, start + param.length], documentation: `Parameter ${at + 1} of ${name}.` }
      })
      const active = before.slice(index + 1).split(',').length - 1
      return { signatures: [{ label, documentation: { kind: 'markdown', value: `Calls **${name}**.` }, parameters }], activeSignature: 0, activeParameter: Math.min(active, Math.max(0, parameters.length - 1)) }
    }
  }
  return null
}

function hover({ textDocument, position }) {
  const at = wordAt(textDocument.uri, position)
  if (!at) return null
  const found = declaration(at.word)
  const value = found ? `\`\`\`ts\nfunction ${at.word}(${found.params.join(', ')})${found.returns ? `: ${found.returns}` : ''}\n\`\`\`\nDefined on line ${found.line + 1}.` : `**${at.word}**`
  return { contents: { kind: 'markdown', value }, range: range(position.line, at.start, at.end) }
}

function definition({ textDocument, position }) {
  const at = wordAt(textDocument.uri, position)
  const found = at ? declaration(at.word) : null
  return found ? [{ uri: found.uri, range: range(found.line, found.start, found.end) }] : []
}

function references({ textDocument, position }) {
  const at = wordAt(textDocument.uri, position)
  return at ? placesOf(at.word).map((place) => ({ uri: place.uri, range: range(place.line, place.start, place.end) })) : []
}

function highlights({ textDocument, position }) {
  const at = wordAt(textDocument.uri, position)
  if (!at) return []
  return placesOf(at.word, textDocument.uri).map((place) => ({ range: range(place.line, place.start, place.end), kind: /^\s*=[^=]/.test(place.text.slice(place.end)) ? 3 : 2 }))
}

function handle(message) {
  // An answer to a request of ours: this server asks nothing, so there is nothing to do.
  if (message.method === undefined) return
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      mark('start')
      return reply(id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
          signatureHelpProvider: { triggerCharacters: ['('], retriggerCharacters: [','] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentHighlightProvider: true,
        },
        serverInfo: { name: 'fake-ts', version: '1' },
      })
    case 'initialized':
      notify('window/logMessage', { type: 3, message: 'fake-ts is ready' })
      return
    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version })
      mark(`open ${nameOf(params.textDocument.uri)}`)
      return publish(params.textDocument.uri)
    case 'textDocument/didChange': {
      const doc = docs.get(params.textDocument.uri)
      if (!doc) return
      for (const change of params.contentChanges) if (!change.range) doc.text = change.text
      doc.version = params.textDocument.version
      return publish(params.textDocument.uri)
    }
    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri)
      mark(`close ${nameOf(params.textDocument.uri)}`)
      return
    case 'textDocument/completion':
      return reply(id, completion(params))
    case 'completionItem/resolve':
      return reply(id, resolveItem(params))
    case 'textDocument/signatureHelp':
      return reply(id, signatureHelp(params))
    case 'textDocument/hover':
      return reply(id, hover(params))
    case 'textDocument/definition':
      return reply(id, definition(params))
    case 'textDocument/references':
      return reply(id, references(params))
    case 'textDocument/documentHighlight':
      return reply(id, highlights(params))
    case 'shutdown':
      shutdown = true
      return reply(id, null)
    case 'exit':
      mark('exit')
      process.exit(shutdown ? 0 : 1)
      return
    default:
      if (id !== undefined) fail(id, -32601, `${method} is not supported`)
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1])
    if (!Number.isFinite(length)) {
      process.stderr.write('fake-ts: a message without a Content-Length header\n')
      process.exit(1)
    }
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8')
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write('fake-ts: started\n')
