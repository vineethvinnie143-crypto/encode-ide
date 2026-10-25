import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { parseManifest } from '../electron/services/updates'
import { manifestOf, notesFromLog, previousTag, releaseBody, releaseFile } from './release-notes.mjs'

const COMMIT = 'f90a8e65cfc3da29837cfa5cb5d7c858a15f4e23'
const record = (hash: string, subject: string, body = '') => `${hash}\x1f${subject}\x1f${body}\x1e\n`

describe('a release description', () => {
  it('lists each merged pull request by its title, and other commits by their subject', () => {
    const log =
      record('a1', 'Merge pull request #91 from vineethvinnie143-crypto/claude/project-thread-2dljav', '\nTester builds update themselves (ADR 0127)\n') +
      record('b2', 'fix   the build   line') +
      record('c3', "Merge branch 'main' into feature") +
      record('d4', 'Merge pull request #90 from someone/branch', 'The agent tells its work and checks the outcome itself (ADR 0126)') +
      record('e5', 'Merge pull request #84: Computer tool opens applications from the Start menu (ADR 0120)', 'body line')
    assert.deepEqual(notesFromLog(log), [
      'Tester builds update themselves (ADR 0127) (#91)',
      'Fix the build line',
      'The agent tells its work and checks the outcome itself (ADR 0126) (#90)',
      'Computer tool opens applications from the Start menu (ADR 0120) (#84)',
    ])
    assert.equal(notesFromLog(Array.from({ length: 30 }, (_, index) => record(`h${index}`, `change ${index}`)).join('')).length, 20)
    assert.deepEqual(notesFromLog(''), [])
  })

  it('is what the updater in the app reads', () => {
    const manifest = manifestOf({
      version: '0.1.0',
      build: 295,
      commit: COMMIT,
      publishedAt: '2026-10-25T15:00:00.000Z',
      notes: ['Tester builds update themselves (ADR 0127) (#91)'],
      installer: releaseFile('eNCode-0.1.0-setup.exe', Buffer.from('setup')),
      portable: releaseFile('eNCode-0.1.0-portable.exe', Buffer.from('portable')),
    })
    const read = parseManifest(JSON.stringify(manifest))
    assert.equal(read.build, 295)
    assert.equal(read.installer.sha256, createHash('sha256').update('setup').digest('hex'))
    assert.equal(read.installer.size, 5)
    assert.equal(read.portable?.name, 'eNCode-0.1.0-portable.exe')
    assert.throws(() => manifestOf({ ...manifest, commit: 'abc' }), /not a commit/)
    assert.throws(() => manifestOf({ ...manifest, build: 0 }), /not a build number/)
  })

  it('writes a page with what is new and each file\'s fingerprint', () => {
    const manifest = manifestOf({
      version: '0.1.0',
      build: 295,
      commit: COMMIT,
      publishedAt: '2026-10-25T15:00:00.000Z',
      notes: ['One (#1)'],
      installer: releaseFile('eNCode-0.1.0-setup.exe', Buffer.from('setup')),
      portable: releaseFile('eNCode-0.1.0-portable.exe', Buffer.from('portable')),
    })
    const body = releaseBody(manifest)
    assert.match(body, /^Tester build 295 of eNCode 0\.1\.0, from commit f90a8e6\./)
    assert.match(body, /What is new:\n- One \(#1\)\n/)
    assert.ok(body.includes(`- eNCode-0.1.0-setup.exe: ${manifest.installer.sha256}`))
    assert.ok(body.includes(`- eNCode-0.1.0-portable.exe: ${manifest.portable!.sha256}`))
  })

  it('finds the release before this one', () => {
    assert.equal(previousTag(['build-290', 'build-12', 'v1', 'build-x', 'build-300', ''], 295), 'build-290')
    assert.equal(previousTag(['build-295'], 295), null)
    assert.equal(previousTag([], 295), null)
  })
})
