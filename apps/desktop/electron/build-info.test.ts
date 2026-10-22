import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildLine } from '../shared/about'
import { aboutInfo, BUILD, describeOs, type BuildStamp } from './build-info'

const stamp: BuildStamp = { version: '0.1.0', commit: '502645ee4cfcac52646f6e6e2acc0bd9cabf7dce', dirty: false, builtAt: '2026-10-22T06:12:00.000Z', channel: 'tester' }
const versions = { electron: '44.9.2', chrome: '140.0.7339.0', node: '22.18.0' } as NodeJS.ProcessVersions

describe('build information', () => {
  it('tells Windows 11 from Windows 10 by the build number', () => {
    assert.equal(describeOs('win32', '10.0.26100'), 'Windows 11 (10.0.26100)')
    assert.equal(describeOs('win32', '10.0.22000'), 'Windows 11 (10.0.22000)')
    assert.equal(describeOs('win32', '10.0.19045'), 'Windows 10 (10.0.19045)')
    assert.equal(describeOs('darwin', '25.0.0'), 'macOS 25.0.0')
    assert.equal(describeOs('linux', '6.18.44'), 'Linux 6.18.44')
  })

  it('puts the stamp and the environment together', () => {
    const info = aboutInfo({ isPackaged: true, versions, platform: 'win32', arch: 'x64', release: '10.0.26100' }, stamp)
    assert.deepEqual(info, {
      name: 'eNCode',
      version: '0.1.0',
      commit: stamp.commit,
      dirty: false,
      builtAt: stamp.builtAt,
      channel: 'tester',
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      os: 'Windows 11 (10.0.26100)',
      electron: '44.9.2',
      chrome: '140.0.7339.0',
      node: '22.18.0',
    })
  })

  it('writes the line a bug report starts with', () => {
    const info = aboutInfo({ isPackaged: true, versions, platform: 'win32', arch: 'x64', release: '10.0.26100' }, stamp)
    assert.equal(buildLine(info), 'eNCode 0.1.0 tester, commit 502645e (built 2026-10-22T06:12:00.000Z)')
    assert.equal(buildLine({ ...info, dirty: true }), 'eNCode 0.1.0 tester, commit 502645e + local changes (built 2026-10-22T06:12:00.000Z)')
    assert.equal(buildLine({ ...info, commit: '', builtAt: '' }), 'eNCode 0.1.0 tester, no commit recorded')
  })

  it('has a stamp even when the sources run unbuilt', () => {
    assert.equal(BUILD.channel, 'dev')
    assert.equal(BUILD.commit, '')
  })
})
