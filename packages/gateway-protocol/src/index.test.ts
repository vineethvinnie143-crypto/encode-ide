import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GATEWAY_ERRORS,
  VIRTUAL_MODEL_IDS,
  VIRTUAL_MODEL_ROLES,
  compareVersions,
  errorAction,
  isVirtualModelId,
  parseClientHeader,
  readGatewayError,
} from './index'

describe('gateway protocol', () => {
  it('gives every error code a status the client can route on', () => {
    for (const [code, spec] of Object.entries(GATEWAY_ERRORS)) {
      assert.ok(spec.status >= 400 && spec.status < 600, code)
      assert.equal(errorAction(code), spec.action)
    }
  })

  it('sends free-tier exhaustion to the next tier and short limits to a wait', () => {
    assert.equal(errorAction('daily_quota_exhausted'), 'next_tier')
    assert.equal(errorAction('free_tier_exhausted'), 'next_tier')
    assert.equal(errorAction('service_disabled'), 'next_tier')
    assert.equal(errorAction('rate_limited'), 'wait')
    assert.equal(errorAction('token_expired'), 'refresh')
    assert.equal(errorAction('invalid_token'), 'sign_in')
  })

  it('treats codes from a newer gateway as transient', () => {
    assert.equal(errorAction('something_new'), 'backoff')
    assert.equal(errorAction('__proto__'), 'backoff')
    assert.equal(errorAction('toString'), 'backoff')
  })

  it('reads gateway errors and ignores upstream ones', () => {
    assert.deepEqual(readGatewayError({ error: { code: 'rate_limited', message: 'Slow down', type: 'rate_limit_error', retry_after: 12 } }), {
      code: 'rate_limited',
      message: 'Slow down',
      type: 'rate_limit_error',
      retry_after: 12,
    })
    assert.equal(readGatewayError({ error: { code: 429, message: 'Rate limit exceeded' } }), undefined)
    assert.equal(readGatewayError({ choices: [] }), undefined)
    assert.equal(readGatewayError(null), undefined)
    assert.equal(readGatewayError({ error: { code: 'rate_limited', retry_after: -1 } })?.retry_after, undefined)
  })

  it('maps every virtual model to roles', () => {
    for (const id of VIRTUAL_MODEL_IDS) {
      assert.ok(isVirtualModelId(id))
      assert.ok(VIRTUAL_MODEL_ROLES[id].length > 0)
    }
    assert.equal(isVirtualModelId('qwen/qwen3-coder:free'), false)
    const roles = VIRTUAL_MODEL_IDS.flatMap((id) => VIRTUAL_MODEL_ROLES[id])
    assert.equal(new Set(roles).size, roles.length, 'a role belongs to one virtual model')
  })

  it('compares versions the way semver orders them', () => {
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
    assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
    assert.equal(compareVersions('1.0', '1.0.0'), null)
  })

  it('parses client headers strictly', () => {
    assert.deepEqual(parseClientHeader('desktop/0.1.0'), { app: 'desktop', version: '0.1.0' })
    assert.deepEqual(parseClientHeader(' cli/1.2.3-beta '), { app: 'cli', version: '1.2.3-beta' })
    assert.equal(parseClientHeader('Desktop/0.1.0'), null)
    assert.equal(parseClientHeader('desktop'), null)
    assert.equal(parseClientHeader(undefined), null)
  })
})
