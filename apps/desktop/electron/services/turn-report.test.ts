import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readTurnReport, type TurnRecord } from '@encode/core'
import type { AboutInfo } from '../../shared/types'
import { readTurnReportDraft, turnReportFileName, type TurnReportDraft } from '../../shared/turn-report'
import { secretFileReason, turnReportFile } from './turn-report'

const about = { version: '0.1.0', channel: 'tester', commit: '0123456789abcdef', dirty: false, builtAt: '2026-10-23T12:00:00Z', os: 'Windows 11 (10.0.26100)', arch: 'x64', electron: '44', chrome: '140', node: '24' } as unknown as AboutInfo

const KEY = 'sk-or-v1-0123456789abcdefABCDEF0123456789'

const record = (patch: Partial<TurnRecord> = {}): TurnRecord => ({
  scrambled: false,
  prompt: 'Raise the limit in src/a.js',
  policy: 'workspace-write',
  models: ['openrouter:some/model'],
  usage: { requests: 2, inputTokens: 900, cachedTokens: 0, outputTokens: 80 },
  steps: [{ text: 'Reading.', calls: [{ name: 'Read', input: { file_path: 'src/a.js' } }] }, { calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'limit = 3', new_string: 'limit = 5' } }] }, { text: 'Done.' }],
  results: [
    { tool: 'Read', ok: true, text: '1\texport const limit = 3' },
    { tool: 'Edit', ok: true, text: 'Edited src/a.js.' },
  ],
  files: [{ path: 'src/a.js', text: 'export const limit = 3\n' }],
  left: [],
  ...patch,
})

const draft: TurnReportDraft = { sessionId: 's1', turn: 'u1', description: 'It edited the wrong line in C:/Users/ana/shop', scramble: false }
const context = { about, now: Date.UTC(2026, 9, 24, 2, 30), redact: (text: string) => text.replace(/C:\/Users\/ana/g, '<home>') }

describe('the file a report of a request is written as', () => {
  it('holds the build, the system and what the person said, then the request, and reads back as a report', () => {
    const made = turnReportFile(record(), draft, context)
    assert.ok(made.ok)
    const report = JSON.parse(made.text)
    assert.equal(report.kind, 'encode-turn-report')
    assert.equal(report.createdAt, '2026-10-24T02:30:00.000Z')
    assert.match(report.build, /0\.1\.0/)
    assert.equal(report.system, 'Windows 11 (10.0.26100) x64')
    assert.equal(report.description, 'It edited the wrong line in <home>/shop', 'what the person wrote goes through the log redaction')
    assert.equal(report.steps.length, 3)
    assert.equal(made.redacted, 0)
    assert.equal(typeof readTurnReport(report), 'object')
    // One line for each step, answer and file, after the facts.
    assert.match(made.text, /\n {4}\{"text":"Reading\.","calls":\[\{"name":"Read"/)
  })

  it('takes out what looks like a key everywhere it appears, the same way in the file and in the call that edits it', () => {
    const line = `const key = "${KEY}"\n`
    const made = turnReportFile(
      record({
        prompt: `Use ${KEY} for the client`,
        steps: [{ calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: line.trim(), new_string: 'const key = process.env.KEY' } }] }, { text: 'Done.' }],
        results: [{ tool: 'Edit', ok: true, text: 'Edited src/a.js.' }],
        files: [{ path: 'src/a.js', text: line }],
      }),
      draft,
      context,
    )
    assert.ok(made.ok)
    assert.equal(made.text.includes(KEY), false)
    assert.equal(made.redacted, 3)
    const report = JSON.parse(made.text)
    assert.ok(report.files[0].text.includes(report.steps[0].calls[0].input.old_string), 'the edit still finds its text')
  })

  it('refuses a request that read a file holding secrets by its name unless its words are replaced', () => {
    const read = record({ steps: [{ calls: [{ name: 'Read', input: { file_path: '.env' } }] }, { text: 'Done.' }], files: [] })
    assert.deepEqual(turnReportFile(read, draft, context), { ok: false, reason: secretFileReason('.env') })
    assert.ok(turnReportFile({ ...read, scrambled: true }, { ...draft, scramble: true }, context).ok)
  })
})

describe('the page’s draft of a report', () => {
  it('is taken only with what a draft holds', () => {
    assert.deepEqual(readTurnReportDraft({ ...draft, extra: 1 }), draft)
    assert.equal(readTurnReportDraft({ ...draft, turn: '../x' }), null)
    assert.equal(readTurnReportDraft({ ...draft, scramble: 'yes' }), null)
    assert.equal(readTurnReportDraft({ ...draft, description: 'x'.repeat(4_001) }), null)
    assert.equal(readTurnReportDraft(null), null)
  })

  it('is saved under a name with the date and time', () => {
    assert.match(turnReportFileName(Date.UTC(2026, 9, 24, 2, 30)), /^encode-turn-report-2026-10-2[34]-\d{4}\.json$/)
  })
})
