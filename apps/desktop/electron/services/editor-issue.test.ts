import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EditorTrace } from '@encode/editor'
import type { AboutInfo } from '../../shared/types'
import type { EditorIssueDraft } from '../../shared/editor-issue'
import { CREDENTIAL_REASON, SECRET_FILE_REASON, editorIssueFile } from './editor-issue'

const about = { version: '0.1.0', channel: 'tester', commit: '0123456789abcdef', dirty: false, builtAt: '2026-10-23T12:00:00Z', os: 'Windows 11 (10.0.26100)', arch: 'x64', electron: '44', chrome: '140', node: '24' } as unknown as AboutInfo

const trace = (doc: string, insert = 'x'): EditorTrace => ({ version: 1, doc, language: 'lua', steps: [{ changes: [[0, 0, insert]], origin: 'input.type', t: 10 }, { expect: { length: doc.length + insert.length, lines: 2, hash: '00000000' }, t: 10 }] })

const draft = (patch: Partial<EditorIssueDraft> = {}): EditorIssueDraft => ({
  description: 'The cursor jumped after Undo',
  path: 'C:/Users/ana/server/resources/shop/client/main.lua',
  language: 'lua',
  scrambled: false,
  editor: { wordWrap: 'off' },
  recorded: { steps: 1, minutes: 0.5, trimmed: false },
  problems: [],
  trace: trace('local shop = {}\n'),
  ...patch,
})

const context = { about, now: Date.UTC(2026, 9, 23, 14, 5), redact: (text: string) => text.replace(/C:\/Users\/ana/g, '<home>') }

describe('the file a report of an editor issue is written as', () => {
  it('holds the build, the system, the facts, and the trace last; never the path but for its extension', () => {
    const made = editorIssueFile(draft({ description: 'It broke in C:/Users/ana/server' }), context)
    assert.ok(made.ok)
    const issue = JSON.parse(made.text)
    assert.equal(issue.kind, 'encode-editor-issue')
    assert.equal(issue.version, 1)
    assert.equal(issue.createdAt, '2026-10-23T14:05:00.000Z')
    assert.match(issue.build, /0\.1\.0/)
    assert.equal(issue.system, 'Windows 11 (10.0.26100) x64')
    assert.equal(issue.extension, '.lua')
    assert.equal(issue.lines, 2)
    assert.equal(issue.description, 'It broke in <home>/server', 'what the person wrote goes through the log redaction')
    assert.deepEqual(issue.trace, draft().trace)
    assert.equal(made.text.includes('resources/shop'), false)
    assert.equal('path' in issue, false)
    assert.ok(made.text.trimEnd().endsWith('}'))
    assert.ok(made.text.lastIndexOf('"trace"') > made.text.lastIndexOf('"problems"'), 'the trace comes last')
  })

  it('carries a secret file, or text shaped like a credential, only with its words replaced', () => {
    assert.deepEqual(editorIssueFile(draft({ path: 'server/.env' }), context), { ok: false, reason: SECRET_FILE_REASON })
    const cfg = trace('sv_licenseKey cfxk_abcdefghijklmnop1234\n')
    assert.deepEqual(editorIssueFile(draft({ path: 'server.cfg', trace: cfg }), context), { ok: false, reason: CREDENTIAL_REASON })
    // Typed in later, not there at the start: the steps are read too.
    assert.deepEqual(editorIssueFile(draft({ trace: trace('local a\n', 'webhook = "https://discord.com/api/webhooks/123/abc"') }), context), { ok: false, reason: CREDENTIAL_REASON })
    assert.equal(editorIssueFile(draft({ path: 'server/.env', scrambled: true }), context).ok, true)
    assert.equal(editorIssueFile(draft({ path: 'server.cfg', trace: cfg, scrambled: true }), context).ok, true)
  })

  it('redacts the problems and the description of credentials too', () => {
    const made = editorIssueFile(draft({ description: 'my key is cfxk_abcdefghijklmnop1234', problems: [{ step: 1, problem: 'the range at sk-or-v1-0123456789abcdef0123456789abcdef' }] }), context)
    assert.ok(made.ok)
    assert.equal(made.text.includes('cfxk_abcdefghijklmnop1234'), false)
    assert.equal(made.text.includes('sk-or-v1-0123456789abcdef'), false)
  })
})
