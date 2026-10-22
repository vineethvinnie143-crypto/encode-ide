import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { McpClient } from './client'
import { Connection, ConnectionClosedError, ProtocolError, type JsonRpcMessage } from './jsonrpc'
import { serverEnvironment } from './program'
import { StdioTransport, type StdioOptions } from './stdio'

/**
 * Real child processes: a small MCP server written in JavaScript, run by the
 * same Node that runs the tests (so there is nothing to find on a PATH).
 */

const SERVER = String.raw`
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const mode = process.argv[2] || ''
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
process.stderr.write('server starting\n')
if (mode === 'noisy') process.stdout.write('Welcome to the demo server v1\n\n')
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  process.stderr.write('pids ' + process.pid + ' ' + grandchild.pid + '\n')
  setInterval(() => {}, 1000)
}
if (mode === 'flood') process.stdout.write('{"jsonrpc":"2.0","method":"x","params":"' + 'a'.repeat(5000))
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'child', version: '1' } })
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: [{ name: 'where', description: 'Says where it runs', inputSchema: { type: 'object' } }] })
  } else if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), env: process.env }) }] })
  } else if (message.method === 'ping') {
    reply(message.id, {})
  } else if (message.method === 'die') {
    process.stderr.write('fatal: something broke\n')
    process.exit(3)
  }
})
`

let dir: string
let script: string

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'encode-mcp-stdio-'))
  script = path.join(dir, 'server.cjs')
  await writeFile(script, SERVER)
  await mkdir(path.join(dir, 'work'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function transport(mode: string, overrides: Partial<StdioOptions> = {}) {
  return new StdioTransport({
    target: { file: process.execPath, args: [script, mode] },
    env: serverEnvironment(process.env, {}, process.platform),
    cwd: path.join(dir, 'work'),
    graceMs: 150,
    ...overrides,
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return true
}

async function dead(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true
    // A process nobody has collected yet still answers to a signal on Linux; its state says it is over.
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return true
      } catch {
        return true
      }
    }
    await wait(50)
  }
  return false
}

describe('stdio servers', () => {
  it('talks to a program: handshake, tools, a call, and a clean close', async () => {
    const stdio = transport('')
    const client = new McpClient({ transport: stdio, clientInfo: { name: 'encode', version: '1' } })
    const info = await client.connect()
    assert.equal(info.name, 'child')
    assert.deepEqual((await client.listTools()).items.map((t) => t.name), ['where'])
    const result = await client.callTool('where', {})
    const seen = JSON.parse((result.content[0] as { text: string }).text) as { cwd: string; env: Record<string, string> }
    assert.equal(path.basename(seen.cwd), 'work')
    const started = Date.now()
    await client.close()
    assert.ok(Date.now() - started < 1000, 'closing waited for the grace period although the program stops when its input ends')
  })

  it('starts the program with the environment it is given and not the rest', async () => {
    process.env.ENCODE_TEST_SECRET = 'do-not-leak'
    try {
      const stdio = new StdioTransport({
        target: { file: process.execPath, args: [script, ''] },
        env: serverEnvironment(process.env, { TOKEN: 'from-config' }, process.platform),
        cwd: dir,
      })
      const client = new McpClient({ transport: stdio, clientInfo: { name: 'encode', version: '1' } })
      await client.connect()
      const text = ((await client.callTool('where', {})).content[0] as { text: string }).text
      const env = (JSON.parse(text) as { env: Record<string, string> }).env
      assert.equal(env.TOKEN, 'from-config')
      assert.equal(env.ENCODE_TEST_SECRET, undefined)
      assert.ok(!text.includes('do-not-leak'))
      await client.close()
    } finally {
      delete process.env.ENCODE_TEST_SECRET
    }
  })

  it('skips what a program prints that is not a message, and keeps a little of it to show', async () => {
    const stdio = transport('noisy')
    const notices: string[] = []
    const client = new McpClient({ transport: stdio, clientInfo: { name: 'encode', version: '1' }, onNotice: (text) => notices.push(text) })
    await client.connect()
    assert.match(stdio.stderrTail(), /server starting/)
    assert.match(stdio.stderrTail(), /\[stdout\] Welcome to the demo server/)
    assert.deepEqual(notices, [])
    await client.close()
  })

  it('says why a program stopped, when it stops mid-request', async () => {
    const stdio = transport('')
    const connection = new Connection(stdio)
    const reasons: Array<Error | undefined> = []
    connection.onclose = (reason) => reasons.push(reason)
    await stdio.start()
    assert.deepEqual(await connection.request('ping'), {})
    await assert.rejects(connection.request('die', {}, { timeoutMs: 5000 }), ConnectionClosedError)
    assert.equal(reasons.length, 1)
    assert.match(reasons[0]?.message ?? '', /exited \(code 3\)[\s\S]*fatal: something broke/)
    await assert.rejects(stdio.send({ jsonrpc: '2.0', method: 'x' } satisfies JsonRpcMessage), ConnectionClosedError)
  })

  it('stops a program that ignores its closed input and a request to stop, and what it started', async () => {
    let pids: [number, number] | undefined
    const stdio = transport('stubborn', {
      onStderr: (text) => {
        const found = /pids (\d+) (\d+)/.exec(text)
        if (found) pids = [Number(found[1]), Number(found[2])]
      },
    })
    const client = new McpClient({ transport: stdio, clientInfo: { name: 'encode', version: '1' } })
    await client.connect()
    for (let i = 0; i < 100 && !pids; i++) await wait(20)
    assert.ok(pids, 'the program did not report its processes')
    assert.ok(alive(pids[0]) && alive(pids[1]))
    await client.close()
    assert.equal(await dead(pids[0]), true, 'the program is still running')
    assert.equal(await dead(pids[1]), true, 'what the program started is still running')
  })

  it('reports a program that cannot be started', async () => {
    const stdio = new StdioTransport({ target: { file: path.join(dir, 'no-such-program'), args: [] }, env: {}, cwd: dir })
    const client = new McpClient({ transport: stdio, clientInfo: { name: 'encode', version: '1' } })
    await assert.rejects(client.connect(), /Could not start the server/)
  })

  it('refuses a line longer than it allows, and ends the program', async () => {
    const errors: Error[] = []
    const stdio = transport('flood', { maxMessageBytes: 1024 })
    stdio.onerror = (error) => errors.push(error)
    await stdio.start()
    for (let i = 0; i < 100 && !errors.length; i++) await wait(20)
    assert.ok(errors[0] instanceof ProtocolError)
    await stdio.close()
  })

  it('does not send what is larger than it allows', async () => {
    const stdio = transport('', { maxMessageBytes: 1024 })
    await stdio.start()
    await assert.rejects(stdio.send({ jsonrpc: '2.0', method: 'x', params: { text: 'a'.repeat(2000) } }), ProtocolError)
    await stdio.close()
  })
})
