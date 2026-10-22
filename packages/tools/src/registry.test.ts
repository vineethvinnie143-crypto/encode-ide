import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ToolRegistry } from './registry'
import type { Tool } from './types'

function tool(name: string, readOnly: boolean, extra: Partial<Tool> = {}): Tool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
    kind: readOnly ? 'read' : 'write',
    readOnly,
    access: () => ({ type: 'none' }),
    describe: () => ({ title: name }),
    run: async () => ({ ok: true, content: '' }),
    ...extra,
  }
}

describe('ToolRegistry', () => {
  it('offers read-only tools in every mode and the rest only when coding', () => {
    const registry = new ToolRegistry()
    registry.register(tool('Read', true))
    registry.register(tool('Write', false))
    registry.register(tool('ExitPlanMode', true, { modes: ['plan'] }))
    assert.deepEqual(registry.definitions('code').map((d) => d.name), ['Read', 'Write'])
    assert.deepEqual(registry.definitions('plan').map((d) => d.name), ['Read', 'ExitPlanMode'])
    assert.deepEqual(registry.definitions('ask').map((d) => d.name), ['Read'])
    assert.deepEqual(registry.definitions('code', ['Write']).map((d) => d.name), ['Write'])
  })

  it('refuses clashing or invalid names and non-object schemas', () => {
    const registry = new ToolRegistry()
    const remove = registry.register(tool('mcp__docs__search', true))
    assert.throws(() => registry.register(tool('mcp__docs__search', true)), /already registered/)
    assert.throws(() => registry.register(tool('bad name', true)), /not a valid tool name/)
    assert.throws(() => registry.register({ ...tool('Odd', true), definition: { name: 'Odd', description: '', inputSchema: { type: 'string' } } }), /must describe an object/)
    remove()
    assert.equal(registry.has('mcp__docs__search'), false)
  })

  it('explains what is wrong with a call', () => {
    const registry = new ToolRegistry()
    registry.register(tool('Read', true))
    registry.register(tool('Write', false, { check: (input) => (String(input.path).startsWith('/') ? undefined : 'path must be absolute.') }))
    assert.equal(registry.check('Read', { path: '/a' }), undefined)
    assert.equal(registry.check('Reed', {}), 'There is no tool called Reed. Available tools: Read, Write.')
    assert.equal(registry.check('Read', {}), 'Invalid input for Read: path is required.')
    assert.equal(registry.check('Write', { path: 'a' }), 'Invalid input for Write: path must be absolute.')
    assert.equal(registry.check('Write', { path: '/a' }, 'plan'), 'Write is not available in plan mode.')
  })
})
