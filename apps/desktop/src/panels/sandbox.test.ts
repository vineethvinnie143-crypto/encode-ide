import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SandboxReport } from '@shared/types'
import { actionFor, headline, limitLines, switchRows, workingLine } from './sandbox'

const report = (patch: Partial<SandboxReport> = {}): SandboxReport => ({
  state: 'active',
  engine: 'bubblewrap',
  limits: { reads: true, network: true, protectedPaths: 'exact' },
  settings: { enabled: true, required: false, allowUnsandboxed: true, caches: true, network: 'allow', allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
  tightened: [],
  problems: [],
  file: '/home/u/.encode/settings.json',
  ...patch,
})

describe('what the screen says first', () => {
  it('says commands are confined, and through what', () => {
    const active = headline(report())
    assert.equal(active.tone, 'success')
    assert.match(active.detail, /bubblewrap/)
    assert.match(headline(report({ engine: 'restricted-token' })).detail, /restricted Windows token/)
    assert.match(headline(report({ engine: 'seatbelt' })).detail, /Seatbelt/)
  })

  it('says plainly when commands run with the person’s full access, and why', () => {
    assert.equal(headline(report({ state: 'off' })).tone, 'warning')
    const none = headline(report({ state: 'unavailable', reason: 'bubblewrap is not installed.' }))
    assert.equal(none.tone, 'warning')
    assert.match(none.detail, /bubblewrap is not installed\. Commands run with everything you can do/)
  })

  it('is an alarm, not a note, when the settings require a sandbox that cannot start', () => {
    const required = headline(report({ state: 'unavailable', reason: 'No user namespaces.', settings: { ...report().settings, required: true } }))
    assert.equal(required.tone, 'danger')
    assert.match(required.title, /no command runs/)
  })
})

describe('what this system does not hold back', () => {
  it('lists nothing where everything is held, and each gap where it is not', () => {
    assert.deepEqual(limitLines(report()), [])
    const windows = limitLines(report({ engine: 'restricted-token', limits: { reads: false, network: false, protectedPaths: 'best-effort' } }))
    assert.equal(windows.length, 3)
    assert.match(windows[0], /read any file you can/)
    assert.match(windows[1], /use the network/)
    assert.match(windows[2], /delete and recreate/)
    assert.deepEqual(limitLines(report({ state: 'off', limits: { reads: false, network: false, protectedPaths: 'best-effort' } })), [])
  })
})

describe('the switches', () => {
  it('show the settings as they apply, the network switch meaning “blocked”', () => {
    const rows = switchRows(report({ settings: { ...report().settings, network: 'block', allowUnsandboxed: false } }))
    assert.deepEqual(rows.map((row) => [row.key, row.checked]), [
      ['enabled', true],
      ['required', false],
      ['allowUnsandboxed', false],
      ['network', true],
      ['caches', true],
    ])
  })

  it('cannot block the network where the system cannot, and says so', () => {
    const rows = switchRows(report({ engine: 'restricted-token', limits: { reads: false, network: false, protectedPaths: 'best-effort' } }))
    assert.match(rows.find((row) => row.key === 'network')!.locked ?? '', /cannot block the network/)
    assert.equal(rows.filter((row) => row.locked).length, 1)
    assert.match(rows.find((row) => row.key === 'caches')!.help, /cache folder of the sandbox’s own/)
  })

  it('turn into the action the host takes', () => {
    assert.deepEqual(actionFor('enabled', false), { type: 'set', key: 'enabled', value: false })
    assert.deepEqual(actionFor('network', true), { type: 'set', key: 'network', value: 'block' })
    assert.deepEqual(actionFor('network', false), { type: 'set', key: 'network', value: 'allow' })
  })

  it('show what is being prepared', () => {
    assert.equal(workingLine(report()), undefined)
    assert.equal(workingLine(report({ working: 'Preparing C:\\work for the sandbox' })), 'Preparing C:\\work for the sandbox')
  })
})
