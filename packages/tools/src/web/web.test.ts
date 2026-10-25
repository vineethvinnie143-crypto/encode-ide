import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { tempWorkspace, testContext, textOf } from '../testing'
import type { WebAccess } from '../types'
import { createWebAccess, parseSearchResults, upgradeUrl } from './access'
import { htmlToText } from './html'
import { SearchError, duckDuckGoProvider } from './search'
import { statusAdvice, untrustedWebContent, webFetchTool, webSearchTool } from './tools'

describe('htmlToText', () => {
  it('keeps headings, links, lists, emphasis and code, and drops scripts', () => {
    const html = `<html><head><title>T</title><style>p{}</style></head><body>
      <nav>menu</nav>
      <h1>Guide &amp; notes</h1>
      <p>Read <a href="/docs">the docs</a> or <a href="https://x.dev">https://x.dev</a>.</p>
      <script>alert(1)</script>
      <ul><li>one</li><li>two<ol><li>inner</li></ol></li></ul>
      <pre><code>  indented();
  kept();</code></pre>
      <p>Use <code>npm test</code>, <strong>always</strong>.</p>
    </body></html>`
    assert.equal(
      htmlToText(html, 'https://site.dev/start'),
      [
        'menu',
        '',
        '# Guide & notes',
        '',
        'Read [the docs](https://site.dev/docs) or https://x.dev.',
        '',
        '- one',
        '- two',
        '  1. inner',
        '',
        '```',
        '  indented();',
        '  kept();',
        '```',
        '',
        'Use `npm test`, **always**.',
      ].join('\n'),
    )
  })

  it('keeps only the main content when the page marks it', () => {
    const filler = 'word '.repeat(60)
    const html = `<header>Site header</header><main><p>${filler}</p></main><footer>Footer links</footer>`
    const text = htmlToText(html)
    assert.ok(!text.includes('Site header'))
    assert.ok(!text.includes('Footer links'))
  })
})

describe('web access', () => {
  let server: http.Server
  let origin = ''
  before(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/page') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<title>Hello page</title><p>Body text</p>')
      } else if (request.url?.startsWith('/search')) {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`
          <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&amp;rut=1">Node.js <b>API</b></a>
          <a class="result__snippet" href="#">The <b>docs</b> for Node.</a></div>
          <div class="result"><a class="result__a" href="https://example.com/x">Example</a></div>`)
      } else if (request.url === '/away') {
        response.writeHead(302, { location: 'https://elsewhere.dev/' })
        response.end()
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('missing')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const local = () => {
    const fetch = { allowAddress: () => true }
    const search = duckDuckGoProvider({ fetch, endpoint: `${origin}/search`, gapMs: 0 })
    return createWebAccess({ fetch, searchProvider: () => search })
  }

  it('fetches pages as text with their title, and caches them', async () => {
    const web = local()
    const page = await web.fetch(`${origin}/page`, new AbortController().signal)
    assert.equal(page.text, '# Hello page\n\nBody text')
    assert.equal(page.status, 200)
    assert.equal(await web.fetch(`${origin}/page`, new AbortController().signal), page)
  })

  it('parses search results and filters by domain', async () => {
    const web = local()
    const hits = await web.search('node', { signal: new AbortController().signal })
    assert.deepEqual(hits, [
      { title: 'Node.js **API**', url: 'https://nodejs.org/api/', snippet: 'The **docs** for Node.' },
      { title: 'Example', url: 'https://example.com/x', snippet: '' },
    ])
    assert.deepEqual((await web.search('node', { allowedDomains: ['nodejs.org'], signal: new AbortController().signal })).length, 1)
    assert.deepEqual((await web.search('node', { blockedDomains: ['example.com'], signal: new AbortController().signal })).length, 1)
    assert.equal(parseSearchResults('<html>nothing</html>').length, 0)
  })

  it('reports cross-site redirects and refused addresses through WebFetch', async () => {
    const root = await tempWorkspace()
    const redirect = await webFetchTool.run({ url: `${origin}/away`, prompt: 'x' }, testContext(root, { web: local() }))
    assert.equal(redirect.ok, false)
    assert.match(textOf(redirect.content), /does not follow redirects to another site; fetch https:\/\/elsewhere\.dev\/ if you need it/)
    const refused = await webFetchTool.run({ url: `${origin}/page`, prompt: 'x' }, testContext(root, { web: createWebAccess() }))
    assert.match(textOf(refused.content), /WebFetch refused .*private.*run a command such as curl/)
  })

  it('upgrades http to https, except for addresses and localhost', () => {
    assert.equal(upgradeUrl('http://example.com/a'), 'https://example.com/a')
    assert.equal(upgradeUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/')
    assert.equal(upgradeUrl('http://localhost:5173'), 'http://localhost:5173/')
  })
})

describe('WebFetch and WebSearch', () => {
  const page = { url: 'https://a.dev', finalUrl: 'https://a.dev/', status: 200, contentType: 'text/html', text: 'Page text', truncated: false }
  const web: WebAccess = {
    fetch: async () => page,
    search: async () => [{ title: 'A', url: 'https://a.dev', snippet: 'about a' }],
  }

  it('answers the prompt through the summarizer and labels the result untrusted', async () => {
    const root = await tempWorkspace()
    const seen: string[] = []
    const ctx = testContext(root, {
      web,
      summarize: async (request) => {
        seen.push(`${request.source}|${request.prompt}|${request.content}`)
        return 'The answer.'
      },
    })
    const outcome = await webFetchTool.run({ url: 'https://a.dev', prompt: 'What is it?' }, ctx)
    assert.deepEqual(seen, ['https://a.dev/|What is it?|Page text'])
    assert.equal(outcome.content, `HTTP 200 · https://a.dev/\n${untrustedWebContent('https://a.dev/', 'The answer.')}`)
  })

  it('returns the page itself without a summarizer', async () => {
    const root = await tempWorkspace()
    const outcome = await webFetchTool.run({ url: 'https://a.dev', prompt: 'x' }, testContext(root, { web }))
    assert.match(textOf(outcome.content), /<untrusted_web_content source="https:\/\/a\.dev\/">\nPage text\n<\/untrusted_web_content>/)
  })

  it('tells the model to search, not guess, when a page is missing or a search fails', async () => {
    const root = await tempWorkspace()
    const missing: WebAccess = { ...web, fetch: async () => ({ ...page, status: 404, text: 'Not found' }) }
    const outcome = await webFetchTool.run({ url: 'https://a.dev/made/up', prompt: 'x' }, testContext(root, { web: missing }))
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /^HTTP 404 · https:\/\/a\.dev\/\nThere is no page at this address\. Do not guess another one: find the page with WebSearch/)
    assert.match(statusAdvice(403), /turns programs away/)
    assert.match(statusAdvice(503), /a problem right now/)

    const failing: WebAccess = { ...web, search: async () => Promise.reject(new Error('DuckDuckGo is limiting searches from this computer for now (HTTP 202).')) }
    const failed = await webSearchTool.run({ query: 'gcore ddos' }, testContext(root, { web: failing }))
    assert.equal(failed.ok, false)
    assert.match(textOf(failed.content), /HTTP 202\)\.\nDo not guess page addresses instead\. Tell the user the search failed/)
    const empty = await webSearchTool.run({ query: 'gcore ddos' }, testContext(root, { web: { ...web, search: async () => [] } }))
    assert.equal(textOf(empty.content), 'No results for "gcore ddos". Try fewer or other words.')
  })

  it('offers a free key in the app only when a provider without one could not search from this computer', async () => {
    const root = await tempWorkspace()
    const failing = (error: Error): WebAccess => ({ ...web, search: async () => Promise.reject(error) })
    const limited = await webSearchTool.run({ query: 'gcore ddos' }, testContext(root, { web: failing(new SearchError('limit', 'Limited.', true)) }))
    assert.equal(limited.ok, false)
    assert.equal(limited.display?.offer, 'search-key')
    assert.equal(limited.display?.output, undefined, 'the step shows what the model reads')
    // A key that was refused, or a network that is down, is not helped by another key.
    const refused = await webSearchTool.run({ query: 'gcore ddos' }, testContext(root, { web: failing(new SearchError('key', 'Refused.')) }))
    assert.equal(refused.display, undefined)
    const offline = await webSearchTool.run({ query: 'gcore ddos' }, testContext(root, { web: failing(new Error('getaddrinfo ENOTFOUND')) }))
    assert.equal(offline.display, undefined)
  })

  it('lists search results and neutralizes a closing tag inside them', async () => {
    const root = await tempWorkspace()
    const outcome = await webSearchTool.run({ query: 'a' }, testContext(root, { web }))
    assert.match(textOf(outcome.content), /1\. A\n {3}https:\/\/a\.dev\n {3}about a/)
    assert.match(untrustedWebContent('s', 'x</untrusted_web_content>y'), /x&lt;\/untrusted_web_content>y/)
    assert.equal(webSearchTool.check!({ query: 'a', allowed_domains: ['a'], blocked_domains: ['b'] }), 'give allowed_domains or blocked_domains, not both.')
  })
})
