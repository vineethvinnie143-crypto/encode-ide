import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowFraming } from './framing'

describe('allowFraming', () => {
  it('drops X-Frame-Options, whatever its case or value', () => {
    assert.deepEqual(allowFraming({ 'X-Frame-Options': ['DENY'], 'content-type': ['text/html'] }), { 'content-type': ['text/html'] })
    assert.deepEqual(allowFraming({ 'x-frame-options': ['SAMEORIGIN'] }), {})
  })

  it('drops frame-ancestors from a policy and keeps the other directives as written', () => {
    const policy = "default-src 'self'; frame-ancestors 'none'; script-src 'self' https://cdn.example/a,b"
    assert.deepEqual(allowFraming({ 'Content-Security-Policy': [policy] }), {
      'Content-Security-Policy': ["default-src 'self'; script-src 'self' https://cdn.example/a,b"],
    })
  })

  it('removes a header whose only directive was frame-ancestors, and keeps the others', () => {
    assert.deepEqual(allowFraming({ 'content-security-policy': ["frame-ancestors 'self' https://a.example"], etag: ['"1"'] }), { etag: ['"1"'] })
    assert.deepEqual(allowFraming({ 'content-security-policy': ["frame-ancestors 'none'", "img-src 'self'"] }), { 'content-security-policy': ["img-src 'self'"] })
  })

  it('reads the directive name in any case and with any spacing', () => {
    assert.deepEqual(allowFraming({ 'content-security-policy': ["img-src 'self';   Frame-Ancestors   'none' ;"] }), { 'content-security-policy': ["img-src 'self';"] })
  })

  it('handles a header that carries several policies', () => {
    assert.deepEqual(allowFraming({ 'content-security-policy': ["frame-ancestors 'none', default-src 'self'; frame-ancestors 'self'"] }), {
      'content-security-policy': ["default-src 'self'"],
    })
  })

  it('does not mistake a source or a value for the directive', () => {
    const policy = "img-src https://frame-ancestors.example; report-uri /frame-ancestors"
    assert.deepEqual(allowFraming({ 'content-security-policy': [policy] }), { 'content-security-policy': [policy] })
  })

  it('leaves a report-only policy and every other header alone, and does not change its input', () => {
    const headers = {
      'content-security-policy-report-only': ["frame-ancestors 'none'"],
      'cross-origin-opener-policy': ['same-origin'],
      'set-cookie': ['a=1', 'b=2'],
    }
    const copy = structuredClone(headers)
    assert.deepEqual(allowFraming(headers), copy)
    assert.deepEqual(headers, copy)
  })
})
