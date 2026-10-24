import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { BUILT_IN_ROLES, DEFAULT_LIMITS, defaultRouterConfig, normalizeBaseUrl, parseRouterConfig, resolveModelList } from './config'
import { FREE_POOL, parseModelRef, splitKey } from './refs'

describe('parseRouterConfig', () => {
  it('starts from OpenRouter and the free pool when nothing is set', () => {
    const config = defaultRouterConfig()
    assert.deepEqual(Object.keys(config.providers), ['openrouter'])
    assert.equal(config.providers.openrouter.type, 'openrouter')
    assert.deepEqual(config.freePool.providers, ['openrouter'])
    assert.deepEqual(resolveModelList(config, { role: 'main' }), { role: 'main', refs: [FREE_POOL] })
    assert.deepEqual(config.limits, DEFAULT_LIMITS)
  })

  it('accepts https anywhere and plain http only on this machine', () => {
    const { config, problems } = parseRouterConfig({
      providers: {
        local: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1/' },
        remote: { type: 'openai-compatible', baseUrl: 'http://example.com/v1' },
        sneaky: { type: 'openai-compatible', baseUrl: 'https://user:pass@example.com/v1' },
        query: { type: 'openai-compatible', baseUrl: 'https://example.com/v1?key=abc' },
      },
    })
    assert.equal(config.providers.local.baseUrl, 'http://127.0.0.1:11434/v1')
    assert.equal(config.providers.local.needsKey, false, 'a server on this machine needs no key by default')
    assert.deepEqual(Object.keys(config.providers), ['local'])
    assert.deepEqual(problems.map((problem) => problem.path).sort(), ['providers.query.baseUrl', 'providers.remote.baseUrl', 'providers.sneaky.baseUrl'])
  })

  it("speaks OpenRouter's own dialect to openrouter.ai, and fills in fixed endpoints", () => {
    const { config } = parseRouterConfig({
      providers: { or: { type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, claude: { type: 'anthropic' } },
    })
    assert.equal(config.providers.or.type, 'openrouter')
    assert.equal(config.providers.claude.baseUrl, 'https://api.anthropic.com')
    assert.equal(config.providers.claude.needsKey, true)
  })

  it('checks every model ref against the configured providers', () => {
    const { config, problems } = parseRouterConfig({
      providers: { openrouter: { type: 'openrouter' } },
      roles: { main: ['openrouter:qwen/qwen3-coder:free', 'missing:model', 'no-colon', '@free', 'openrouter:qwen/qwen3-coder:free'], explore: 'openrouter:x/y' },
    })
    assert.deepEqual(config.roles.main, ['openrouter:qwen/qwen3-coder:free', '@free'])
    assert.deepEqual(config.roles.explore, ['openrouter:x/y'])
    assert.deepEqual(problems.map((problem) => problem.path), ['roles.main[1]', 'roles.main[2]'])
  })

  it('reads tool and agent assignments, with a string as shorthand', () => {
    const { config } = parseRouterConfig({
      providers: { openrouter: { type: 'openrouter' } },
      tools: { WebFetch: 'utility', Summarize: 'openrouter:google/gemma:free' },
      agents: { 'security-review': { role: 'reviewer', models: ['openrouter:a/b'] } },
    })
    assert.deepEqual(config.tools.WebFetch, { role: 'utility' })
    assert.deepEqual(config.tools.Summarize, { models: ['openrouter:google/gemma:free'] })
    assert.deepEqual(config.agents['security-review'], { role: 'reviewer', models: ['openrouter:a/b'] })
  })

  it('validates model overrides and clamps what is out of range', () => {
    const { config, problems } = parseRouterConfig({
      providers: { openrouter: { type: 'openrouter' } },
      models: { 'openrouter:a/b': { contextWindow: 50, family: 'Qwen', tools: 'yes', editFormat: 'patch', reasoning: true } },
    })
    assert.deepEqual(config.models['openrouter:a/b'], { contextWindow: 1_000, family: 'qwen', editFormat: 'patch', reasoning: true })
    assert.deepEqual(problems.map((problem) => problem.path), ['models.openrouter:a/b.contextWindow', 'models.openrouter:a/b.tools'])
    assert.equal(parseRouterConfig({ models: { 'openrouter:a/b': { family: 'klingon' } } }).problems[0].path, 'models.openrouter:a/b.family')
  })

  it("puts the user's OpenRouter account before free providers in the pool", () => {
    const { config } = parseRouterConfig({
      providers: {
        gateway: { type: 'openai-compatible', baseUrl: 'https://gateway.encode.test/v1', free: true },
        openrouter: { type: 'openrouter' },
        paid: { type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      },
    })
    assert.deepEqual(config.freePool.providers, ['openrouter', 'gateway'])
  })

  it('clamps limits and keeps the cooldown cap above the first cooldown', () => {
    const { config, problems } = parseRouterConfig({ limits: { maxFailovers: 99, cooldownMs: 120_000, maxCooldownMs: 2_000, idleMs: 'soon' } })
    assert.equal(config.limits.maxFailovers, 20)
    assert.equal(config.limits.maxCooldownMs, 120_000)
    assert.equal(config.limits.idleMs, DEFAULT_LIMITS.idleMs)
    assert.deepEqual(problems.map((problem) => problem.path), ['limits.maxFailovers', 'limits.idleMs'])
  })

  it('keeps free-only mode off unless asked, and on when the setting cannot be read', () => {
    assert.equal(defaultRouterConfig().freeOnly, false)
    assert.deepEqual(parseRouterConfig({ freeOnly: true }), { config: { ...defaultRouterConfig(), freeOnly: true }, problems: [] })
    assert.equal(parseRouterConfig({ freeOnly: false }).config.freeOnly, false)
    // A switch that guards against spending money must not fall back to off because of a typo.
    for (const unreadable of ['true', 'false', 'yes', 1, 0, null, [], {}]) {
      const { config, problems } = parseRouterConfig({ freeOnly: unreadable })
      assert.equal(config.freeOnly, true, `freeOnly: ${JSON.stringify(unreadable)}`)
      assert.deepEqual(problems.map((problem) => problem.path), ['freeOnly'])
    }
  })

  it('treats prototype keys as nothing at all', () => {
    const input = JSON.parse('{"providers":{"__proto__":{"type":"openrouter"},"constructor":{"type":"openrouter"}},"roles":{"__proto__":["@free"]}}')
    const { config } = parseRouterConfig(input)
    assert.deepEqual(Object.keys(config.providers), [])
    assert.equal(({} as Record<string, unknown>).type, undefined)
    assert.deepEqual(resolveModelList(config, { role: 'constructor' }), { role: 'constructor', refs: [FREE_POOL] })
  })

  const json: Gen<unknown> = (random, size) => {
    const leaf = gen.pick<unknown>(gen.int(-5, 1e6), gen.string('ab:/@.-_ ', 0, 12), gen.oneOf<unknown>(true, false, null))
    if (size <= 1 || random() < 0.35) return leaf(random, size)
    const child: Gen<unknown> = (r, s) => json(r, Math.floor(s / 2))
    if (random() < 0.4) return gen.array(child, 0, 4)(random, size)
    const keys = gen.oneOf('providers', 'roles', 'tools', 'agents', 'models', 'freePool', 'freeOnly', 'limits', 'type', 'baseUrl', 'main', 'openrouter', 'role', 'models', '__proto__', 'constructor')
    return Object.fromEntries(gen.array(gen.tuple(keys, child), 0, 5)(random, size))
  }

  it('never throws, whatever the settings file holds', async () => {
    await check(json, (input) => {
      const { config, problems } = parseRouterConfig(input)
      assert.ok(config.limits.maxAttempts >= 1)
      assert.equal(typeof config.freeOnly, 'boolean')
      const asked = (input as { freeOnly?: unknown } | null)?.freeOnly
      if (asked !== undefined && typeof asked !== 'boolean') assert.equal(config.freeOnly, true, 'a setting that cannot be read turns free-only mode on')
      for (const problem of problems) assert.equal(typeof problem.message, 'string')
      for (const refs of Object.values(config.roles)) for (const ref of refs) assert.ok(ref === FREE_POOL || parseModelRef(ref))
    })
  })
})

describe('resolveModelList', () => {
  const { config } = parseRouterConfig({
    providers: { openrouter: { type: 'openrouter' }, anthropic: { type: 'anthropic' } },
    roles: { main: ['anthropic:claude-sonnet-5', '@free'], utility: ['openrouter:google/gemma:free'] },
    tools: { WebFetch: { role: 'utility' }, Grep: { models: ['openrouter:fast/model'] } },
    agents: { reviewer: { models: ['anthropic:claude-opus-5'] } },
  })

  it('follows a role nobody configured down its fallback chain', () => {
    assert.deepEqual(resolveModelList(config, { role: 'explore' }).refs, ['anthropic:claude-sonnet-5', '@free'])
    assert.deepEqual(resolveModelList(config, { role: 'summarizer' }).refs, ['openrouter:google/gemma:free'])
    assert.deepEqual(resolveModelList(config, { role: 'custom-role' }).refs, ['anthropic:claude-sonnet-5', '@free'])
  })

  it('never sends a role nobody configured to the free pool while Main lists only billed models (ADR 0094)', () => {
    const { config: billed } = parseRouterConfig({
      providers: { openrouter: { type: 'openrouter' }, anthropic: { type: 'anthropic' } },
      roles: { main: ['anthropic:claude-sonnet-5'] },
      freePool: { providers: ['openrouter'] },
    })
    for (const role of [...BUILT_IN_ROLES, 'custom-role']) {
      assert.deepEqual(resolveModelList(billed, { role }).refs, ['anthropic:claude-sonnet-5'], role)
      assert.deepEqual(resolveModelList(billed, { role, tool: 'WebFetch' }).refs, ['anthropic:claude-sonnet-5'], `${role}, for a tool`)
      assert.deepEqual(resolveModelList(billed, { role, agent: 'Explore' }).refs, ['anthropic:claude-sonnet-5'], `${role}, for a subagent`)
    }
  })

  it('lets an agent win over a tool, and a tool over the role', () => {
    assert.deepEqual(resolveModelList(config, { role: 'main', tool: 'WebFetch' }), { role: 'utility', refs: ['openrouter:google/gemma:free'] })
    assert.deepEqual(resolveModelList(config, { role: 'main', tool: 'Grep' }).refs, ['openrouter:fast/model'])
    assert.deepEqual(resolveModelList(config, { role: 'main', tool: 'Grep', agent: 'reviewer' }).refs, ['anthropic:claude-opus-5'])
  })
})

describe('model refs and base URLs', () => {
  it('splits a ref at its first colon, since model ids have their own', () => {
    assert.deepEqual(parseModelRef('openrouter:qwen/qwen3-coder:free'), { provider: 'openrouter', model: 'qwen/qwen3-coder:free' })
    assert.equal(parseModelRef(':model'), null)
    assert.equal(parseModelRef('openrouter:has space'), null)
    assert.deepEqual(splitKey('a:b:c'), { provider: 'a', model: 'b:c' })
  })

  it('normalizes a base URL without its trailing slash', () => {
    assert.deepEqual(normalizeBaseUrl(' https://api.example.com/v1/ '), { url: 'https://api.example.com/v1' })
    assert.deepEqual(normalizeBaseUrl('http://localhost:1234'), { url: 'http://localhost:1234' })
    assert.ok('error' in normalizeBaseUrl('ftp://example.com'))
    assert.ok('error' in normalizeBaseUrl('not a url'))
  })
})
