import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseConfig, type GatewayEnvVars } from './config'

const BASE: GatewayEnvVars = {
  OPENROUTER_API_KEY: 'sk-or-v1-0123456789',
  GATEWAY_SECRET: 'a-gateway-secret-of-at-least-32-characters',
}

function problems(env: GatewayEnvVars): string[] {
  const result = parseConfig(env)
  return result.ok ? [] : result.problems
}

describe('gateway configuration', () => {
  it('starts from safe defaults: invite-only sign-up, admin API and sign-in off, the kill switch off', () => {
    const result = parseConfig(BASE)
    assert.ok(result.ok)
    const { config } = result
    assert.equal(config.environment, 'production')
    assert.equal(config.signup.mode, 'allowlist')
    assert.equal(config.signup.minAccountAgeDays, 30)
    assert.equal(config.adminToken, null)
    assert.equal(config.githubClientId, null)
    assert.equal(config.killSwitch.on, false)
    assert.equal(config.openRouterBaseUrl, 'https://openrouter.ai/api/v1')
    assert.equal(config.global.requestsPerDay, 950)
    assert.equal(config.global.requestsPerMinute, 18)
    assert.equal(config.user.maxConcurrent, 2)
    assert.equal(config.upstream.fallbackModels, 3)
    assert.ok(config.upstream.preStreamBudgetMs < 60_000, "the pre-stream budget stays under the client's 60 s watchdog")
  })

  it('refuses to start without its secrets', () => {
    assert.deepEqual(problems({}), ['GATEWAY_SECRET must be set to at least 32 random characters', 'OPENROUTER_API_KEY must be set'])
    assert.ok(problems({ ...BASE, GATEWAY_SECRET: 'short' }).some((problem) => problem.startsWith('GATEWAY_SECRET')))
    assert.ok(problems({ ...BASE, GATEWAY_SECRET_PREVIOUS: 'short' }).some((problem) => problem.startsWith('GATEWAY_SECRET_PREVIOUS')))
    assert.ok(problems({ ...BASE, ADMIN_TOKEN: 'guessable' }).some((problem) => problem.startsWith('ADMIN_TOKEN')))
    assert.ok(problems({ ...BASE, OPENROUTER_API_KEY: 'sk-or v1' }).some((problem) => problem.startsWith('OPENROUTER_API_KEY')))
    assert.ok(problems({ ...BASE, OPENROUTER_API_KEY: 'sk-or-é' }).some((problem) => problem.startsWith('OPENROUTER_API_KEY')))
  })

  it('accepts https only, and plain http to loopback in development', () => {
    assert.ok(problems({ ...BASE, OPENROUTER_BASE_URL: 'http://openrouter.ai/api/v1' }).length)
    assert.ok(problems({ ...BASE, OPENROUTER_BASE_URL: 'http://127.0.0.1:8788/api/v1' }).length)
    assert.ok(problems({ ...BASE, ALERT_WEBHOOK_URL: 'https://user:pass@hooks.example.com/x' }).length)
    assert.ok(problems({ ...BASE, GITHUB_BASE_URL: 'not a url' }).length)
    const dev = parseConfig({ ...BASE, ENVIRONMENT: 'development', OPENROUTER_BASE_URL: 'http://127.0.0.1:8788/api/v1/' })
    assert.ok(dev.ok)
    assert.equal(dev.config.openRouterBaseUrl, 'http://127.0.0.1:8788/api/v1')
    assert.ok(problems({ ...BASE, ENVIRONMENT: 'development', OPENROUTER_BASE_URL: 'http://evil.example.com/api/v1' }).length)
  })

  it('checks numbers, modes and versions instead of guessing', () => {
    assert.ok(problems({ ...BASE, USER_REQUESTS_PER_DAY: '12.5' }).length)
    assert.ok(problems({ ...BASE, USER_REQUESTS_PER_DAY: '-1' }).length)
    assert.ok(problems({ ...BASE, GLOBAL_REQUESTS_PER_MINUTE: '0' }).length)
    assert.ok(problems({ ...BASE, UPSTREAM_FALLBACK_MODELS: '4' }).length, 'OpenRouter takes at most three models')
    assert.ok(problems({ ...BASE, SIGNUP_MODE: 'everyone' }).length)
    assert.ok(problems({ ...BASE, MIN_CLIENT_VERSION: 'latest' }).length)
    assert.ok(problems({ ...BASE, GITHUB_CLIENT_ID: 'x' }).length)
    assert.ok(problems({ ...BASE, DEFAULT_OUTPUT_TOKENS: '9000', MAX_OUTPUT_TOKENS: '4096' }).length)
  })

  it('reads lists and switches', () => {
    const result = parseConfig({ ...BASE, ALLOWED_GITHUB_LOGINS: ' Vineeth , octocat,,', KILL_SWITCH: 'on', KILL_SWITCH_MESSAGE: 'Back soon.', SIGNUP_MODE: 'open' })
    assert.ok(result.ok)
    assert.deepEqual(result.config.signup.allowedLogins, ['vineeth', 'octocat'])
    assert.deepEqual(result.config.killSwitch, { on: true, message: 'Back soon.' })
    assert.equal(result.config.signup.mode, 'open')
  })
})
