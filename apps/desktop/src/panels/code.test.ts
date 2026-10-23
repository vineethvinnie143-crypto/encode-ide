import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LanguageServerInfo, LanguageServersReport } from '@shared/types'
import { filesLabel, footerStatus, headline, noAnswerReason, serverForPath, sortedServers, stateLabel } from './code'

const server = (patch: Partial<LanguageServerInfo> & Pick<LanguageServerInfo, 'id'>): LanguageServerInfo => ({ label: patch.id, state: 'stopped', documents: 0, install: `install ${patch.id}`, files: [], ...patch })

const ts = server({ id: 'typescript', label: 'TypeScript and JavaScript', files: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] })
const cmake = server({ id: 'cmake', label: 'CMake', files: ['.cmake', 'cmakelists.txt'] })
const report = (patch: Partial<LanguageServersReport> = {}): LanguageServersReport => ({ state: 'on', servers: [ts, cmake], ...patch })

describe('the language servers on screen', () => {
  it('finds the server of a file by its whole name first, then its extension, in any case', () => {
    assert.equal(serverForPath(report(), 'src/App.TSX')?.id, 'typescript')
    assert.equal(serverForPath(report(), 'build/CMakeLists.txt')?.id, 'cmake')
    assert.equal(serverForPath(report(), 'notes.txt'), null)
    assert.equal(serverForPath(report(), 'Makefile'), null)
    assert.equal(serverForPath(null, 'a.ts'), null)
  })

  it('says what to do when servers do not run in the folder', () => {
    assert.equal(headline(report({ state: 'off' })).action, 'turn-on')
    assert.equal(headline(report({ state: 'untrusted' })).action, 'trust')
    assert.equal(headline(report({ servers: [{ ...ts, state: 'running' }, cmake] })).title, '1 server running')
    assert.equal(headline(report({ servers: [{ ...ts, state: 'missing' }] })).title, 'No language server is installed')
    assert.equal(headline(report()).title, 'Ready')
  })

  it('names each state plainly, and lists what runs and what failed first', () => {
    assert.deepEqual(stateLabel({ ...ts, state: 'running', working: true }), { label: 'Checking', tone: 'busy' })
    assert.deepEqual(stateLabel({ ...ts, state: 'stopped', detail: 'tsserver exited with code 1.' }), { label: 'Stopped', tone: 'warning' })
    assert.deepEqual(stateLabel({ ...ts, state: 'missing' }), { label: 'Not installed', tone: 'quiet' })
    const order = sortedServers(report({ servers: [{ ...cmake, state: 'missing' }, server({ id: 'go', state: 'failed' }), { ...ts, state: 'running' }] }))
    assert.deepEqual(order.map((item) => item.id), ['typescript', 'go', 'cmake'])
    assert.equal(filesLabel(ts), '.ts .tsx .js .jsx and 2 more')
    assert.equal(filesLabel(cmake), '.cmake cmakelists.txt')
  })

  it('tells the footer how the open file\'s server stands, and nothing for a file no server covers', () => {
    assert.equal(footerStatus(report(), 'notes.md'), null)
    assert.equal(footerStatus(report(), null), null)
    assert.deepEqual(footerStatus(report({ servers: [{ ...ts, state: 'running' }] }), 'a.ts')?.text, 'TypeScript and JavaScript')
    const missing = footerStatus(report({ servers: [{ ...ts, state: 'missing' }] }), 'a.ts')!
    assert.equal(missing.text, 'TypeScript and JavaScript: not installed')
    assert.match(missing.title, /install typescript/)
    assert.equal(footerStatus(report({ state: 'untrusted' }), 'a.ts')?.tone, 'warning')
    assert.equal(footerStatus(report({ state: 'off' }), 'a.ts')?.text, 'Language servers off')
    assert.equal(footerStatus(report({ servers: [{ ...ts, state: 'failed', detail: 'It crashed.' }] }), 'a.ts')?.title, 'It crashed.')
    // A file larger than the servers are given says so, whatever the server is doing.
    assert.deepEqual(footerStatus(report({ servers: [{ ...ts, state: 'running' }] }), 'a.ts', true)?.text, 'TypeScript and JavaScript: file too large')
    assert.equal(footerStatus(report({ state: 'off' }), 'a.ts', true)?.text, 'Language servers off')
  })

  it('say why a question to the servers had no answer, and what to do about it', () => {
    const feature = 'go to definition'
    assert.equal(noAnswerReason(report(), 'notes.md', feature), 'No language server covers notes.md, so go to definition is not available for it.')
    assert.equal(noAnswerReason(null, 'src/a.ts', feature), 'No language server covers a.ts, so go to definition is not available for it.')
    assert.equal(noAnswerReason(report({ state: 'off' }), 'a.ts', feature), 'Language servers are off. Turn them on in Settings to use go to definition.')
    assert.match(noAnswerReason(report({ state: 'untrusted' }), 'a.ts', feature), /Trust this folder/)
    assert.equal(noAnswerReason(report({ servers: [{ ...ts, state: 'running' }] }), 'src/a.ts', feature, true), 'a.ts is over 8 MB, more than language servers are given, so go to definition is not available for it.')
    assert.equal(noAnswerReason(report({ servers: [{ ...ts, state: 'missing' }] }), 'a.ts', feature), 'TypeScript and JavaScript is not installed. Install it to use go to definition: install typescript')
    assert.equal(noAnswerReason(report({ servers: [{ ...ts, state: 'running' }] }), 'a.ts', feature), 'TypeScript and JavaScript does not offer go to definition.')
    assert.match(noAnswerReason(report({ servers: [{ ...ts, state: 'starting' }] }), 'a.ts', feature), /still starting/)
  })
})
