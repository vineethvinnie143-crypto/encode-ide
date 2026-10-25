import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { CompletionRequest } from '@encode/providers'
import { closeHarnesses, loopHarness } from './testing'

after(closeHarnesses)

const names = (request: CompletionRequest) => request.payload.tools.map((tool) => tool.name)
const search = (request: CompletionRequest) => request.payload.tools.find((tool) => tool.name === 'ToolSearch')?.description ?? ''
const SELDOM = ['EnterPlanMode', 'CreateGoal', 'UpdateGoal', 'GetGoal']

describe('a smaller tool list for a model without a cache (ADR 0136)', () => {
  it('holds back the seldom needed tools, names them in ToolSearch, and sends one once it is loaded', async () => {
    const h = await loopHarness({
      client: { cache: { read: 1, write: 1, boundThinking: false, source: 'price' } },
      script: [{ calls: [{ name: 'ToolSearch', input: { query: 'select:CreateGoal' } }] }, { text: 'done' }],
    })
    await h.run('set a goal')
    const [first, second] = h.client.requests
    for (const name of SELDOM) assert.ok(!names(first!).includes(name), name)
    assert.ok(names(first!).includes('ExitPlanMode'), 'plan mode can always be left')
    assert.match(search(first!), /\nAlso: EnterPlanMode, CreateGoal, UpdateGoal, GetGoal$/)
    assert.ok(names(second!).includes('CreateGoal'), 'loaded, it is in the next request')
    assert.ok(!names(second!).includes('GetGoal'))
    assert.match(search(second!), /\nAlso: EnterPlanMode, UpdateGoal, GetGoal$/)
  })

  it('keeps the full list where cached tokens cost less, and where the cache is not known', async () => {
    for (const client of [{ cache: { read: 0.1, write: 1, boundThinking: false, source: 'price' as const } }, {}]) {
      const h = await loopHarness({ client, script: [{ text: 'done' }] })
      await h.run('hello')
      for (const name of SELDOM) assert.ok(names(h.client.requests[0]!).includes(name), name)
      assert.doesNotMatch(search(h.client.requests[0]!), /\nAlso:/)
    }
  })
})

describe('a tool loaded twice (ADR 0136)', () => {
  it('stays in the list after the conversation that loaded it is gone', async () => {
    const h = await loopHarness({
      script: [
        { calls: [{ name: 'ToolSearch', input: { query: 'select:NotebookEdit' } }] },
        { text: 'loaded' },
        { calls: [{ name: 'ToolSearch', input: { query: 'select:NotebookEdit' } }] },
        { text: 'loaded again' },
        { text: 'after' },
      ],
    })
    const forget = async () => h.conversation.replace([], { trigger: 'auto', summary: '', removed: 0, turnId: 'summary' })
    await h.run('load it')
    await forget()
    // The first request after: loaded once, the tool went with the messages that loaded it, and is loaded again.
    await h.run('load it again')
    assert.ok(!names(h.client.requests[2]!).includes('NotebookEdit'), 'loaded once, it goes with the messages that loaded it')
    await forget()
    await h.run('and now')
    assert.ok(names(h.client.requests.at(-1)!).includes('NotebookEdit'), 'loaded twice, it stays')
  })
})
