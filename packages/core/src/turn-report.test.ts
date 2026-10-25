import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { parseRule, RuleSet } from '@encode/permissions'
import type { SessionCheckpoints } from './session'
import { closeHarnesses, hostHarness } from './testing'
import { readTurnReport, relativeTo, scrambleRecord, TURN_REPORT_KIND, type TurnRecord } from './turn-report'
import type { TurnFileChange } from './ui'

after(closeHarnesses)

const BEFORE = 'export const limit = 3\n'

/** Checkpoints that remember src/a.js as it was before the request. */
function checkpointsBefore(root: string): SessionCheckpoints {
  const file = path.join(root, 'src', 'a.js')
  const change: TurnFileChange = { path: 'src/a.js', file, before: { state: 'bytes', hash: 'h', bytes: new TextEncoder().encode(BEFORE) }, after: { state: 'unread', hash: null, size: 0, why: 'unkept' }, afterFrom: 'now', changedSince: false }
  return {
    info: async () => ({ available: true, turns: [], canUndo: false }),
    plan: async (turn) => ({ kind: 'rewind', turn, known: true, files: [], fingerprint: 'fp' }),
    planRedo: async () => null,
    apply: async () => ({ ok: true, restored: 0, deleted: 0, skipped: [], failed: [] }),
    changes: async () => ({ known: true, files: [change] }),
  }
}

describe('the record of a request', () => {
  it('holds the steps, what the tools answered, and the files as they were before, with paths relative', async () => {
    const h = await hostHarness({
      files: { 'src/a.js': BEFORE, 'src/b.js': 'export const b = 1\n', 'secret.txt': 'hush\n' },
      scriptFor: (root) => [
        { text: 'Reading.', calls: [{ name: 'Read', input: { file_path: path.join(root, 'src', 'a.js') } }, { name: 'Read', input: { file_path: 'src/b.js' } }, { name: 'Read', input: { file_path: 'secret.txt' } }] },
        { calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'limit = 3', new_string: 'limit = 5' } }] },
        { calls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'no such text', new_string: 'x' } }] },
        { text: `Raised the limit in ${path.join(root, 'src', 'a.js')}.` },
      ],
      host: {
        scope: ({ root }) => ({
          checkpoints: checkpointsBefore(root),
          rules: new RuleSet([(parseRule('Read(secret.txt)', 'deny', 'user') as { ok: true; rule: never }).rule], { root, home: root, windows: process.platform === 'win32' }),
        }),
      },
    })
    const session = await h.host.create()
    await h.host.start(session.id, { text: `Raise the limit in ${path.join(h.root, 'src', 'a.js')}`, mode: 'code' })
    const outcome = await h.host.turnRecord(session.id, undefined, { scramble: false })
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason)
    const { record } = outcome
    assert.equal(record.prompt, 'Raise the limit in src/a.js')
    assert.equal(record.steps.length, 4)
    assert.deepEqual(record.steps[0]!.calls![0], { name: 'Read', input: { file_path: 'src/a.js' } })
    assert.equal(record.steps[3]!.text, 'Raised the limit in src/a.js.')
    assert.deepEqual(record.results.map((result) => [result.tool, result.ok]), [['Read', true], ['Read', true], ['Read', false], ['Edit', true], ['Edit', false]])
    // src/a.js as the record kept it before the request; src/b.js from disk; the file the rules keep private, not at all.
    assert.deepEqual(record.files, [{ path: 'src/a.js', text: BEFORE }, { path: 'src/b.js', text: 'export const b = 1\n' }])
    assert.deepEqual(record.left, ['secret.txt: your permission rules keep it from being read'])
    assert.equal(JSON.stringify(record).includes(h.root), false, 'the folder is never named')
    assert.equal(record.usage.requests, 4)
  })

  it('scrambles every word the same way everywhere, so the calls still match the files', async () => {
    const record: TurnRecord = {
      scrambled: false,
      prompt: 'Rename getUserName in src/users.js',
      policy: 'workspace-write',
      models: ['x:y'],
      usage: { requests: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      steps: [{ text: 'Renaming getUserName.', calls: [{ name: 'Edit', input: { file_path: 'src/users.js', old_string: 'export function getUserName(user) {', new_string: 'export function getDisplayName(user) {' } }, { name: 'Bash', input: { command: 'node --test test/users.test.js' } }] }],
      results: [{ tool: 'Edit', ok: true, text: 'Edited src/users.js.' }],
      files: [{ path: 'src/users.js', text: 'export function getUserName(user) {\n  return user.name\n}\n' }],
      left: [],
    }
    const scrambled = scrambleRecord(record)
    const edit = scrambled.steps[0]!.calls![0]!.input as { file_path: string; old_string: string }
    assert.equal(scrambled.scrambled, true)
    assert.equal(edit.file_path, scrambled.files[0]!.path)
    assert.ok(scrambled.files[0]!.text.includes(edit.old_string), 'the edit still finds its text')
    assert.match(scrambled.files[0]!.path, /^\w+\/\w+\.js$/)
    assert.match(scrambled.files[0]!.text, /^export function \w+\(\w+\) \{\n  return \w+\.\w+\n\}\n$/)
    assert.equal(JSON.stringify(scrambled).includes('getUserName'), false)
    assert.match((scrambled.steps[0]!.calls![1]!.input as { command: string }).command, /^node --test \w+\/\w+\.test\.js$/)
  })

  it('takes the folder out of paths, and not out of a longer name that starts like it', () => {
    assert.equal(relativeTo('/work/shop', 'cat /work/shop/src/a.js /work/shop2/b.js /work/shop'), 'cat src/a.js /work/shop2/b.js .')
    assert.equal(relativeTo('C:\\Work\\shop', 'type c:\\work\\shop\\src\\a.js and C:/Work/shop/b.js'), 'type src/a.js and b.js')
  })

  it('says why a request cannot be reported', async () => {
    const h = await hostHarness({ script: [{ text: 'ok' }] })
    const session = await h.host.create()
    const none = await h.host.turnRecord(session.id, undefined, { scramble: true })
    assert.deepEqual(none, { ok: false, reason: 'There is no request to report yet.' })
    const gone = await h.host.turnRecord(session.id, 'no-such-turn', { scramble: true })
    assert.deepEqual(gone, { ok: false, reason: 'That request is not in this conversation any more.' })
  })
})

describe('a report read back', () => {
  const report = { kind: TURN_REPORT_KIND, version: 1, createdAt: '2026-10-24T00:00:00.000Z', build: 'eNCode 0.1.0', system: 'win32 x64', description: 'It edited the wrong file.', scrambled: true, prompt: 'Fix it', policy: 'workspace-write', models: [], usage: { requests: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1 }, steps: [{ text: 'ok' }], results: [], files: [{ path: 'src/a.js', text: 'x' }], left: [] }

  it('is taken only whole, and only with its files inside the project', async () => {
    assert.equal(typeof readTurnReport(report), 'object')
    const extra = readTurnReport({ ...report, extra: 'x', steps: [{ text: 'ok', more: 1 }] }) as unknown as Record<string, unknown>
    assert.equal('extra' in extra, false, 'only the fields a report has travel on')
    assert.deepEqual(extra.steps, [{ text: 'ok' }])
    const refused = (patch: Record<string, unknown>) => readTurnReport({ ...report, ...patch })
    assert.match(refused({ kind: 'other' }) as string, /not a report of a request/)
    assert.match(refused({ version: 2 }) as string, /version 2/)
    assert.match(refused({ steps: [] }) as string, /1 to 200 steps/)
    assert.match(refused({ files: [{ path: '../outside.js', text: 'x' }] }) as string, /not inside its project/)
    assert.match(refused({ files: [{ path: 'C:/x.js', text: 'x' }] }) as string, /not inside its project/)
    assert.match(refused({ files: [{ path: 'a.js', text: 'x' }, { path: 'A.js', text: 'y' }] }) as string, /twice/)
    assert.match(refused({ steps: [{ calls: [{ name: '../x', input: {} }] }] }) as string, /call that is not one/)
    assert.match(refused({ policy: 'anything' }) as string, /no request/)
  })

  it('carries what compaction did in the request, counts only (ADR 0132)', () => {
    const context = { rewrites: 4, summaries: 1, readBacks: 2, editMisses: 1, checkBounces: 0, claimBounces: 0 }
    assert.deepEqual((readTurnReport({ ...report, context }) as TurnRecord).context, context)
    assert.deepEqual((readTurnReport({ ...report, context: { rewrites: 2, note: 'x', readBacks: -1 } }) as TurnRecord).context, { rewrites: 2, summaries: 0, readBacks: 0, editMisses: 0, checkBounces: 0, claimBounces: 0 })
    assert.match(readTurnReport({ ...report, context: 'many' }) as string, /what compaction did/)
    assert.equal('context' in (readTurnReport(report) as TurnRecord), false)
  })

  it('round-trips through JSON', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'turn-report-'))
    const file = path.join(dir, 'r.json')
    await fs.writeFile(file, JSON.stringify(report))
    assert.deepEqual(readTurnReport(JSON.parse(await fs.readFile(file, 'utf8'))), report)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
