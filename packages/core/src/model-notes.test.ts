import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelBudget, ModelClient } from '@encode/providers'
import { isModelNotesSetting, modelNotes, reviewerSystem } from './model-notes'

const budgetOf = (model: string, family?: ModelBudget['family']): Pick<ModelClient, 'budget'> => ({
  budget: async () => ({ model, contextWindow: 128_000, maxOutputTokens: 8_192, ...(family ? { family } : {}) }) as ModelBudget,
})

describe('notes for a family of models (ADR 0142)', () => {
  it("finds DeepSeek's by the family the client knows, or by the model's id", () => {
    assert.match(modelNotes('deepseek/deepseek-v4.1-flash-1017').reviewer!, /Keep your reasoning short/)
    assert.match(modelNotes('@preset/flash', 'deepseek').reviewer!, /Keep your reasoning short/, 'a preset the router learned is served by DeepSeek')
    assert.match(modelNotes('@preset/deepseek-v4-1-1017', 'other').reviewer!, /Keep your reasoning short/, 'a preset named after its model')
    assert.deepEqual(modelNotes('anthropic/claude-sonnet-4.5', 'anthropic'), {})
    assert.deepEqual(modelNotes('qwen/qwen3-coder', 'qwen'), {})
  })

  it("puts the Reviewer's note after its instructions, both kept in the prompt cache", async () => {
    const parts = await reviewerSystem(budgetOf('@preset/flash', 'deepseek'), 'Review the change.', undefined)
    assert.deepEqual(parts.map((part) => [part.text.split('\n', 1)[0], part.cache]), [
      ['Review the change.', true],
      ['# Keep your reasoning short', true],
    ])
    assert.equal((await reviewerSystem(budgetOf('@preset/flash', 'deepseek'), 'Review the change.', 'auto')).length, 2)
  })

  it('gives the instructions alone when the notes are off, the family has none, or the client cannot say which model', async () => {
    const alone = [{ text: 'Review the change.', cache: true }]
    let asked = 0
    const counting: Pick<ModelClient, 'budget'> = { budget: async (role) => (asked++, budgetOf('deepseek/deepseek-chat').budget(role)) }
    assert.deepEqual(await reviewerSystem(counting, 'Review the change.', 'off'), alone)
    assert.equal(asked, 0, 'notes that are off ask the client nothing')
    assert.deepEqual(await reviewerSystem(budgetOf('openai/gpt-5', 'openai'), 'Review the change.', 'auto'), alone)
    const failing: Pick<ModelClient, 'budget'> = { budget: async () => Promise.reject(new Error('Choose a model in Settings first.')) }
    assert.deepEqual(await reviewerSystem(failing, 'Review the change.', 'auto'), alone)
    const throwing = { budget: () => { throw new Error('no router') } } as unknown as Pick<ModelClient, 'budget'>
    assert.deepEqual(await reviewerSystem(throwing, 'Review the change.', 'auto'), alone)
  })

  it('reads the setting', () => {
    assert.deepEqual(['auto', 'off', 'on', undefined, true].map(isModelNotesSetting), [true, true, false, false, false])
  })
})
