/**
 * What every request costs before the person's first word, and what a turn adds
 * to it. These are ceilings, not targets: a change that makes the instructions
 * or a tool description longer has to say so here, where the price is read
 * (each character is paid on every step, by the person's key or the free pool's
 * allowance). Run with ENCODE_TOKEN_REPORT=1 to print the sizes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { ToolDefinition } from '@encode/providers'
import { addToolSearch, BUILTIN_SUBAGENT_TYPES, createToolRegistry } from '@encode/tools'
import { outsideTools } from '@encode/tools/testing'
import { CHARS_PER_TOKEN } from './compaction'
import { closeHarnesses, sessionHarness } from './testing'

after(closeHarnesses)

const report = Boolean(process.env.ENCODE_TOKEN_REPORT)

const toolChars = (tool: ToolDefinition): number => tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length
const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

function show(title: string, rows: readonly [string, number][]): void {
  if (!report) return
  console.log(`\n${title}`)
  for (const [name, chars] of rows) console.log(`  ${name.padEnd(20)} ${String(chars).padStart(7)} chars  ~${String(tokens(chars)).padStart(5)} tokens`)
}

/** The tools of a desktop session on a project with skills: the largest set the app sends without outside tools. */
function fullToolSet(): ToolDefinition[] {
  const skills = Array.from({ length: 20 }, (_, index) => ({
    name: `skill-${index}`,
    description: 'A skill with a description of the usual length, saying what it does and when to use it, in about this many words.',
  }))
  const registry = createToolRegistry({ dialect: 'bash', platform: 'linux', subagentTypes: BUILTIN_SUBAGENT_TYPES, skills, computer: true })
  return registry.allDefinitions()
}

describe('the cost of a request before the first word', () => {
  it('keeps the instructions and the tool list inside their ceilings', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'Fix the failing test in src/utils.ts', mode: 'code' })
    const { payload } = h.client.requests[0]
    const system = payload.system.reduce((sum, part) => sum + part.text.length, 0)
    const tools = payload.tools.reduce((sum, tool) => sum + toolChars(tool), 0)
    show('Request without a project, no skills, no desktop', [
      ['instructions', system],
      ['tools', tools],
      ...payload.tools.map((tool): [string, number] => [`  ${tool.name}`, toolChars(tool)]),
    ])
    // ADR 0141 raised it from 6,500: the inputs around a change are tried too, and probes go in the scratch folder.
    // ADR 0147 from 6,600: a wrong result the agent's own checks find on input like the request's is fixed, not offered.
    assert.ok(system <= 6_800, `the instructions are ${system} characters; the ceiling is 6800`)
    // CodeMap (ADR 0090) raised it from 20,500: a map in one call saves the Glob, Grep and Read rounds that find code.
    // Its package lookups (ADR 0091) from 21,000: one call reads a dependency's API instead of its files. The largest
    // set is Windows', whose Bash says how Git Bash names paths.
    assert.ok(tools <= 21_200, `the tools are ${tools} characters; the ceiling is 21200`)
    for (const tool of payload.tools) assert.ok(toolChars(tool) <= 3_000, `${tool.name} is ${toolChars(tool)} characters; one tool may take at most 3000`)
  })

  it('sends a model that needs no guide the short instructions and tools, under 17,500 characters (5,000 tokens) together', async () => {
    const sizes = async (model: string, guide?: 'full') => {
      const h = await sessionHarness({ script: [{ text: 'ok' }], client: { model }, ...(guide ? { settings: { guide } } : {}) })
      await h.session.start({ text: 'Fix the failing test in src/utils.ts', mode: 'code' })
      const { payload } = h.client.requests[0]
      return { system: payload.system.reduce((sum, part) => sum + part.text.length, 0), tools: payload.tools.reduce((sum, tool) => sum + toolChars(tool), 0), names: payload.tools.map((tool) => tool.name) }
    }
    const short = await sizes('anthropic/claude-sonnet-4.5')
    const full = await sizes('deepseek/deepseek-chat')
    const chosen = await sizes('anthropic/claude-sonnet-4.5', 'full')
    show('Short guide', [['instructions', short.system], ['tools', short.tools], ['together', short.system + short.tools], ['full guide, together', full.system + full.tools]])
    assert.deepEqual(short.names, full.names, 'the same tools, described more briefly')
    assert.ok(short.system + short.tools <= 17_500, `the short guide is ${short.system + short.tools} characters; the ceiling is 17500`)
    assert.ok(short.system + short.tools < (full.system + full.tools) * 0.75)
    assert.deepEqual(chosen, full, 'the person can choose the full guide for every model')
  })

  it('keeps the largest built-in tool set (skills and the desktop included) inside its ceiling', () => {
    const tools = fullToolSet()
    const total = tools.reduce((sum, tool) => sum + toolChars(tool), 0)
    show('Full built-in tool set', [['tools', total], ...tools.map((tool): [string, number] => [`  ${tool.name}`, toolChars(tool)])])
    assert.ok(total <= 30_000, `the full tool set is ${total} characters; the ceiling is 30000`)
    for (const tool of tools) assert.ok(toolChars(tool) <= 6_000, `${tool.name} is ${toolChars(tool)} characters; one tool may take at most 6000`)
  })

  it('sends a model without a cache its seldom needed tools only once ToolSearch loads them (ADR 0136)', async () => {
    const sent = async (read: number) => {
      const h = await sessionHarness({ script: [{ text: 'ok' }], client: { cache: { read, write: 1, boundThinking: false, source: 'price' } } })
      await h.session.start({ text: 'Fix the failing test in src/utils.ts', mode: 'code' })
      return h.client.requests[0].payload.tools.reduce((sum, tool) => sum + toolChars(tool), 0)
    }
    const cached = await sent(0.1)
    const uncached = await sent(1)
    const desktop = createToolRegistry({ dialect: 'bash', platform: 'linux', subagentTypes: BUILTIN_SUBAGENT_TYPES, computer: true, browser: true })
    addToolSearch(desktop)
    const chars = (lean: boolean) => desktop.visibleDefinitions(undefined, new Set(), false, lean).reduce((sum, tool) => sum + toolChars(tool), 0)
    show('Without a cache', [['tools, cached', cached], ['tools, uncached', uncached], ['desktop, cached', chars(false)], ['desktop, uncached', chars(true)]])
    assert.ok(uncached <= cached - 1_400, `a model without a cache is sent ${uncached} characters of tools, one with ${cached}`)
    assert.ok(chars(true) <= chars(false) * 0.75, `with the desktop tools, ${chars(true)} against ${chars(false)}`)
  })

  it('sends the environment and the memory once, not with every turn', async () => {
    const h = await sessionHarness({
      script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      files: { 'ENCODE.md': 'Use tabs.\n', 'src/a.ts': 'export {}\n' },
    })
    await h.session.start({ text: 'first', mode: 'code' })
    await h.session.start({ text: 'second', mode: 'code' })
    await h.session.start({ text: 'third', mode: 'code' })
    const sizes = h.client.requests.map((request) =>
      request.payload.messages.map((message) => message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)),
    )
    show('Text of each message, by request', sizes.map((row, index): [string, number] => [`request ${index + 1}`, row.reduce((a, b) => a + b, 0)]))
    const [first, second, third] = sizes
    // Each later request is the one before it plus the model's last answer and the person's new words, nothing re-sent.
    assert.deepEqual(second.slice(0, first.length), first)
    assert.deepEqual(third.slice(0, second.length), second)
    assert.equal(second.length, first.length + 2)
    const added = second.slice(first.length)
    assert.ok(added.every((chars) => chars < 40), `a turn added ${added.join(' and ')} characters beside the words themselves`)
  })
})

describe('a server with many tools', () => {
  const names = Array.from({ length: 40 }, (_, index) => `operation_${index}`)

  it('costs its tool names, not its definitions, until the model asks for some', async () => {
    const tools = outsideTools('bigserver', names, 800)
    const h = await sessionHarness({ script: [{ text: 'ok' }], env: { external: { key: () => 'one', list: () => tools } } })
    await h.session.start({ text: 'hi', mode: 'code' })
    const sent = h.client.requests[0].payload.tools
    const sentChars = sent.reduce((sum, tool) => sum + toolChars(tool), 0)
    const definitions = tools.reduce((sum, tool) => sum + toolChars(tool.definition), 0)
    show('40 tools of one MCP server', [
      ['definitions', definitions],
      ['tools sent', sentChars],
      ['  ToolSearch', toolChars(sent.find((tool) => tool.name === 'ToolSearch')!)],
    ])
    assert.ok(sent.some((tool) => tool.name === 'ToolSearch'))
    assert.ok(!sent.some((tool) => tool.name.startsWith('mcp__')))
    assert.ok(sentChars < 21_000 + 3_500, `${sentChars} characters of tools are sent`)
    assert.ok(definitions > 60_000, `the definitions themselves are ${definitions} characters`)
  })
})

describe('what a long session writes to its log', () => {
  it('grows with the messages, not with the square of them: a step that changes nothing rewrites nothing', async () => {
    const h = await sessionHarness({
      files: { 'a.txt': 'hello\nworld\n' },
      scriptFor: (root) => [
        ...Array.from({ length: 6 }, () => ({ calls: [{ name: 'Read', input: { file_path: path.join(root, 'a.txt') } }] })),
        { text: 'done' },
      ],
    })
    await h.session.start({ text: 'go', mode: 'code' })
    await h.session.flush()
    const [name] = fs.readdirSync(h.dir).filter((file) => file.endsWith('.jsonl'))
    const records = fs.readFileSync(path.join(h.dir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    const counts = records.reduce<Record<string, number>>((all, record) => ({ ...all, [record.type]: (all[record.type] ?? 0) + 1 }), {})
    show('Log records after six tool steps', Object.entries(counts))
    assert.equal(counts.compaction ?? 0, 0, 'a compaction record holds the whole conversation; none is written when nothing was compacted')
    assert.equal(counts.message, 1 + 6 * 2 + 1, 'the request, a call and its result six times, the answer')
  })
})
