/**
 * A small language server for the end-to-end smoke: the real wire format (JSON-RPC 2.0 framed by Content-Length
 * headers) on standard input and output, standard error for logs. It keeps the text of the documents it is given and
 * reports an error on each line with ERROR in it and a warning on each line with WARN in it.
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

function handle(message) {
  // An answer to a request of ours: this server asks nothing, so there is nothing to do.
  if (message.method === undefined) return
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      mark('start')
      return reply(id, { capabilities: { textDocumentSync: { openClose: true, change: 1, save: { includeText: false } } }, serverInfo: { name: 'fake-ts', version: '1' } })
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
