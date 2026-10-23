import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@encode/providers'
import { createToolRegistry } from './builtin'
import { DEFER_ABOVE_CHARS, TOOL_SEARCH, ToolRegistry } from './registry'
import { addToolSearch, createToolSearchTool, loadedTools, searchDeferred } from './tool-search'
import { outsideTools, testContext, textOf } from './testing'

const GITHUB = ['create_issue', 'list_issues', 'get_issue', 'create_pull_request', 'merge_pull_request', 'search_code', 'get_file_contents', 'list_commits']
const SLACK = ['post_message', 'list_channels', 'get_thread_replies', 'add_reaction']

function registryWith(...groups: [string, readonly string[], number?, Record<string, string>?][]): ToolRegistry {
  const registry = createToolRegistry({ dialect: 'bash', platform: 'linux' })
  for (const [server, names, padding, described] of groups) for (const tool of outsideTools(server, names, padding, described)) registry.register(tool)
  addToolSearch(registry)
  return registry
}

const call = (name: string, input: Record<string, unknown>, id = `id_${name}`): Message => ({ role: 'assistant', content: [{ type: 'tool-use', id, name, input }] })

describe('deferring tools', () => {
  it('sends outside tools in full while their definitions are short, and defers them once they are long', () => {
    const outside = (registry: ToolRegistry) => registry.deferred().filter((tool) => tool.definition.name.startsWith('mcp__'))
    const small = registryWith(['github', GITHUB.slice(0, 3), 100])
    assert.equal(outside(small).length, 0, 'three short definitions are cheaper than a search')
    // The built-in tools that always wait for a search (NotebookEdit) are all it lists then.
    assert.deepEqual(small.deferred().map((tool) => tool.definition.name), ['NotebookEdit'])
    const names = small.visibleDefinitions(undefined, new Set()).map((tool) => tool.name)
    assert.ok(names.includes('mcp__github__create_issue'))

    const large = registryWith(['github', GITHUB, 900], ['slack', SLACK, 900])
    assert.equal(outside(large).length, GITHUB.length + SLACK.length)
    assert.ok(large.has(TOOL_SEARCH))
    const total = outside(large).reduce((sum, tool) => sum + JSON.stringify(tool.definition).length, 0)
    assert.ok(total > DEFER_ABOVE_CHARS)
    const visible = large.visibleDefinitions(undefined, new Set()).map((tool) => tool.name)
    assert.ok(visible.includes(TOOL_SEARCH) && visible.includes('Read'))
    assert.ok(!visible.some((name) => name.startsWith('mcp__')))
  })

  it('sends a loaded tool in full, in registration order, and keeps the built-in tools where they were', () => {
    const registry = registryWith(['github', GITHUB, 900])
    const before = registry.visibleDefinitions(undefined, new Set()).map((tool) => tool.name)
    const after = registry.visibleDefinitions(undefined, new Set(['mcp__github__list_issues', 'mcp__github__create_issue'])).map((tool) => tool.name)
    assert.deepEqual(after.filter((name) => !name.startsWith('mcp__')), before)
    assert.deepEqual(after.filter((name) => name.startsWith('mcp__')), ['mcp__github__create_issue', 'mcp__github__list_issues'])
  })

  it('sends an agent that cannot search everything it may use, because it could not ask', () => {
    const registry = registryWith(['github', GITHUB, 900])
    const only = ['Read', 'mcp__github__get_issue']
    assert.deepEqual(registry.visibleDefinitions(only, new Set()).map((tool) => tool.name), ['Read', 'mcp__github__get_issue'])
    const searching = registry.visibleDefinitions(['Read', TOOL_SEARCH, 'mcp__github__get_issue'], new Set()).map((tool) => tool.name)
    assert.deepEqual(searching, ['Read', TOOL_SEARCH])
  })

  it('leaves tools that do not ask for it alone, however many there are', () => {
    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux' })
    for (const tool of outsideTools('big', GITHUB, 2000)) registry.register({ ...tool, defer: false })
    assert.deepEqual(registry.deferred().map((tool) => tool.definition.name), ['NotebookEdit'])
  })

  it('registers ToolSearch once, and only when something is deferred', () => {
    const registry = registryWith(['github', GITHUB, 900])
    assert.equal(addToolSearch(registry), false, 'already there')
    assert.equal(registry.get(TOOL_SEARCH)?.definition.name, TOOL_SEARCH)
  })
})

describe('ToolSearch', () => {
  it('lists the names of what it can load by server, and costs far less than the definitions', () => {
    const registry = registryWith(['github', GITHUB, 900], ['slack', SLACK, 900])
    const { description } = registry.get(TOOL_SEARCH)!.definition
    assert.match(description, /^github: create_issue, list_issues, get_issue,/m)
    assert.match(description, /^slack: post_message, list_channels,/m)
    const full = registry.deferred().reduce((sum, tool) => sum + JSON.stringify(tool.definition).length, 0)
    assert.ok(description.length < full / 10, `${description.length} characters against ${full}`)
  })

  it('cuts a very long list and says how to find the rest', () => {
    const many = Array.from({ length: 400 }, (_, index) => `tool_number_${index}`)
    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux' })
    for (let server = 0; server < 40; server++) for (const tool of outsideTools(`server${server}`, many.slice(server * 10, server * 10 + 10), 200)) registry.register(tool)
    addToolSearch(registry)
    const { description } = registry.get(TOOL_SEARCH)!.definition
    assert.match(description, /… and the tools of \d+ more servers: search by words to find them\./)
    assert.ok(description.length < 8_000)
  })

  it('finds tools by words, ranking a name above a description, and loads at most the limit', () => {
    const registry = registryWith(
      ['github', GITHUB, 900, { search_code: 'Searches code in repositories for a pattern.', get_issue: 'Gets an issue; the issue may mention a pull request.' }],
      ['slack', SLACK, 900],
    )
    const names = (query: string, limit?: number) => searchDeferred(registry, query, limit).map((tool) => tool.definition.name)
    assert.deepEqual(names('pull request').slice(0, 2), ['mcp__github__create_pull_request', 'mcp__github__merge_pull_request'])
    assert.equal(names('pull request')[2], 'mcp__github__get_issue', 'a description counts for less than a name')
    assert.deepEqual(names('slack message'), ['mcp__slack__post_message'].concat(names('slack message').slice(1)))
    assert.equal(names('slack message')[0], 'mcp__slack__post_message')
    assert.equal(names('issue', 2).length, 2)
    assert.deepEqual(names('the tool for nothing at all zzzz'), [])
    assert.deepEqual(names(''), [])
  })

  it('loads exactly what select: names, by full name or by a name that only one server has', () => {
    const registry = registryWith(['github', GITHUB, 900], ['slack', SLACK, 900])
    const names = (query: string) => searchDeferred(registry, query).map((tool) => tool.definition.name)
    assert.deepEqual(names('select:mcp__slack__add_reaction,get_issue'), ['mcp__slack__add_reaction', 'mcp__github__get_issue'])
    assert.deepEqual(names('SELECT: Create_Issue , nothing_here'), ['mcp__github__create_issue'])
    for (const tool of outsideTools('gitlab', ['create_issue'], 900)) registry.register(tool)
    assert.deepEqual(names('select:create_issue'), [], 'two servers have it: the full name is needed')
    assert.deepEqual(names('select:mcp__gitlab__create_issue'), ['mcp__gitlab__create_issue'])
  })

  it('does not load a few tools with enormous definitions all at once', () => {
    const registry = registryWith(['wide', ['one', 'two', 'three', 'four'], 3_000])
    assert.equal(searchDeferred(registry, 'select:one,two,three,four').length, 3)
    assert.equal(searchDeferred(registry, 'select:one').length, 1, 'one is always loaded, however long')
  })

  it('answers with what was loaded, or with what exists when nothing matched', async () => {
    const registry = registryWith(['github', GITHUB, 900, { create_issue: 'Creates an issue in a repository. Needs the title.' }])
    const tool = createToolSearchTool(registry)
    const ctx = testContext('/tmp/project')
    const found = await tool.run({ query: 'create issue' }, ctx)
    assert.equal(found.ok, true)
    assert.match(textOf(found.content), /^Loaded \d tools?\. /)
    assert.match(textOf(found.content), /- mcp__github__create_issue: Creates an issue in a repository\./)
    const none = await tool.run({ query: 'calendar invite' }, ctx)
    assert.equal(none.ok, false)
    assert.match(textOf(none.content), /^No tool matches "calendar invite"\./)
    assert.match(textOf(none.content), /github: create_issue/)
    assert.match(registry.check(TOOL_SEARCH, { query: '' }) ?? '', /^Invalid input for ToolSearch: /)
    assert.equal(registry.check(TOOL_SEARCH, { query: 'issue', max_results: 3 }), undefined)
  })
})

describe('what a conversation has loaded', () => {
  it('is what its ToolSearch calls found and what it called, and nothing else', () => {
    const registry = registryWith(['github', GITHUB, 900], ['slack', SLACK, 900])
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      call(TOOL_SEARCH, { query: 'select:mcp__slack__post_message' }),
      call('mcp__github__get_issue', { target: '1' }),
      call('Read', { file_path: '/a' }),
    ]
    assert.deepEqual([...loadedTools(messages, registry)].sort(), ['mcp__github__get_issue', 'mcp__slack__post_message'])
    assert.deepEqual([...loadedTools(messages.slice(0, 1), registry)], [])
  })

  it('is empty when nothing is deferred', () => {
    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux' })
    assert.equal(loadedTools([call('Read', { file_path: '/a' })], registry).size, 0)
  })

  it('does not trust the shape of a call: a query that is not text loads nothing', () => {
    const registry = registryWith(['github', GITHUB, 900])
    assert.equal(loadedTools([call(TOOL_SEARCH, { query: 42 }), call(TOOL_SEARCH, {})], registry).size, 0)
  })
})
