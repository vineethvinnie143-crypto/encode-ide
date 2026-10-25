import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, ModelBudget, ModelRole } from '@encode/providers'
import { BATCH_LOOKS } from './prompt'
import { closeHarnesses, loopHarness, sessionHarness } from './testing'

after(closeHarnesses)

/** Whether the request's last message carries the note that asks for batched reads. */
const asked = (request: CompletionRequest) => JSON.stringify(request.payload.messages.at(-1)).includes(BATCH_LOOKS.slice(0, 40))

describe('fewer, fuller steps (ADR 0134)', () => {
  it('asks once a request, after three steps that each read one thing, to make the reads it knows of together', async () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`src/f${n}.js`, `export const v${n} = ${n}\n`]))
    const h = await loopHarness({
      files,
      maxSteps: 20,
      script: [
        { calls: [{ name: 'Read', input: { file_path: 'src/f0.js' } }] },
        { calls: [{ name: 'Grep', input: { pattern: 'v1' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'src/f1.js' } }] },
        // Asked after the third: the next reply batches.
        { calls: [{ name: 'Read', input: { file_path: 'src/f2.js' } }, { name: 'Read', input: { file_path: 'src/f3.js' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'src/f4.js' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'src/f5.js' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'src/f6.js' } }] },
        { text: 'done' },
      ],
    })
    await h.run('look around')
    const notes = h.client.requests.map(asked)
    // Requests 2, 3 and 4 follow the first three solo steps; the third of those carries the note, and only it.
    assert.deepEqual(notes, [false, false, false, true, false, false, false, false])
  })

  it('does not count a command or an edit as a step that only read', async () => {
    const h = await loopHarness({
      files: { 'a.txt': 'one\n' },
      maxSteps: 20,
      script: [
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { calls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'one', new_string: 'two' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { calls: [{ name: 'Bash', input: { command: 'echo hi' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'done' },
      ],
    })
    await h.run('change it')
    assert.ok(!h.client.requests.some(asked))
  })
})

describe('a cheaper Explore (ADR 0134)', () => {
  const budgets = (prices: Partial<Record<ModelRole, { model: string; input?: number }>>) => async (role: ModelRole): Promise<ModelBudget> => {
    const own = prices[role] ?? prices.main!
    return { model: own.model, contextWindow: 200_000, maxOutputTokens: 8_192, ...(own.input !== undefined ? { price: { input: own.input, output: own.input * 4 } } : {}) }
  }
  const environment = (request: CompletionRequest) => JSON.stringify(request.payload.messages[0])

  it('is named in the environment when its model costs at most half of Main', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    h.client.budget = budgets({ main: { model: 'big', input: 3 }, explore: { model: 'small', input: 0.25 } })
    await h.session.start({ text: 'Find where the config is read', mode: 'code' })
    assert.match(environment(h.client.requests[0]!), /Explore subagents \(Task with subagent_type Explore\) run on small, at 8% of your model's price/)
  })

  it('is not named when it follows Main, costs more than half of it, or a price is unknown', async () => {
    for (const prices of [
      { main: { model: 'big', input: 3 } },
      { main: { model: 'big', input: 3 }, explore: { model: 'mid', input: 2 } },
      { main: { model: 'big' }, explore: { model: 'small', input: 0.25 } },
      { main: { model: 'big', input: 3 }, explore: { model: 'small' } },
    ]) {
      const h = await sessionHarness({ script: [{ text: 'ok' }] })
      h.client.budget = budgets(prices)
      await h.session.start({ text: 'Find where the config is read', mode: 'code' })
      assert.ok(!environment(h.client.requests[0]!).includes('Explore subagents'), JSON.stringify(prices))
    }
  })
})
