import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { tempWorkspace, testContext, textOf } from '../testing'
import { createWebAccess } from './access'
import {
  SearchError,
  braveProvider,
  createSearchProvider,
  domainOf,
  duckDuckGoProvider,
  exaProvider,
  excerptText,
  parallelArguments,
  parallelProvider,
  plainSnippet,
  tavilyProvider,
  toHits,
  type ParallelOptions,
  type SearchProvider,
  type SearchRequest,
} from './search'
import { webSearchTool } from './tools'

interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
  at: number
}

let server: http.Server
let elsewhere: http.Server
let origin = ''
let seen: Seen[] = []
let elsewhereSeen: Seen[] = []
/** What a request gets: the first of `replies` while there are any, else `reply`. */
let reply: { status: number; type?: string; body: string } = { status: 200, body: '{}' }
let replies: Array<typeof reply> = []

const local = { fetch: { allowAddress: () => true } }
const never = new AbortController().signal

function request(patch: Partial<SearchRequest> = {}): SearchRequest {
  return { query: 'node streams', limit: 8, signal: never, ...patch }
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const created = http.createServer(handler)
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve))
  return { server: created, origin: `http://127.0.0.1:${(created.address() as AddressInfo).port}` }
}

function readBody(incoming: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

before(async () => {
  const second = await listen(async (incoming, outgoing) => {
    elsewhereSeen.push({ method: incoming.method ?? '', path: incoming.url ?? '', headers: incoming.headers, body: await readBody(incoming), at: Date.now() })
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end('{"web":{"results":[]}}')
  })
  elsewhere = second.server
  const first = await listen(async (incoming, outgoing) => {
    seen.push({ method: incoming.method ?? '', path: incoming.url ?? '', headers: incoming.headers, body: await readBody(incoming), at: Date.now() })
    if (incoming.url?.startsWith('/moved')) {
      outgoing.writeHead(307, { location: `${second.origin}/stolen` })
      outgoing.end()
      return
    }
    const answer = replies.shift() ?? reply
    outgoing.writeHead(answer.status, { 'content-type': answer.type ?? 'application/json' })
    outgoing.end(answer.body)
  })
  server = first.server
  origin = first.origin
})

after(async () => {
  for (const created of [server, elsewhere]) {
    created.closeAllConnections()
    await new Promise<void>((resolve) => created.close(() => resolve()))
  }
})

beforeEach(() => {
  seen = []
  elsewhereSeen = []
  reply = { status: 200, body: '{}' }
  replies = []
})

const KEY_VALUE = 'secret-key'
const key = () => KEY_VALUE

describe('Brave Search', () => {
  const brave = () => braveProvider(key, { ...local, endpoint: `${origin}/res/v1/web/search` })

  it('sends the key in its header and reads titles, addresses and descriptions without markup', async () => {
    reply.body = JSON.stringify({
      web: {
        results: [
          { title: 'Node.js <strong>Streams</strong>', url: 'https://nodejs.org/api/stream.html', description: 'A <strong>stream</strong> is an abstract interface &amp; more' },
          { title: 'Duplicate', url: 'https://nodejs.org/api/stream.html/', description: 'same page' },
          { title: 'Not a web address', url: 'javascript:alert(1)', description: 'x' },
          { title: 'Vector<int>', url: 'https://cppreference.com/vector', description: '' },
        ],
      },
    })
    const hits = await brave().search(request())
    assert.deepEqual(hits, [
      { title: 'Node.js Streams', url: 'https://nodejs.org/api/stream.html', snippet: 'A stream is an abstract interface & more' },
      { title: 'Vector<int>', url: 'https://cppreference.com/vector', snippet: '' },
    ])
    assert.equal(seen.length, 1)
    const [call] = seen
    assert.equal(call.method, 'GET')
    assert.equal(call.headers['x-subscription-token'], 'secret-key')
    const url = new URL(call.path, origin)
    assert.equal(url.pathname, '/res/v1/web/search')
    assert.equal(url.searchParams.get('q'), 'node streams')
    assert.equal(url.searchParams.get('count'), '8')
    assert.equal(url.searchParams.get('text_decorations'), 'false')
  })

  it('turns one allowed domain and the blocked ones into operators, and filters again whatever comes back', async () => {
    reply.body = JSON.stringify({
      web: { results: [{ title: 'In', url: 'https://docs.example.com/a', description: '' }, { title: 'Out', url: 'https://other.dev/b', description: '' }] },
    })
    const hits = await brave().search(request({ allowedDomains: ['https://docs.example.com/docs'], blockedDomains: ['ads.example'] }))
    assert.deepEqual(hits.map((hit) => hit.title), ['In'])
    const q = new URL(seen[0].path, origin).searchParams.get('q')
    assert.equal(q, 'site:docs.example.com -site:ads.example node streams')
    assert.equal(new URL(seen[0].path, origin).searchParams.get('count'), '16', 'a longer page, since some results are dropped')
  })

  it('cuts a query that is too long at a word', async () => {
    await brave().search(request({ query: `${'word '.repeat(120)}end` }))
    const q = new URL(seen[0].path, origin).searchParams.get('q') ?? ''
    assert.ok(q.length <= 400 && !q.endsWith(' '), `${q.length}`)
  })
})

describe('Tavily', () => {
  const tavily = () => tavilyProvider(key, { ...local, endpoint: `${origin}/search` })

  it('posts the query with the key as a bearer token and the domains it understands', async () => {
    reply.body = JSON.stringify({
      answer: 'ignored',
      results: [
        { title: 'Tavily result', url: 'https://example.com/post', content: 'A long   content\nwith lines.', score: 0.9 },
        { title: '', url: 'https://example.org/untitled', content: 'x'.repeat(900) },
      ],
    })
    const hits = await tavily().search(request({ allowedDomains: ['example.com', 'example.org'] }))
    assert.equal(hits.length, 2)
    assert.deepEqual(hits[0], { title: 'Tavily result', url: 'https://example.com/post', snippet: 'A long content with lines.' })
    assert.equal(hits[1].title, 'example.org', 'the host stands in for a missing title')
    assert.equal(hits[1].snippet.length, 400)
    const [call] = seen
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.authorization, 'Bearer secret-key')
    assert.equal(call.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(call.body), {
      query: 'node streams',
      search_depth: 'basic',
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_domains: ['example.com', 'example.org'],
    })
  })

  it('passes blocked domains as exclusions', async () => {
    reply.body = JSON.stringify({ results: [] })
    await tavily().search(request({ blockedDomains: ['pinterest.com'] }))
    assert.deepEqual(JSON.parse(seen[0].body).exclude_domains, ['pinterest.com'])
  })
})

describe('Exa', () => {
  const exa = () => exaProvider(key, { ...local, endpoint: `${origin}/search` })

  it('posts the query with the key in x-api-key and takes the highlights as the snippet', async () => {
    reply.body = JSON.stringify({
      results: [
        { title: 'One', url: 'https://one.dev/', highlights: ['first part', 'second part'] },
        { title: 'Two', url: 'https://two.dev/', text: 'the page text' },
        { title: 'Three', url: 'https://three.dev/' },
      ],
    })
    const hits = await exa().search(request({ blockedDomains: ['spam.example'] }))
    assert.deepEqual(hits, [
      { title: 'One', url: 'https://one.dev/', snippet: 'first part … second part' },
      { title: 'Two', url: 'https://two.dev/', snippet: 'the page text' },
      { title: 'Three', url: 'https://three.dev/', snippet: '' },
    ])
    const [call] = seen
    assert.equal(call.headers['x-api-key'], 'secret-key')
    assert.deepEqual(JSON.parse(call.body), {
      query: 'node streams',
      type: 'auto',
      numResults: 8,
      excludeDomains: ['spam.example'],
      contents: { highlights: { maxCharacters: 400 } },
    })
  })
})

describe('what goes wrong with a keyed provider', () => {
  const providers: Array<[string, () => SearchProvider]> = [
    ['Brave Search', () => braveProvider(key, { ...local, endpoint: `${origin}/api` })],
    ['Tavily', () => tavilyProvider(key, { ...local, endpoint: `${origin}/api` })],
    ['Exa', () => exaProvider(key, { ...local, endpoint: `${origin}/api` })],
  ]

  const failure = async (make: () => SearchProvider): Promise<SearchError> => {
    try {
      await make().search(request())
    } catch (error) {
      assert.ok(error instanceof SearchError, String(error))
      return error
    }
    throw new assert.AssertionError({ message: 'the search did not fail' })
  }

  for (const [name, make] of providers) {
    it(`${name}: a refused key says so and points to Settings`, async () => {
      reply = { status: 401, body: JSON.stringify({ error: { detail: 'Invalid subscription token' }, detail: { error: 'Unauthorized: missing or invalid API key.' } }) }
      const error = await failure(make)
      assert.equal(error.kind, 'key')
      assert.match(error.message, new RegExp(`^${name} refused the API key \\(HTTP 401: .+\\)\\. Check it in Settings\\.$`))
    })

    it(`${name}: a provider that quotes the key it refused does not get it into the message`, async () => {
      reply = { status: 401, body: JSON.stringify({ detail: `Invalid API key: ${KEY_VALUE}. Create a new one.` }) }
      const error = await failure(make)
      assert.equal(error.kind, 'key')
      assert.doesNotMatch(error.message, new RegExp(KEY_VALUE))
      assert.match(error.message, /Invalid API key: \[the key\]\. Create a new one\./)
    })

    it(`${name}: a limit is told as a limit, and a broken service as unavailable`, async () => {
      reply = { status: 429, body: '{}' }
      assert.equal((await failure(make)).kind, 'limit')
      reply = { status: 432, body: '{}' }
      assert.equal((await failure(make)).kind, 'limit')
      reply = { status: 503, body: 'upstream down', type: 'text/plain' }
      assert.equal((await failure(make)).kind, 'unavailable')
    })

    it(`${name}: an answer that is not JSON, and a request the service refuses, fail with what it said`, async () => {
      reply = { status: 200, body: '<html>captive portal</html>', type: 'text/html' }
      const notJson = await failure(make)
      assert.equal(notJson.kind, 'failed')
      assert.match(notJson.message, /not JSON/)
      reply = { status: 422, body: JSON.stringify({ detail: [{ msg: 'query too short' }] }) }
      const refused = await failure(make)
      assert.equal(refused.kind, 'failed')
      assert.match(refused.message, /refused the search \(HTTP 422/)
    })

    it(`${name}: a redirect is not followed, so the key stays with the provider`, async () => {
      const redirecting = name === 'Brave Search' ? braveProvider(key, { ...local, endpoint: `${origin}/moved` }) : name === 'Tavily' ? tavilyProvider(key, { ...local, endpoint: `${origin}/moved` }) : exaProvider(key, { ...local, endpoint: `${origin}/moved` })
      await assert.rejects(redirecting.search(request()), (error: unknown) => error instanceof SearchError && /redirect/.test(error.message))
      assert.equal(elsewhereSeen.length, 0, 'the other server was contacted')
    })

    it(`${name}: no key means no request`, async () => {
      const keyless = name === 'Brave Search' ? braveProvider(() => '  ', { ...local, endpoint: `${origin}/api` }) : name === 'Tavily' ? tavilyProvider(() => '', { ...local, endpoint: `${origin}/api` }) : exaProvider(() => '', { ...local, endpoint: `${origin}/api` })
      await assert.rejects(keyless.search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'key' && /Add one in Settings/.test(error.message))
      assert.equal(seen.length, 0)
    })
  }

  it('never makes a keyed request to a private address unless the test widens the check', async () => {
    const guarded = braveProvider(key, { endpoint: `${origin}/api` })
    await assert.rejects(guarded.search(request()), (error: unknown) => error instanceof SearchError && /private or special-purpose/.test(error.message))
    assert.equal(seen.length, 0)
  })
})

describe('hits', () => {
  it('keeps angle brackets that are not markup, decodes entities and cuts long text', () => {
    assert.equal(plainSnippet('Use <b>Array&lt;T&gt;</b> and std::vector<int><br>done', 100), 'Use Array<T> and std::vector<int> done')
    assert.equal(plainSnippet('x'.repeat(50), 10), `${'x'.repeat(9)}…`)
    assert.equal(plainSnippet(42, 10), '')
  })

  it('reads a domain from what the model passes', () => {
    assert.equal(domainOf('Example.COM'), 'example.com')
    assert.equal(domainOf('https://www.example.com:8080/docs?q=1'), 'www.example.com')
    assert.equal(domainOf('*.example.com'), 'example.com')
    assert.equal(domainOf('  '), '')
  })

  it('stops at the limit and applies the allowed or blocked domains to subdomains too', () => {
    const raw = ['a.dev', 'b.dev', 'c.dev', 'docs.a.dev'].map((host) => ({ title: host, url: `https://${host}/`, snippet: '' }))
    assert.deepEqual(toHits(raw, { limit: 2 }).map((hit) => hit.title), ['a.dev', 'b.dev'])
    assert.deepEqual(toHits(raw, { limit: 9, allowedDomains: ['a.dev'] }).map((hit) => hit.title), ['a.dev', 'docs.a.dev'])
    assert.deepEqual(toHits(raw, { limit: 9, blockedDomains: ['a.dev'] }).map((hit) => hit.title), ['b.dev', 'c.dev'])
  })
})

describe('DuckDuckGo and the choice of provider', () => {
  const RESULTS = {
    status: 200,
    type: 'text/html',
    body: '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F">Node</a></div>',
  }
  // What a tester's computer got for every search, the first one included (2026-10-25).
  const CHALLENGE = { status: 202, type: 'text/html', body: '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form>' }
  // The address is read when a provider is made: the server has its port by then.
  const ddg = (patch: { gapMs?: number; now?: () => number } = {}) => duckDuckGoProvider({ ...local, endpoint: `${origin}/html/`, gapMs: 0, retryMs: 10, ...patch })

  it('reads result pages and says when the service limits it', async () => {
    reply = RESULTS
    const hits = await ddg().search(request())
    assert.deepEqual(hits, [{ title: 'Node', url: 'https://nodejs.org/', snippet: '' }])
    reply = { status: 202, type: 'text/html', body: '' }
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'limit' && /HTTP 202\). Try again in a few minutes/.test(error.message))
  })

  it('asks once more, after a wait, when it was slowed down', async () => {
    replies = [{ status: 202, type: 'text/html', body: '' }, RESULTS]
    assert.equal((await ddg().search(request())).length, 1)
    assert.equal(seen.length, 2)
    assert.ok(seen[1].at - seen[0].at >= 10, 'the second try waits')
    seen = []
    replies = [{ status: 429, body: '' }, { status: 429, body: '' }]
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'limit' && /HTTP 429/.test(error.message))
    assert.equal(seen.length, 2, 'one retry, no more')
  })

  it('says at once that a puzzle for a person blocks it, and asks nothing for a while after', async () => {
    let clock = 1_000_000
    const provider = ddg({ now: () => clock })
    reply = CHALLENGE
    await assert.rejects(provider.search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'limit' && /blocking searches from this computer: it answers every one with a picture puzzle .* Settings > Agent > Web search/.test(error.message))
    assert.equal(seen.length, 1, 'asking again does not solve a puzzle')
    reply = RESULTS
    await assert.rejects(provider.search(request()), /picture puzzle/)
    assert.equal(seen.length, 1, 'nothing is sent while the block is remembered')
    clock += 10 * 60_000
    assert.equal((await provider.search(request())).length, 1, 'after ten minutes it asks again')
    assert.equal(seen.length, 2)
    // The same page with HTTP 200 is the same puzzle.
    reply = { ...CHALLENGE, status: 200 }
    await assert.rejects(ddg().search(request()), /picture puzzle/)
  })

  it('tells a page about the puzzle from the puzzle', async () => {
    // A result about the challenge page is a result, not the challenge.
    reply = { ...RESULTS, body: `${RESULTS.body}<p>bots use DuckDuckGo too</p>` }
    assert.equal((await ddg().search(request())).length, 1)
    // A page with no results that is not a challenge is no results.
    reply = { status: 200, type: 'text/html', body: '<div class="no-results">No results.</div>' }
    assert.deepEqual(await ddg().search(request()), [])
  })

  it('searches one at a time, a moment apart, so a burst is not taken for a robot', async () => {
    reply = RESULTS
    const provider = ddg({ gapMs: 120 })
    const all = await Promise.all([provider.search(request()), provider.search(request({ query: 'two' })), provider.search(request({ query: 'three' }))])
    assert.deepEqual(all.map((hits) => hits.length), [1, 1, 1])
    assert.equal(seen.length, 3)
    assert.ok(seen[1].at - seen[0].at >= 110 && seen[2].at - seen[1].at >= 110, `${seen.map((one) => one.at - seen[0].at).join(', ')} ms`)
    // A search that fails does not hold up the next one, and one stopped while it waits stops at once.
    replies = [{ status: 500, body: '' }]
    await assert.rejects(provider.search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'unavailable')
    const stop = new AbortController()
    const waiting = provider.search(request({ signal: stop.signal }))
    stop.abort(new Error('stopped'))
    await assert.rejects(waiting, /stopped/)
    assert.equal((await provider.search(request())).length, 1)
  })

  it('creates the provider for an id and falls back to Parallel', () => {
    assert.equal(createSearchProvider('brave', key).id, 'brave')
    assert.equal(createSearchProvider('tavily', key).id, 'tavily')
    assert.equal(createSearchProvider('exa', key).id, 'exa')
    assert.equal(createSearchProvider('duckduckgo', key).id, 'duckduckgo')
    assert.equal(createSearchProvider('parallel', key).id, 'parallel')
    assert.equal(createSearchProvider('search:brave' as never, key).id, 'parallel')
  })

  it('searches through the chosen provider, which is asked on every search, and names its address for approval', async () => {
    let chosen: SearchProvider = tavilyProvider(key, { ...local, endpoint: `${origin}/tavily` })
    const web = createWebAccess({ searchProvider: () => chosen })
    reply.body = JSON.stringify({ results: [{ title: 'T', url: 'https://t.dev/', content: 'c' }] })
    assert.equal(web.searchTarget?.(), `${origin}/tavily`)
    const root = await tempWorkspace()
    const access = await webSearchTool.access({ query: 'x y' }, testContext(root, { web }))
    assert.deepEqual(access, { type: 'web', url: `${origin}/tavily` })
    const hits = await web.search('x y', { signal: never })
    assert.deepEqual(hits, [{ title: 'T', url: 'https://t.dev/', snippet: 'c' }])
    chosen = braveProvider(key, { ...local, endpoint: `${origin}/brave` })
    assert.equal(web.searchTarget?.(), `${origin}/brave`)
  })

  it('names Parallel when no provider was chosen', async () => {
    const root = await tempWorkspace()
    const access = await webSearchTool.access({ query: 'x y' }, testContext(root, { web: createWebAccess() }))
    assert.deepEqual(access, { type: 'web', url: 'https://search.parallel.ai/mcp' })
  })

  it('offers a free key when DuckDuckGo blocks or limits searches, and not when the service cannot be reached', async () => {
    reply = CHALLENGE
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.keyHelps && /Choose Parallel \(free, no key\) or add a free Tavily key/.test(error.message))
    reply = { status: 503, type: 'text/html', body: '' }
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'unavailable' && error.keyHelps)
    await assert.rejects(duckDuckGoProvider({ endpoint: `${origin}/html/`, gapMs: 0 }).search(request()), (error: unknown) => error instanceof SearchError && !error.keyHelps && /could not be reached/.test(error.message))
  })

  it('tells the model what went wrong in the words of the provider', async () => {
    const root = await tempWorkspace()
    const web = createWebAccess({ searchProvider: () => braveProvider(() => '', { ...local, endpoint: `${origin}/api` }) })
    const outcome = await webSearchTool.run({ query: 'x y' }, testContext(root, { web }))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /The web search failed: There is no API key for Brave Search\. Add one in Settings/)
  })
})

describe('Parallel', () => {
  interface Call {
    headers: http.IncomingHttpHeaders
    message: Record<string, any>
  }
  type Answer = (id: unknown, outgoing: http.ServerResponse) => void

  let mcp: http.Server
  let address = ''
  let calls: Call[] = []
  /** What a tools/call gets: the first of `answers` while there are any, else the results. */
  let answers: Answer[] = []
  let sessions = new Set<string>()
  let opened = 0
  let refuseOpen = false

  // The shape search.parallel.ai answered with from a tester's computer (2026-10-25): one excerpt per page, in
  // markdown, which can begin in the middle of a word and hold a zero-width space.
  const RESULTS = {
    search_id: 'search_1',
    results: [
      {
        url: 'https://docs.example.com/ddos',
        title: 'DDoS protection',
        publish_date: null,
        excerpts: ['ion\n\n## \u200B\n\nProtection modes\n\n* Basic protection is **free**.\n> See [the form](https://example.com/form).'],
      },
      { url: 'https://example.com/b', title: null, publish_date: '2025-10-10', excerpts: ['Second'] },
      { url: 'ftp://example.com/c', title: 'Not the web', excerpts: ['x'] },
    ],
    warnings: null,
    metadata: null,
    session_id: 'encode-test',
  }
  const HITS = [
    { title: 'DDoS protection', url: 'https://docs.example.com/ddos', snippet: 'Protection modes Basic protection is free. See the form.' },
    { title: 'example.com', url: 'https://example.com/b', snippet: 'Second' },
  ]
  const rpc = (outgoing: http.ServerResponse, value: unknown, status = 200) => {
    outgoing.writeHead(status, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify(value))
  }
  const toolResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result })

  before(async () => {
    const made = await listen(async (incoming, outgoing) => {
      const message = JSON.parse(await readBody(incoming)) as Record<string, any>
      calls.push({ headers: incoming.headers, message })
      if (message.method === 'initialize') {
        if (refuseOpen) return void outgoing.writeHead(503).end()
        const id = `session-${++opened}`
        sessions.add(id)
        outgoing.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id })
        outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }))
        return
      }
      // As the MCP rules say, a session the server does not know is answered with 404.
      if (!sessions.has(String(incoming.headers['mcp-session-id']))) return void outgoing.writeHead(404).end()
      if (message.method === 'notifications/initialized') return void outgoing.writeHead(202).end()
      const answer = answers.shift()
      if (answer) return answer(message.id, outgoing)
      rpc(outgoing, toolResult(message.id, { content: [{ type: 'text', text: JSON.stringify(RESULTS, null, 2) }], isError: false, structuredContent: RESULTS }))
    })
    mcp = made.server
    address = made.origin
  })
  after(() => new Promise<void>((resolve) => mcp.close(() => resolve())))
  beforeEach(() => {
    calls = []
    answers = []
    sessions = new Set()
    opened = 0
    refuseOpen = false
  })

  const parallel = (patch: Partial<ParallelOptions> = {}) => parallelProvider({ ...local, endpoint: `${address}/mcp`, sessionId: 'encode-test', ...patch })
  const methods = () => calls.map((call) => call.message.method)

  it('opens an MCP session once, asks web_search with the query, and reads the excerpts as plain words', async () => {
    const provider = parallel()
    assert.equal(provider.id, 'parallel')
    assert.deepEqual(await provider.search(request({ query: 'gcore "ddos" protection' })), HITS)
    assert.deepEqual(methods(), ['initialize', 'notifications/initialized', 'tools/call'])
    const [open, ready, call] = calls
    assert.equal(open.message.params.protocolVersion, '2025-06-18')
    assert.equal(open.headers['mcp-session-id'], undefined)
    assert.equal(ready.headers['mcp-session-id'], 'session-1')
    assert.equal(call.headers['mcp-session-id'], 'session-1')
    assert.equal(call.headers['mcp-protocol-version'], '2025-06-18')
    assert.match(String(call.headers.accept), /application\/json/)
    assert.match(String(call.headers['user-agent']), /^eNCode\//)
    assert.equal(call.headers.authorization, undefined, 'no key, and nothing that says who is searching')
    assert.deepEqual(call.message.params, {
      name: 'web_search',
      // Its keyword queries may not hold quoted phrases; the objective keeps the query as it was.
      arguments: { objective: 'gcore "ddos" protection', search_queries: ['gcore ddos protection'], session_id: 'encode-test' },
    })

    // The next search uses the same session.
    await provider.search(request())
    assert.deepEqual(methods().slice(3), ['tools/call'])
    assert.equal(opened, 1)
  })

  it('reads the results from the text when there is no structured content, and from an event stream', async () => {
    answers = [
      (id, outgoing) => rpc(outgoing, toolResult(id, { content: [{ type: 'text', text: JSON.stringify(RESULTS) }], isError: false })),
      (id, outgoing) => {
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        outgoing.end(`event: message\ndata: ${JSON.stringify(toolResult(id, { content: [], structuredContent: RESULTS }))}\n\n`)
      },
    ]
    const provider = parallel()
    assert.deepEqual(await provider.search(request()), HITS)
    assert.deepEqual(await provider.search(request()), HITS)
  })

  it('makes a few allowed domains into site: queries, and keeps the domain filters on what comes back', async () => {
    const provider = parallel()
    const kept = await provider.search(request({ allowedDomains: ['https://docs.example.com/x'] }))
    assert.deepEqual(kept.map((hit) => hit.url), ['https://docs.example.com/ddos'])
    assert.deepEqual(calls.at(-1)!.message.params.arguments.search_queries, ['site:docs.example.com node streams'])
    const dropped = await provider.search(request({ blockedDomains: ['docs.example.com'] }))
    assert.deepEqual(dropped.map((hit) => hit.url), ['https://example.com/b'])
    assert.deepEqual(calls.at(-1)!.message.params.arguments.search_queries, ['node streams'])
    assert.deepEqual(parallelArguments({ query: 'q', allowedDomains: ['a.dev', 'b.dev', 'c.dev', 'd.dev'] }, 's').search_queries, ['q'])
    assert.deepEqual(parallelArguments({ query: 'q', allowedDomains: ['a.dev', 'b.dev'] }, 's').search_queries, ['site:a.dev q', 'site:b.dev q'])
  })

  it('opens the session again, once, when the server no longer knows it', async () => {
    const provider = parallel()
    await provider.search(request())
    sessions.clear()
    assert.deepEqual(await provider.search(request()), HITS)
    assert.deepEqual(methods().slice(3), ['tools/call', 'initialize', 'notifications/initialized', 'tools/call'])
    assert.equal(calls.at(-1)!.headers['mcp-session-id'], 'session-2')

    answers = [(_id, outgoing) => void outgoing.writeHead(404).end(), (_id, outgoing) => void outgoing.writeHead(404).end()]
    await assert.rejects(provider.search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'failed' && error.keyHelps && /HTTP 404/.test(error.message))
  })

  it('says a limit, a refusal and a broken service plainly, with a free Tavily key as the way on', async () => {
    const provider = parallel()
    const fails = async (answer: Answer, kind: string, words: RegExp) => {
      answers = [answer]
      await assert.rejects(provider.search(request()), (error: unknown) => {
        assert.ok(error instanceof SearchError)
        assert.equal(error.kind, kind, error.message)
        assert.equal(error.keyHelps, true)
        assert.match(error.message, words)
        assert.match(error.message, /add a free Tavily key in Settings > Agent > Web search\.$/)
        return true
      })
    }
    await fails((_id, outgoing) => void outgoing.writeHead(429).end(), 'limit', /is limiting searches from this computer for now \(HTTP 429\)\. Try again in a few minutes/)
    await fails((_id, outgoing) => void outgoing.writeHead(403).end(), 'limit', /refused searches from this computer \(HTTP 403\)/)
    await fails((_id, outgoing) => void outgoing.writeHead(503).end(), 'unavailable', /is not available right now \(HTTP 503\)/)
    await fails((id, outgoing) => rpc(outgoing, toolResult(id, { content: [{ type: 'text', text: 'Rate limit exceeded for this session' }], isError: true })), 'limit', /limiting searches from this computer for now: Rate limit exceeded for this session\. Try again/)
    await fails((id, outgoing) => rpc(outgoing, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid <b>params</b>' } }), 'failed', /could not search: Invalid params\. Try again later/)
    await fails((_id, outgoing) => void outgoing.writeHead(200, { 'content-type': 'application/json' }).end('not json'), 'failed', /answered in a way eNCode does not understand/)
    await fails((id, outgoing) => rpc(outgoing, toolResult(id, { content: [{ type: 'text', text: 'Done' }] })), 'failed', /without results eNCode can read/)
    await fails((_id, outgoing) => void outgoing.writeHead(307, { location: 'https://elsewhere.dev/' }).end(), 'failed', /redirect to https:\/\/elsewhere\.dev\/, which is not followed/)
  })

  it('fails the searches waiting on a session the server would not open, and tries again with the next', async () => {
    refuseOpen = true
    const provider = parallel()
    const waiting = await Promise.allSettled([provider.search(request()), provider.search(request())])
    assert.deepEqual(waiting.map((outcome) => outcome.status), ['rejected', 'rejected'])
    assert.match(String((waiting[0] as PromiseRejectedResult).reason.message), /is not available right now \(HTTP 503\)/)
    assert.equal(methods().filter((method) => method === 'initialize').length, 1, 'searches made at once wait on one session')
    refuseOpen = false
    assert.deepEqual(await provider.search(request()), HITS)
  })

  it('shares one session among searches made at once, and stops one search without stopping the others', async () => {
    const provider = parallel()
    const stopped = new AbortController()
    const searches = [provider.search(request()), provider.search(request({ signal: stopped.signal })), provider.search(request())]
    stopped.abort(new Error('stopped'))
    const outcomes = await Promise.allSettled(searches)
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'rejected', 'fulfilled'])
    assert.match(String((outcomes[1] as PromiseRejectedResult).reason.message), /stopped/)
    assert.equal(opened, 1)
  })

  it('sends nothing to a private address, and says it could not be reached without offering a key', async () => {
    await assert.rejects(parallelProvider({ endpoint: `${address}/mcp` }).search(request()), (error: unknown) => error instanceof SearchError && !error.keyHelps && /could not be reached/.test(error.message))
    assert.equal(calls.length, 0)
  })

  it('names a random session of its own when none is given, the same for each search', async () => {
    const provider = parallelProvider({ ...local, endpoint: `${address}/mcp` })
    await provider.search(request())
    await provider.search(request())
    const ids = calls.filter((call) => call.message.method === 'tools/call').map((call) => call.message.params.arguments.session_id)
    assert.match(ids[0], /^[0-9a-f-]{36}$/)
    assert.equal(ids[1], ids[0])
  })

  it('reads excerpts as words: links keep their words, marks and hidden characters go', () => {
    assert.equal(plainSnippet(excerptText(['ion\n\nDDoS Protection', '# Title\n\n1. one\n2) two']), 400), 'DDoS Protection … Title one two')
    assert.equal(plainSnippet(excerptText(['Use ![logo](x.png) and [docs](https://d.dev) for `npm`']), 400), 'Use logo and docs for `npm`')
    assert.equal(plainSnippet(excerptText(['a\u200Bb\u202Ec']), 400), 'abc')
    assert.equal(excerptText('not a list'), '')
  })
})
