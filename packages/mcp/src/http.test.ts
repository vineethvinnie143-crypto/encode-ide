import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, it } from 'node:test'
import { McpClient } from './client'
import {
  AuthRequiredError,
  HttpStatusError,
  LegacySseTransport,
  SessionExpiredError,
  StreamableHttpTransport,
  headerProblem,
  parseServerUrl,
} from './http'
import { ProtocolError } from './jsonrpc'

/** Real HTTP servers on the loopback interface, so the transports meet real sockets, headers and streams. */

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  json: any
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void | Promise<void>

async function serve(handler: Handler) {
  const requests: Seen[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, json }
    requests.push(seen)
    await handler(req, res, seen)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    url: `${origin}/mcp`,
    requests,
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await wait(10)
  }
}

const INFO = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'http-demo', version: '1' } }

function json(res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function event(res: http.ServerResponse, body: unknown, name = 'message') {
  res.write(`event: ${name}\ndata: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`)
}

/** A server that speaks JSON for requests, with sessions; `extra` may answer a method itself. */
function jsonMcp(extra: (seen: Seen, res: http.ServerResponse) => boolean = () => false): Handler {
  return (req, res, seen) => {
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    if (req.method === 'GET') return void res.writeHead(405).end()
    if (extra(seen, res)) return
    const message = seen.json
    if (message.id === undefined) return void res.writeHead(202).end()
    if (message.method === 'initialize') return json(res, { jsonrpc: '2.0', id: message.id, result: INFO }, { 'mcp-session-id': 'session-1' })
    if (message.method === 'tools/list') return json(res, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })
    json(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}

const clientInfo = { name: 'encode', version: '1' }

describe('Streamable HTTP', () => {
  it('handshakes, repeats the session and protocol headers, sends the configured headers, and ends the session', async () => {
    const server = await serve(jsonMcp())
    try {
      const transport = new StreamableHttpTransport({ url: server.url, headers: { Authorization: 'Bearer abc', 'X-Team': 'core' }, userAgent: 'encode-test' })
      const client = new McpClient({ transport, clientInfo })
      await client.connect()
      assert.deepEqual((await client.listTools()).items.map((t) => t.name), ['echo'])
      await client.close()

      const posts = server.requests.filter((r) => r.method === 'POST')
      assert.equal(posts[0].headers.authorization, 'Bearer abc')
      assert.equal(posts[0].headers['x-team'], 'core')
      assert.equal(posts[0].headers['user-agent'], 'encode-test')
      assert.equal(posts[0].headers['content-type'], 'application/json')
      assert.match(String(posts[0].headers.accept), /application\/json/)
      assert.match(String(posts[0].headers.accept), /text\/event-stream/)
      assert.equal(posts[0].headers['mcp-session-id'], undefined)
      assert.equal(posts[0].headers['mcp-protocol-version'], undefined)
      for (const post of posts.slice(1)) {
        assert.equal(post.headers['mcp-session-id'], 'session-1')
        assert.equal(post.headers['mcp-protocol-version'], '2025-06-18')
      }
      const deleted = server.requests.find((r) => r.method === 'DELETE')
      assert.equal(deleted?.headers['mcp-session-id'], 'session-1')
    } finally {
      await server.stop()
    }
  })

  it('reads answers sent as an event stream, with progress and requests from the server along the way', async () => {
    const server = await serve(
      jsonMcp((seen, res) => {
        const message = seen.json
        if (message.method !== 'tools/call') return false
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        event(res, { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 1, total: 2 } })
        event(res, { jsonrpc: '2.0', id: 'server-1', method: 'roots/list' })
        event(res, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } }, 'unrelated')
        setTimeout(() => {
          event(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'streamed' }] } })
          res.end()
        }, 30)
        return true
      }),
    )
    try {
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo, roots: () => [{ path: '/work' }] })
      await client.connect()
      const progress: number[] = []
      const result = await client.callTool('anything', {}, { onProgress: (p) => progress.push(p.progress) })
      assert.deepEqual(result.content, [{ type: 'text', text: 'streamed' }])
      assert.deepEqual(progress, [1])
      // The client answered the server's request with a POST of its own.
      await until(() => server.requests.some((r) => r.json?.id === 'server-1'))
      assert.deepEqual(server.requests.find((r) => r.json?.id === 'server-1')?.json.result, { roots: [{ uri: 'file:///work' }] })
      await client.close()
    } finally {
      await server.stop()
    }
  })

  it('does not wait for ever for a request the server accepted but never answered, or a stream that ended early', async () => {
    const server = await serve(
      jsonMcp((seen, res) => {
        if (seen.json.method === 'resources/read') return void res.writeHead(202).end(), true
        if (seen.json.method === 'prompts/get') return void (res.writeHead(200, { 'content-type': 'text/event-stream' }), res.end()), true
        return false
      }),
    )
    try {
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo })
      await client.connect()
      await assert.rejects(client.readResource('x://y'), /never answered/)
      await assert.rejects(client.getPrompt('p'), /without answering/)
      await client.close()
    } finally {
      await server.stop()
    }
  })

  it('turns errors into messages: JSON-RPC errors in a 4xx body, other statuses, and a demand for credentials', async () => {
    const server = await serve(
      jsonMcp((seen, res) => {
        if (seen.json.method === 'resources/read') return json(res, { jsonrpc: '2.0', id: seen.json.id, error: { code: -32602, message: 'Unknown resource' } }, {}, 400), true
        if (seen.json.method === 'prompts/get') return void res.writeHead(500, { 'content-type': 'text/plain' }).end('database is\non fire'), true
        if (seen.json.method === 'tools/list') return void res.writeHead(401, { 'www-authenticate': 'Bearer realm="demo"' }).end(), true
        return false
      }),
    )
    try {
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo })
      await client.connect()
      await assert.rejects(client.readResource('x://y'), /Unknown resource/)
      await assert.rejects(client.getPrompt('p'), /HTTP 500: database is on fire/)
      await assert.rejects(client.listTools(), (error: Error) => error instanceof AuthRequiredError && error.status === 401 && /"headers"/.test(error.message) && error.challenge === 'Bearer realm="demo"')
      await client.close()
    } finally {
      await server.stop()
    }
  })

  it('never follows a redirect, so the configured headers go nowhere else', async () => {
    const elsewhere = await serve((_req, res) => json(res, { jsonrpc: '2.0', id: 1, result: INFO }))
    const server = await serve((_req, res) => void res.writeHead(307, { location: `${elsewhere.origin}/mcp` }).end())
    try {
      const transport = new StreamableHttpTransport({ url: server.url, headers: { Authorization: 'Bearer secret' } })
      const client = new McpClient({ transport, clientInfo })
      await assert.rejects(client.connect(), /redirected the request to http:\/\/127\.0\.0\.1:\d+\/mcp.*does not follow redirects/)
      assert.equal(elsewhere.requests.length, 0)
    } finally {
      await server.stop()
      await elsewhere.stop()
    }
  })

  it('ends when the server forgets the session', async () => {
    let forget = false
    const server = await serve(jsonMcp((_seen, res) => (forget ? (res.writeHead(404).end(), true) : false)))
    try {
      const closed: Array<Error | undefined> = []
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo, onClose: (reason) => closed.push(reason) })
      await client.connect()
      forget = true
      await assert.rejects(client.listTools(), /server ended the session/)
      await until(() => closed.length === 1)
      assert.ok(closed[0] instanceof SessionExpiredError)
    } finally {
      await server.stop()
    }
  })

  it('listens for what the server says unprompted, and lets go of the stream when closed', async () => {
    let streamClosed = false
    let stream: http.ServerResponse | undefined
    const server = await serve((req, res, seen) => {
      if (req.method === 'GET') {
        stream = res
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': open\n\n')
        res.on('close', () => (streamClosed = true))
        return
      }
      return jsonMcp()(req, res, seen)
    })
    try {
      const changes: string[] = []
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo, onChanged: (what) => changes.push(what) })
      await client.connect()
      await until(() => stream !== undefined)
      assert.equal(server.requests.find((r) => r.method === 'GET')?.headers['mcp-session-id'], 'session-1')
      event(stream!, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      await until(() => changes.length === 1)
      assert.deepEqual(changes, ['tools'])
      const started = Date.now()
      await client.close()
      await until(() => streamClosed)
      assert.ok(Date.now() - started < 1500)
    } finally {
      await server.stop()
    }
  })

  it('treats a server with no stream of its own as one with nothing to say', async () => {
    const server = await serve(jsonMcp())
    try {
      const errors: string[] = []
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url }), clientInfo, onNotice: (text) => errors.push(text) })
      await client.connect()
      await wait(100)
      assert.equal(server.requests.filter((r) => r.method === 'GET').length, 1)
      assert.deepEqual(errors, [])
      await client.close()
    } finally {
      await server.stop()
    }
  })

  it('gives up on a server that is slow to start answering, but not on a stream that is slow afterwards', async () => {
    const server = await serve((req, res, seen) => {
      if (seen.json?.method === 'initialize' && req.headers['x-mode'] === 'silent') return
      if (seen.json?.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        setTimeout(() => {
          event(res, { jsonrpc: '2.0', id: seen.json.id, result: { content: [{ type: 'text', text: 'late but fine' }] } })
          res.end()
        }, 150)
        return
      }
      return jsonMcp()(req, res, seen)
    })
    try {
      const silent = new McpClient({ transport: new StreamableHttpTransport({ url: server.url, headers: { 'x-mode': 'silent' }, headerTimeoutMs: 50 }), clientInfo })
      await assert.rejects(silent.connect(), /did not answer within/)

      const patient = new McpClient({ transport: new StreamableHttpTransport({ url: server.url, headerTimeoutMs: 50 }), clientInfo })
      await patient.connect()
      assert.deepEqual((await patient.callTool('slow', {})).content, [{ type: 'text', text: 'late but fine' }])
      await patient.close()
    } finally {
      await server.stop()
    }
  })

  it('refuses answers that are too large or not JSON', async () => {
    const server = await serve(
      jsonMcp((seen, res) => {
        if (seen.json.method === 'resources/read') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'), true
        if (seen.json.method === 'prompts/get') return json(res, { jsonrpc: '2.0', id: seen.json.id, result: { messages: [{ role: 'user', content: { type: 'text', text: 'x'.repeat(2000) } }] } }), true
        return false
      }),
    )
    try {
      const client = new McpClient({ transport: new StreamableHttpTransport({ url: server.url, maxMessageBytes: 1000 }), clientInfo })
      await client.connect()
      await assert.rejects(client.readResource('x://y'), (error: Error) => error instanceof ProtocolError && /text\/html/.test(error.message))
      await assert.rejects(client.getPrompt('p'), /too large/)
      await client.close()
    } finally {
      await server.stop()
    }
  })
})

describe('legacy HTTP with SSE', () => {
  function legacy(options: { endpoint?: string } = {}) {
    const streams = new Set<http.ServerResponse>()
    let closedStreams = 0
    const handler: Handler = (req, res, seen) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        event(res, options.endpoint ?? '/messages?session=1', 'endpoint')
        streams.add(res)
        res.on('close', () => {
          streams.delete(res)
          closedStreams++
        })
        return
      }
      res.writeHead(202).end('Accepted')
      const message = seen.json
      if (message.id === undefined) return
      const answer = message.method === 'initialize' ? { ...INFO, protocolVersion: '2024-11-05' } : message.method === 'tools/list' ? { tools: [{ name: 'old', inputSchema: { type: 'object' } }] } : {}
      for (const stream of streams) event(stream, { jsonrpc: '2.0', id: message.id, result: answer })
    }
    return { handler, streams, closed: () => closedStreams }
  }

  it('finds the address to post to, takes answers from the stream, and closes it', async () => {
    const fake = legacy()
    const server = await serve(fake.handler)
    try {
      const client = new McpClient({ transport: new LegacySseTransport({ url: `${server.origin}/sse`, headers: { 'X-Key': 'k' } }), clientInfo })
      const info = await client.connect()
      assert.equal(info.protocolVersion, '2024-11-05')
      assert.deepEqual((await client.listTools()).items.map((t) => t.name), ['old'])
      const posts = server.requests.filter((r) => r.method === 'POST')
      assert.ok(posts.every((p) => p.url === '/messages?session=1' && p.headers['x-key'] === 'k'))
      await client.close()
      await until(() => fake.closed() === 1)
    } finally {
      await server.stop()
    }
  })

  it('will not post to another site, whatever the server asks', async () => {
    for (const endpoint of ['http://127.0.0.1:1/steal', 'https://evil.example/messages', '//evil.example/x']) {
      const fake = legacy({ endpoint })
      const server = await serve(fake.handler)
      try {
        const client = new McpClient({ transport: new LegacySseTransport({ url: `${server.origin}/sse` }), clientInfo })
        await assert.rejects(client.connect(), /not the site that was configured/, endpoint)
        await until(() => fake.closed() === 1)
      } finally {
        await server.stop()
      }
    }
  })

  it('says so when the server is not one', async () => {
    const server = await serve((_req, res) => void res.writeHead(200, { 'content-type': 'text/plain' }).end('hello'))
    try {
      const client = new McpClient({ transport: new LegacySseTransport({ url: server.url }), clientInfo })
      await assert.rejects(client.connect(), /did not answer with an event stream/)
    } finally {
      await server.stop()
    }
    const missing = await serve((_req, res) => void res.writeHead(404).end('nope'))
    try {
      const client = new McpClient({ transport: new LegacySseTransport({ url: missing.url }), clientInfo })
      await assert.rejects(client.connect(), (error: Error) => error instanceof HttpStatusError && error.status === 404)
    } finally {
      await missing.stop()
    }
  })

  it('tells its owner when the server ends the stream', async () => {
    const fake = legacy()
    const server = await serve(fake.handler)
    try {
      const closed: Array<Error | undefined> = []
      const client = new McpClient({ transport: new LegacySseTransport({ url: `${server.origin}/sse` }), clientInfo, onClose: (reason) => closed.push(reason) })
      await client.connect()
      for (const stream of fake.streams) stream.end()
      await until(() => closed.length === 1)
      assert.match(closed[0]?.message ?? '', /closed the event stream/)
    } finally {
      await server.stop()
    }
  })
})

describe('addresses and headers', () => {
  it('accepts http and https URLs without credentials in them', () => {
    assert.ok(parseServerUrl('https://example.com/mcp') instanceof URL)
    assert.ok(parseServerUrl('http://localhost:8080/sse?x=1') instanceof URL)
    for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://user:pass@example.com/mcp', 'http://']) {
      assert.equal(typeof parseServerUrl(bad), 'string', bad)
    }
  })

  it('refuses headers that are not plain, and ones eNCode sets itself', () => {
    assert.equal(headerProblem({ Authorization: 'Bearer x', 'X-Custom-1': 'a b' }), null)
    assert.match(headerProblem({ 'bad name': 'x' }) ?? '', /not a header name/)
    assert.match(headerProblem({ 'X-A': 'one\r\nX-Injected: two' }) ?? '', /single line/)
    assert.match(headerProblem({ 'X-A': 'a\u0000b' }) ?? '', /single line/)
    for (const reserved of ['Host', 'content-type', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Accept', 'Content-Length', 'Transfer-Encoding']) {
      assert.match(headerProblem({ [reserved]: 'x' }) ?? '', /set by eNCode/, reserved)
    }
    assert.throws(() => new StreamableHttpTransport({ url: 'https://example.com', headers: { Host: 'evil' } }), /Cannot send these headers/)
    assert.throws(() => new LegacySseTransport({ url: 'ftp://example.com' }), /not supported/)
  })
})
