import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VirtualModels } from '@encode/gateway-protocol'
import { CATALOG, catalogJson, poolDocument } from '../testing/harness'
import { buildPools, parseCatalog, pickCandidates, type CatalogModel } from './pool'

function listed(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'acme/model:free',
    name: 'Acme',
    created: 1,
    context_length: 65_536,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools'],
    architecture: { input_modalities: ['text'] },
    top_provider: { max_completion_tokens: 4096 },
    ...overrides,
  }
}

describe("OpenRouter's catalog", () => {
  it('reads the free models and their abilities', () => {
    assert.deepEqual(parseCatalog(catalogJson()), CATALOG)
  })

  it('keeps a model only when its id ends in :free and every listed price is zero', () => {
    const models = parseCatalog({
      data: [
        listed({ id: 'acme/ok:free' }),
        listed({ id: 'acme/numeric:free', pricing: { prompt: 0, completion: 0, request: 0, image: '0', web_search: null } }),
        listed({ id: 'acme/paid' }),
        listed({ id: 'acme/mislabeled:free', pricing: { prompt: '0.000001', completion: '0' } }),
        listed({ id: 'acme/web:free', pricing: { prompt: '0', completion: '0', web_search: '0.004' } }),
        listed({ id: 'acme/request-fee:free', pricing: { prompt: '0', completion: '0', request: '0.01' } }),
        listed({ id: 'acme/unpriced:free', pricing: undefined }),
        listed({ id: 'acme/half:free', pricing: { prompt: '0' } }),
        listed({ id: 'acme/blank:free', pricing: { prompt: '', completion: '' } }),
        listed({ id: 'acme/nan:free', pricing: { prompt: 'free', completion: '0' } }),
        listed({ id: 'acme/negative:free', pricing: { prompt: '-1', completion: '0' } }),
        listed({ id: 'acme/no-context:free', context_length: 0 }),
        listed({ id: 'openrouter/auto:free' }),
        null,
        'junk',
      ],
    })
    assert.deepEqual(
      models.map((model) => model.id),
      ['acme/ok:free', 'acme/numeric:free'],
    )
    assert.deepEqual(parseCatalog(null), [])
    assert.deepEqual(parseCatalog({ data: 'x' }), [])
  })
})

function model(id: string, context: number, tools: boolean, created = 0, images = false): CatalogModel {
  return { id, name: id, created, context, maxOutput: 4096, tools, images, reasoning: false }
}

describe('the free pool', () => {
  const models = [
    model('a/huge:free', 262_144, true, 1),
    model('a/notools:free', 262_144, false, 9),
    model('a/mid:free', 65_536, true, 5),
    model('a/mid-new:free', 65_536, true, 6),
    model('a/tiny:free', 8_192, true, 9),
    model('a/fast:free', 20_000, false, 2),
  ]

  it('ranks the main pool by capability and the fast pool by observed speed', () => {
    const pools = buildPools(models, {}, { 'a/fast:free': 300, 'a/mid:free': 900 })
    assert.deepEqual(pools[VirtualModels.main], ['a/huge:free', 'a/mid-new:free', 'a/mid:free'])
    assert.deepEqual(pools[VirtualModels.fast], ['a/fast:free', 'a/mid:free', 'a/notools:free', 'a/mid-new:free', 'a/huge:free'])
  })

  it('applies blocks, pins and an approved-only lock', () => {
    const pinned = buildPools(models, { pin: { [VirtualModels.main]: ['a/mid:free', 'a/unknown:free'] }, block: ['a/huge:free'] })
    assert.deepEqual(pinned[VirtualModels.main], ['a/mid:free', 'a/mid-new:free'])
    const locked = buildPools(models, { approvedOnly: true, approved: ['a/mid:free', 'a/fast:free'] })
    assert.deepEqual(locked[VirtualModels.main], ['a/mid:free'])
    assert.deepEqual(locked[VirtualModels.fast], ['a/mid:free', 'a/fast:free'])
    assert.deepEqual(buildPools(models, { approvedOnly: true })[VirtualModels.main], [])
  })

  it('picks fitting, untried and healthy models first', () => {
    const doc = poolDocument()
    const needs = { tools: true, images: false, contextTokens: 1000 }
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, needs, new Set(), {}, 0, 3), ['acme/big:free', 'acme/medium:free', 'beta/vision:free'])
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, needs, new Set(['acme/big:free']), {}, 0, 3), ['acme/medium:free', 'beta/vision:free'])
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, { ...needs, images: true }, new Set(), {}, 0, 3), ['beta/vision:free'])
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, { ...needs, contextTokens: 100_000 }, new Set(), {}, 0, 3), ['acme/big:free'])
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, { ...needs, contextTokens: 200_000 }, new Set(), {}, 0, 3), [])
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, needs, new Set(), { 'acme/big:free': 50 }, 10, 3), ['acme/medium:free', 'beta/vision:free'])
  })

  it('still offers the model that recovers soonest when every fitting one is cooling', () => {
    const doc = poolDocument()
    const cooling = { 'acme/big:free': 500, 'acme/medium:free': 200, 'beta/vision:free': 900 }
    assert.deepEqual(pickCandidates(doc, VirtualModels.main, { tools: true, images: false, contextTokens: 1 }, new Set(), cooling, 100, 3), ['acme/medium:free'])
  })
})
