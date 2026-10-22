import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CompletionOutcome, CompletionRequest, ModelClient } from '@encode/providers'
import { cleanCommitMessage, commitPrompt, draftCommitMessage } from './commit-message'

function clientAnswering(answer: string | CompletionOutcome): ModelClient & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    requests,
    budget: async () => ({ model: 'test', contextWindow: 128_000, maxOutputTokens: 8_000 }),
    complete: async (request) => {
      requests.push(request)
      if (typeof answer !== 'string') return answer
      return {
        kind: 'done',
        message: { role: 'assistant', content: [{ type: 'thinking', text: 'The change renames a function.' }, { type: 'text', text: answer }] },
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        finish: 'stop',
      }
    },
  }
}

const input = { diff: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old()\n+fresh()\n', files: ['modified a.ts (+1 -1)'], subjects: ['feat(core): add a', 'fix(ui): b'] }

describe('a drafted commit message', () => {
  it('is asked of the Small tasks model with the subjects, the files and the changes, and nothing else', async () => {
    const client = clientAnswering('refactor(core): rename old to fresh')
    const message = await draftCommitMessage(client, input, new AbortController().signal)
    assert.equal(message, 'refactor(core): rename old to fresh')
    const [request] = client.requests
    assert.equal(request.role, 'utility')
    assert.equal(request.tool, 'CommitMessage')
    assert.deepEqual(request.payload.tools, [])
    assert.equal(request.requirements.tools, false)
    assert.equal(request.sticky, undefined, 'no session to stay with')
    const prompt = commitPrompt(input)
    assert.match(prompt, /^<recent_subjects>\nfeat\(core\): add a\nfix\(ui\): b\n<\/recent_subjects>\n\n<files>\nmodified a\.ts \(\+1 -1\)\n<\/files>\n\n<changes>\n--- a\.ts\n[\s\S]*\+fresh\(\)\n<\/changes>\n\nWrite the commit message\.$/)
    assert.doesNotMatch(commitPrompt({ ...input, subjects: [] }), /recent_subjects/, 'a first commit has no style to follow')
  })

  it('says why when no model can answer', async () => {
    const client = clientAnswering({ kind: 'paused', reason: 'no-model', message: 'Choose a model in Settings first.' })
    await assert.rejects(draftCommitMessage(client, input, new AbortController().signal), /Choose a model in Settings first\./)
    await assert.rejects(draftCommitMessage(clientAnswering('  \n'), input, new AbortController().signal), /did not write a message/)
  })

  it('is unwrapped from what models put around it', () => {
    assert.equal(cleanCommitMessage('```\nFix the parser\n\nIt dropped the last line.\n```'), 'Fix the parser\n\nIt dropped the last line.')
    assert.equal(cleanCommitMessage('```text\r\nFix the parser\r\n```'), 'Fix the parser')
    assert.equal(cleanCommitMessage('Commit message: Fix the parser'), 'Fix the parser')
    assert.equal(cleanCommitMessage('"Fix the parser"'), 'Fix the parser')
    assert.equal(cleanCommitMessage('Fix "the" parser'), 'Fix "the" parser', 'quotes inside stay')
    assert.equal(cleanCommitMessage('Fix the parser   \n\n\n\nIt dropped   \nthe last line.'), 'Fix the parser\n\nIt dropped\nthe last line.')
    assert.equal(cleanCommitMessage('x'.repeat(9_000)).length, 8_000)
  })
})
