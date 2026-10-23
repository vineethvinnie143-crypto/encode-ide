import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { failureOf, roleText, skipSentence } from './plain'
import type { SkipReason } from './select'

const KEY = 'openrouter:deepseek/deepseek-chat-v3:free'

const KINDS = [
  'no-key', 'key-read', 'auth', 'payment', 'quota', 'free-daily', 'rate-limit', 'free-rpm', 'overloaded', 'server', 'timeout', 'network',
  'context-overflow', 'unsupported', 'not-found', 'content-filter', 'invalid-request', 'protocol', 'empty', 'tool-json', 'policy',
  'app-only', 'forbidden', 'server-tool', 'something-new',
]

const SKIPS: SkipReason[] = ['not-free', 'no-key', 'no-adapter', 'provider-blocked', 'paid-blocked', 'free-closed', 'pacing', 'cooling', 'context', 'tools', 'images', 'expired', 'tried']

/** One sentence: a full stop at its end, and none of a provider's raw answer. */
function assertSentence(text: string): void {
  assert.match(text, /^\S[^\n]*\.$/, text)
  assert.doesNotMatch(text, /HTTP|\d{3}|[{}"]|undefined|Error/, text)
  assert.ok(text.includes('deepseek/deepseek-chat-v3:free') || text.includes('openrouter') || text.startsWith('The free models'), `${text} names neither the model nor the provider`)
}

describe('the router in plain words', () => {
  it('says every kind of failure in one sentence about the model or the provider', () => {
    for (const kind of KINDS) assertSentence(failureOf({ kind }, KEY))
    for (const feature of ['tools', 'images', 'documents', 'stream', undefined]) assertSentence(failureOf({ kind: 'unsupported', feature }, KEY))
    assert.equal(failureOf({ kind: 'auth' }, KEY), 'openrouter did not accept the API key.')
    assert.equal(failureOf({ kind: 'rate-limit' }, KEY), 'deepseek/deepseek-chat-v3:free is getting too many requests right now.')
    assert.equal(failureOf({ kind: 'unsupported', feature: 'documents' }, KEY), 'deepseek/deepseek-chat-v3:free cannot read PDFs.')
  })

  it('says why selection passed a model over, by the block behind it when there is one', () => {
    for (const reason of SKIPS) assertSentence(skipSentence({ key: KEY, reason, message: `raw HTTP 429 {"x":1}` }, 'rate-limit'))
    assert.equal(skipSentence({ key: KEY, reason: 'provider-blocked', message: 'x' }, 'payment'), 'The openrouter account is out of credit.')
    assert.equal(skipSentence({ key: KEY, reason: 'cooling', message: 'x' }), 'deepseek/deepseek-chat-v3:free is not available right now.')
  })

  it('names the main role as the chat', () => {
    assert.equal(roleText('main'), 'this chat')
    assert.equal(roleText('reviewer'), 'the reviewer role')
  })
})
