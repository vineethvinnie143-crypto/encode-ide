import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { monitorTool, MONITOR_DEFAULT_MS, scheduleWakeupTool, sendMessageTool } from './background'
import { killShellTool } from './bash'
import { BUILTIN_SUBAGENT_TYPES, builtinTools, createToolRegistry } from './builtin'
import { createTaskTool } from './interaction'
import { addToolSearch } from './tool-search'
import { tempWorkspace, testContext, textOf } from './testing'
import type { AgentShell, BackgroundWork, SubagentMessage, SubagentRequest, Subagents } from './types'

/** A shell that only says where it is. */
const shellAt = (root: string): AgentShell => ({
  dialect: 'bash',
  program: '/bin/bash',
  state: () => ({ cwd: root, env: {}, dialect: 'bash' }),
  run: async () => {
    throw new Error('Monitor runs nothing itself.')
  },
})

function backgroundWork() {
  const monitors: Parameters<BackgroundWork['monitor']>[0][] = []
  const wakes: Parameters<BackgroundWork['wake']>[0][] = []
  let set = false
  const work: BackgroundWork = {
    monitor: async (request) => {
      monitors.push(request)
      return request.command === 'refuse' ? { ok: false, reason: 'Too many monitors.' } : { ok: true, id: 'bash_7' }
    },
    wake: (request) => {
      wakes.push(request)
      const replaced = set
      set = true
      return { at: Date.now() + request.delayMs, replaced }
    },
    cancelWake: () => {
      const had = set
      set = false
      return had
    },
  }
  return { work, monitors, wakes }
}

function subagents(overrides: Partial<Subagents> = {}): Subagents & { started: SubagentRequest[]; messages: SubagentMessage[]; stopped: string[] } {
  const started: SubagentRequest[] = []
  const messages: SubagentMessage[] = []
  const stopped: string[] = []
  return {
    started,
    messages,
    stopped,
    types: () => [...BUILTIN_SUBAGENT_TYPES],
    run: async () => ({ ok: true, report: 'REPORT', agentId: 'agent_1' }),
    start: async (request) => {
      started.push(request)
      return { ok: true, agentId: 'agent_2' }
    },
    message: async (request) => {
      messages.push(request)
      return { ok: true, report: `went on: ${request.text}`, agentId: request.to }
    },
    stop: async (agentId) => {
      stopped.push(agentId)
      return agentId === 'agent_2' ? { stopped: true, description: 'Look around' } : undefined
    },
    ...overrides,
  }
}

describe('Monitor', () => {
  it('starts the command in the background with the default time limit, or none when persistent', async () => {
    const root = await tempWorkspace()
    const { work, monitors } = backgroundWork()
    const ctx = testContext(root, { background: work, shell: shellAt(root) })
    const watched = await monitorTool.run({ command: 'tail -f a.log', description: ' Errors in the log ' }, ctx)
    assert.equal(watched.ok, true)
    assert.match(textOf(watched.content), /^Watching with id bash_7, for at most 300 s\. .*KillShell \(shell_id "bash_7"\)/)
    assert.deepEqual(monitors[0], { command: 'tail -f a.log', description: 'Errors in the log', cwd: root, timeoutMs: MONITOR_DEFAULT_MS })
    const forever = await monitorTool.run({ command: 'tail -f b.log', description: 'b', persistent: true, timeout_ms: 5_000 }, ctx)
    assert.match(textOf(forever.content), /until it ends or you stop it/)
    assert.equal(monitors[1].timeoutMs, null)
    const refused = await monitorTool.run({ command: 'refuse', description: 'x' }, ctx)
    assert.deepEqual([refused.ok, textOf(refused.content)], [false, 'Too many monitors.'])
  })

  it('is judged as a command in the background, and is not there for an agent without background work', async () => {
    const root = await tempWorkspace()
    const ctx = testContext(root, { shell: shellAt(root) })
    assert.deepEqual(monitorTool.access({ command: 'tail -f a.log', description: 'x' }, ctx), { type: 'command', command: 'tail -f a.log', cwd: root, background: true })
    const outcome = await monitorTool.run({ command: 'tail -f a.log', description: 'x' }, ctx)
    assert.equal(outcome.ok, false)
    assert.match(textOf(outcome.content), /Monitor is not available here/)
  })
})

describe('ScheduleWakeup', () => {
  it('needs a delay, a reason and a prompt unless it cancels', () => {
    assert.match(scheduleWakeupTool.check!({ delaySeconds: 60, reason: 'x' }) ?? '', /give delaySeconds, reason and prompt/)
    assert.equal(scheduleWakeupTool.check!({ delaySeconds: 60, reason: 'x', prompt: 'y' }), undefined)
    assert.equal(scheduleWakeupTool.check!({ cancel: true }), undefined)
  })

  it('sets one wake-up, says when one replaced another, and cancels it', async () => {
    const root = await tempWorkspace()
    const { work, wakes } = backgroundWork()
    const ctx = testContext(root, { background: work })
    const first = await scheduleWakeupTool.run({ delaySeconds: 90, reason: ' check ', prompt: ' look again ' }, ctx)
    assert.match(textOf(first.content), /^You will be woken at .+ \(in 90 s\)\. End your turn now/)
    assert.deepEqual(wakes[0], { delayMs: 90_000, reason: 'check', prompt: 'look again' })
    const second = await scheduleWakeupTool.run({ delaySeconds: 120, reason: 'b', prompt: 'c' }, ctx)
    assert.match(textOf(second.content), /in place of the wake-up set before/)
    assert.equal(textOf((await scheduleWakeupTool.run({ cancel: true }, ctx)).content), 'The wake-up is cancelled.')
    assert.equal(textOf((await scheduleWakeupTool.run({ cancel: true }, ctx)).content), 'There was no wake-up to cancel.')
  })
})

describe('SendMessage', () => {
  it('sends the message to the subagent, in the background when asked', async () => {
    const root = await tempWorkspace()
    const agents = subagents()
    const ctx = testContext(root, { subagents: agents, toolUseId: 'call_9' })
    const outcome = await sendMessageTool.run({ to: ' agent_1 ', message: 'Next part.', run_in_background: true }, ctx)
    assert.equal(textOf(outcome.content), 'went on: Next part.')
    assert.deepEqual(agents.messages[0], { to: 'agent_1', text: 'Next part.', background: true, toolUseId: 'call_9', mode: 'code' })
    const none = await sendMessageTool.run({ to: 'agent_1', message: 'x' }, testContext(root))
    assert.match(textOf(none.content), /no subagents to message here/)
  })
})

describe('Task in the background', () => {
  it('starts the subagent and returns at once with its id', async () => {
    const root = await tempWorkspace()
    const agents = subagents()
    const tool = createTaskTool(BUILTIN_SUBAGENT_TYPES)
    const outcome = await tool.run({ description: 'Look around', prompt: 'Find the parser.', subagent_type: 'Explore', run_in_background: true }, testContext(root, { subagents: agents }))
    assert.match(textOf(outcome.content), /^Started agent agent_2 in the background\. Its report reaches you as a notice/)
    assert.equal(agents.started[0].type, 'Explore')
  })

  it('names the agent id after a report when SendMessage can go on with it', async () => {
    const root = await tempWorkspace()
    const tool = createTaskTool(BUILTIN_SUBAGENT_TYPES)
    const input = { description: 'Look around', prompt: 'Find the parser.', subagent_type: 'Explore' }
    const withMessages = await tool.run(input, testContext(root, { subagents: subagents() }))
    assert.equal(textOf(withMessages.content), 'REPORT\n\n(agent id: agent_1; SendMessage to it continues this work)')
    assert.equal(withMessages.display?.output, 'REPORT')
    const without = await tool.run(input, testContext(root, { subagents: subagents({ message: undefined }) }))
    assert.equal(textOf(without.content), 'REPORT')
    const noBackground = await tool.run({ ...input, run_in_background: true }, testContext(root, { subagents: subagents({ start: undefined }) }))
    assert.match(textOf(noBackground.content), /cannot run in the background here/)
  })
})

describe('KillShell', () => {
  it('stops a subagent in the background when no command has the id', async () => {
    const root = await tempWorkspace()
    const agents = subagents()
    const ctx = testContext(root, { subagents: agents })
    assert.equal(textOf((await killShellTool.run({ shell_id: 'agent_2' }, ctx)).content), 'Stopped agent agent_2: Look around')
    const missing = await killShellTool.run({ shell_id: 'agent_9' }, ctx)
    assert.equal(missing.ok, false)
    assert.match(textOf(missing.content), /no background command or subagent agent_9/)
  })
})

describe('the background tools in the tool set', () => {
  it('come only with background work, SendMessage only with subagents, and all wait for ToolSearch', () => {
    const names = (options: Parameters<typeof builtinTools>[0]) => builtinTools(options).map((tool) => tool.definition.name)
    assert.ok(!names({ dialect: 'bash', platform: 'linux' }).includes('Monitor'))
    const plain = names({ dialect: 'bash', platform: 'linux', background: true })
    assert.ok(plain.includes('Monitor') && plain.includes('ScheduleWakeup') && !plain.includes('SendMessage'))
    assert.ok(names({ dialect: 'bash', platform: 'linux', background: true, subagentTypes: BUILTIN_SUBAGENT_TYPES }).includes('SendMessage'))

    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux', background: true, subagentTypes: BUILTIN_SUBAGENT_TYPES })
    assert.equal(addToolSearch(registry), true)
    const deferred = registry.deferred().map((tool) => tool.definition.name).sort()
    assert.deepEqual(deferred, ['Monitor', 'NotebookEdit', 'ScheduleWakeup', 'SendMessage'])
    const sent = registry.visibleDefinitions(undefined, new Set()).map((tool) => tool.name)
    assert.ok(!sent.includes('Monitor') && sent.includes('Task') && sent.includes('Bash'))
  })
})
