import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AssistantMessage } from '@encode/providers'
import { callsInText, recoverTextCalls } from './text-calls'

const TOOLS = new Set(['Read', 'Grep', 'Edit', 'Bash'])
const known = (name: string) => TOOLS.has(name)
const reply = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const ids = (index: number) => `call_text_${index}`

const BAR = String.fromCharCode(0xff5c)
const LOW = String.fromCharCode(0x2581)
const ds = (name: string) => `<${BAR}${name.split('_').join(LOW)}${BAR}>`

describe('tool calls a model wrote as text', () => {
  it('are read in the formats models use, values kept as written', () => {
    const cases: [string, { name: string; input: Record<string, unknown> }[]][] = [
      ['I will read it.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "src/a.ts"}}\n</tool_call>', [{ name: 'Read', input: { file_path: 'src/a.ts' } }]],
      ['<tool_call>{"name": "Grep", "arguments": "{\\"pattern\\": \\"TODO\\"}"}</tool_call>', [{ name: 'Grep', input: { pattern: 'TODO' } }]],
      ['<tool_call>Read\n<arg_key>file_path</arg_key>\n<arg_value>src/a.ts</arg_value>\n<arg_key>limit</arg_key>\n<arg_value>50</arg_value>\n</tool_call>', [{ name: 'Read', input: { file_path: 'src/a.ts', limit: '50' } }]],
      ['<tool_call>\n<function=Edit>\n<parameter=file_path>\na.ts\n</parameter>\n<parameter=old_string>\nconst a = 1\n</parameter>\n<parameter=new_string>\nconst a = 2\n</parameter>\n</function>\n</tool_call>', [{ name: 'Edit', input: { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }]],
      ['<function=Bash><parameter=command>npm test</parameter></function>', [{ name: 'Bash', input: { command: 'npm test' } }]],
      ['<function_calls>\n<invoke name="Read">\n<parameter name="file_path">a.ts</parameter>\n</invoke>\n<invoke name="Grep">\n<parameter name="pattern">x</parameter>\n</invoke>\n</function_calls>', [{ name: 'Read', input: { file_path: 'a.ts' } }, { name: 'Grep', input: { pattern: 'x' } }]],
      [`${ds('tool_calls_begin')}${ds('tool_call_begin')}function${ds('tool_sep')}Read\n\`\`\`json\n{"file_path": "a.ts"}\n\`\`\`${ds('tool_call_end')}${ds('tool_calls_end')}`, [{ name: 'Read', input: { file_path: 'a.ts' } }]],
      [`${ds('tool_calls_begin')}${ds('tool_call_begin')}Grep${ds('tool_sep')}{"pattern": "x"}${ds('tool_call_end')}${ds('tool_call_begin')}Read${ds('tool_sep')}{"file_path": "b.ts"}${ds('tool_call_end')}${ds('tool_calls_end')}`, [{ name: 'Grep', input: { pattern: 'x' } }, { name: 'Read', input: { file_path: 'b.ts' } }]],
      ['<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path": "a.ts"}<|tool_call_end|><|tool_calls_section_end|>', [{ name: 'Read', input: { file_path: 'a.ts' } }]],
      ['{"name": "Read", "arguments": {"file_path": "a.ts"}}', [{ name: 'Read', input: { file_path: 'a.ts' } }]],
      ['```json\n{"type": "function", "function": {"name": "Grep", "arguments": "{\\"pattern\\": \\"y\\"}"}}\n```', [{ name: 'Grep', input: { pattern: 'y' } }]],
      ['[{"tool": "Read", "input": {"file_path": "a.ts"}}, {"tool": "Read", "input": {"file_path": "b.ts"}}]', [{ name: 'Read', input: { file_path: 'a.ts' } }, { name: 'Read', input: { file_path: 'b.ts' } }]],
    ]
    for (const [text, calls] of cases) assert.deepEqual(callsInText(text, known)?.calls, calls, text.slice(0, 60))
  })

  it('keeps the words around them, without the markup', () => {
    assert.equal(callsInText('First I read the file.\n\n<tool_call>{"name": "Read", "arguments": {"file_path": "a.ts"}}</tool_call>\n\n\nThen I fix it.', known)?.text, 'First I read the file.\n\nThen I fix it.')
  })

  it('leaves a reply that only shows a call, or JSON that is an answer', () => {
    const cases = [
      'Models such as Qwen write calls like this:\n```\n<tool_call>{"name": "Read", "arguments": {}}</tool_call>\n```',
      '{"name": "eNCode", "version": "0.1.0"}',
      '{"name": "Deploy", "arguments": {}}',
      'The config is:\n```json\n{"name": "Read", "arguments": {"file_path": "a.ts"}}\n```\nThat is all.',
      '<tool_call>this is not a call</tool_call>',
      'Plain words, nothing to run.',
    ]
    for (const text of cases) assert.equal(callsInText(text, known), null, text.slice(0, 60))
  })

  it('become tool calls of the reply, only when it has none of its own', () => {
    const made = recoverTextCalls(reply('Reading.\n<tool_call>{"name": "Read", "arguments": {"file_path": "a.ts"}}</tool_call>'), known, ids)
    assert.deepEqual(made?.content, [
      { type: 'text', text: 'Reading.' },
      { type: 'tool-use', id: 'call_text_0', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    const own: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '<tool_call>{"name": "Read", "arguments": {}}</tool_call>' }, { type: 'tool-use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] }
    assert.equal(recoverTextCalls(own, known, ids), null)
    assert.equal(recoverTextCalls(reply('Done: the tests pass.'), known, ids), null)
    // A call to a tool the agent does not have still becomes a call: it is refused with the list of tools.
    assert.equal(recoverTextCalls(reply('<function=Deploy><parameter=to>prod</parameter></function>'), known, ids)?.content[0].type, 'tool-use')
  })
})
