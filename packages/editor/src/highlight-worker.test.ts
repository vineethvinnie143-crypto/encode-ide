import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { ChangeSet, Text } from '@encode/text'
import {
  Highlighter,
  connectHighlighting,
  languageById,
  serveHighlighting,
  tokenizeBatch,
  type HighlightBatch,
  type HighlightPort,
  type HighlightResult,
  type HighlightWorkerPort,
  type Tokenizer,
} from './index'

const FRAGMENTS = [' ', 'a', 'x1', '"', "'", '`', '\\', '/*', '*/', '//', '#', '--[[', ']]', '${', '{', '}', '(', ')', '[', ']', '<div ', '</div>', '<!--', '-->', '```', '"""', 'end', 'function', '\t', '😀', '\n']
const fragment = gen.oneOf(...FRAGMENTS)
const lineGen: Gen<string> = (random, size) => gen.array(fragment, 0, Math.max(1, size >> 1))(random, size).join('')
const sourceGen: Gen<string> = (random, size) => gen.array(lineGen, 1, Math.max(1, size))(random, size).join('\n')

/** What a fresh highlighter, reading every line in order on this thread, draws for each line. */
function expected(tokenizer: Tokenizer, brackets: readonly (readonly [string, string])[], doc: Text) {
  const fresh = new Highlighter(tokenizer, doc)
  fresh.setBrackets(brackets)
  return Array.from({ length: doc.lineCount }, (_, index) => ({ tokens: [...fresh.line(index + 1).tokens], brackets: [...fresh.brackets(index + 1).brackets] }))
}

describe('highlighting on another thread', () => {
  for (const id of ['typescript', 'python', 'lua', 'markdown', 'html']) {
    it(`gives ${id} the same colours and bracket depths as reading on this thread, through edits made while a batch is out`, async () => {
      const language = languageById(id)!
      const step = gen.tuple(gen.int(0, 3), gen.int(0, 10_000), gen.int(0, 12), gen.array(fragment, 0, 4), gen.int(1, 6))
      await check(gen.tuple(sourceGen, gen.array(step, 1, 14)), ([source, steps]) => {
        let doc = Text.of(source)
        const highlighter = new Highlighter(language.tokenizer, doc)
        highlighter.setBrackets(language.brackets)
        let out: HighlightBatch | null = null
        for (const [kind, at, length, insert, size] of steps) {
          if (kind === 0) {
            const from = at % (doc.length + 1)
            const changes = ChangeSet.of({ from, to: Math.min(doc.length, from + length), insert: insert.join('') }, doc.length)
            doc = changes.apply(doc)
            highlighter.update(changes, doc)
          } else if (kind === 1) {
            out ??= highlighter.nextBatch(id, size)
          } else if (kind === 2 && out) {
            highlighter.acceptBatch(tokenizeBatch(language.tokenizer, out))
            out = null
          } else {
            highlighter.line((at % doc.lineCount) + 1)
          }
        }
        for (let rounds = 0; rounds < 10_000; rounds++) {
          if (out) highlighter.acceptBatch(tokenizeBatch(language.tokenizer, out))
          out = highlighter.nextBatch(id, 3)
          if (!out) break
        }
        assert.ok(highlighter.done, 'every state is known')
        const want = expected(language.tokenizer, language.brackets, doc)
        for (let line = 1; line <= doc.lineCount; line++) {
          const got = highlighter.line(line)
          assert.ok(got.exact, `line ${line} is exact`)
          assert.deepEqual([...got.tokens], want[line - 1].tokens, `tokens of line ${line}`)
          const brackets = highlighter.brackets(line)
          assert.ok(brackets.exact, `brackets of line ${line} are exact`)
          assert.deepEqual([...brackets.brackets], want[line - 1].brackets, `brackets of line ${line}`)
        }
      })
    })
  }

  it('reads a large file without tokenizing on this thread, and an edit re-reads from there', () => {
    const language = languageById('typescript')!
    let calls = 0
    const counting: Tokenizer = { start: language.tokenizer.start, line: (text, state) => (calls++, language.tokenizer.line(text, state)) }
    let doc = Text.of(Array.from({ length: 40_000 }, (_, index) => `const v${index} = [${index}] // ${index}`))
    const highlighter = new Highlighter(counting, doc)
    highlighter.setBrackets(language.brackets)
    let batches = 0
    for (let batch = highlighter.nextBatch('typescript'); batch; batch = highlighter.nextBatch('typescript')) {
      batches++
      assert.ok(highlighter.acceptBatch(tokenizeBatch(language.tokenizer, batch)))
    }
    assert.ok(highlighter.done)
    assert.equal(calls, 0, 'nothing was tokenized here')
    assert.equal(batches, 3, 'batches of 16,384 lines')
    // An open comment at the top changes every state below; the batch after it reads on until they settle again.
    const changes = ChangeSet.of({ from: 0, insert: '/* ' }, doc.length)
    doc = changes.apply(doc)
    highlighter.update(changes, doc)
    const batch = highlighter.nextBatch('typescript', 100)!
    assert.equal(batch.lines[0], '/* const v0 = [0] // 0')
    highlighter.acceptBatch(tokenizeBatch(language.tokenizer, batch))
    assert.equal(highlighter.frontier, 101, 'all hundred lines differ from before')
  })

  it('draws a line far past what is known from a guess, without reading every line above it', () => {
    const language = languageById('typescript')!
    let calls = 0
    const counting: Tokenizer = { start: language.tokenizer.start, line: (text, state) => (calls++, language.tokenizer.line(text, state)) }
    const doc = Text.of(Array.from({ length: 100_000 }, (_, index) => `call(${index})`))
    const highlighter = new Highlighter(counting, doc)
    for (let line = 60_000; line < 60_040; line++) assert.equal(highlighter.line(line).exact, false)
    assert.ok(calls < 40 * 90, `tokenized ${calls} lines for 40 far ones`)
    assert.equal(highlighter.frontier, 1)
    // Near what is known, a line is read exactly.
    calls = 0
    assert.equal(highlighter.line(2_000).exact, true)
    assert.equal(calls, 2_000)
  })

  it('ignores an answer for a batch that is not out, or one that does not fit it', () => {
    const language = languageById('typescript')!
    const doc = Text.of(['let a = 1', '/* x', 'y */', 'let b = 2'])
    const highlighter = new Highlighter(language.tokenizer, doc)
    highlighter.setBrackets(language.brackets)
    const broken: ((good: HighlightResult) => HighlightResult)[] = [
      (good) => ({ ...good, id: good.id + 1 }),
      (good) => ({ ...good, states: good.states.subarray(1) }),
      (good) => ({ ...good, states: Int32Array.from(good.states, () => 99) }),
      (good) => ({ ...good, summaries: null }),
      (good) => ({ ...good, summaries: Int32Array.from(good.summaries!, (_, index) => (index % 2 ? 0 : 5)) }),
      (good) => ({ ...good, table: [7 as unknown as string, ...good.table.slice(1)] }),
    ]
    for (const make of broken) {
      const batch = highlighter.nextBatch('typescript')!
      assert.equal(highlighter.nextBatch('typescript'), null, 'one batch at a time')
      assert.equal(highlighter.acceptBatch(make(tokenizeBatch(language.tokenizer, batch))), false)
      assert.equal(highlighter.frontier, 1)
      // An answer for another batch leaves this one out.
      highlighter.dropBatch()
    }
    const batch = highlighter.nextBatch('typescript')!
    assert.deepEqual(batch.lines, ['let a = 1', '/* x', 'y */'], 'the last line starts nothing')
    assert.ok(highlighter.acceptBatch(tokenizeBatch(language.tokenizer, batch)))
    assert.ok(highlighter.done)
    assert.equal(highlighter.nextBatch('typescript'), null)
  })

  it('drops what a changed language or bracket setting makes stale', () => {
    const ts = languageById('typescript')!
    const doc = Text.of(['let a = (1', ')'])
    const highlighter = new Highlighter(ts.tokenizer, doc)
    let batch = highlighter.nextBatch('typescript')!
    highlighter.setBrackets(ts.brackets)
    assert.equal(highlighter.acceptBatch(tokenizeBatch(ts.tokenizer, batch)), false)
    batch = highlighter.nextBatch('typescript')!
    assert.deepEqual(batch.brackets, ts.brackets)
    highlighter.setTokenizer(languageById('python')!.tokenizer)
    assert.equal(highlighter.acceptBatch(tokenizeBatch(ts.tokenizer, batch)), false)
  })
})

/** A worker and its page joined in this thread, delivering messages on the next turn as a real channel does. */
function channel() {
  const pageListeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  const workerListeners: ((event: { data: unknown }) => void)[] = []
  let terminated = false
  const deliver = (listeners: ((event: { data: unknown }) => void)[] | undefined, data: unknown) =>
    setImmediate(() => {
      if (!terminated) for (const listener of listeners ?? []) listener({ data: structuredClone(data) })
    })
  const scope: HighlightPort = {
    postMessage: (message) => deliver(pageListeners.get('message'), message),
    addEventListener: (_type, listener) => void workerListeners.push(listener),
  }
  const worker: HighlightWorkerPort & { fire(type: string): void; readonly terminated: boolean } = {
    postMessage: (message) => deliver(workerListeners, message),
    addEventListener: (type, listener) => void pageListeners.set(type, [...(pageListeners.get(type) ?? []), listener]),
    terminate: () => void (terminated = true),
    fire: (type) => pageListeners.get(type)?.forEach((listener) => listener({})),
    get terminated() {
      return terminated
    },
  }
  return { scope, worker }
}

describe('the highlighting worker', () => {
  const batch = (language: string, lines: string[]): HighlightBatch => ({ id: 1, language, brackets: [['(', ')']], state: languageById('typescript')!.tokenizer.start, lines })

  it('answers each batch with what tokenizing it here gives', async () => {
    const { scope, worker } = channel()
    serveHighlighting(scope)
    const connection = connectHighlighting(worker)
    const lines = ['let a = (1', '/* (', ') */ )']
    const [first, second] = await Promise.all([connection.run(batch('typescript', lines)), connection.run(batch('typescript', lines.slice(1)))])
    const ts = languageById('typescript')!.tokenizer
    assert.deepEqual(first, tokenizeBatch(ts, batch('typescript', lines)))
    assert.deepEqual(second, tokenizeBatch(ts, batch('typescript', lines.slice(1))))
    assert.deepEqual([...first!.summaries!], [0, 1, 0, 0, -1, -1])
  })

  it('answers null for a language it does not know or a batch it cannot read', async () => {
    const { scope, worker } = channel()
    serveHighlighting(scope)
    const connection = connectHighlighting(worker)
    assert.equal(await connection.run(batch('cobol-2099', ['x'])), null)
    assert.equal(await connection.run({ ...batch('typescript', ['x']), lines: [1 as unknown as string] }), null)
    assert.equal(await connection.run({ ...batch('typescript', ['x']), brackets: [['(']] as unknown as HighlightBatch['brackets'] }), null)
    assert.ok(connection.alive)
  })

  it('stops a worker that fails or hangs, and answers every batch out with null', async () => {
    const failing = channel()
    serveHighlighting(failing.scope)
    const connection = connectHighlighting(failing.worker)
    const out = connection.run(batch('typescript', ['x']))
    failing.worker.fire('error')
    assert.equal(await out, null)
    assert.equal(connection.alive, false)
    assert.ok(failing.worker.terminated)
    assert.equal(await connection.run(batch('typescript', ['x'])), null)

    const silent = channel()
    const stuck = connectHighlighting(silent.worker, 20)
    assert.equal(await stuck.run(batch('typescript', ['x'])), null)
    assert.equal(stuck.alive, false)
    assert.ok(silent.worker.terminated)
  })
})
