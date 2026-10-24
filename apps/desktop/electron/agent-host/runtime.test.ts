import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { NO_MODEL_MESSAGE, type AgentEvent } from '@encode/core'
import { stubManagedShell } from '@encode/core/testing'
import { createPortPair } from '@encode/protocol'
import { tempWorkspace } from '@encode/tools/testing'
import type { ModelAlert } from '../../shared/types'
import type { HostConfig } from './api'
import { runHostRuntime, type HostRuntime } from './runtime'
import { AgentHostService, type HostProcess } from './service'

/** A provider on this machine, answering as the test says. */
type Reply = (request: { headers: http.IncomingHttpHeaders; url: string; body: Record<string, any> }, response: http.ServerResponse) => void

let server: http.Server
let baseUrl = ''
let origin = ''
let reply: Reply = () => undefined
let seen: Array<{ authorization: string | undefined; url: string; body: Record<string, any> }> = []

before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ authorization: request.headers.authorization, url: request.url ?? '', body })
    reply({ headers: request.headers, url: request.url ?? '', body }, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  baseUrl = `${origin}/v1`
})
after(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  seen = []
  reply = () => undefined
})

const chat = (url: string) => url.endsWith('/chat/completions')

function say(text: string): Reply {
  return (request, response) => {
    if (!chat(request.url)) return void response.writeHead(404).end()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
}

function callEcho(request: Parameters<Reply>[0], response: http.ServerResponse): void {
  if (!chat(request.url)) return void response.writeHead(404).end()
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo', arguments: '{"text":"eNCode"}' } }] } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

const unauthorized: Reply = (_request, response) => {
  response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }))
}

/** The host's configuration for one local provider that the main role uses. */
function config(patch: { model?: HostConfig['model']; keyRevision?: number | null; free?: boolean; freeOnly?: boolean } = {}): HostConfig {
  return {
    policy: 'workspace-write',
    maxSteps: 30,
    maxGoalRounds: 8,
    computer: false,
    languageServers: false,
    errorGate: 'auto',
    guide: 'auto',
    model: patch.model ?? 'router',
    router: {
      providers: { 'p-local': { type: 'openai-compatible', baseUrl, needsKey: patch.keyRevision !== null, free: patch.free ?? true } },
      roles: { main: ['p-local:mock-model'] },
      freeOnly: patch.freeOnly ?? false,
      freePool: { providers: [] },
    },
    providers: { 'p-local': { profile: 'local', name: 'Local mock', keyRevision: patch.keyRevision === undefined ? 1 : patch.keyRevision } },
    searchProvider: 'duckduckgo',
  }
}

interface Fixture {
  service: AgentHostService
  events: AgentEvent[]
  alerts: ModelAlert[]
  keysAsked: string[]
  runtimes: HostRuntime[]
  /** What the main process answers for the local profile's key. */
  key: { current: string }
  stateFile: string
}

const services: AgentHostService[] = []
after(async () => {
  for (const service of services.splice(0)) await service.dispose()
})

async function fixture(stateFile?: string): Promise<Fixture> {
  const dir = await tempWorkspace()
  const home = await tempWorkspace()
  const workspace = await tempWorkspace()
  const state = stateFile ?? path.join(await tempWorkspace(), 'models.json')
  const events: AgentEvent[] = []
  const alerts: ModelAlert[] = []
  const keysAsked: string[] = []
  const runtimes: HostRuntime[] = []
  const key = { current: 'key-one-0001' }
  const service = new AgentHostService({
    spawn(): HostProcess {
      const [mainSide, hostSide] = createPortPair()
      let onExit: () => void = () => undefined
      const exit = () => {
        mainSide.close?.()
        hostSide.close?.()
        onExit()
      }
      runtimes.push(runHostRuntime(hostSide, { hostOptions: { createShell: stubManagedShell, goalDelayMs: 0, nameSessions: false }, log: () => undefined, onShutdown: exit }))
      return { port: mainSide, kill: exit, onExit: (handler) => (onExit = handler) }
    },
    init: () => ({ dir, home, workspace, routerStateFile: state }),
    apiKey: (profileId, server) => {
      keysAsked.push(`${profileId} ${server}`)
      return (profileId === 'local' || profileId === 'other') && server === origin ? key.current : ''
    },
    searchKey: () => '',
    onEvent: (event) => events.push(event),
    onJobs: () => undefined,
    onAlert: (alert) => alerts.push(alert),
    log: () => undefined,
  })
  services.push(service)
  return { service, events, alerts, keysAsked, runtimes, key, stateFile: state }
}

/** One turn: the last error the session reported, or the reply it ended with. */
async function turn(f: Fixture, text = 'hi'): Promise<{ reply?: string; error?: string; notices: string[] }> {
  const before = f.events.length
  const [session] = await f.service.client.sessions().then(async (list) => (list.length ? list : [await f.service.client.create()]))
  await f.service.client.start(session.id, { text, mode: 'code' })
  const history = await f.service.client.history(session.id)
  const error = f.events.slice(before).find((event) => event.type === 'error')
  return {
    reply: history.entries.filter((entry) => entry.kind === 'assistant').at(-1)?.text,
    error: error?.type === 'error' ? error.message : undefined,
    notices: history.entries.filter((entry) => entry.kind === 'notice').map((entry) => entry.text ?? ''),
  }
}

describe('model calls in the agent host', () => {
  it('go through the router to the provider, with the key the main process gives for that server', async () => {
    reply = say('Hello from the provider')
    const f = await fixture()
    f.service.configure(config())
    const result = await turn(f)
    assert.equal(result.reply, 'Hello from the provider')
    assert.equal(result.error, undefined)
    assert.equal(seen[0].authorization, 'Bearer key-one-0001')
    assert.equal(seen[0].body.model, 'mock-model')
    // The router names the server by its origin, and the main process answers only for that.
    assert.ok(f.keysAsked.length > 0 && f.keysAsked.every((asked) => asked === `local ${origin}`), f.keysAsked.join(', '))
  })

  it('answer with the plain message, and call nothing, while no model is set up', async () => {
    reply = say('never')
    const f = await fixture()
    f.service.configure(config({ model: 'none' }))
    const result = await turn(f)
    assert.equal(result.error, NO_MODEL_MESSAGE)
    assert.equal(seen.length, 0)
  })

  it('follow a change of settings at once', async () => {
    reply = say('First')
    const f = await fixture()
    f.service.configure(config())
    assert.equal((await turn(f)).reply, 'First')
    f.service.configure(config({ model: 'none' }))
    assert.equal((await turn(f, 'again')).error, NO_MODEL_MESSAGE)
  })

  it('refuse a model that costs money in free-only mode, before any request, in words that name the connection', async () => {
    reply = say('never')
    const f = await fixture()
    f.service.configure(config({ free: false, freeOnly: true }))
    const result = await turn(f)
    assert.match(result.error ?? '', /free/i)
    assert.doesNotMatch(result.error ?? '', /p-local/)
    assert.equal(seen.length, 0, 'nothing was sent to a model that may be billed')
  })
})

describe('the effort chosen for a role', () => {
  /** The main role on a model with a thinking dial. */
  const thinking = (efforts?: HostConfig['efforts']): HostConfig => {
    const base = config()
    return { ...base, router: { ...base.router, roles: { main: ['p-local:gpt-5-mini'] } }, ...(efforts ? { efforts } : {}) }
  }
  const sent = () => seen.filter((request) => chat(request.url)).map((request) => request.body.reasoning_effort)

  it('reaches that role\'s model, and a level past the model\'s own goes as its highest', async () => {
    reply = say('Thought it through')
    const f = await fixture()
    f.service.configure(thinking({ main: 'low' }))
    assert.equal((await turn(f)).reply, 'Thought it through')
    f.service.configure(thinking({ main: 'max' }))
    await turn(f, 'again')
    assert.deepEqual(sent(), ['low', 'high'])
  })

  it('is left to the model while the role has none, whatever another role is set to', async () => {
    reply = say('Plain')
    const f = await fixture()
    f.service.configure(thinking({ explore: 'max' }))
    await turn(f)
    f.service.configure(thinking())
    await turn(f, 'again')
    assert.deepEqual(sent(), [undefined, undefined])
  })
})

/** Two connections to the same test server, told apart by their path: /v1 is "local", /v2 is "other". */
function twoConnections(roles: Record<string, string[]>, freePool: string[] = []): HostConfig {
  const base = config()
  return {
    ...base,
    router: {
      ...base.router,
      providers: {
        'p-local': { type: 'openai-compatible', baseUrl, needsKey: true, free: false },
        'p-other': { type: 'openai-compatible', baseUrl: `${origin}/v2`, needsKey: true, free: false },
      },
      roles,
      freePool: { providers: freePool },
    },
    providers: { 'p-local': { profile: 'local', name: 'First', keyRevision: 1 }, 'p-other': { profile: 'other', name: 'Second', keyRevision: 1 } },
  }
}

const broken: Reply = (_request, response) => {
  response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'upstream failure' } }))
}

describe('when a model fails', () => {
  it('the next model of the role answers, and the person sees only the answer', async () => {
    reply = (request, response) => (request.url.startsWith('/v1') ? broken(request, response) : say('Answered by the second')(request, response))
    const f = await fixture()
    f.service.configure(twoConnections({ main: ['p-local:model-a', 'p-other:model-b'] }))
    const result = await turn(f)
    assert.equal(result.reply, 'Answered by the second')
    assert.equal(result.error, undefined)
    assert.equal(f.alerts.length, 0, 'a failover is silent')
    assert.deepEqual([...new Set(seen.map((request) => request.body.model))], ['model-a', 'model-b'])
    // The notice in the conversation names the connections as the person does, not by the router's ids.
    assert.ok(result.notices.some((notice) => /^Switched to model-b \(Second\)\. model-a had a problem on the provider's side\.$/.test(notice)), result.notices.join(' | '))
    assert.ok(result.notices.every((notice) => !/p-local|p-other/.test(notice)))
  })

  it('a connection that the role does not list is never used in its place, nor the free models', async () => {
    reply = (request, response) => (request.url.startsWith('/v1') ? broken(request, response) : say('Should not be asked')(request, response))
    const f = await fixture()
    // Another key is stored and a free pool is set up, but this role names only the first model.
    const lone = twoConnections({ main: ['p-local:model-a'] }, ['p-other'])
    lone.router.limits = { maxFailovers: 1, cooldownMs: 1000 }
    f.service.configure(lone)
    const result = await turn(f)
    assert.ok(result.error, 'the turn ends with a message instead')
    assert.ok(seen.length > 0 && seen.every((request) => request.url.startsWith('/v1')), 'no request went to the other connection')
  })

  it('"@free" is the only way into the free models, and it uses the connection chosen for them', async () => {
    reply = (request, response) => (request.url.startsWith('/v1') ? broken(request, response) : say('From the free pool')(request, response))
    const f = await fixture()
    const withPool = twoConnections({ main: ['p-local:model-a', '@free'] }, ['p-other'])
    // The pool lists its models from the connection chosen for it.
    const inner = reply
    reply = (request, response) => {
      if (request.url === '/v2/models') {
        return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'pool-model:free', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }))
      }
      inner(request, response)
    }
    withPool.router.providers['p-other'] = { type: 'openai-compatible', baseUrl: `${origin}/v2`, needsKey: true, free: true }
    f.service.configure(withPool)
    const result = await turn(f)
    assert.equal(result.reply, 'From the free pool')
    assert.ok(seen.some((request) => request.url === '/v2/chat/completions' && request.body.model === 'pool-model:free'))
  })
})

describe('a key the provider refuses', () => {
  it('blocks that provider and tells the person once, and a new key lifts the block', async () => {
    reply = (request, response) => (request.headers.authorization === 'Bearer key-two-0002' ? say('Welcome back')(request, response) : unauthorized(request, response))
    const f = await fixture()
    f.service.configure(config())
    const first = await turn(f)
    assert.ok(first.error, 'the turn did not work')
    assert.equal(f.alerts.length, 1)
    assert.equal(f.alerts[0].kind, 'key-refused')
    assert.equal(f.alerts[0].profileId, 'local')
    assert.doesNotMatch(f.alerts[0].message, /p-local/)
    assert.doesNotMatch(f.alerts[0].message, /key-one-0001/)

    // Held back: no second request with the same key, no second alert.
    const requests = seen.length
    await turn(f, 'try again')
    assert.equal(seen.length, requests)
    assert.equal(f.alerts.length, 1)

    // A new key (a new revision) lets the router ask again.
    f.key.current = 'key-two-0002'
    f.service.configure(config({ keyRevision: 2 }))
    const again = await turn(f, 'and now')
    assert.equal(again.reply, 'Welcome back')
  })

  it('is tried again when the person asks to check again', async () => {
    let allowed = false
    reply = (request, response) => (allowed ? say('Back')(request, response) : unauthorized(request, response))
    const f = await fixture()
    f.service.configure(config())
    assert.ok((await turn(f)).error)
    allowed = true
    await f.service.modelRecheck()
    assert.equal((await turn(f, 'now')).reply, 'Back')
  })
})

describe('the check of one model', () => {
  it('passes a model that calls the tool it was given', async () => {
    reply = callEcho
    const f = await fixture()
    f.service.configure(config())
    const result = await f.service.modelCheck('local', 'mock-model')
    assert.equal(result.ok, true, result.message)
  })

  it('fails a model that answers in words, and says what that means for the agent', async () => {
    reply = say('I will not call tools')
    const f = await fixture()
    f.service.configure(config())
    const result = await f.service.modelCheck('local', 'mock-model')
    assert.equal(result.ok, false)
    assert.match(result.message, /did not call the tool/)
  })

  it('says so for a connection that is not set up, and for a key the provider refuses, without the provider\'s own id', async () => {
    reply = unauthorized
    const f = await fixture()
    f.service.configure(config())
    assert.equal((await f.service.modelCheck('elsewhere', 'm')).ok, false)
    const refused = await f.service.modelCheck('local', 'mock-model')
    assert.equal(refused.ok, false)
    assert.doesNotMatch(refused.message, /p-local|key-one-0001/)
  })
})

describe('the status of the connections', () => {
  it('lists each connection by its name, with the models it offers', async () => {
    reply = (request, response) => {
      if (request.url.endsWith('/models')) return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other' }] }))
      response.writeHead(404).end()
    }
    const f = await fixture()
    f.service.configure(config())
    const status = await f.service.modelStatus()
    assert.deepEqual(status.problems, [])
    assert.equal(status.providers.length, 1)
    assert.equal(status.providers[0].name, 'Local mock')
    assert.equal(status.providers[0].profileId, 'local')
    assert.equal(status.providers[0].models, 2)
    assert.equal(status.providers[0].blocked, undefined)
  })

  it('shows what stops a connection, in words, and the settings the router could not use', async () => {
    reply = unauthorized
    const f = await fixture()
    const bad = config()
    bad.router.roles.reviewer = ['gone:x']
    f.service.configure(bad)
    await turn(f)
    const status = await f.service.modelStatus()
    assert.ok(status.providers[0].blocked, 'the refused key is shown')
    assert.ok(status.providers[0].blocked!.until > Date.now())
    assert.doesNotMatch(status.providers[0].blocked!.message, /p-local/)
    assert.ok(status.problems.some((problem) => /gone/.test(problem)))
  })
})

describe('what the router has learned', () => {
  let stateDir = ''
  beforeEach(async () => {
    stateDir = await tempWorkspace()
  })
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }))

  it('is written when the host closes, holds no key, and is read back by the next one', async () => {
    reply = say('ok')
    const file = path.join(stateDir, 'models.json')
    const f = await fixture(file)
    f.service.configure(config())
    await turn(f)
    await f.service.dispose()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number }
    assert.equal(saved.version, 1)
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /key-one-0001/)

    const next = await fixture(file)
    next.service.configure(config())
    await next.service.start()
    assert.equal(next.runtimes.length, 1)
    assert.ok(next.runtimes[0].router(), 'the router started with the file in place')
  })

  it('does not stop a host from starting when the file is damaged', async () => {
    reply = say('fine')
    const file = path.join(stateDir, 'models.json')
    fs.writeFileSync(file, '{ not json')
    const f = await fixture(file)
    f.service.configure(config())
    assert.equal((await turn(f)).reply, 'fine')
  })
})
