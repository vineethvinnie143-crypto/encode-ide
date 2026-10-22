import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'
import { stubManagedShell } from '@encode/core/testing'
import { createPortPair } from '@encode/protocol'
import type { WebAccess } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { DEFAULT_SEARCH_PROVIDER, type KeyedSearchProviderId, type SearchProviderId } from '../../shared/search'
import type { HostConfig } from './api'
import { runHostRuntime, type HostRuntime } from './runtime'
import { AgentHostService, type HostProcess } from './service'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

/** The search providers on this machine, answering as the test says. */
let server: http.Server
let origin = ''
let seen: Seen[] = []
let answer: (request: Seen, response: http.ServerResponse) => void = () => undefined

before(async () => {
  server = http.createServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    const call: Seen = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body }
    seen.push(call)
    answer(call, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  seen = []
  answer = () => undefined
})

const json = (value: unknown) => (_request: Seen, response: http.ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

const BRAVE = { web: { results: [{ title: 'Brave <strong>result</strong>', url: 'https://example.com/brave', description: 'About things' }] } }
const TAVILY = { results: [{ title: 'Tavily result', url: 'https://example.com/tavily', content: 'A passage' }] }
const DUCK = '<div class="result results_links"><a class="result__a" href="https://example.com/duck">Duck result</a><a class="result__snippet">A line</a></div>'

function config(searchProvider: SearchProviderId): HostConfig {
  return {
    policy: 'workspace-write',
    maxSteps: 30,
    maxGoalRounds: 8,
    computer: false,
    model: 'none',
    router: { providers: {}, roles: {}, freeOnly: true, freePool: { providers: [] } },
    providers: {},
    searchProvider,
  }
}

interface Fixture {
  service: AgentHostService
  runtimes: HostRuntime[]
  /** The keys the main process holds, which the test may change; and every time it was asked for one. */
  keys: Partial<Record<KeyedSearchProviderId, string>>
  asked: string[]
}

const services: AgentHostService[] = []
after(async () => {
  for (const service of services.splice(0)) await service.dispose()
})

async function fixture(): Promise<Fixture> {
  const dir = await tempWorkspace()
  const home = await tempWorkspace()
  const workspace = await tempWorkspace()
  const runtimes: HostRuntime[] = []
  const keys: Fixture['keys'] = { brave: 'brave-key-0001', tavily: 'tavily-key-0001' }
  const asked: string[] = []
  const service = new AgentHostService({
    spawn(): HostProcess {
      const [mainSide, hostSide] = createPortPair()
      let onExit: () => void = () => undefined
      const exit = () => {
        mainSide.close?.()
        hostSide.close?.()
        onExit()
      }
      runtimes.push(
        runHostRuntime(hostSide, {
          hostOptions: { createShell: stubManagedShell, goalDelayMs: 0, nameSessions: false },
          log: () => undefined,
          onShutdown: exit,
          // The providers are really at api.search.brave.com and the like; here they are this machine's server.
          search: {
            fetch: { allowAddress: () => true },
            endpoints: { duckduckgo: `${origin}/duck`, brave: `${origin}/brave`, tavily: `${origin}/tavily`, exa: `${origin}/exa` },
          },
        }),
      )
      return { port: mainSide, kill: exit, onExit: (handler) => (onExit = handler) }
    },
    init: () => ({ dir, home, workspace }),
    apiKey: () => '',
    searchKey: (provider) => {
      asked.push(provider)
      return keys[provider] ?? ''
    },
    onEvent: () => undefined,
    onJobs: () => undefined,
    log: () => undefined,
  })
  services.push(service)
  return { service, runtimes, keys, asked }
}

/** What the agent's WebSearch tool searches through, as the host built it. */
async function webOf(f: Fixture): Promise<WebAccess> {
  await f.service.start()
  return (f.runtimes.at(-1)!.host() as unknown as { web: WebAccess }).web
}

describe('web search in the agent host', () => {
  it('goes to the provider chosen in Settings, with the key the main process gives at that moment', async () => {
    answer = json(BRAVE)
    const f = await fixture()
    f.service.configure(config('brave'))
    const first = await f.service.searchCheck()
    assert.deepEqual([first.ok, first.message], [true, 'Brave Search answered with 1 result.'])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'GET')
    assert.match(seen[0].url, /^\/brave\?q=web\+search\+test&/)
    assert.equal(seen[0].headers['x-subscription-token'], 'brave-key-0001')

    // A key changed in Settings applies to the next search: it is asked for each time and never kept here.
    f.keys.brave = 'brave-key-0002'
    await f.service.searchCheck()
    assert.equal(seen[1].headers['x-subscription-token'], 'brave-key-0002')
    assert.deepEqual(f.asked, ['brave', 'brave'])
  })

  it('follows a change of provider at once, for the test and for the agent alike', async () => {
    const f = await fixture()
    f.service.configure(config('brave'))
    const web = await webOf(f)
    assert.equal(web.searchTarget?.(), `${origin}/brave`)

    answer = json(TAVILY)
    f.service.configure(config('tavily'))
    await until(() => web.searchTarget?.() === `${origin}/tavily`)
    const result = await f.service.searchCheck()
    assert.deepEqual([result.ok, result.message], [true, 'Tavily answered with 1 result.'])
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url, '/tavily')
    assert.equal(seen[0].headers.authorization, 'Bearer tavily-key-0001')

    // The agent's tool searches the same way: the answer is the provider's hits, not the test's.
    seen = []
    const hits = await web.search('node test runner', { signal: new AbortController().signal })
    assert.deepEqual(hits, [{ title: 'Tavily result', url: 'https://example.com/tavily', snippet: 'A passage' }])
    assert.equal(JSON.parse(seen[0].body).query, 'node test runner')
  })

  it('needs no key for DuckDuckGo, and asks the main process for none', async () => {
    answer = (_request, response) => void response.writeHead(200, { 'content-type': 'text/html' }).end(DUCK)
    const f = await fixture()
    f.service.configure(config(DEFAULT_SEARCH_PROVIDER))
    const result = await f.service.searchCheck()
    assert.deepEqual([result.ok, result.message], [true, 'DuckDuckGo answered with 1 result.'])
    assert.deepEqual(f.asked, [])
    assert.equal(seen[0].headers['x-subscription-token'], undefined)
    assert.equal(seen[0].headers.authorization, undefined)
  })

  it('searches DuckDuckGo before the settings have been sent', async () => {
    answer = (_request, response) => void response.writeHead(200, { 'content-type': 'text/html' }).end(DUCK)
    const f = await fixture()
    const web = await webOf(f)
    assert.equal(web.searchTarget?.(), `${origin}/duck`)
  })

  it('says what is wrong when there is no key or it was refused, and the agent is told where to add one', async () => {
    const f = await fixture()
    f.service.configure(config('exa'))
    const none = await f.service.searchCheck()
    assert.equal(none.ok, false)
    // The test runs in Settings, so it says where the field is; the agent's tool says where Settings is.
    assert.equal(none.message, 'There is no API key for Exa. Paste one above, then press Test search.')
    const web = await webOf(f)
    await assert.rejects(web.search('anything', { signal: new AbortController().signal }), /no API key for Exa\. Add one in Settings, or choose another search provider/)
    assert.equal(seen.length, 0, 'nothing is sent without a key')

    f.keys.brave = 'brave-key-0001'
    f.service.configure(config('brave'))
    answer = (_request, response) => void response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'bad token' }))
    const refused = await f.service.searchCheck()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /Brave Search refused the API key.*Check it in Settings/)
    assert.doesNotMatch(refused.message, /brave-key-0001/, 'a key is never part of a message')
  })

  it('reports a search that found nothing as not working, since an empty answer is how a slowed search looks', async () => {
    answer = json({ web: { results: [] } })
    const f = await fixture()
    f.service.configure(config('brave'))
    const result = await f.service.searchCheck()
    assert.equal(result.ok, false)
    assert.match(result.message, /found nothing for the test search/)
  })

  it('searches through DuckDuckGo, and asks for no key, when it is told a provider nobody knows', async () => {
    answer = (_request, response) => void response.writeHead(200, { 'content-type': 'text/html' }).end(DUCK)
    const f = await fixture()
    f.service.configure({ ...config('brave'), searchProvider: 'search:brave' as never })
    const result = await f.service.searchCheck()
    assert.deepEqual([result.ok, result.message], [true, 'DuckDuckGo answered with 1 result.'])
    assert.deepEqual(f.asked, [])
  })
})

async function until(read: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!read()) {
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
