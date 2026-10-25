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
  plainSnippet,
  tavilyProvider,
  toHits,
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
  const CHALLENGE = { status: 200, type: 'text/html', body: '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form>' }
  // The address is read when a provider is made: the server has its port by then.
  const ddg = (patch: { gapMs?: number } = {}) => duckDuckGoProvider({ ...local, endpoint: `${origin}/html/`, gapMs: 0, retryMs: 10, ...patch })

  it('reads result pages and says when the service limits it', async () => {
    reply = RESULTS
    const hits = await ddg().search(request())
    assert.deepEqual(hits, [{ title: 'Node', url: 'https://nodejs.org/', snippet: '' }])
    reply = { status: 202, type: 'text/html', body: '' }
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'limit' && /HTTP 202\). Try again in a few minutes/.test(error.message))
  })

  it('asks once more, after a wait, when it was slowed down, and reads a page that asks for a person as a limit', async () => {
    replies = [{ status: 202, type: 'text/html', body: '' }, RESULTS]
    assert.equal((await ddg().search(request())).length, 1)
    assert.equal(seen.length, 2)
    assert.ok(seen[1].at - seen[0].at >= 10, 'the second try waits')

    seen = []
    replies = [CHALLENGE, CHALLENGE]
    await assert.rejects(ddg().search(request()), (error: unknown) => error instanceof SearchError && error.kind === 'limit' && /a page asking whether a person is searching/.test(error.message))
    assert.equal(seen.length, 2, 'one retry, no more')

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

  it('creates the provider for an id and falls back to DuckDuckGo', () => {
    assert.equal(createSearchProvider('brave', key).id, 'brave')
    assert.equal(createSearchProvider('tavily', key).id, 'tavily')
    assert.equal(createSearchProvider('exa', key).id, 'exa')
    assert.equal(createSearchProvider('duckduckgo', key).id, 'duckduckgo')
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

  it('names DuckDuckGo when no provider was chosen', async () => {
    const root = await tempWorkspace()
    const access = await webSearchTool.access({ query: 'x y' }, testContext(root, { web: createWebAccess() }))
    assert.deepEqual(access, { type: 'web', url: 'https://html.duckduckgo.com/html/' })
  })

  it('tells the model what went wrong in the words of the provider', async () => {
    const root = await tempWorkspace()
    const web = createWebAccess({ searchProvider: () => braveProvider(() => '', { ...local, endpoint: `${origin}/api` }) })
    const outcome = await webSearchTool.run({ query: 'x y' }, testContext(root, { web }))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /The web search failed: There is no API key for Brave Search\. Add one in Settings/)
  })
})
