import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ModelTestResult } from '../../shared/model-tests'
import { MAX_KEPT, ModelTestStore, resultOf } from './model-tests'

let dir = ''
let file = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-model-tests-'))
  file = path.join(dir, 'eNCode-model-tests.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function result(ref: string, at: string, extra: Partial<ModelTestResult> = {}): ModelTestResult {
  return {
    ref,
    model: ref.split(':').slice(1).join(':'),
    at,
    skills: { writing: { passed: 3, total: 4 }, exploring: { passed: 2, total: 2 } },
    items: [{ id: 'fix-failing-test', title: 'Fix a failing test', skill: 'writing', outcome: 'passed', requests: 4, cost: 0.01 }],
    requests: 12,
    inputTokens: 90_000,
    outputTokens: 3_000,
    cost: 0.04,
    costKnown: true,
    durationMs: 61_000,
    ...extra,
  }
}

describe('ModelTestStore', () => {
  it('starts empty without a file, and keeps each model’s latest result across a restart', () => {
    const store = new ModelTestStore(file)
    assert.deepEqual(store.all(), {})
    store.save(result('p1:model-a', '2026-10-24T08:00:00.000Z'))
    store.save(result('p1:model-b', '2026-10-24T08:05:00.000Z'))
    store.save(result('p1:model-a', '2026-10-24T08:10:00.000Z', { skills: { writing: { passed: 4, total: 4 } } }))

    const again = new ModelTestStore(file).all()
    assert.deepEqual(Object.keys(again).sort(), ['p1:model-a', 'p1:model-b'])
    assert.deepEqual(again['p1:model-a'].skills, { writing: { passed: 4, total: 4 } })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1)
  })

  it('a run stopped before anything scored replaces nothing', () => {
    const store = new ModelTestStore(file)
    store.save(result('p1:model-a', '2026-10-24T08:00:00.000Z'))
    const kept = store.save(result('p1:model-a', '2026-10-24T09:00:00.000Z', { skills: {}, stopped: 'cancelled' }))
    assert.equal(kept['p1:model-a'].at, '2026-10-24T08:00:00.000Z')
    assert.equal(new ModelTestStore(file).all()['p1:model-a'].at, '2026-10-24T08:00:00.000Z')
  })

  it(`keeps the ${MAX_KEPT} most recently tested models`, () => {
    const store = new ModelTestStore(file)
    for (let index = 0; index <= MAX_KEPT; index++) {
      store.save(result(`p1:model-${index}`, new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString()))
    }
    const kept = new ModelTestStore(file).all()
    assert.equal(Object.keys(kept).length, MAX_KEPT)
    assert.equal(kept['p1:model-0'], undefined)
    assert.ok(kept[`p1:model-${MAX_KEPT}`])
  })

  it('starts afresh from a file it cannot read', () => {
    fs.writeFileSync(file, '{ not json')
    assert.deepEqual(new ModelTestStore(file).all(), {})
  })
})

describe('resultOf', () => {
  it('takes a result as written', () => {
    const written = result('p1:model-a', '2026-10-24T08:00:00.000Z', { stopped: 'limit' })
    assert.deepEqual(resultOf(JSON.parse(JSON.stringify(written))), written)
  })

  it('leaves out what is not a result, and the parts of one that are not of its shape', () => {
    assert.equal(resultOf(null), undefined)
    assert.equal(resultOf({ ref: 'p1:a', model: 'a', at: 'yesterday', skills: {}, items: [] }), undefined)
    assert.equal(resultOf({ ref: 'p1:a', model: 'a', at: '2026-10-24T08:00:00.000Z', items: [] }), undefined)
    const taken = resultOf({
      ref: 'p1:a',
      model: 'a',
      at: '2026-10-24T08:00:00.000Z',
      skills: { writing: { passed: 5, total: 4 }, exploring: { passed: 1, total: 2 }, guessing: { passed: 1, total: 1 } },
      items: [{ id: 'x', title: 'X', skill: 'writing', outcome: 'failed', reason: 'The test still fails.', requests: 3, cost: 0 }, { id: 'y', title: 'Y', skill: 'writing', outcome: 'hacked' }, { id: 'z', title: 'Z' }, 'junk', null],
      requests: -3,
      cost: Number.NaN,
      costKnown: 'yes',
      stopped: 'bored',
    })
    assert.ok(taken)
    assert.deepEqual(taken.skills, { exploring: { passed: 1, total: 2 } })
    assert.deepEqual(taken.items.map((item) => item.id), ['x'])
    assert.equal(taken.requests, 0)
    assert.equal(taken.cost, 0)
    assert.equal(taken.costKnown, false)
    assert.equal(taken.stopped, undefined)
  })
})
