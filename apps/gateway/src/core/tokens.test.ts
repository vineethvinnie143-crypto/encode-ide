import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { base64url, fromBase64url, secretsEqual, utf8 } from './crypto'
import { GatewayError } from './errors'
import { TokenService } from './tokens'

const SECRET = 'a-gateway-secret-of-at-least-32-characters'
const OTHER = 'another-gateway-secret-of-32-characters!!'
const NOW = Date.UTC(2026, 9, 21, 12)

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected a GatewayError, got ${String(error)}`)
    return error.code
  }
  return 'resolved'
}

describe('access tokens', () => {
  it('verify while fresh and expire after their lifetime', async () => {
    const tokens = await TokenService.create(SECRET, null, 3600)
    const { token, expiresIn } = await tokens.issueAccess('acc_12345678', 'ses_12345678', NOW)
    assert.equal(expiresIn, 3600)
    assert.match(token, /^ea1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(await tokens.verifyAccess(token, NOW + 3_599_000), { sub: 'acc_12345678', sid: 'ses_12345678', iat: NOW / 1000, exp: NOW / 1000 + 3600 })
    assert.equal(await code(tokens.verifyAccess(token, NOW + 3_600_000)), 'token_expired')
  })

  it('refuse tokens signed with another secret, or changed in any byte', async () => {
    const tokens = await TokenService.create(SECRET, null, 3600)
    const stranger = await TokenService.create(OTHER, null, 3600)
    const { token } = await stranger.issueAccess('acc_12345678', 'ses_12345678', NOW)
    assert.equal(await code(tokens.verifyAccess(token, NOW)), 'invalid_token')

    const genuine = (await tokens.issueAccess('acc_12345678', 'ses_12345678', NOW)).token
    for (let index = 0; index < genuine.length; index++) {
      const replacement = genuine[index] === 'A' ? 'B' : 'A'
      const forged = genuine.slice(0, index) + replacement + genuine.slice(index + 1)
      assert.equal(await code(tokens.verifyAccess(forged, NOW)), 'invalid_token', `byte ${index}`)
    }
  })

  it('refuse claims that were re-signed with a forged account or a far-future issue time', async () => {
    const tokens = await TokenService.create(SECRET, null, 3600)
    const genuine = (await tokens.issueAccess('acc_12345678', 'ses_12345678', NOW)).token
    const [prefix, , tag] = genuine.split('.')
    const forgedClaims = base64url(utf8(JSON.stringify({ sub: 'acc_attacker1', sid: 'ses_12345678', iat: NOW / 1000, exp: NOW / 1000 + 3600 })))
    assert.equal(await code(tokens.verifyAccess(`${prefix}.${forgedClaims}.${tag}`, NOW)), 'invalid_token')

    const early = (await tokens.issueAccess('acc_12345678', 'ses_12345678', NOW + 3_600_000)).token
    assert.equal(await code(tokens.verifyAccess(early, NOW)), 'invalid_token')
  })

  it('keep working through a secret rotation', async () => {
    const before = await TokenService.create(OTHER, null, 3600)
    const after = await TokenService.create(SECRET, OTHER, 3600)
    const { token } = await before.issueAccess('acc_12345678', 'ses_12345678', NOW)
    assert.equal((await after.verifyAccess(token, NOW + 60_000)).sub, 'acc_12345678')
    const dropped = await TokenService.create(SECRET, null, 3600)
    assert.equal(await code(dropped.verifyAccess(token, NOW + 60_000)), 'invalid_token')
  })

  it('refuse anything that is not a token without throwing anything else', async () => {
    const tokens = await TokenService.create(SECRET, null, 3600)
    await check(gen.string('ea1.ABCxyz_-=/+.é\u0000', 0, 120), async (text) => {
      assert.equal(await code(tokens.verifyAccess(text, NOW)), 'invalid_token')
    })
    assert.equal(await code(tokens.verifyAccess(`ea1.${'A'.repeat(2000)}.x`, NOW)), 'invalid_token')
  })
})

describe('refresh tokens and pseudonyms', () => {
  it('have one fixed shape and 256 bits of randomness', async () => {
    const tokens = await TokenService.create(SECRET, null, 3600)
    const seen = new Set<string>()
    for (let index = 0; index < 200; index++) {
      const token = tokens.newRefreshToken()
      assert.equal(TokenService.refreshTokenShape(token), token)
      seen.add(token)
    }
    assert.equal(seen.size, 200)
    for (const bad of [null, 42, '', 'er1_short', `er2_${'a'.repeat(43)}`, `er1_${'a'.repeat(44)}`, `er1_${'a'.repeat(42)}!`]) {
      assert.equal(TokenService.refreshTokenShape(bad), null, String(bad))
    }
  })

  it('hash refresh tokens and devices without the secret, so sessions outlive a rotation', async () => {
    const a = await TokenService.create(SECRET, null, 3600)
    const b = await TokenService.create(OTHER, null, 3600)
    assert.equal(await a.hashRefresh('er1_x'), await b.hashRefresh('er1_x'))
    assert.notEqual(await a.hashDevice('device'), await a.hashRefresh('device'))
  })

  it('derive log ids and address buckets from the secret', async () => {
    const a = await TokenService.create(SECRET, null, 3600)
    const b = await TokenService.create(OTHER, null, 3600)
    assert.match(await a.logId('acc_12345678'), /^[0-9a-f]{16}$/)
    assert.equal(await a.logId('acc_12345678'), await a.logId('acc_12345678'))
    assert.notEqual(await a.logId('acc_12345678'), await b.logId('acc_12345678'))
    assert.notEqual(await a.ipBucket('203.0.113.7'), await a.ipBucket('203.0.113.8'))
    assert.ok(!(await a.ipBucket('203.0.113.7')).includes('203'))
  })
})

describe('crypto helpers', () => {
  it('round-trip base64url and reject other alphabets', async () => {
    await check(gen.array(gen.int(0, 255), 0, 64), (bytes) => {
      const encoded = base64url(new Uint8Array(bytes))
      assert.match(encoded, /^[A-Za-z0-9_-]*$/)
      assert.deepEqual([...(fromBase64url(encoded) ?? [])], bytes)
    })
    assert.equal(fromBase64url('ab+c'), null)
    assert.equal(fromBase64url('abc='), null)
    assert.equal(fromBase64url('a'), null)
  })

  it('compare secrets of any length', async () => {
    assert.equal(await secretsEqual('same', 'same'), true)
    assert.equal(await secretsEqual('same', 'Same'), false)
    assert.equal(await secretsEqual('short', 'a much longer value'), false)
    assert.equal(await secretsEqual('', ''), true)
  })
})
