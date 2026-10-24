import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseBrowserRequest } from '@encode/tools'
import { agentKey, agentKeyOf, agentPartition, followsOnItsOwn, isWebUrl, keyStroke, permits, plainUserAgent } from './rules'

describe('Browser tabs', () => {
  it('give each chat an agent partition of its own that does not give the chat away', () => {
    const key = agentKey('session-1')
    assert.match(key, /^[a-f0-9]{16}$/)
    assert.equal(agentKey('session-1'), key)
    assert.notEqual(agentKey('session-2'), key)
    assert.equal(agentKeyOf(agentPartition(key)), key)
    for (const partition of ['persist:encode-browser', 'encode-agent-XYZ', `persist:${agentPartition(key)}`, '', undefined]) assert.equal(agentKeyOf(partition), null, String(partition))
  })

  it('load web pages and the blank page only', () => {
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'about:blank']) assert.ok(isWebUrl(url), url)
    for (const url of ['file:///C:/Windows/', 'javascript:alert(1)', 'app://renderer/index.html', 'data:text/html,hi', 'ms-settings:', 'not a url']) assert.ok(!isWebUrl(url), url)
  })

  it('let the agent’s tab follow a page on its own only to this computer and the hosts it opened', () => {
    const opened = new Set(['example.com'])
    assert.ok(followsOnItsOwn(opened, 'http://localhost:3000/login'))
    assert.ok(followsOnItsOwn(opened, 'http://127.0.0.1:8080/'))
    assert.ok(followsOnItsOwn(opened, 'https://example.com/docs'))
    assert.ok(followsOnItsOwn(opened, 'https://www.example.com/'), 'with or without www.')
    assert.ok(!followsOnItsOwn(opened, 'https://evil.example.org/'))
    assert.ok(!followsOnItsOwn(opened, 'https://example.com.evil.org/'))
    assert.ok(!followsOnItsOwn(opened, 'https://accounts.google.com/'))
    assert.ok(!followsOnItsOwn(opened, 'file:///etc/passwd'))
  })

  it('give the person’s tabs full screen and clipboard writes, and the agent’s nothing', () => {
    assert.ok(permits('fullscreen', false) && permits('clipboard-sanitized-write', false))
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid', 'serial', 'usb']) assert.ok(!permits(permission, false), permission)
    for (const permission of ['fullscreen', 'clipboard-sanitized-write', 'media']) assert.ok(!permits(permission, true), permission)
  })

  it('answer sites as Chrome does', () => {
    const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eNCode/0.4.0 Chrome/146.0.0.0 Electron/44.9.2 Safari/537.36'
    assert.equal(plainUserAgent(electron), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  })

  it('press the keys the tool names, and type text only where a key types it', () => {
    assert.deepEqual(keyStroke('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
    assert.deepEqual(keyStroke('Control+A'), { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
    assert.deepEqual(keyStroke('Shift+b'), { key: 'B', code: 'KeyB', keyCode: 66, modifiers: 8, text: 'B' })
    assert.equal(keyStroke('Alt+1')?.code, 'Digit1')
    assert.equal(keyStroke('Meta+Q'), null)
    assert.equal(keyStroke('rm -rf'), null)
  })

  it('take from the agent host only the steps the tool sends, field by field', () => {
    assert.deepEqual(parseBrowserRequest({ step: { type: 'open', url: 'localhost:5173' }, image: true }), { step: { type: 'open', url: 'http://localhost:5173/' }, image: true })
    assert.deepEqual(parseBrowserRequest({ step: { type: 'click', ref: 'e3', extra: 'x' }, image: false }), { step: { type: 'click', ref: 'e3' }, image: false })
    assert.deepEqual(parseBrowserRequest({ step: { type: 'scroll', direction: 'down', amount: 99 }, image: false })?.step, { type: 'scroll', direction: 'down', amount: 10 })
    for (const bad of [
      null,
      { step: { type: 'open', url: 'file:///C:/' }, image: false },
      { step: { type: 'open', url: 'https://example.com' } },
      { step: { type: 'click' }, image: false },
      { step: { type: 'click', ref: 'body' }, image: false },
      { step: { type: 'key', key: 'Meta+Q' }, image: false },
      { step: { type: 'type', text: 'x'.repeat(20_000) }, image: false },
      { step: { type: 'evaluate', code: 'alert(1)' }, image: false },
    ])
      assert.equal(parseBrowserRequest(bad), null, JSON.stringify(bad)?.slice(0, 80))
  })
})
