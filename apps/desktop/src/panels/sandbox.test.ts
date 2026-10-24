import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SandboxReport } from '@shared/types'
import { actionFor, canFix, fixConfirm, headline, limitLines, switchRows, workingLine } from './sandbox'

const report = (patch: Partial<SandboxReport> = {}): SandboxReport => ({
  state: 'active',
  engine: 'bubblewrap',
  limits: { reads: true, network: true, protectedPaths: 'exact', processes: true },
  settings: { enabled: true, required: false, allowUnsandboxed: true, caches: true, powershell: false, network: 'allow', allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
  tightened: [],
  problems: [],
  file: '/home/u/.encode/settings.json',
  marked: [],
  blocked: [],
  ...patch,
})

describe('what the screen says first', () => {
  it('says commands are confined, and through what', () => {
    const active = headline(report())
    assert.equal(active.tone, 'success')
    assert.match(active.detail, /bubblewrap/)
    assert.match(headline(report({ engine: 'integrity-level' })).detail, /low integrity level of Windows/)
    assert.match(headline(report({ engine: 'seatbelt' })).detail, /Seatbelt/)
  })

  it('says when Windows does not let the account prepare the folder, what that means for commands, and what helps', () => {
    const blocked = headline(report({ engine: 'integrity-level', blocked: ['D:\\TEST SERVEr'] }))
    assert.equal(blocked.tone, 'warning')
    assert.equal(blocked.title, 'The sandbox cannot be used in this folder')
    assert.match(blocked.detail, /security settings of D:\\TEST SERVEr, which the sandbox needs/)
    assert.match(blocked.detail, /you are asked each time, unless you chose Full access/)
    assert.match(blocked.detail, /copy of the folder inside your user folder/)
    assert.match(blocked.detail, /Fix this folder asks Windows for an administrator’s yes once/)
    const strict = headline(report({ blocked: ['D:\\a', 'E:\\b'], settings: { ...report().settings, allowUnsandboxed: false } }))
    assert.match(strict.detail, /2 folders \(D:\\a, E:\\b\)/)
    assert.match(strict.detail, /Commands there do not run/)
  })

  it('offers Fix this folder only for Windows’ sandbox in a folder it was refused, and says what it changes first (ADR 0118)', () => {
    assert.equal(canFix(report({ engine: 'integrity-level', blocked: ['D:\\TEST SERVEr'] })), true)
    assert.equal(canFix(report({ engine: 'integrity-level' })), false, 'nothing was refused')
    assert.equal(canFix(report({ blocked: ['/srv/a'] })), false, 'not Windows')
    assert.equal(canFix(report({ state: 'off', engine: 'integrity-level', blocked: ['D:\\a'] })), false, 'the sandbox is off')
    const other = headline(report({ engine: 'seatbelt', blocked: ['/Volumes/x'] }))
    assert.match(other.detail, /Full control of it \(Properties > Security\), then Check again/)
    assert.doesNotMatch(other.detail, /Fix this folder/)
    const ask = fixConfirm('D:\\TEST SERVEr')
    assert.match(ask.body, /^Windows asks for an administrator’s yes\. Then your account gets Full control of D:\\TEST SERVEr/)
    assert.match(ask.body, /takes ownership of it first/)
    assert.match(ask.body, /Remove marks does not take this back/)
    assert.equal(ask.confirmLabel, 'Fix folder')
  })

  it('says plainly when commands run with the person’s full access, and why', () => {
    assert.equal(headline(report({ state: 'off' })).tone, 'warning')
    const none = headline(report({ state: 'unavailable', reason: 'bubblewrap is not installed.' }))
    assert.equal(none.tone, 'warning')
    assert.match(none.detail, /bubblewrap is not installed\. Commands run with everything you can do/)
  })

  it('says which shell it cannot confine, and offers PowerShell only where that helps', () => {
    const git = { name: 'Git Bash', unsupported: 'Git Bash cannot run inside the Windows sandbox: its runtime shares objects with every other Git Bash and git program that is running, and a confined program is refused them. PowerShell can.' }
    const windows = headline(report({ state: 'unavailable', engine: 'integrity-level', reason: git.unsupported, shell: git }))
    assert.equal(windows.tone, 'warning')
    assert.equal(windows.title, 'Git Bash cannot run in the sandbox')
    assert.match(windows.detail, /Commands run with everything you can do on this computer\. Turn on “Run commands in PowerShell”/)
    const elsewhere = headline(report({ state: 'unavailable', reason: 'odd', shell: { name: 'bash', unsupported: 'bash cannot be confined here.' } }))
    assert.doesNotMatch(elsewhere.detail, /PowerShell/)
    const required = headline(report({ state: 'unavailable', engine: 'integrity-level', reason: git.unsupported, shell: git, settings: { ...report().settings, required: true } }))
    assert.equal(required.tone, 'danger')
    assert.match(required.title, /Git Bash cannot run in the sandbox, so no command runs/)
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
    const windows = limitLines(report({ engine: 'integrity-level', limits: { reads: false, network: false, protectedPaths: 'best-effort', processes: false } }))
    assert.equal(windows.length, 4)
    assert.match(windows[0], /read any file you can/)
    assert.match(windows[1], /use the network/)
    assert.match(windows[2], /end other programs you run/)
    assert.match(windows[3], /\.mcp\.json cannot be written by a command/)
    const loose = limitLines(report({ limits: { reads: true, network: true, protectedPaths: 'best-effort', processes: true } }))
    assert.equal(loose.length, 1)
    assert.match(loose[0], /delete and recreate/)
    assert.deepEqual(limitLines(report({ state: 'off', limits: { reads: false, network: false, protectedPaths: 'exact', processes: false } })), [])
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

  it('offer the PowerShell switch on Windows only', () => {
    const on = switchRows(report({ engine: 'integrity-level', limits: { reads: false, network: false, protectedPaths: 'exact', processes: false }, settings: { ...report().settings, powershell: true } }))
    assert.deepEqual(on.map((row) => row.key), ['enabled', 'powershell', 'required', 'allowUnsandboxed', 'network', 'caches'])
    assert.equal(on.find((row) => row.key === 'powershell')!.checked, true)
    assert.equal(switchRows(report()).some((row) => row.key === 'powershell'), false)
    assert.deepEqual(actionFor('powershell', true), { type: 'set', key: 'powershell', value: true })
  })

  it('cannot block the network where the system cannot, and says so', () => {
    const rows = switchRows(report({ engine: 'integrity-level', limits: { reads: false, network: false, protectedPaths: 'exact', processes: false } }))
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
