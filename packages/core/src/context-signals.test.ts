import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import type { Tool } from '@encode/tools'
import { addSignals, anySignals, ContextWatch, DIGEST_READ_BACKS_TO_STOP, isEditMiss, keepingMore, READ_BACKS_TO_KEEP_MORE } from './context-signals'
import { shortenedBy, ELIDE_LIMIT } from './compaction'
import { createOutputStore } from './outputs'
import { shorteningPolicy } from './shortening'
import { loopHarness } from './testing'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const root = path.resolve('/work/project')

describe('context signals (ADR 0132)', () => {
  it('add up, a missing or malformed count as none', () => {
    assert.deepEqual(addSignals({ rewrites: 2, readBacks: 1 }, { rewrites: 1, summaries: 1, editMisses: -3, checkBounces: Number.NaN }), {
      rewrites: 3,
      summaries: 1,
      readBacks: 1,
      editMisses: 0,
      checkBounces: 0,
      claimBounces: 0,
      digests: 0,
      digestReadBacks: 0,
    })
    assert.equal(anySignals(undefined), false)
    assert.equal(anySignals({ rewrites: 0 }), false)
    assert.equal(anySignals({ claimBounces: 1 }), true)
  })

  it('call an Edit that missed its text an edit miss, and no other failure', () => {
    assert.equal(isEditMiss('Edit', 'old_string was not found in the file. Read the file again'), true)
    assert.equal(isEditMiss('MultiEdit', 'Edit 2: old_string was not found in the file.'), true)
    assert.equal(isEditMiss('Edit', 'The file has changed since it was read.'), false)
    assert.equal(isEditMiss('Edit', undefined), false)
    assert.equal(isEditMiss('Write', 'old_string was not found'), false)
  })
})

describe('the watch on what shortening cut', () => {
  it('counts reading a kept output again, by Read, Grep or a command that names it, once for each output', () => {
    const watch = new ContextWatch()
    const kept = [1, 2, 3].map((n) => path.join(os.tmpdir(), 'outputs', `Bash-call_${n}.txt`))
    watch.shortened({ files: kept, reads: [] }, root)
    assert.equal(watch.called('Read', { file_path: kept[0], offset: 200 }, root), 'readBacks')
    assert.equal(watch.called('Read', { file_path: kept[0], offset: 400 }, root), undefined, 'reading on in the same output is the same need')
    assert.equal(watch.called('Grep', { pattern: 'FAIL', path: kept[1] }, root), 'readBacks')
    assert.equal(watch.called('Bash', { command: `grep -n FAIL ${kept[2]}` }, root), 'readBacks')
    assert.equal(watch.called('Read', { file_path: 'src/other.js' }, root), undefined)
    assert.equal(watch.called('Grep', { pattern: 'FAIL', path: 'src' }, root), undefined)
    assert.equal(watch.readBacks, 3)
  })

  it('counts reading a file again after its Read was shortened, once, and not after the file was changed', () => {
    const watch = new ContextWatch()
    watch.shortened({ files: [], reads: ['src/a.js', path.join(root, 'src', 'b.js')] }, root)
    assert.equal(watch.called('Read', { file_path: path.join(root, 'src', 'a.js') }, root), 'readBacks')
    assert.equal(watch.called('Read', { file_path: 'src/a.js' }, root), undefined, 'counted once')
    assert.equal(watch.called('Edit', { file_path: 'src/b.js', old_string: 'a', new_string: 'b' }, root), undefined)
    assert.equal(watch.called('Read', { file_path: 'src/b.js' }, root), undefined, 'changed since, so reading it is no sign')
    assert.equal(watch.readBacks, 1)
  })

  it(`keeps more once the model has read back ${READ_BACKS_TO_KEEP_MORE} outputs: a step more whole, twice the characters`, () => {
    const watch = new ContextWatch()
    const policy = shorteningPolicy({ read: 0.1, write: 1, boundThinking: false, source: 'price' })
    assert.equal(keepingMore(policy, watch.level), policy)
    const files = Array.from({ length: READ_BACKS_TO_KEEP_MORE }, (_, i) => path.join(root, '.out', `r${i}.txt`))
    watch.shortened({ files, reads: [] }, root)
    for (const file of files.slice(0, -1)) watch.called('Read', { file_path: file }, root)
    assert.equal(watch.level, 0)
    watch.called('Read', { file_path: files.at(-1)! }, root)
    assert.equal(watch.level, 1)
    const more = keepingMore(policy, watch.level)
    assert.deepEqual(more.recent, { steps: policy.recent.steps + 1, reads: policy.recent.reads + 1, files: true })
    assert.equal(more.limit, policy.limit * 2)
    assert.equal(more.floor, policy.floor)
  })

  it('learns from a rewrite which kept files and which Reads it cut', () => {
    const big = 'x'.repeat(5_000)
    const before: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-use', id: 'r1', name: 'Read', input: { file_path: 'src/a.js' } }, { type: 'tool-use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolUseId: 'r1', content: [{ type: 'text', text: big }] },
          { type: 'tool-result', toolUseId: 'b1', content: [{ type: 'text', text: big }] },
        ],
      },
    ]
    const kept = path.join(os.tmpdir(), 'outputs', 'Bash-b1.txt')
    const after: Message[] = [
      before[0]!,
      before[1]!,
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolUseId: 'r1', content: [{ type: 'text', text: `${big.slice(0, 600)}\n[… 4100 characters left out. Read the file again for them; it may have changed since. …]\n` }] },
          { type: 'tool-result', toolUseId: 'b1', content: [{ type: 'text', text: `${big.slice(0, 600)}\n[… 4100 characters left out. All of it is in ${kept}: Read it with offset and limit, or Grep it. …]\n` }] },
        ],
      },
    ]
    assert.deepEqual(shortenedBy(before, after), { files: [kept], reads: ['src/a.js'] })
    assert.deepEqual(shortenedBy(before, after, (file) => file !== kept), { files: [], reads: ['src/a.js'] })
    assert.deepEqual(shortenedBy(before, before), { files: [], reads: [] })
  })
})

/** A read-only tool whose output is as long as the call asks. */
const probe: Tool = {
  definition: {
    name: 'Probe',
    description: 'Returns text.',
    inputSchema: { type: 'object', properties: { chars: { type: 'number' }, tag: { type: 'string' } }, required: ['chars', 'tag'], additionalProperties: false },
  },
  kind: 'read',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: () => ({ title: 'Probe' }),
  run: async (input) => {
    const { chars, tag } = input as { chars: number; tag: string }
    const lines: string[] = []
    for (let index = 1, length = 0; length < chars; index++) {
      const line = `${tag} ${index}: ${'abcdefghij'.repeat(5)}`
      lines.push(line)
      length += line.length + 1
    }
    return { ok: true, content: lines.join('\n') }
  },
}

/** The files the request's shortened outputs say they are kept in, oldest first. */
function keptIn(request: CompletionRequest): string[] {
  const text = JSON.stringify(request.payload.messages)
  return [...new Set([...text.matchAll(/All of it is in (.+?): Read it with offset and limit/g)].map((match) => JSON.parse(`"${match[1]}"`) as string))]
}

describe('a session that reads shortened output back', () => {
  it('counts each read-back and rewrite with its request, and keeps more after enough of them', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-signals-')))
    made.push(dir)
    const watch = new ContextWatch()
    const read = new Set<string>()
    let probes = 0
    const h = await loopHarness({
      extraTools: [probe],
      client: { contextWindow: 128_000, maxOutputTokens: 8_192, cache: { read: 0.1, write: 1, boundThinking: false, source: 'price' } },
      services: { outputs: createOutputStore({ dir }), contextWatch: watch },
      maxSteps: 40,
      script: (request, step) => {
        if (request.role !== 'main') return { text: 'SUMMARY' }
        // Once outputs are shortened, the model reads three of them back, then carries on.
        const back = keptIn(request).find((file) => !read.has(file))
        if (back && read.size < READ_BACKS_TO_KEEP_MORE) {
          read.add(back)
          return { calls: [{ name: 'Read', input: { file_path: back, limit: 20 }, id: `read_${step}` }] }
        }
        if (probes >= 16) return { text: 'done' }
        probes++
        return { calls: [{ name: 'Probe', input: { chars: 12_000, tag: `p${probes}` }, id: `probe_${step}` }] }
      },
    })
    await h.run('look through it all')
    assert.equal(read.size, READ_BACKS_TO_KEEP_MORE)
    assert.equal(h.surface.signals.filter((kind) => kind === 'readBacks').length, READ_BACKS_TO_KEEP_MORE)
    assert.ok(h.surface.signals.includes('rewrites'), h.surface.signals.join(', '))
    assert.equal(h.surface.signals.includes('summaries'), false)
    assert.equal(watch.level, 1)
    // From then on an old output keeps twice the characters it did.
    // A shortened output keeps 60% of the limit (its head and tail) of the 12,000 or so characters it had.
    const removed = [...JSON.stringify(h.conversation.messages()).matchAll(/\[… (\d+) characters removed to save context/g)].map((match) => Number(match[1]))
    const kept = removed.map((count) => 12_030 - count)
    assert.ok(kept.some((length) => Math.abs(length - ELIDE_LIMIT * 0.6) < 40), `some outputs were cut to ${ELIDE_LIMIT}: ${kept.join(', ')}`)
    assert.ok(kept.some((length) => Math.abs(length - ELIDE_LIMIT * 1.2) < 40), `later ones keep twice that: ${kept.join(', ')}`)
  })

  it('counts an edit that misses its text after a rewrite in the request, and not before one', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-signals-')))
    made.push(dir)
    let step = 0
    const h = await loopHarness({
      files: { 'a.txt': 'one\n' },
      extraTools: [probe],
      client: { contextWindow: 128_000, maxOutputTokens: 8_192, cache: { read: 0.1, write: 1, boundThinking: false, source: 'price' } },
      services: { outputs: createOutputStore({ dir }), contextWatch: new ContextWatch() },
      maxSteps: 40,
      script: (request) => {
        if (request.role !== 'main') return { text: 'SUMMARY' }
        step++
        if (step === 1) return { calls: [{ name: 'Read', input: { file_path: 'a.txt' }, id: 'read_a' }] }
        if (step === 2) return { calls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'three', new_string: 'four' }, id: 'miss_1' }] }
        if (step <= 9) return { calls: [{ name: 'Probe', input: { chars: 12_000, tag: `p${step}` }, id: `probe_${step}` }] }
        if (step === 10) return { calls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'two', new_string: 'four' }, id: 'miss_2' }] }
        return { text: 'done' }
      },
    })
    await h.run('change it')
    const signals = h.surface.signals
    assert.ok(signals.includes('rewrites'), signals.join(', '))
    assert.equal(signals.filter((kind) => kind === 'editMisses').length, 1, signals.join(', '))
    assert.ok(signals.indexOf('editMisses') > signals.indexOf('rewrites'))
  })
})

/** A tool whose output comes with a digest, as Bash's does for a long test run (ADR 0133). */
const digester: Tool = {
  definition: {
    name: 'Digester',
    description: 'Runs the tests.',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false },
  },
  kind: 'read',
  readOnly: true,
  access: () => ({ type: 'none' }),
  describe: () => ({ title: 'Digester' }),
  run: async (input) => {
    const { tag } = input as { tag: string }
    const whole = [...Array.from({ length: 200 }, (_, n) => `${tag} ok ${n}`), `${tag} FAILED one`].join('\n')
    return { ok: false, content: whole, digest: { content: `${tag} FAILED one`, note: 'The digest leaves out the lines of 200 passing tests.' } }
  },
}

describe('a session whose commands come with digests (ADR 0133)', () => {
  it('sends the digest with where the whole is kept, and the whole once the model has read enough of them back', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-digests-')))
    made.push(dir)
    const watch = new ContextWatch()
    const read = new Set<string>()
    let runs = 0
    const h = await loopHarness({
      extraTools: [digester],
      services: { outputs: createOutputStore({ dir }), contextWatch: watch },
      maxSteps: 20,
      script: (request, step) => {
        if (request.role !== 'main') return { text: 'SUMMARY' }
        const back = keptIn(request).find((file) => !read.has(file))
        if (back) {
          read.add(back)
          return { calls: [{ name: 'Read', input: { file_path: back }, id: `read_${step}` }] }
        }
        if (runs > DIGEST_READ_BACKS_TO_STOP) return { text: 'done' }
        runs++
        return { calls: [{ name: 'Digester', input: { tag: `run${runs}` }, id: `run_${runs}` }] }
      },
    })
    await h.run('run the tests')
    const results: string[] = []
    for (const message of h.conversation.messages()) {
      if (message.role !== 'user' || typeof message.content === 'string') continue
      for (const block of message.content) {
        if (block.type === 'tool-result' && block.toolUseId.startsWith('run_')) results.push(block.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
      }
    }
    assert.equal(results.length, DIGEST_READ_BACKS_TO_STOP + 1)
    for (const result of results.slice(0, -1)) {
      assert.match(result, /^run\d FAILED one\n\n\[… The digest leaves out the lines of 200 passing tests\. All of it is in .+: Read it with offset and limit, or Grep it\. …\]$/)
    }
    const [first] = [...read]
    assert.equal(await fs.readFile(first!, 'utf8'), (await digester.run({ tag: 'run1' }, {} as never)).content)
    // Three digests read back whole: the fourth run goes in whole.
    assert.ok(results.at(-1)!.includes('run4 ok 150') && !results.at(-1)!.includes('digest'))
    assert.equal(watch.wholeOutputs, true)
    assert.equal(h.surface.signals.filter((kind) => kind === 'digests').length, DIGEST_READ_BACKS_TO_STOP)
    assert.equal(h.surface.signals.filter((kind) => kind === 'digestReadBacks').length, DIGEST_READ_BACKS_TO_STOP)
    assert.equal(h.surface.signals.includes('readBacks'), false, 'a digest read back is not a shortened output read back')
  })

  it('sends the whole when there is no folder to keep it in', async () => {
    let runs = 0
    const h = await loopHarness({
      extraTools: [digester],
      script: () => (runs++ ? { text: 'done' } : { calls: [{ name: 'Digester', input: { tag: 'run1' }, id: 'run_1' }] }),
    })
    await h.run('run the tests')
    assert.ok(JSON.stringify(h.conversation.messages()).includes('run1 ok 150'))
  })
})
