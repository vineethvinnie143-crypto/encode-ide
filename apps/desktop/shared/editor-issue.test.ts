import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EditRecorder, EditorState, insertText, type EditorTrace } from '@encode/editor'
import { ISSUE_LIMITS, editorIssueFileName, readEditorIssueDraft, readTrace, traceTexts } from './editor-issue'
import { isSecretFile } from './secret-files'

function recorded(): EditorTrace {
  let state = EditorState.create({ doc: 'local a = 1\n', selection: undefined })
  const recorder = new EditRecorder(state)
  for (const text of ['x', 'y']) {
    const tr = insertText(state, text)!
    recorder.record(tr)
    state = tr.state
  }
  return recorder.trace() as EditorTrace
}

const draft = (patch: Record<string, unknown> = {}) => ({
  description: 'Tab after a paste indented the wrong line',
  path: 'resources/shop/client.lua',
  language: 'lua',
  scrambled: true,
  editor: { wordWrap: 'off', tabMovesFocus: false, devicePixelRatio: 1.25 },
  recorded: { steps: 4, minutes: 2.345, trimmed: false },
  problems: [{ step: 3, problem: 'the selection has no ranges' }],
  trace: recorded(),
  ...patch,
})

describe('a trace in a report', () => {
  it('is taken as the recorder writes it, field for field', () => {
    const trace = recorded()
    assert.deepEqual(readTrace(JSON.parse(JSON.stringify(trace))), trace)
  })

  it('is refused for anything a recorder does not write, or past its limits', () => {
    const trace = recorded()
    const bad: unknown[] = [
      null,
      { ...trace, version: 2 },
      { ...trace, steps: [{ command: 'undo' }] },
      { ...trace, steps: [{ type: 'abc' }] },
      { ...trace, steps: [{ changes: [[5, 2, 'x']] }] },
      { ...trace, steps: [{ changes: [[-1, 0, 'x']] }] },
      { ...trace, steps: [{ changes: [[0, 0, 1]] }] },
      { ...trace, steps: [{ select: [] }] },
      { ...trace, steps: [{ select: [[0, 0]], main: 1 }] },
      { ...trace, steps: [{ expect: { length: 1, lines: 1, hash: 'not hex' } }] },
      { ...trace, steps: [{ reload: 'a', t: -5 }] },
      { ...trace, indentUnit: 'xx' },
      { ...trace, lineSeparator: '\r' },
      { ...trace, doc: 'a'.repeat(ISSUE_LIMITS.doc + 1) },
      { ...trace, steps: [{ reload: 'b'.repeat(ISSUE_LIMITS.stepChars + 1) }] },
    ]
    for (const value of bad) assert.equal(readTrace(value), null, JSON.stringify(value)?.slice(0, 120))
  })

  it('lists every text it carries', () => {
    const trace: EditorTrace = { version: 1, name: 'n', doc: 'd', steps: [{ changes: [[0, 0, 'c']] }, { reload: 'r' }, { insert: 'i' }, { paste: 'p' }] }
    assert.deepEqual(traceTexts(trace), ['d', 'n', 'c', 'r', 'i', 'p'])
  })
})

describe('the draft the page sends', () => {
  it('is rebuilt from its known fields', () => {
    const read = readEditorIssueDraft({ ...draft(), extra: 'dropped' })
    assert.ok(read)
    assert.equal('extra' in read, false)
    assert.equal(read.recorded.minutes, 2.3)
    assert.deepEqual(read.editor, { wordWrap: 'off', tabMovesFocus: false, devicePixelRatio: 1.25 })
  })

  it('is refused when a field is not what it should be', () => {
    for (const patch of [
      { description: 'x'.repeat(ISSUE_LIMITS.description + 1) },
      { path: '' },
      { scrambled: 'yes' },
      { editor: { 'bad name': 1 } },
      { editor: { nested: { a: 1 } } },
      { editor: Object.fromEntries(Array.from({ length: 41 }, (_, n) => [`o${n}`, n])) },
      { recorded: { steps: -1, minutes: 1, trimmed: false } },
      { problems: Array.from({ length: 21 }, () => ({ step: 1, problem: 'p' })) },
      { trace: { version: 1 } },
    ]) {
      assert.equal(readEditorIssueDraft(draft(patch)), null, JSON.stringify(patch).slice(0, 80))
    }
  })

  it('is saved under a name with its date and time', () => {
    assert.match(editorIssueFileName(new Date(2026, 9, 23, 14, 5).getTime()), /^encode-editor-issue-2026-10-23-1405\.json$/)
  })
})

describe('files that hold secrets by their name', () => {
  it('are known in the page as in the main process', () => {
    for (const name of ['.env', '.env.local', 'config/.ENV.production', 'certs\\server.pem', 'keys/app.key', 'id_ed25519', '.npmrc', 'creds/credentials.json', 'infra/prod.tfvars', 'store.p12']) assert.ok(isSecretFile(name), name)
    for (const name of ['.env.example', '.env.sample', 'server.cfg', 'client/main.lua', 'keymap.ts', 'environment.ts', 'id_ed25519.pub', '.key', 'folder/']) assert.ok(!isSecretFile(name), name)
  })
})
