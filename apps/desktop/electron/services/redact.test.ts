import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redact } from './redact'

const OPENROUTER = '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'

describe('redact: credentials', () => {
  it('removes the keys of the services eNCode talks to wherever they appear', () => {
    assert.equal(redact(`using ${OPENROUTER} now`), 'using [redacted] now')
    assert.equal(redact('key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv end'), 'key [redacted] end')
    assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'), '[redacted] and [redacted]')
    assert.equal(redact('AKIAIOSFODNN7EXAMPLE'), '[redacted]')
    assert.equal(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'), 'jwt [redacted]')
  })

  it('removes a header or a field by its name and leaves the rest of the line', () => {
    assert.equal(redact(`Authorization: Bearer ${OPENROUTER}`), 'Authorization: [redacted]')
    assert.equal(redact('request failed (authorization=Basic dXNlcjpwYXNz, retrying)'), 'request failed (authorization=[redacted], retrying)')
    assert.equal(redact('sent Bearer abcdefghijklmnop to the server'), 'sent Bearer [redacted] to the server')
    assert.equal(redact('{"apiKey":"abc123def456","model":"x/y"}'), '{"apiKey":"[redacted]","model":"x/y"}')
    assert.equal(redact('GET /v1/models?api_key=abc123def456&limit=5'), 'GET /v1/models?api_key=[redacted]&limit=5')
    assert.equal(redact('password: hunter22 for the proxy'), 'password: [redacted] for the proxy')
    assert.equal(redact('x-api-key: abcdefgh'), 'x-api-key: [redacted]')
  })

  it('removes the password in an address', () => {
    assert.equal(redact('proxy http://ana:s3cret@proxy.local:8080/ failed'), 'proxy http://[redacted]@proxy.local:8080/ failed')
    assert.equal(redact('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1')
  })

  it('removes long mixed-case runs, which are tokens, and keeps hashes and ids', () => {
    assert.equal(redact('token-like Zk3pQ9vL2xR7mT4nB8cD1fG6hJ0sW5yA end'), 'token-like [redacted] end')
    const commit = '4a94a78ae0077626de380f1738d553b7701cae93'
    const session = '3f2b8c1e-9d4a-4e6b-8a1c-2b7d5e9f0a13'
    assert.equal(redact(`commit ${commit} session ${session}`), `commit ${commit} session ${session}`)
    assert.equal(redact('apps-desktop-electron-services-redact-test-file'), 'apps-desktop-electron-services-redact-test-file')
  })

  it('removes any value it is told about, however it looks, in every way a path or a JSON log would write it', () => {
    assert.equal(redact('the key correct-horse-battery-staple was rejected', { secrets: ['correct-horse-battery-staple'] }), 'the key [redacted] was rejected')
    const odd = 'C:\\keys\\main'
    assert.equal(redact('a C:\\\\keys\\\\main b and C:/keys/main', { secrets: [odd] }), 'a [redacted] b and [redacted]')
    assert.equal(redact('abc is short', { secrets: ['abc'] }), 'abc is short', 'a value too short to tell apart from a word is left')
    assert.equal(redact('anything', { secrets: [''] }), 'anything')
  })
})

describe('redact: who and where', () => {
  it('replaces e-mail addresses', () => {
    assert.equal(redact('from ana.b+x@example.co.uk to git@github.com:org/repo.git'), 'from [email] to [email]:org/repo.git')
  })

  it('replaces the home folder in every spelling and any other user folder', () => {
    const home = 'C:\\Users\\ana'
    assert.equal(redact('C:\\Users\\ana\\AppData\\Roaming\\eNCode', { home }), '~\\AppData\\Roaming\\eNCode')
    assert.equal(redact('"C:\\\\Users\\\\ana\\\\work"', { home }), '"~\\\\work"')
    assert.equal(redact('file:///c:/users/ana/work/a.ts', { home }), 'file:///~/work/a.ts')
    assert.equal(redact('C:\\Users\\ana2\\x', { home }), 'C:\\Users\\<user>\\x', 'a longer name is not the home folder, but it is still a name')
    assert.equal(redact('D:\\Users\\Bo Peep\\x'), 'D:\\Users\\<user> Peep\\x', 'a name with a space is cut at the space, which still removes the first part')
    assert.equal(redact('/home/bob/project and /Users/eve/x'), '/home/<user>/project and /Users/<user>/x')
  })

  it('leaves paths that name no user, and ordinary numbers and words', () => {
    const text = 'D:\\work\\encode\\src\\main.ts:42 maxTokens: 4096 tokens=250 input_token_count: 5 in 120 ms'
    assert.equal(redact(text, { home: 'C:\\Users\\ana' }), text)
  })

  it('does nothing more the second time', () => {
    const samples = [
      `Authorization: Bearer ${OPENROUTER} at C:\\Users\\ana\\x by ana@example.com`,
      '{"password":"hunter22","path":"C:\\\\Users\\\\ana\\\\x"} token=abc123def456',
      'proxy http://ana:s3cret@proxy.local/ and /home/bob/x and Zk3pQ9vL2xR7mT4nB8cD1fG6hJ0sW5yA',
    ]
    for (const sample of samples) {
      const once = redact(sample, { home: 'C:\\Users\\ana' })
      assert.equal(redact(once, { home: 'C:\\Users\\ana' }), once, sample)
    }
  })
})
