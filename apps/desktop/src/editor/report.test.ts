import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { TraceReplayer, insertText, paste, undo, type EditorState, type Transaction } from '@encode/editor'
import { Text } from '@encode/text'
import { applyExternal, applyServerEdits, attach, closeDoc, currentDoc, docState, openDoc, recordState, renameDocs } from './docs'
import { recordEdit, recordingOf } from './recording'
import { checkRecording, issueDraft, mustScramble, unavailableReason, type IssueCheck } from './report'

const path = '/work/shop/client.lua'
const moved = '/work/shop/client.ts'
afterEach(() => {
  closeDoc(path)
  closeDoc(moved)
})

/** What the editor does with a view: the view's transactions are recorded and reported, as CodeEditor does. */
function view(at: string) {
  const host = {
    state: docState(at)!,
    dispatch(tr: Transaction) {
      host.state = tr.state
      recordEdit(at, tr)
      recordState(at, tr.state)
    },
  }
  attach(at, host)
  return host
}

const take = (host: { dispatch(tr: Transaction): void; state: EditorState }, make: (state: EditorState) => Transaction | null) => {
  const tr = make(host.state)
  if (tr) host.dispatch(tr)
}

describe('what is recorded of an open file', () => {
  it('is every edit, from the view and from outside it, replayed to the text shown', () => {
    openDoc(path, 'local items = {}\n')
    const host = view(path)
    take(host, (state) => insertText(state, 'x'))
    take(host, (state) => paste(state, 'print(items)\n'))
    take(host, undo)
    applyServerEdits(path, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'LOCAL' }])
    applyExternal(path, 'LOCAL items = {}\n-- saved by another program\n')
    attach(path, null)
    // Without a view, the store records what it changes itself.
    applyServerEdits(path, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'local' }])
    const check = checkRecording(path, currentDoc(path)) as IssueCheck
    assert.equal(typeof check, 'object')
    assert.deepEqual(check.problems, [])
    const replayer = new TraceReplayer(check.recording.trace)
    for (const step of check.recording.trace.steps) replayer.step(step)
    assert.equal(replayer.state.doc.toString(), currentDoc(path)!.toString())
    assert.ok(check.checked >= 1)
    const origins = check.recording.trace.steps.flatMap((step) => ('changes' in step ? [step.origin] : []))
    assert.deepEqual(origins, ['input.type', 'input.paste', 'undo', 'server', 'external', 'server'])
  })

  it('follows the file to its new name, and starts again in its new language', () => {
    openDoc(path, 'a\n')
    const host = view(path)
    take(host, (state) => insertText(state, 'b'))
    renameDocs(path, moved)
    assert.equal(recordingOf(path), 'not open')
    assert.equal(recordingOf(moved), 'nothing yet', 'a new language starts the trace again')
  })

  it('says why there is nothing to report', () => {
    assert.match(unavailableReason('not open'), /Open the file/)
    openDoc(path, 'a\n')
    assert.equal(checkRecording(path, currentDoc(path)), unavailableReason('nothing yet'))
  })

  it('names a replay that does not reach the text shown', () => {
    openDoc(path, 'a\n')
    const host = view(path)
    take(host, (state) => insertText(state, 'b'))
    const check = checkRecording(path, Text.of(['something else'])) as IssueCheck
    assert.deepEqual(check.problems.map((problem) => problem.problem), ['replaying the steps does not give the text the editor shows'])
  })
})

describe('the draft of a report', () => {
  it('replaces the words of the file unless the person keeps them, and always for a secret file', () => {
    openDoc(path, 'local inventory = exports.inventory\n')
    const host = view(path)
    take(host, (state) => insertText(state, 'weapon'))
    const check = checkRecording(path, currentDoc(path)) as IssueCheck
    const base = { path, description: 'Tab misbehaved', editor: { wordWrap: 'off' }, check, seed: 5 }
    const scrambled = issueDraft({ ...base, scramble: true })
    assert.equal(scrambled.scrambled, true)
    assert.equal(JSON.stringify(scrambled.trace).includes('inventory'), false)
    assert.equal(JSON.stringify(scrambled.trace).includes('weapon'), false)
    const kept = issueDraft({ ...base, scramble: false })
    assert.equal(kept.scrambled, false)
    assert.ok(kept.trace.doc.includes('inventory'))
    assert.equal(mustScramble('/work/.env.production'), true)
    assert.equal(issueDraft({ ...base, path: '/work/.env', scramble: false }).scrambled, true)
  })

  it('leaves out the characters a problem quotes when the words are replaced', () => {
    openDoc(path, 'a\n')
    const host = view(path)
    take(host, (state) => insertText(state, 'b'))
    const check = checkRecording(path, currentDoc(path)) as IssueCheck
    const found = { ...check, problems: [{ step: 1, problem: 'the auto-closed character at 3 is now "q"' }] }
    assert.equal(issueDraft({ path, description: '', editor: {}, check: found, scramble: true }).problems[0].problem, 'the auto-closed character at 3 is now "…"')
    assert.equal(issueDraft({ path, description: '', editor: {}, check: found, scramble: false }).problems[0].problem, 'the auto-closed character at 3 is now "q"')
  })
})
