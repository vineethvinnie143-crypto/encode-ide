/**
 * Errors after every edit and the error gate, in the loop: a model edits a file, the language servers (a fake here;
 * the real client is tested in @encode/lsp and @encode/tools) report what the edit broke, and the agent is told with
 * the step's results, and once more if it wants to finish with the errors still there.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import type { CodeDiagnostic, CodeIntelligence, FileDiagnostics } from '@encode/tools'
import { introduced } from './edit-diagnostics'
import type { ScriptedStep } from './scripted'
import { loopHarness } from './testing'
import type { AgentSettings } from './types'

const textOf = (message: Message): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? JSON.stringify(block.content) : '')).join('\n')
const lastUser = (request: CompletionRequest): string => textOf(request.payload.messages.at(-1)!)

const error = (line: number, message: string, source = 'fake'): CodeDiagnostic => ({ line, character: 0, endLine: line, endCharacter: 1, severity: 'error', message, source })

/** Language servers as the loop sees them: a line with BAD in it is an error. */
function fakeCode(options: { stale?: number; unknownBaseline?: boolean } = {}) {
  const calls: string[] = []
  const known = new Map<string, CodeDiagnostic[]>()
  let stale = options.stale ?? 0
  const compute = (file: string): CodeDiagnostic[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => (line.includes('BAD') ? [{ line: index, character: line.indexOf('BAD'), endLine: index, endCharacter: line.indexOf('BAD') + 3, severity: 'error' as const, message: 'BAD is not allowed here', source: 'fake', code: 'X1' }] : []))
  const code = {
    covers: (file: string) => (file.endsWith('.ts') ? { ok: true as const, server: 'Fake', languageId: 'typescript' } : { ok: false as const, reason: 'No server.' }),
    known: (files: readonly string[]) => new Map(files.filter((file) => known.has(file)).map((file) => [file, known.get(file)!])),
    prefetch: (files: readonly string[]) => {
      for (const file of files) {
        calls.push(`prefetch ${path.basename(file)}`)
        if (!options.unknownBaseline) known.set(file, compute(file))
      }
    },
    changed: async (changes: readonly { file: string; kind: string }[]) => {
      for (const change of changes) calls.push(`${change.kind} ${path.basename(change.file)}`)
    },
    diagnostics: async (files: readonly string[]): Promise<FileDiagnostics[]> =>
      files.map((file) => {
        if (stale > 0) {
          stale--
          return { file, ok: true, server: 'Fake', diagnostics: [], stale: true }
        }
        const diagnostics = compute(file)
        known.set(file, diagnostics)
        return { file, ok: true, server: 'Fake', diagnostics }
      }),
    status: () => [],
  }
  return { code: code as unknown as CodeIntelligence, calls }
}

async function run(script: (root: string) => ScriptedStep[], options: { files?: Record<string, string>; settings?: Partial<AgentSettings>; code?: ReturnType<typeof fakeCode> } = {}) {
  const fake = options.code ?? fakeCode()
  const h = await loopHarness({
    files: options.files ?? { 'a.ts': 'const x = 1\nconst y = 2\n' },
    settings: { policy: 'full-access', ...options.settings },
    scriptFor: script,
    services: { code: fake.code },
  })
  const end = await h.run('change it')
  return { h, end, calls: fake.calls, requests: h.client.requests }
}

const read = (root: string, name = 'a.ts'): ScriptedStep => ({ calls: [{ name: 'Read', input: { file_path: path.join(root, name) } }] })
const edit = (root: string, from: string, to: string, name = 'a.ts'): ScriptedStep => ({ calls: [{ name: 'Edit', input: { file_path: path.join(root, name), old_string: from, new_string: to } }] })

describe('errors after every edit', () => {
  it('counts only the errors an edit introduced, wherever they moved', () => {
    const before = [error(3, 'old one'), error(9, 'twice'), error(10, 'twice')]
    const after = [error(4, 'old one'), error(11, 'twice'), error(12, 'twice'), error(13, 'twice'), error(1, 'new')]
    assert.deepEqual(introduced(after, before).map((item) => [item.line, item.message]), [[13, 'twice'], [1, 'new']])
    assert.deepEqual(introduced([error(1, 'same', 'tsc')], [error(1, 'same', 'eslint')]).length, 1)
  })

  it('tells the model what its edit broke, sends it back once when it wants to finish, and says when it is fixed', async () => {
    const { h, end, calls, requests } = await run((root) => [read(root), edit(root, 'const x = 1', 'const x = BAD'), { text: 'Done.' }, edit(root, 'const x = BAD', 'const x = 3'), { text: 'Fixed and done.' }])
    assert.equal(end.kind, 'done')
    assert.deepEqual(calls, ['prefetch a.ts', 'changed a.ts', 'changed a.ts'])
    assert.match(lastUser(requests[2]), /The language servers found errors after your changes:\na\.ts: 1 error\n {2}1:11 BAD is not allowed here \[fake X1\]/)
    assert.match(lastUser(requests[3]), /Before you finish: your changes this turn left errors the language servers report:\na\.ts: 1 error\n {2}1:11 BAD is not allowed here/)
    assert.ok(h.surface.notices().some((text) => /still report errors in the files the agent changed/.test(text)))
    assert.match(lastUser(requests[4]), /The language servers checked your changes again:\na\.ts: the errors reported before are fixed\./)
    assert.equal(requests.length, 5)
  })

  it('says nothing of errors a file had before the turn changed it', async () => {
    const { requests } = await run((root) => [read(root), edit(root, 'const y = 2', 'const y = 4'), { text: 'Done.' }], { files: { 'a.ts': 'const x = BAD\nconst y = 2\n' } })
    assert.equal(requests.length, 3)
    for (const request of requests) assert.doesNotMatch(lastUser(request), /language servers/)
  })

  it('notes that some errors may be older when the server had not said what the file had', async () => {
    const { requests } = await run((root) => [read(root), edit(root, 'const y = 2', 'const y = 4'), { text: 'Done.' }, { text: 'They were there before.' }], { files: { 'a.ts': 'const x = BAD\nconst y = 2\n' }, code: fakeCode({ unknownBaseline: true }) })
    assert.match(lastUser(requests[2]), /a\.ts: 1 error \(some may be older than your change\)/)
    assert.equal(requests.length, 4, 'the gate sent it back once, then let it finish')
  })

  it('counts a new file from nothing', async () => {
    const { requests } = await run((root) => [{ calls: [{ name: 'Write', input: { file_path: path.join(root, 'b.ts'), content: 'let z = BAD\n' } }] }, { text: 'Done.' }, { text: 'Leaving it.' }])
    assert.match(lastUser(requests[1]), /b\.ts: 1 error\n {2}1:9 BAD/)
    assert.doesNotMatch(lastUser(requests[1]), /older/)
  })

  it('tells a slow answer with a later step', async () => {
    const { requests } = await run((root) => [read(root), edit(root, 'const x = 1', 'const x = BAD'), read(root), { text: 'Done.' }, { text: 'Stopping.' }], { code: fakeCode({ stale: 1 }) })
    assert.doesNotMatch(lastUser(requests[2]), /language servers/)
    assert.match(lastUser(requests[3]), /The language servers found errors after your changes:\na\.ts: 1 error/)
  })

  it('lets the agent finish with the gate off, and sends it back up to three times with it on', async () => {
    const off = await run((root) => [read(root), edit(root, 'const x = 1', 'const x = BAD'), { text: 'Done.' }], { settings: { errorGate: 'off' } })
    assert.equal(off.requests.length, 3)
    const on = await run((root) => [read(root), edit(root, 'const x = 1', 'const x = BAD'), { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done!' }], { settings: { errorGate: 'on' } })
    assert.equal(on.requests.length, 6)
    assert.equal(on.end.kind, 'done')
  })

  it('does not gate a turn in ask mode, where nothing is changed', async () => {
    const fake = fakeCode()
    const h = await loopHarness({ files: { 'a.ts': 'const x = BAD\n' }, settings: { policy: 'full-access' }, scriptFor: (root) => [read(root), { text: 'It has an error.' }], services: { code: fake.code } })
    const end = await h.run('what is wrong?', 'ask')
    assert.equal(end.kind, 'done')
    assert.equal(h.client.requests.length, 2)
  })
})
