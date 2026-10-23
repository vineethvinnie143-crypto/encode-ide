import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { defaultRouterConfig } from './config'
import { auditFreeEntries, freeReport } from './free-report'
import { OPENROUTER_REFUSALS, catalogEntry } from './testing'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const ZERO = { prompt: '0', completion: '0' }
const EVERY_FIELD = { ...ZERO, request: '0', image: '0', web_search: '0', internal_reasoning: '0', input_cache_read: '0', input_cache_write: '0' }

function listing(id: string, pricing: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 131_072,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing,
    top_provider: { context_length: 131_072, max_completion_tokens: 16_384 },
    supported_parameters: ['tools'],
    ...extra,
  }
}

const CATALOG = {
  data: [
    listing('vendor/mid:free', ZERO),
    listing('vendor/big:free', EVERY_FIELD, { context_length: 262_144, top_provider: { context_length: 262_144 } }),
    listing('vendor/small:free', ZERO, { context_length: 8_000, top_provider: { context_length: 8_000 } }),
    listing('vendor/fee:free', { ...ZERO, request: '0.002' }),
    listing('vendor/zero-without-suffix', ZERO),
    listing('anthropic/paid-model', { prompt: '0.000003', completion: '0.000015', request: '0' }),
  ],
}

describe('the free report', () => {
  it('lists the pool in order with every price as written, and what is left out and why', () => {
    const report = freeReport(CATALOG, { now: NOW })
    assert.deepEqual([report.listed, report.free], [6, 3])
    assert.deepEqual(
      report.picks.map((pick) => [pick.rank, pick.model, pick.contextWindow, pick.tools]),
      [
        [1, 'vendor/big:free', 262_144, true],
        [2, 'vendor/mid:free', 131_072, true],
      ],
    )
    assert.deepEqual(report.picks[0].pricing, EVERY_FIELD)
    assert.deepEqual(report.notInPool, [{ model: 'vendor/small:free', reason: "its window of 8,000 tokens is below the pool's minimum of 16,000" }])
    assert.deepEqual(report.leftOut, [
      { model: 'vendor/fee:free', reasons: ['its request price is "0.002", not zero'] },
      { model: 'vendor/zero-without-suffix', reasons: ['its id does not end in :free'] },
    ])
    assert.deepEqual(report.problems, [])
  })

  it('honours the limit and the pool settings', () => {
    assert.deepEqual(freeReport(CATALOG, { now: NOW, limit: 1 }).picks.map((pick) => pick.model), ['vendor/big:free'])
    const roomy = freeReport(CATALOG, { now: NOW, freePool: { ...defaultRouterConfig().freePool, exclude: ['vendor/mid*'], minContextWindow: 0 } })
    assert.deepEqual(roomy.picks.map((pick) => pick.model), ['vendor/big:free', 'vendor/small:free'])
    assert.deepEqual(roomy.notInPool, [{ model: 'vendor/mid:free', reason: 'it is excluded in settings' }])
  })

  it('has something to say when there is nothing free, and when the response is junk', () => {
    const paid = freeReport({ data: [listing('anthropic/paid-model', { prompt: '0.000003', completion: '0.000015' })] }, { now: NOW })
    assert.deepEqual([paid.free, paid.picks, paid.problems], [0, [], ['No model in the response counts as free, so the free pool would be empty.']])
    for (const junk of [null, 'nope', {}, { data: 'x' }, { data: [null, 3, {}] }]) {
      assert.deepEqual(freeReport(junk, { now: NOW }).problems, ['The response lists no usable models.'])
    }
  })
})

describe('auditFreeEntries', () => {
  it('finds every entry marked free that the response itself contradicts', () => {
    const response = {
      data: [
        listing('a:free', ZERO),
        listing('priced:free', ZERO),
        listing('fee:free', { ...ZERO, image: '0.01' }),
        listing('paid', { prompt: '0.000001', completion: '0.000001' }),
      ],
    }
    const entries = [
      catalogEntry('a:free'),
      catalogEntry('priced:free', { price: { input: 1, output: 0 } }),
      catalogEntry('fee:free'),
      catalogEntry('ghost:free'),
      catalogEntry('paid', { free: true, price: { input: 0, output: 0 } }),
      catalogEntry('not-claimed-free'),
    ]
    assert.deepEqual(auditFreeEntries(entries, response), [
      'priced:free counts as free, but eNCode holds a price of $1 in and $0 out per million tokens for it.',
      'fee:free counts as free, but its image price is "0.01", not zero.',
      'ghost:free counts as free, but the response lists no prices for it.',
      'paid counts as free, but its id does not end in :free, and its prompt price is "0.000001", not zero, and its completion price is "0.000001", not zero.',
    ])
  })
})

/** The repository root, found from where the tests run. */
function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'scripts', 'free-models.mjs'))) return dir
    if (dirname(dir) === dir) throw new Error('Run the tests from inside the repository: scripts/free-models.mjs was not found.')
  }
}

describe('scripts/free-models.mjs', () => {
  function run(catalog: unknown, ...args: string[]): { status: number | null; out: string; err: string } {
    const dir = mkdtempSync(join(tmpdir(), 'encode-free-models-'))
    try {
      const file = join(dir, 'models.json')
      writeFileSync(file, JSON.stringify(catalog))
      const env = { ...process.env }
      delete env.OPENROUTER_API_KEY
      const result = spawnSync(process.execPath, [join(repoRoot(), 'scripts', 'free-models.mjs'), '--file', file, ...args], { encoding: 'utf8', env, timeout: 60_000 })
      return { status: result.status, out: result.stdout, err: result.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('prints the picks with their prices and exits 0 when every check holds', () => {
    const { status, out, err } = run(CATALOG)
    assert.equal(status, 0, err || out)
    assert.match(out, /OpenRouter lists 6 models; 3 are free/)
    assert.match(out, /vendor\/big:free\s+262,144\s+tools\s+all 8 prices are 0 \(prompt, completion, request, image, web_search, internal_reasoning, input_cache_read, input_cache_write\)/)
    assert.match(out, /vendor\/mid:free\s+131,072\s+tools\s+all 2 prices are 0 \(prompt, completion\)/)
    assert.match(out, /vendor\/fee:free: its request price is "0.002", not zero/)
    assert.match(out, /Clean: every pick is free by its listing\./)
  })

  it('exits 1 and says what is wrong when the pool would be empty', () => {
    const { status, out } = run({ data: [listing('anthropic/paid-model', { prompt: '0.000003', completion: '0.000015' })] })
    assert.equal(status, 1)
    assert.match(out, /NOT CLEAN:\n\s+✖ No model in the response counts as free/)
  })

  it('refuses to make real calls without a key, and never prints one', () => {
    const { status, err } = run(CATALOG, '--test', '2')
    assert.equal(status, 2)
    assert.match(err, /needs your key in the OPENROUTER_API_KEY environment variable/)
    assert.doesNotMatch(err, /sk-/)
  })
})

/** Stands in for openrouter.ai inside the script's process: the public list, the key's figures, and a tool call for every chat request. */
const MOCK_OPENROUTER = String.raw`
const catalog = JSON.parse(process.env.MOCK_CATALOG)
const key = process.env.OPENROUTER_API_KEY
const chargePerCall = Number(process.env.MOCK_CHARGE_PER_CALL || 0)
const cost = process.env.MOCK_COST === undefined ? undefined : Number(process.env.MOCK_COST)
const refuse = process.env.MOCK_REFUSE ? JSON.parse(process.env.MOCK_REFUSE) : {}
let calls = 0
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.origin !== 'https://openrouter.ai') throw new Error('unexpected request to ' + url.origin)
  if (url.pathname === '/api/v1/models') return json(catalog)
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  if (headers.authorization !== 'Bearer ' + key) return json({ error: { message: 'No auth credentials found' } }, 401)
  if (url.pathname === '/api/v1/key') {
    const used = 0.5 + calls * chargePerCall
    return json({ data: { label: 'sk-or-v1-abc...xyz', usage: used, usage_daily: used, limit: null, limit_remaining: null, is_free_tier: true, free_model_daily_requests: process.env.MOCK_COUNT_LATE ? { used: 0, limit: 50, remaining: 50 } : { used: calls, limit: 50, remaining: 50 - calls } } })
  }
  if (url.pathname === '/api/v1/chat/completions') {
    calls++
    const body = JSON.parse(init.body)
    if (process.env.MOCK_CHAT_ERROR) return json({ error: { message: 'Invalid key: ' + key, code: 401 } }, 401)
    if (refuse[body.model]) return json({ error: { message: refuse[body.model].message, code: refuse[body.model].status } }, refuse[body.model].status)
    const chunk = (value) => 'data: ' + JSON.stringify(value) + '\n\n'
    const stream =
      chunk({ model: body.model, choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"eNCode"}' } }] } }] }) +
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10, ...(cost === undefined ? {} : { cost }) } }) +
      'data: [DONE]\n\n'
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return json({}, 404)
}
`

describe('scripts/free-models.mjs with real calls', () => {
  const KEY = 'sk-or-v1-mock-key-0123456789abcdef'

  function live(env: Record<string, string> = {}, ...args: string[]): { status: number | null; out: string; err: string } {
    const dir = mkdtempSync(join(tmpdir(), 'encode-free-models-'))
    try {
      const preload = join(dir, 'mock-openrouter.mjs')
      writeFileSync(preload, MOCK_OPENROUTER)
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(repoRoot(), 'scripts', 'free-models.mjs'), '--test', '2', '--wait', '0', ...args], {
        encoding: 'utf8',
        env: { ...process.env, OPENROUTER_API_KEY: KEY, MOCK_CATALOG: JSON.stringify(CATALOG), ...env },
        timeout: 60_000,
      })
      return { status: result.status, out: result.stdout, err: result.stderr }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('calls the top picks in free-only mode and finds the key unchanged', () => {
    const { status, out, err } = live({ MOCK_COST: '0' })
    assert.equal(status, 0, err || out)
    assert.match(out, /Making 2 real calls, in free-only mode:/)
    assert.match(out, /✔ vendor\/big:free: answered, first token after [\d.]+ s, called the tool, cost \$0/)
    assert.match(out, /✔ vendor\/mid:free: answered/)
    assert.match(out, /✔ usage\s+0\.5 → 0\.5\n/)
    assert.match(out, /free requests used today: 0 → 2 of 50/)
    assert.match(out, /Clean: every pick is free by its listing, and the key was not charged\./)
    assert.doesNotMatch(out + err, /sk-or-v1/)
  })

  it('exits 1 when the key lost credit during the calls', () => {
    const { status, out } = live({ MOCK_CHARGE_PER_CALL: '0.01' })
    assert.equal(status, 1)
    assert.match(out, /✖ usage\s+0\.5 → 0\.52\s+CHANGED/)
    assert.match(out, /NOT CLEAN:\n\s+✖ usage changed from 0\.5 to 0\.52: something may have been charged\./)
  })

  it('exits 1 when a call reports a cost, and says so without the key', () => {
    const { status, out, err } = live({ MOCK_COST: '0.002' })
    assert.equal(status, 1)
    assert.match(out, /a call reported a cost above zero/)
    assert.match(out, /openrouter billed \$0\.002 for a request to vendor\/big:free, which is listed as free\. eNCode now treats vendor\/big:free as a paid model and will not use it\./)
    assert.doesNotMatch(out + err, /sk-or-v1/)
  })

  it("skips a model the account is shut out of, goes on to the next, and is still clean", () => {
    const refuse = { 'vendor/big:free': { status: 404, message: OPENROUTER_REFUSALS.policy } }
    const { status, out, err } = live({ MOCK_COST: '0', MOCK_REFUSE: JSON.stringify(refuse) }, '--test', '1')
    assert.equal(status, 0, err || out)
    assert.match(out, /– vendor\/big:free: skipped\. Your OpenRouter privacy settings leave vendor\/big:free no endpoint/)
    assert.match(out, /✔ vendor\/mid:free: answered/)
    assert.match(out, /1 answered, 1 shut out by this account or app/)
    assert.match(out, /Clean: every pick is free by its listing, and the key was not charged\./)
    assert.doesNotMatch(out, /NOT CLEAN/)
  })

  it('does not call it clean when every model it tries is shut out', () => {
    const refuse = {
      'vendor/big:free': { status: 403, message: OPENROUTER_REFUSALS.appOnly('vendor/big:free') },
      'vendor/mid:free': { status: 404, message: OPENROUTER_REFUSALS.policy },
    }
    const { status, out } = live({ MOCK_REFUSE: JSON.stringify(refuse) })
    assert.equal(status, 1)
    assert.match(out, /– vendor\/big:free: skipped\. OpenRouter lets only the coding apps on its list use vendor\/big:free/)
    assert.match(out, /0 answered, 2 shut out by this account or app/)
    assert.match(out, /no call was answered, so the comparison above proves nothing/)
  })

  it("says so when OpenRouter's count of free requests does not move", () => {
    const { status, out, err } = live({ MOCK_COST: '0', MOCK_COUNT_LATE: '1' })
    assert.equal(status, 0, err || out)
    assert.match(out, /free requests used today: 0 → 0 of 50 \(OpenRouter's count runs late, so this proves nothing either way\)/)
  })

  it('does not call a clean run when no call was answered, and keeps the key out of what the provider says back', () => {
    const { status, out, err } = live({ MOCK_CHAT_ERROR: '1' })
    assert.equal(status, 1)
    assert.match(out, /✖ vendor\/big:free: openrouter did not accept the API key\. \(HTTP 401/)
    assert.match(out, /no call was answered, so the comparison above proves nothing/)
    assert.doesNotMatch(out + err, /sk-or-v1/)
    assert.doesNotMatch(out + err, /mock-key/)
  })
})
