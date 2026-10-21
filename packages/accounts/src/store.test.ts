import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { MemorySecretStore, parseSession, readAccount, serializeSession, type StoredSession } from './store'

const tokenChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~+/=-'
const token = gen.string(tokenChars, 16, 200)
const time = gen.int(1, 4_000_000_000_000)
const login = gen.string('abcdefghijklmnopqrstuvwxyz0123456789-', 1, 39)

const session = gen.map(
  gen.tuple(token, token, time, time, time, login, gen.string('acc_0123456789abcdef', 1, 60)),
  ([accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, signedInAt, name, id]): StoredSession => ({
    v: 1,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
    account: { id, login: name },
    signedInAt,
  }),
)

describe('the saved session', () => {
  it('reads back exactly what was written', async () => {
    await check(session, (value) => {
      assert.deepEqual(parseSession(serializeSession(value)), value)
    })
  })

  it('keeps an https avatar and drops anything else', () => {
    const base: StoredSession = {
      v: 1,
      accessToken: 'a'.repeat(20),
      accessExpiresAt: 2,
      refreshToken: 'r'.repeat(20),
      refreshExpiresAt: 3,
      account: { id: 'acc_1', login: 'octocat', avatar_url: 'https://avatars.example.test/u/1' },
      signedInAt: 1,
    }
    assert.equal(parseSession(serializeSession(base))?.account.avatar_url, base.account.avatar_url)
    for (const avatar of ['javascript:alert(1)', 'http://avatars.example.test/u/1', 'data:image/png;base64,AAAA', 'x'.repeat(600)]) {
      const text = serializeSession({ ...base, account: { ...base.account, avatar_url: avatar } })
      assert.equal(parseSession(text)?.account.avatar_url, undefined, avatar)
    }
  })

  it('never throws on text it did not write, and accepts none of it', async () => {
    await check(gen.string('{}[]":,0123456789 abcdefnrstuvlx\\\n\t', 0, 120), (text) => {
      assert.equal(parseSession(text), null)
    })
    assert.equal(parseSession(undefined), null)
    assert.equal(parseSession(''), null)
  })

  it('rejects a session with any field that is the wrong kind', async () => {
    const good = JSON.parse(
      serializeSession({
        v: 1,
        accessToken: 'a'.repeat(20),
        accessExpiresAt: 2,
        refreshToken: 'r'.repeat(20),
        refreshExpiresAt: 3,
        account: { id: 'acc_1', login: 'octocat' },
        signedInAt: 1,
      }),
    ) as Record<string, unknown>
    const damage: Record<string, unknown[]> = {
      v: [0, 2, '1', null],
      accessToken: ['', 'short', 'has space in it 12345', 'new\nline-in-the-token', 42, null, 'x'.repeat(2000)],
      refreshToken: ['', 'short', 'tab\tin-the-token-1234', {}, null],
      accessExpiresAt: [0, -1, Number.NaN, '5', null, 9e15],
      refreshExpiresAt: [0, -1, '5', null],
      signedInAt: [0, -1, '5', null],
      account: [null, 'octocat', [], { id: 'acc_1' }, { login: 'octocat' }, { id: '', login: 'octocat' }, { id: 'acc_1', login: 'has space' }, { id: 'acc_1', login: 'x'.repeat(40) }],
    }
    for (const [field, values] of Object.entries(damage)) {
      for (const value of values) {
        const text = JSON.stringify({ ...good, [field]: value })
        assert.equal(parseSession(text), null, `${field} = ${String(value)}`)
      }
      const without = { ...good }
      delete without[field]
      assert.equal(parseSession(JSON.stringify(without)), null, `${field} missing`)
    }
  })

  it('does not carry unknown fields from the store into the session', () => {
    const text = JSON.stringify({
      v: 1,
      accessToken: 'a'.repeat(20),
      accessExpiresAt: 2,
      refreshToken: 'r'.repeat(20),
      refreshExpiresAt: 3,
      account: { id: 'acc_1', login: 'octocat', extra: 'x' },
      signedInAt: 1,
      isAdmin: true,
    })
    const parsed = parseSession(text) as unknown as Record<string, unknown>
    assert.equal(parsed.isAdmin, undefined)
    assert.deepEqual(Object.keys(parsed.account as object), ['id', 'login'])
  })
})

describe('readAccount', () => {
  it('accepts GitHub logins and gateway ids, and nothing else', async () => {
    assert.deepEqual(readAccount({ id: 'acc_1', login: 'a-b-1' }), { id: 'acc_1', login: 'a-b-1' })
    await check(gen.string(' <>"\'`&%$#@!*()[]{}|\\;:,.?/+=_~^\n\t', 1, 12), (text) => {
      assert.equal(readAccount({ id: 'acc_1', login: text }), undefined)
    })
  })
})

describe('MemorySecretStore', () => {
  it('keeps, replaces and removes values', async () => {
    const store = new MemorySecretStore()
    assert.equal(await store.get('a'), undefined)
    await store.set('a', '1')
    await store.set('a', '2')
    assert.equal(await store.get('a'), '2')
    await store.delete('a')
    await store.delete('a')
    assert.equal(await store.get('a'), undefined)
  })
})
