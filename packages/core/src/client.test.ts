import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CompletionRequest, ProviderAdapter, StreamInput, TransportEvent } from '@encode/providers'
import { createProfileClient, NO_MODEL_MESSAGE, type ProfileConfig } from './client'
import { createScriptedClient } from './scripted'

const request = (): CompletionRequest => ({
  role: 'main',
  payload: { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] },
  requirements: { promptTokens: 10, maxOutputTokens: 100, tools: false, images: false },
  signal: new AbortController().signal,
})

function recordingAdapter(): ProviderAdapter & { inputs: StreamInput[] } {
  const inputs: StreamInput[] = []
  return {
    type: 'openai-compatible',
    inputs,
    async *stream(input): AsyncGenerator<TransportEvent> {
      inputs.push(input)
      yield { type: 'text', text: 'from the model' }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

const custom: ProfileConfig = { id: 'local', kind: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'local-model', contextWindow: 32_000 }

describe('the profile client', () => {
  it('says so when no profile is set up', async () => {
    const client = createProfileClient({ profile: () => null })
    assert.deepEqual(await client.complete(request()), { kind: 'paused', reason: 'no-model', message: NO_MODEL_MESSAGE })
    assert.equal((await client.budget('main')).model, 'none')
  })

  it('runs the demo agent for a demo profile', async () => {
    const demo = createScriptedClient([{ text: 'demo says hi' }])
    const client = createProfileClient({ profile: () => ({ id: 'demo', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }), demo })
    const outcome = await client.complete(request())
    assert.equal(outcome.kind, 'done')
    assert.equal(demo.requests.length, 1)
    assert.equal((await client.budget('main')).model, 'scripted')
  })

  it('calls the profile\'s model with its key, fetched afresh for every call', async () => {
    const adapter = recordingAdapter()
    let key = 'sk-one'
    const asked: string[] = []
    const client = createProfileClient({
      profile: () => custom,
      apiKey: (id) => {
        asked.push(id)
        return key
      },
      direct: { adapters: { 'openai-compatible': adapter } },
    })
    const first = await client.complete(request())
    assert.equal(first.kind, 'done')
    key = 'sk-two'
    await client.complete(request())
    assert.deepEqual(adapter.inputs.map((input) => input.target.apiKey), ['sk-one', 'sk-two'])
    assert.equal(adapter.inputs[0].target.baseUrl, 'http://127.0.0.1:9/v1')
    assert.equal(adapter.inputs[0].target.model, 'local-model')
    assert.equal(adapter.inputs[0].target.provider, 'local')
    assert.ok(asked.length >= 2)
    assert.equal((await client.budget('main')).contextWindow, 32_000)
  })

  it('goes without a key when none is stored, and names OpenRouter when told to', async () => {
    const adapter = recordingAdapter()
    const client = createProfileClient({
      profile: () => ({ ...custom, kind: 'openrouter', baseUrl: 'https://proxy.example/v1', model: 'some/model:free' }),
      apiKey: () => '',
      direct: { adapters: { openrouter: { ...adapter, type: 'openrouter' } } },
    })
    await client.complete(request())
    assert.equal(adapter.inputs[0].target.providerType, 'openrouter')
    assert.equal(adapter.inputs[0].target.apiKey, undefined)
  })

  it('follows a change of profile between calls', async () => {
    let profile: ProfileConfig | null = custom
    const demo = createScriptedClient([{ text: 'demo' }])
    const adapter = recordingAdapter()
    const client = createProfileClient({ profile: () => profile, demo, direct: { adapters: { 'openai-compatible': adapter } } })
    await client.complete(request())
    profile = { id: 'demo', kind: 'demo', baseUrl: '', model: 'eNCode-demo' }
    await client.complete(request())
    profile = null
    assert.equal((await client.complete(request())).kind, 'paused')
    assert.equal(adapter.inputs.length, 1)
    assert.equal(demo.requests.length, 1)
  })
})
