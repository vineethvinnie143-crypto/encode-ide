import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { createAssembler, type AssemblerOptions } from './assembler'
import type { TransportEvent } from './contract'

const origin = { provider: 'test', model: 'requested', family: 'anthropic' } as const

function assemble(events: TransportEvent[], options: Partial<AssemblerOptions> = {}) {
  let next = 0
  const assembler = createAssembler({ origin, newId: () => `generated_${next++}`, ...options })
  for (const event of events) assembler.push(event)
  return assembler.finish()
}

describe('createAssembler', () => {
  it('keeps blocks in stream order and merges consecutive text', () => {
    const reply = assemble([
      { type: 'model', model: 'served' },
      { type: 'thinking', text: 'Let me ' },
      { type: 'thinking', text: 'look.', signature: 'sig-1' },
      { type: 'text', text: 'Reading ' },
      { type: 'text', text: 'the file.' },
      { type: 'tool-call', index: 0, id: 'toolu_1', name: 'Read', arguments: '{"file_' },
      { type: 'tool-call', index: 0, arguments: 'path":"a.ts"}' },
      { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 80, outputTokens: 1 } },
      { type: 'usage', usage: { outputTokens: 42 } },
      { type: 'finish', reason: 'tool_use' },
    ])
    assert.deepEqual(reply.message.content, [
      { type: 'thinking', text: 'Let me look.', signature: 'sig-1' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool-use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    assert.deepEqual(reply.message.origin, { provider: 'test', model: 'served', family: 'anthropic' })
    assert.deepEqual(reply.usage, { inputTokens: 100, outputTokens: 42, cacheReadTokens: 80, cacheWriteTokens: 0 })
    assert.equal(reply.finish, 'tool_use')
  })

  it('starts a new thinking block after a signature closes one', () => {
    const reply = assemble([
      { type: 'thinking', text: 'first', signature: 'a' },
      { type: 'thinking', text: 'second' },
      { type: 'thinking', text: '', signature: 'b' },
      { type: 'redacted-thinking', data: 'opaque' },
    ])
    assert.deepEqual(reply.message.content, [
      { type: 'thinking', text: 'first', signature: 'a' },
      { type: 'thinking', text: 'second', signature: 'b' },
      { type: 'redacted-thinking', data: 'opaque' },
    ])
  })

  it('interleaves parallel tool calls by first appearance and fills missing or unsafe ids', () => {
    const reply = assemble([
      { type: 'tool-call', index: 1, name: 'Grep', arguments: '{"pattern":' },
      { type: 'tool-call', index: 0, id: 'call 0!', name: 'Glob', arguments: '{"pattern":"*.ts"}' },
      { type: 'tool-call', index: 1, arguments: '"x"}' },
      { type: 'finish', reason: 'stop' },
    ])
    assert.deepEqual(reply.message.content, [
      { type: 'tool-use', id: 'generated_0', name: 'Grep', input: { pattern: 'x' } },
      { type: 'tool-use', id: 'generated_1', name: 'Glob', input: { pattern: '*.ts' } },
    ])
    assert.equal(reply.finish, 'tool_use', "a 'stop' that carries tool calls is a tool_use")
  })

  it('never repeats a tool-call id within one reply', () => {
    const reply = assemble([
      { type: 'tool-call', index: 0, id: 'same', name: 'Read', arguments: '{}' },
      { type: 'tool-call', index: 1, id: 'same', name: 'Read', arguments: '{}' },
    ])
    const ids = reply.message.content.map((block) => (block.type === 'tool-use' ? block.id : ''))
    assert.deepEqual(ids, ['same', 'generated_0'])
  })

  it('marks unparseable arguments invalid, keeping the raw text', () => {
    const reply = assemble([{ type: 'tool-call', index: 0, id: 't', name: 'Write', arguments: '{"file_path": "a.ts", "content": "unterminated' }])
    const block = reply.message.content[0]
    assert.equal(block.type, 'tool-use')
    if (block.type !== 'tool-use') return
    assert.deepEqual(block.input, {})
    assert.equal(block.invalid?.raw, '{"file_path": "a.ts", "content": "unterminated')
    assert.match(block.invalid?.error ?? '', /not valid JSON/)
  })

  it('uses the repair hook before giving up, then the schema check', () => {
    const repaired = assemble([{ type: 'tool-call', index: 0, id: 't', name: 'Read', arguments: "{'file_path': 'a.ts'}" }], {
      repairJson: () => ({ file_path: 'a.ts' }),
    })
    assert.deepEqual(repaired.message.content[0], { type: 'tool-use', id: 't', name: 'Read', input: { file_path: 'a.ts' } })

    const rejected = assemble([{ type: 'tool-call', index: 0, id: 't', name: 'Read', arguments: '{"path":"a.ts"}' }], {
      validateToolCall: (name, input) => (name === 'Read' && !('file_path' in input) ? 'file_path is required' : undefined),
    })
    const block = rejected.message.content[0]
    assert.equal(block.type === 'tool-use' && block.invalid?.error, 'file_path is required')
  })

  it('unwraps double-encoded arguments, treats empty arguments as {}, and drops nameless calls', () => {
    const reply = assemble([
      { type: 'tool-call', index: 0, id: 'a', name: 'TodoWrite', arguments: JSON.stringify(JSON.stringify({ todos: [] })) },
      { type: 'tool-call', index: 1, id: 'b', name: 'KillShell', arguments: '' },
      { type: 'tool-call', index: 2, id: 'c', arguments: '{}' },
    ])
    assert.deepEqual(reply.message.content, [
      { type: 'tool-use', id: 'a', name: 'TodoWrite', input: { todos: [] } },
      { type: 'tool-use', id: 'b', name: 'KillShell', input: {} },
    ])
  })

  it('reports a first token only once content arrives, and refuses events after finish', () => {
    const assembler = createAssembler({ origin })
    assembler.push({ type: 'keepalive' })
    assembler.push({ type: 'model', model: 'x' })
    assert.equal(assembler.snapshot().received, 0)
    assembler.push({ type: 'text', text: 'hi' })
    assert.equal(assembler.snapshot().received, 1)
    assembler.finish()
    assert.throws(() => assembler.push({ type: 'text', text: 'late' }))
  })

  it('assembles the same reply however the stream is sliced', async () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    const args = JSON.stringify({ file_path: 'src/a.ts', old_string: 'a\n"b"', new_string: 'c' })
    const cuts = gen.array(gen.int(0, 1), 0, 60)
    await check(gen.tuple(cuts, cuts), ([textCuts, argCuts]) => {
      const slice = (whole: string, marks: number[]) => {
        const parts: string[] = []
        let start = 0
        marks.forEach((mark, index) => {
          const at = Math.min(whole.length, Math.round(((index + 1) * whole.length) / (marks.length + 1)))
          if (mark && at > start) {
            parts.push(whole.slice(start, at))
            start = at
          }
        })
        parts.push(whole.slice(start))
        return parts
      }
      const events: TransportEvent[] = [
        ...slice(text, textCuts).map((piece): TransportEvent => ({ type: 'text', text: piece })),
        ...slice(args, argCuts).map((piece, index): TransportEvent =>
          index === 0 ? { type: 'tool-call', index: 0, id: 'id', name: 'Edit', arguments: piece } : { type: 'tool-call', index: 0, arguments: piece },
        ),
      ]
      const reply = assemble(events)
      assert.deepEqual(reply.message.content, [
        { type: 'text', text },
        { type: 'tool-use', id: 'id', name: 'Edit', input: JSON.parse(args) },
      ])
    })
  })
})
