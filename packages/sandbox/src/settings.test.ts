import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_SETTINGS, expandPath, resolveSandboxSettings } from './settings'

describe('sandbox settings', () => {
  it('start with the defaults: on, optional, asking, network open, caches writable', () => {
    const settings = resolveSandboxSettings([])
    assert.deepEqual({ ...settings, problems: undefined }, { ...DEFAULT_SETTINGS, problems: undefined })
    assert.equal(settings.enabled, true)
    assert.equal(settings.required, false)
    assert.equal(settings.allowUnsandboxed, true)
    assert.equal(settings.network, true)
    assert.equal(settings.caches, true)
    assert.equal(settings.powershell, false)
  })

  it('take what the user says, the command line over the user’s files', () => {
    const settings = resolveSandboxSettings([
      { scope: 'user', config: { enabled: false, network: 'block', allowWrite: ['~/shared'], allowUnsandboxed: false } },
      { scope: 'cli', config: { enabled: true } },
    ])
    assert.equal(settings.enabled, true)
    assert.equal(settings.network, false)
    assert.equal(settings.allowUnsandboxed, false)
    assert.deepEqual(settings.allowWrite, ['~/shared'])
    assert.deepEqual(settings.problems, [])
  })

  it('let a folder’s settings make the sandbox stricter and nothing else', () => {
    const settings = resolveSandboxSettings([
      { scope: 'user', config: { network: true } },
      { scope: 'project', config: { required: true, network: 'block', allowUnsandboxed: false, caches: false, powershell: true, denyWrite: ['dist'], denyRead: ['secrets'] } },
    ])
    assert.equal(settings.required, true)
    assert.equal(settings.powershell, true)
    assert.equal(settings.network, false)
    assert.equal(settings.allowUnsandboxed, false)
    assert.equal(settings.caches, false)
    assert.deepEqual(settings.denyWrite, ['dist'])
    assert.deepEqual(settings.denyRead, ['secrets'])
    assert.deepEqual(settings.problems, [])
  })

  it('ignore, and report, a folder’s attempt to loosen it', () => {
    const settings = resolveSandboxSettings([
      { scope: 'user', config: { network: 'block', allowUnsandboxed: false } },
      {
        scope: 'project',
        config: { enabled: false, required: false, allowUnsandboxed: true, network: 'allow', caches: true, powershell: false, allowWrite: ['/'], allowRead: ['~/.ssh'] },
      },
      { scope: 'local', config: { enabled: false } },
      { scope: 'user', config: { powershell: true } },
    ])
    assert.equal(settings.powershell, true, 'a folder cannot turn it off for the person')
    assert.equal(settings.enabled, true)
    assert.equal(settings.required, false)
    assert.equal(settings.allowUnsandboxed, false)
    assert.equal(settings.network, false)
    assert.deepEqual(settings.allowWrite, [])
    assert.deepEqual(settings.allowRead, [])
    assert.equal(settings.problems.length, 9)
    assert.ok(settings.problems.every((problem) => /ignored/.test(problem)))
  })

  it('report wrong values and unknown keys and keep going', () => {
    const settings = resolveSandboxSettings([
      { scope: 'user', config: { enabled: 'yes', network: 'maybe', denyWrite: 'dist', allowWrite: [1, '', 'ok'], mystery: true } },
      { scope: 'user', config: 'nope' },
    ])
    assert.equal(settings.enabled, true)
    assert.equal(settings.network, true)
    assert.deepEqual(settings.allowWrite, ['ok'])
    assert.equal(settings.problems.length, 7)
  })

  it('read network as a word or a boolean', () => {
    assert.equal(resolveSandboxSettings([{ scope: 'user', config: { network: false } }]).network, false)
    assert.equal(resolveSandboxSettings([{ scope: 'user', config: { network: 'allow' } }]).network, true)
  })
})

describe('expandPath', () => {
  it('puts a relative path under the base and a leading ~ at home', () => {
    assert.equal(expandPath('dist', '/work/p', '/home/u', path.posix), '/work/p/dist')
    assert.equal(expandPath('~/x', '/work/p', '/home/u', path.posix), '/home/u/x')
    assert.equal(expandPath('~', '/work/p', '/home/u', path.posix), '/home/u')
    assert.equal(expandPath('/abs/../etc', '/work/p', '/home/u', path.posix), '/etc')
    assert.equal(expandPath('~\\x', 'C:\\work', 'C:\\Users\\u', path.win32), 'C:\\Users\\u\\x')
  })
})
