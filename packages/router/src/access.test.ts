import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TransportError, classifyHttpFailure } from '@encode/providers'
import { refusalMessage, refusalOf } from './access'
import { OPENROUTER_REFUSALS } from './testing'

const MINUTE = 60_000

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** An error as the providers package classifies a failed OpenRouter response. */
function classified(status: number, message: string, extra: Record<string, unknown> = {}): TransportError {
  return classifyHttpFailure(status, undefined, JSON.stringify({ error: { message, code: status, ...extra } }))
}

describe('refusalOf', () => {
  it('knows a model the account privacy settings leave without an endpoint', () => {
    const error = classified(404, OPENROUTER_REFUSALS.policy)
    // The providers package sees only a missing model; the router reads what the provider wrote.
    assert.equal(error.kind, 'not-found')
    assert.deepEqual(refusalOf('openrouter', error), { kind: 'policy', ms: DAY })
  })

  it('knows the older wording of the same refusal', () => {
    const error = classified(404, 'No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy')
    assert.deepEqual(refusalOf('openrouter', error), { kind: 'policy', ms: DAY })
  })

  it('knows a model that answers only the apps OpenRouter lists, which the providers package takes for a refused key', () => {
    const error = classified(403, OPENROUTER_REFUSALS.appOnly('thinkingmachines/inkling:free'))
    assert.equal(error.kind, 'auth')
    assert.deepEqual(refusalOf('openrouter', error), { kind: 'app-only', ms: DAY })
  })

  it("knows a preset's server tool that the chat-completions API refuses, and sets the model aside for a short while", () => {
    const error = classified(400, OPENROUTER_REFUSALS.serverTool('openrouter:shell'))
    assert.equal(error.kind, 'invalid-request')
    assert.deepEqual(refusalOf('openrouter', error), { kind: 'server-tool', ms: 15 * MINUTE })
  })

  it('treats any other 403 as a refusal of that model for an hour, never as a refused key', () => {
    const error = classified(403, 'Forbidden')
    assert.equal(error.kind, 'auth')
    assert.deepEqual(refusalOf('openrouter', error), { kind: 'forbidden', ms: HOUR })
  })

  it('leaves a refused key alone, whatever the message says', () => {
    assert.equal(refusalOf('openrouter', classified(401, 'No auth credentials found')), undefined)
    assert.equal(refusalOf('openrouter', classified(401, 'Your guardrail rejected this API key')), undefined)
  })

  it('leaves what has its own handling alone', () => {
    const cases: Array<[string, TransportError]> = [
      ['a plain missing model', classified(404, 'No endpoints found for this model.')],
      ['a model without tool support', classified(404, 'No endpoints found that support tool use.')],
      ['a moderation refusal', classified(403, 'Input was flagged by moderation')],
      ['a spent budget', classified(403, 'Key limit exceeded (guardrail budget)', { metadata: { limit_source: 'guardrail', resets_at: '2026-10-22T00:00:00Z' } })],
      ['an empty balance', classified(402, 'Insufficient credits, see your data policy')],
      ['a rate limit', classified(429, 'Rate limit exceeded: free-models-per-day. See your guardrail settings')],
      ['an overloaded upstream', classified(502, 'Provider returned error')],
      ['a guardrail that stopped one request', classified(400, 'Guardrail triggered: the request contains personal data')],
      ['a data policy that is not about endpoints', classified(404, 'The model was not found. See our data policy for retention.')],
    ]
    for (const [name, error] of cases) assert.equal(refusalOf('openrouter', error), undefined, name)
  })

  it('applies to OpenRouter only', () => {
    const error = classified(404, OPENROUTER_REFUSALS.policy)
    for (const type of ['openai-compatible', 'anthropic', 'gateway']) assert.equal(refusalOf(type, error), undefined, type)
  })

  it('reads a failure that came inside a stream', () => {
    const error = new TransportError('auth', OPENROUTER_REFUSALS.appOnly('vendor/gated:free'), { status: 403 })
    assert.equal(refusalOf('openrouter', error)?.kind, 'app-only')
  })
})

describe('refusalMessage', () => {
  it('tells the user what is wrong and how to fix a privacy refusal, with the page the provider named', () => {
    const message = refusalMessage('policy', 'nvidia/nemotron-3.5-super-vl:free', `HTTP 404: ${OPENROUTER_REFUSALS.policy}`)
    assert.match(message, /nvidia\/nemotron-3\.5-super-vl:free/)
    assert.match(message, /privacy settings/)
    assert.match(message, /skips it for a day/)
    assert.match(message, /\(https:\/\/openrouter\.ai\/workspaces\/default\/guardrails\)/)
  })

  it('passes on links to OpenRouter only', () => {
    const elsewhere = refusalMessage('policy', 'vendor/m:free', 'No endpoints match your data policy. Fix it at https://evil.example/openrouter.ai/settings')
    assert.doesNotMatch(elsewhere, /evil\.example/)
    assert.doesNotMatch(elsewhere, /\(http/)
    const lookalike = refusalMessage('policy', 'vendor/m:free', 'No endpoints match your data policy. See https://openrouter.ai.evil.example/x')
    assert.doesNotMatch(lookalike, /evil\.example/)
  })

  it('explains an app-only model without blaming the key', () => {
    const message = refusalMessage('app-only', 'thinkingmachines/inkling:free', 'HTTP 403')
    assert.match(message, /thinkingmachines\/inkling:free/)
    assert.match(message, /coding apps/)
    assert.doesNotMatch(message, /key/i)
  })

  it('tells the user which tool, in which preset to look, and how long the model is skipped', () => {
    const error = classified(400, OPENROUTER_REFUSALS.serverTool('openrouter:shell'))
    const message = refusalMessage('server-tool', '@preset/deepseek', error.message)
    assert.match(message, /^OpenRouter added its openrouter:shell tool/)
    assert.match(message, /preset/)
    assert.match(message, /skips @preset\/deepseek for 15 minutes/)
    assert.doesNotMatch(message, /HTTP 400/)
  })

  it("says a refusal it cannot explain plainly, and leaves the provider's words to the details", () => {
    const message = refusalMessage('forbidden', 'vendor/m:free', `HTTP 403: ${'x'.repeat(500)}`)
    assert.equal(message, 'OpenRouter refused vendor/m:free for this account. eNCode skips it for an hour; the key and the other models are not affected.')
    assert.doesNotMatch(message, /HTTP|xxx/)
  })
})
