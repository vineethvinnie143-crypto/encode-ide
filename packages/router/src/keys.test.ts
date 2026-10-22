import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { originOf, redact, staticKeys } from './keys'

describe('redact', () => {
  it('removes the keys in use, and anything shaped like a key or a credential', () => {
    const key = 'my-custom-secret-token-value'
    const text = [
      `failed with ${key}`,
      'key sk-or-v1-0123456789abcdef',
      'Authorization: Bearer abc.def-ghi_jkl',
      '{"api_key": "plain-secret-value"}',
      'x-api-key=another-secret-1234',
      'access_token:"tok_12345678"',
    ].join('\n')
    const clean = redact(text, [key])
    for (const secret of [key, '0123456789abcdef', 'abc.def-ghi_jkl', 'plain-secret-value', 'another-secret-1234', 'tok_12345678']) {
      assert.ok(!clean.includes(secret), `${secret} leaked: ${clean}`)
    }
    assert.match(clean, /"api_key": "\[redacted\]"/)
  })

  it('leaves ordinary text and short values alone', () => {
    assert.equal(redact('HTTP 429: rate limited, retry in 5 s', ['short']), 'HTTP 429: rate limited, retry in 5 s')
    assert.equal(redact('api_key: none'), 'api_key: none')
  })
})

describe('key sources', () => {
  it('reads a fixed map and binds nothing beyond it', async () => {
    const keys = staticKeys({ openrouter: 'sk-or-v1-abc', empty: '' })
    assert.equal(keys.has('openrouter'), true)
    assert.equal(keys.has('empty'), false)
    assert.equal(await keys.get('openrouter', 'https://openrouter.ai'), 'sk-or-v1-abc')
    assert.equal(await keys.get('missing', 'https://example.com'), undefined)
  })

  it('takes the origin of a base URL', () => {
    assert.equal(originOf('https://openrouter.ai/api/v1'), 'https://openrouter.ai')
    assert.equal(originOf('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434')
    assert.equal(originOf('nonsense'), '')
  })
})
