import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { MAX_TOOL_NAME, modelToolName, ruleToolName, serverNameProblem } from './names'

const VALID = /^[A-Za-z0-9_-]{1,64}$/

describe('MCP names', () => {
  it('accepts plain server names and refuses the ones that would blur mcp__server__tool', () => {
    for (const ok of ['github', 'my-server', 'a', 'Server_1', '9lives', 'a_b']) assert.equal(serverNameProblem(ok), null, ok)
    for (const bad of ['', '_a', '-a', 'a b', 'a.b', 'a__b', 'a/b', 'x'.repeat(49), 'caf\u00e9', '__proto__']) assert.notEqual(serverNameProblem(bad), null, bad)
  })

  it('names tools mcp__server__tool, and spells them for rules the same way', () => {
    assert.equal(modelToolName('github', 'create_issue', new Set()), 'mcp__github__create_issue')
    assert.equal(modelToolName('github', 'list.files', new Set()), 'mcp__github__list_files')
    assert.equal(ruleToolName('list.files'), 'list_files')
    assert.equal(ruleToolName('a b/c'), 'a_b_c')
  })

  it('cuts a long name to fit and keeps it distinct from other long names', () => {
    const long = 'x'.repeat(100)
    const one = modelToolName('server', `${long}1`, new Set())
    const two = modelToolName('server', `${long}2`, new Set())
    assert.equal(one.length, MAX_TOOL_NAME)
    assert.match(one, VALID)
    assert.notEqual(one, two)
    assert.equal(modelToolName('server', `${long}1`, new Set()), one, 'the same tool always gets the same name')
  })

  it('does not give two tools one name, even when they differ only in characters that became _', () => {
    const taken = new Set<string>()
    const names = ['a.b', 'a_b', 'a b', 'a/b'].map((tool) => {
      const name = modelToolName('s', tool, taken)
      taken.add(name)
      return name
    })
    assert.equal(new Set(names).size, 4)
    assert.equal(names[0], 'mcp__s__a_b')
    for (const name of names) assert.match(name, VALID)
  })

  it('always produces a valid, unused name', async () => {
    const server = gen.string('abcXYZ019-_', 1, 20)
    const tool = gen.string('ab.-_ /\u00e9\u4e2d9', 1, 90)
    await check(gen.tuple(server, gen.array(tool, 1, 12)), ([serverName, tools]) => {
      const name = serverName.replace(/__/g, '_x').replace(/^[-_]/, 'a')
      assert.equal(serverNameProblem(name), null)
      const taken = new Set<string>()
      for (const entry of tools) {
        const modelName = modelToolName(name, entry, taken)
        assert.match(modelName, VALID)
        assert.ok(modelName.startsWith('mcp__'))
        assert.ok(!taken.has(modelName), `${modelName} was already taken`)
        taken.add(modelName)
      }
    })
  })
})
