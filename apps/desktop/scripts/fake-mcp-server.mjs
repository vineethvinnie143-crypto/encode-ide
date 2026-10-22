/**
 * A small MCP server for the end-to-end smoke: JSON-RPC 2.0, one message per line on standard input and output
 * (the stdio transport), standard error for logs. It offers two tools, `echo` and `add`, and some instructions.
 *
 *   node scripts/fake-mcp-server.mjs [--note=text] [--marker=file]
 *
 * The note is repeated in its instructions, so that the smoke can tell that a change to the entry really started a
 * different server. With a marker file, the server appends a line when it starts and another when its input closes
 * (an orderly stop), so that the smoke can tell which servers ran, how often, and that they were stopped.
 */
import fs from 'node:fs'
import readline from 'node:readline'

const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const note = option('note') ?? 'plain'
const marker = option('marker')
const mark = (text) => {
  if (marker) fs.appendFileSync(marker, `${text}\n`)
}

const tools = [
  {
    name: 'echo',
    description: 'Repeats the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    annotations: { readOnlyHint: true },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function answer(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function refuse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function call(id, params) {
  const input = params?.arguments ?? {}
  if (params?.name === 'echo') return answer(id, { content: [{ type: 'text', text: `echo: ${String(input.text ?? '')}` }] })
  if (params?.name === 'add') return answer(id, { content: [{ type: 'text', text: `sum: ${Number(input.a) + Number(input.b)}` }] })
  return refuse(id, -32602, `Unknown tool: ${params?.name}`)
}

process.stderr.write(`fake mcp server started (${note})\n`)
mark('started')

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (id === undefined) return // a notification
  switch (method) {
    case 'initialize':
      return answer(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        instructions: `Prefer the echo tool when you are asked to repeat something. Note: ${note}.`,
      })
    case 'ping':
      return answer(id, {})
    case 'tools/list':
      return answer(id, { tools })
    case 'tools/call':
      return call(id, params)
    case 'resources/list':
      return answer(id, { resources: [] })
    case 'prompts/list':
      return answer(id, { prompts: [] })
    default:
      return refuse(id, -32601, `Method not found: ${method}`)
  }
})
// A server ends when its input does.
lines.on('close', () => {
  mark('stopped')
  process.exit(0)
})
