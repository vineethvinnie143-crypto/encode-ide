import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LanguageServerInfo, LanguageServersReport } from '@shared/types'
import { companionsForPath, filesLabel, footerStatus, headline, installName, installOffer, installPercent, installTarget, noAnswerReason, serverForPath, sizeLabel, sortedServers, stateLabel } from './code'

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
    assert.equal(noAnswerReason(report({ servers: [{ ...ts, state: 'missing', installer: 'npm' }] }), 'a.ts', feature), 'TypeScript and JavaScript is not installed. Install it from Settings > Language servers to use go to definition.')
  })
})

describe('installing a language server with one click', () => {
  const missing = { ...ts, state: 'missing' as const, installer: 'npm' as const }

  it('offers it above a file whose server is missing, only when eNCode can install it, servers may run and the person did not say not now', () => {
    assert.deepEqual(installOffer(report({ servers: [missing] }), 'src/App.tsx', []), {
      id: 'typescript',
      label: 'TypeScript and JavaScript',
      text: 'No language server for TypeScript and JavaScript files. Install one for errors as you type, completions and go to definition.',
    })
    assert.equal(installOffer(report({ servers: [missing] }), 'src/App.tsx', ['typescript']), null)
    assert.equal(installOffer(report({ servers: [{ ...missing, installer: undefined }] }), 'src/App.tsx', []), null)
    assert.equal(installOffer(report({ servers: [{ ...missing, installing: { done: 1, total: 2 } }] }), 'src/App.tsx', []), null)
    assert.equal(installOffer(report({ servers: [{ ...missing, state: 'stopped' }] }), 'src/App.tsx', []), null)
    assert.equal(installOffer(report({ state: 'untrusted', servers: [missing] }), 'src/App.tsx', []), null)
    assert.equal(installOffer(report({ servers: [missing] }), 'notes.md', []), null)
    assert.equal(installOffer(null, 'a.ts', []), null)
  })

  it("offers what the folder wants the server to read once the server is there, such as FiveM's natives", () => {
    const natives = { id: 'fivem-natives', label: 'FiveM natives', what: "FiveM's natives for Lua" }
    const lua = server({ id: 'lua', label: 'Lua', files: ['.lua'], libraries: [natives] })
    assert.deepEqual(installOffer(report({ servers: [lua] }), 'client/main.lua', []), {
      id: 'fivem-natives',
      label: 'FiveM natives',
      text: "FiveM's natives for Lua are not installed. Install them so hovers, completion and checks know each one.",
    })
    // The server first, when it is missing too.
    assert.equal(installOffer(report({ servers: [{ ...lua, state: 'missing', installer: 'download' }] }), 'client/main.lua', [])?.id, 'lua')
    assert.equal(installOffer(report({ servers: [lua] }), 'client/main.lua', ['fivem-natives']), null)
    assert.equal(installOffer(report({ servers: [{ ...lua, libraries: [{ ...natives, installed: '2.0' }] }] }), 'client/main.lua', []), null)
    assert.equal(installOffer(report({ servers: [{ ...lua, libraries: [{ ...natives, installing: { done: 0, total: 1 } }] }] }), 'client/main.lua', []), null)
    assert.deepEqual(installTarget(report({ servers: [lua] }), 'fivem-natives'), { kind: 'library', item: natives, server: lua })
    assert.equal(installTarget(report({ servers: [lua] }), 'lua')?.kind, 'server')
    assert.equal(installTarget(report({ servers: [lua] }), 'nope'), null)
    assert.equal(installName(report({ servers: [lua] }), 'fivem-natives'), "FiveM's natives for Lua")
    assert.equal(installName(report({ servers: [lua] }), 'lua'), "Lua's language server")
  })

  it('offers a companion the folder uses once the file\'s own server is there, and never takes it for the file\'s server', () => {
    const web = server({ id: 'web', label: 'JSON, CSS and HTML', state: 'running', files: ['.css', '.html'] })
    const tailwind = server({ id: 'tailwind', label: 'Tailwind CSS', state: 'missing', installer: 'npm', companion: true, files: ['.css', '.html', '.tsx'], used: { files: 12, markers: ['tailwind.config.js'] } })
    // Listed first (it covers the most files), still not the file's server.
    const both = report({ servers: [tailwind, web, ts] })
    assert.equal(serverForPath(both, 'web/src/index.css')?.id, 'web')
    assert.equal(serverForPath(both, 'web/src/App.tsx')?.id, 'typescript')
    assert.deepEqual(companionsForPath(both, 'web/src/index.css').map((item) => item.id), ['tailwind'])
    assert.deepEqual(companionsForPath(both, 'server/main.lua'), [])
    assert.deepEqual(installOffer(both, 'web/src/index.css', []), {
      id: 'tailwind',
      label: 'Tailwind CSS',
      text: 'This folder uses Tailwind CSS. Install its language server for its suggestions, hovers and checks in these files.',
    })
    assert.equal(installOffer(both, 'web/src/App.tsx', [])?.id, 'tailwind')
    // The file's own server first, when it is missing too.
    assert.equal(installOffer(report({ servers: [tailwind, web, { ...ts, state: 'missing', installer: 'npm' }] }), 'web/src/App.tsx', [])?.id, 'typescript')
    assert.equal(installOffer(both, 'web/src/index.css', ['tailwind']), null)
    // Not in a folder that does not use it, nor once it is installed or installing.
    assert.equal(installOffer(report({ servers: [{ ...tailwind, used: undefined }, web] }), 'web/src/index.css', []), null)
    assert.equal(installOffer(report({ servers: [{ ...tailwind, state: 'stopped' }, web] }), 'web/src/index.css', []), null)
    assert.equal(installOffer(report({ servers: [{ ...tailwind, installing: { done: 0, total: 1 } }, web] }), 'web/src/index.css', []), null)
  })

  it('shows the progress of an install, and the size to download', () => {
    assert.equal(installPercent({ ...missing, installing: { done: 512, total: 2048 } }), 25)
    assert.equal(installPercent({ ...missing, installing: { done: 3000, total: 2048 } }), 100)
    assert.equal(installPercent({ ...missing, installing: { done: 512, total: 0 } }), null)
    assert.equal(installPercent(missing), null)
    assert.deepEqual(stateLabel({ ...missing, installing: { done: 1, total: 4 } }), { label: 'Installing, 25%', tone: 'busy' })
    assert.deepEqual(stateLabel({ ...missing, installing: { done: 0, total: 0 } }), { label: 'Installing', tone: 'busy' })
    assert.equal(footerStatus(report({ servers: [{ ...missing, installing: { done: 0, total: 0 } }] }), 'a.ts')?.text, 'TypeScript and JavaScript: installing')
    assert.equal(footerStatus(report({ servers: [missing] }), 'a.ts')?.title, 'Click to install it, to see errors as you type.')
    assert.equal(sizeLabel(4.25 * 1048576), '4.3 MB')
    assert.equal(sizeLabel(860 * 1024), '860 KB')
    assert.equal(sizeLabel(10), '1 KB')
  })

  it('lists a missing server the folder uses with the ready ones, before those it does not use', () => {
    const python = server({ id: 'python', state: 'missing' })
    const lua = server({ id: 'lua', state: 'missing', used: { files: 3, markers: ['fxmanifest.lua'] } })
    const go = server({ id: 'go', state: 'missing', installing: { done: 0, total: 0 } })
    const order = sortedServers(report({ servers: [python, lua, { ...ts, state: 'stopped' }, go] }))
    assert.deepEqual(order.map((item) => item.id), ['lua', 'typescript', 'go', 'python'])
  })
})
