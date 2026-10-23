import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import { linkOrSkip, tempWorkspace } from '@encode/tools/testing'
import { builtinDefinitions, loadAgentDefinitions } from './subagents'
import type { Script, ScriptedStep } from './scripted'
import { closeHarnesses, sessionHarness } from './testing'

after(closeHarnesses)

const agent = (fields: Record<string, string>, body = 'Be careful.'): string =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n---\n${body}`

describe('the built-in subagents', () => {
  it('include Plan and Review beside Explore, each on its own model role and with read-only tools', () => {
    const found = Object.fromEntries(builtinDefinitions().map((definition) => [definition.name, definition]))
    assert.deepEqual(Object.keys(found), ['general-purpose', 'Explore', 'Plan', 'Review'])
    assert.equal(found.Explore.role, 'explore')
    assert.equal(found.Plan.role, 'planner')
    assert.equal(found.Review.role, 'reviewer')
    assert.equal(found['general-purpose'].role, undefined)
    for (const name of ['Explore', 'Plan', 'Review']) {
      assert.deepEqual(found[name].tools, ['Bash', 'BashOutput', 'Glob', 'Grep', 'Read', 'LSP', 'WebFetch', 'WebSearch'], name)
      assert.ok(!found[name].tools?.includes('Write') && !found[name].tools?.includes('Edit'), name)
    }
    assert.match(found.Plan.prompt ?? '', /plan, do not build/)
    assert.match(found.Review.prompt ?? '', /by severity/)
    assert.match(found.Review.prompt ?? '', /file and line/)
  })

  it('keep their names for themselves', async () => {
    const dir = await tempWorkspace({ 'Plan.md': agent({ description: 'Mine' }), 'Review.md': agent({ description: 'Mine' }), 'planner.md': agent({ description: 'Mine' }) })
    assert.deepEqual(loadAgentDefinitions([{ dir, source: 'user' }]).map((definition) => definition.name), ['planner'])
  })
})

describe('agent definitions', () => {
  it('read the extra fields: disallowed tools, turns, model as role, colour', async () => {
    const dir = await tempWorkspace({
      'a.md': agent({ description: 'A', tools: '[Read, "Grep", Bash]', disallowedTools: 'Bash, WebFetch', maxTurns: '12', model: 'reviewer', color: 'Blue' }),
      'b.md': agent({ description: 'B', 'disallowed-tools': 'Write', 'max-turns': '500', role: 'planner', model: 'ignored', color: 'chartreuse' }),
    })
    const [a, b] = loadAgentDefinitions([{ dir, source: 'user' }])
    assert.deepEqual(a, {
      name: 'a',
      description: 'A',
      tools: ['Read', 'Grep', 'Bash'],
      disallowedTools: ['Bash', 'WebFetch'],
      role: 'reviewer',
      maxTurns: 12,
      color: 'blue',
      prompt: 'Be careful.',
      source: 'user',
    })
    assert.equal(b.role, 'planner', 'role wins over model')
    assert.equal(b.maxTurns, 100, 'the number of turns is capped')
    assert.equal(b.color, undefined, 'an unknown colour is dropped')
    assert.deepEqual(b.disallowedTools, ['Write'])
  })

  it('leave the main agent\'s model alone for the names other tools give their models', async () => {
    const dir = await tempWorkspace(Object.fromEntries(['inherit', 'sonnet', 'Opus', 'haiku'].map((model) => [`${model}.md`, agent({ description: 'x', model })])))
    for (const definition of loadAgentDefinitions([{ dir, source: 'user' }])) assert.equal(definition.role, undefined, definition.name)
  })

  it('ignore a turns value that is not a positive number', async () => {
    const dir = await tempWorkspace({ 'a.md': agent({ description: 'A', maxTurns: 'many' }), 'b.md': agent({ description: 'B', maxTurns: '0' }), 'c.md': agent({ description: 'C', maxTurns: '-3' }) })
    for (const definition of loadAgentDefinitions([{ dir, source: 'user' }])) assert.equal(definition.maxTurns, undefined, definition.name)
  })

  it('let a later folder override an earlier one', async () => {
    const first = await tempWorkspace({ 'helper.md': agent({ description: 'First' }, 'one') })
    const second = await tempWorkspace({ 'helper.md': agent({ description: 'Second' }, 'two') })
    const [found] = loadAgentDefinitions([
      { dir: first, source: 'user' },
      { dir: second, source: 'workspace' },
    ])
    assert.equal(found.description, 'Second')
    assert.equal(found.source, 'workspace')
  })
})

describe('reading the agents a repository holds', () => {
  const root = async () => {
    const dir = await tempWorkspace({ '.encode/agents/ok.md': agent({ description: 'Fine' }) })
    return { dir, agents: path.join(dir, '.encode', 'agents') }
  }

  it('reads the files of the workspace\'s folder', async () => {
    const { agents } = await root()
    assert.deepEqual(loadAgentDefinitions([{ dir: agents, source: 'workspace' }]).map((definition) => definition.name), ['ok'])
  })

  it('skips a file that is a link, in the workspace, and follows one in the user\'s own folder', async (t) => {
    const { agents } = await root()
    const outside = await tempWorkspace({ 'secret.md': agent({ description: 'Private notes' }, 'do not read me') })
    if (!linkOrSkip(t, path.join(outside, 'secret.md'), path.join(agents, 'linked.md'), 'file')) return
    assert.deepEqual(loadAgentDefinitions([{ dir: agents, source: 'workspace' }]).map((definition) => definition.name), ['ok'])
    assert.deepEqual(loadAgentDefinitions([{ dir: agents, source: 'user' }]).map((definition) => definition.name), ['linked', 'ok'])
  })

  it('skips a workspace folder that leads out of the workspace', async (t) => {
    const dir = await tempWorkspace({ '.encode/placeholder': '' })
    const outside = await tempWorkspace({ 'notes.md': agent({ description: 'Somebody else\'s notes' }) })
    if (!linkOrSkip(t, outside, path.join(dir, '.encode', 'agents'), 'junction')) return
    assert.deepEqual(loadAgentDefinitions([{ dir: path.join(dir, '.encode', 'agents'), source: 'workspace' }]), [])
    assert.deepEqual(loadAgentDefinitions([{ dir: path.join(dir, '.encode', 'agents'), source: 'user' }]).map((definition) => definition.name), ['notes'])
  })

  it('skips a named pipe without waiting on it', async (t) => {
    if (process.platform === 'win32') return t.skip('no named pipes here')
    const { agents } = await root()
    execFileSync('mkfifo', [path.join(agents, 'pipe.md')])
    assert.deepEqual(loadAgentDefinitions([{ dir: agents, source: 'workspace' }]).map((definition) => definition.name), ['ok'])
  })

  it('skips a file that is too large, and reads no more than 64 files of a folder', async () => {
    const files: Record<string, string> = { 'huge.md': agent({ description: 'Huge' }, 'x'.repeat(70_000)) }
    for (let index = 0; index < 80; index++) files[`a${String(index).padStart(2, '0')}.md`] = agent({ description: `Agent ${index}` })
    const dir = await tempWorkspace(files)
    const names = loadAgentDefinitions([{ dir, source: 'user' }]).map((definition) => definition.name)
    assert.ok(!names.includes('huge'))
    assert.equal(names.length, 64)
    assert.ok(names.includes('a00') && !names.includes('a79'))
  })
})

describe('subagents in a session', () => {
  const taskCall = (type: string) => ({ name: 'Task', input: { description: 'Do the work', prompt: 'SUB-BRIEF', subagent_type: type } })
  const brief = (request: CompletionRequest): string =>
    request.payload.messages.map((message: Message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('\n')
  const isSubagent = (request: CompletionRequest) => brief(request).includes('SUB-BRIEF')

  /** The main agent calls the subagent once; the subagent follows `sub`. */
  function scripted(type: string, sub: (step: number) => ScriptedStep): Script {
    let main = 0
    let step = 0
    return (request) => (isSubagent(request) ? sub(step++) : [{ calls: [taskCall(type)] }, { text: 'All done.' }][main++])
  }

  async function run(files: Record<string, string>, type: string, sub: (step: number) => ScriptedStep, settings: { maxSteps?: number } = {}) {
    const dir = await tempWorkspace(files)
    const h = await sessionHarness({ script: scripted(type, sub), settings, env: { agentSources: () => [{ dir, source: 'user' }] } })
    await h.session.start({ text: 'go', mode: 'code' })
    return { h, subagent: h.client.requests.find(isSubagent)! }
  }

  it('gives a subagent only the tools its definition allows, whatever the case it spells them in', async () => {
    const { subagent } = await run({ 'scout.md': agent({ description: 'Scouts', tools: 'read, GREP, bash', disallowedTools: 'Bash' }) }, 'scout', () => ({ text: 'Report.' }))
    assert.deepEqual(subagent.payload.tools.map((tool) => tool.name).sort(), ['Grep', 'Read'])
  })

  it('takes tools away from all of them when the definition names none to keep', async () => {
    const { subagent } = await run({ 'careful.md': agent({ description: 'Careful', disallowedTools: 'Write, Edit, Bash' }) }, 'careful', () => ({ text: 'Report.' }))
    const names = subagent.payload.tools.map((tool) => tool.name)
    assert.ok(names.includes('Read') && names.includes('Glob'))
    for (const gone of ['Write', 'Edit', 'Bash', 'Task']) assert.ok(!names.includes(gone), gone)
  })

  it('stops a subagent after the turns its definition allows', async () => {
    const { h } = await run({ 'short.md': agent({ description: 'Short', maxTurns: '2' }) }, 'short', () => ({ calls: [{ name: 'Glob', input: { pattern: '*' } }] }))
    const subagentCalls = h.client.requests.filter(isSubagent)
    assert.equal(subagentCalls.length, 2)
    const result = JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1))
    assert.match(result, /ran out of steps \(2\)/)
  })

  it('never lets a definition run longer than the person\'s own limit of steps', async () => {
    const files = { 'long.md': agent({ description: 'Long', maxTurns: '90' }) }
    const { h } = await run(files, 'long', () => ({ calls: [{ name: 'Glob', input: { pattern: '*' } }] }), { maxSteps: 3 })
    assert.equal(h.client.requests.filter(isSubagent).length, 3)
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /ran out of steps \(3\)/)
  })

  it('sends the work to the model role the definition names, and the built-ins to theirs', async () => {
    const { subagent } = await run({ 'checker.md': agent({ description: 'Checks', model: 'reviewer' }) }, 'checker', () => ({ text: 'Report.' }))
    assert.equal(subagent.role, 'reviewer')
    const plan = await run({}, 'Plan', () => ({ text: 'Plan.' }))
    assert.equal(plan.subagent.role, 'planner')
    assert.match(plan.subagent.payload.system.map((part) => part.text).join('\n'), /plan, do not build/)
    const review = await run({}, 'Review', () => ({ text: 'Findings.' }))
    assert.equal(review.subagent.role, 'reviewer')
    const foreign = await run({ 'tool.md': agent({ description: 'Uses sonnet', model: 'sonnet' }) }, 'tool', () => ({ text: 'Report.' }))
    assert.equal(foreign.subagent.role, 'main')
  })

  it('lists a new agent file to the model from the next turn on', async () => {
    const dir = await tempWorkspace()
    const h = await sessionHarness({ script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], env: { agentSources: () => [{ dir, source: 'user' }] } })
    const types = (request: CompletionRequest): string[] => {
      const task = request.payload.tools.find((tool) => tool.name === 'Task')!
      return ((task.inputSchema.properties as Record<string, { enum?: string[] }>).subagent_type.enum ?? []).slice()
    }
    await h.session.start({ text: 'first', mode: 'code' })
    assert.deepEqual(types(h.client.requests[0]), ['general-purpose', 'Explore', 'Plan', 'Review'])
    fs.writeFileSync(path.join(dir, 'helper.md'), agent({ description: 'Helps' }))
    await h.session.start({ text: 'second', mode: 'code' })
    assert.deepEqual(types(h.client.requests[1]), ['general-purpose', 'Explore', 'Plan', 'Review', 'helper'])
    await h.session.start({ text: 'third', mode: 'code' })
    assert.deepEqual(types(h.client.requests[2]), types(h.client.requests[1]))
  })
})
