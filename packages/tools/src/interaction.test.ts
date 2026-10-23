import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BUILTIN_SUBAGENT_TYPES, builtinTools, createToolRegistry } from './builtin'
import {
  askUserQuestionTool,
  attemptCompletionTool,
  createGoalTool,
  createSkillTool,
  createTaskTool,
  enterPlanModeTool,
  exitPlanModeTool,
  todoWriteTool,
  updateGoalTool,
} from './interaction'
import { tempWorkspace, testContext, textOf } from './testing'
import type { GoalState, Interaction, PlanVerdict, TodoInput } from './types'

function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    ask: async () => [],
    enterPlan: async () => ({ approved: true }),
    proposePlan: async () => ({ approved: true }),
    setTodos: () => {},
    ...overrides,
  }
}

describe('interaction tools', () => {
  it('publishes todos and nudges toward one item in progress', async () => {
    const root = await tempWorkspace()
    let published: TodoInput[] = []
    const ctx = testContext(root, { interaction: interaction({ setTodos: (todos) => (published = todos) }) })
    const todos: TodoInput[] = [
      { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { content: 'Ship', activeForm: 'Shipping', status: 'in_progress' },
    ]
    const outcome = await todoWriteTool.run({ todos }, ctx)
    assert.deepEqual(published, todos)
    assert.match(textOf(outcome.content), /keep exactly one in progress/)
  })

  it('asks questions and returns each answer under its question', async () => {
    const root = await tempWorkspace()
    const ctx = testContext(root, { interaction: interaction({ ask: async (questions) => questions.map((question) => `${question.header}!`) }) })
    const outcome = await askUserQuestionTool.run(
      { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
      ctx,
    )
    assert.equal(outcome.content, 'The user answered:\n- Which database?\n  Database!\n\nContinue with these answers in mind.')
  })

  it('leaves plan mode on approval, revises on feedback, and stops when the answer comes later', async () => {
    const root = await tempWorkspace()
    const run = (verdict: PlanVerdict) => exitPlanModeTool.run({ plan: '1. Do it' }, testContext(root, { mode: 'plan', interaction: interaction({ proposePlan: async () => verdict }) }))
    const approved = await run({ approved: true })
    assert.equal(approved.mode, 'code')
    const rejected = await run({ approved: false, feedback: 'Use SQLite.' })
    assert.equal(rejected.ok, false)
    assert.match(textOf(rejected.content), /Their feedback: Use SQLite\. Stay in plan mode/)
    const deferred = await run({ approved: false, deferred: true })
    assert.deepEqual(deferred.stop, { summary: 'Plan proposed.' })
  })

  it('enters plan mode once the user agrees, and carries on in code mode when they do not', async () => {
    const root = await tempWorkspace()
    const reasons: string[] = []
    const run = (consent: { approved: boolean; note?: string }, reason?: string) =>
      enterPlanModeTool.run(
        reason === undefined ? {} : { reason },
        testContext(root, { interaction: interaction({ enterPlan: async (asked) => (reasons.push(asked), consent) }) }),
      )
    const entered = await run({ approved: true }, '  Three files change.  ')
    assert.equal(entered.mode, 'plan')
    assert.match(textOf(entered.content), /^You are in plan mode now\. Only the read-only tools work/)
    assert.match(textOf(entered.content), /call ExitPlanMode/)
    const declined = await run({ approved: false, note: 'Just fix it.' })
    assert.equal(declined.ok, true)
    assert.equal(declined.mode, undefined)
    assert.equal(textOf(declined.content), 'The user wants you to go ahead without a plan. They said: Just fix it. Carry on with the work in code mode.')
    assert.deepEqual(reasons, ['Three files change.', ''])
    assert.deepEqual(await enterPlanModeTool.describe({ reason: 'Three files change.' }, testContext(root)), { title: 'Plan first', detail: 'Three files change.' })
  })

  it('runs subagents through the context, and lists the types it offers', async () => {
    const root = await tempWorkspace()
    const task = createTaskTool(BUILTIN_SUBAGENT_TYPES)
    assert.deepEqual((task.definition.inputSchema.properties as Record<string, { enum?: string[] }>).subagent_type.enum, ['general-purpose', 'Explore', 'Plan', 'Review'])
    const ctx = testContext(root, {
      subagents: { types: () => [...BUILTIN_SUBAGENT_TYPES], run: async (request) => ({ ok: true, report: `did ${request.type}: ${request.prompt}` }) },
    })
    const outcome = await task.run({ description: 'Find auth', prompt: 'Where is login handled?', subagent_type: 'Explore' }, ctx)
    assert.equal(outcome.content, 'did Explore: Where is login handled?')
    assert.equal((await task.run({ description: 'x', prompt: 'y', subagent_type: 'Explore' }, testContext(root))).ok, false)
  })

  it('loads skills by name', async () => {
    const root = await tempWorkspace()
    const tool = createSkillTool([{ name: 'release', description: 'Cut a release' }])
    assert.match(tool.definition.description, /- release: Cut a release/)
    const ctx = testContext(root, {
      skills: {
        list: () => [{ name: 'release', description: 'Cut a release' }],
        load: async (name) => (name === 'release' ? { name, directory: '/skills/release', body: 'Step one.' } : undefined),
      },
    })
    assert.equal((await tool.run({ skill: 'release', args: 'v2' }, ctx)).content, 'Skill release. Its files are in /skills/release.\n\nStep one.\n\nArguments: v2')
    assert.match(textOf((await tool.run({ skill: 'nope' }, ctx)).content), /no skill called nope\. Known skills: release/)
  })

  it('sets and finishes the session goal', async () => {
    const root = await tempWorkspace()
    let goal: GoalState | null = null
    const ctx = testContext(root, { goals: { get: () => goal, set: (next) => (goal = next) } })
    assert.equal((await createGoalTool.run({ goal: 'Ship v1' }, ctx)).ok, true)
    assert.equal((await createGoalTool.run({ goal: 'Again' }, ctx)).ok, false)
    assert.equal(updateGoalTool.check!({ status: 'blocked' }), 'reason is required when the goal is blocked.')
    const done = await updateGoalTool.run({ status: 'complete' }, ctx)
    assert.equal(goal!.status, 'complete')
    assert.deepEqual(done.stop, { summary: 'Goal complete.' })
    assert.deepEqual((await attemptCompletionTool.run({ result: 'All done.' }, ctx)).stop, { summary: 'All done.' })
  })
})

describe('the built-in tool set', () => {
  it('describes the shell it runs, and leaves out what a session does not have', () => {
    const names = builtinTools({ dialect: 'pwsh', platform: 'win32' }).map((tool) => tool.definition.name)
    assert.deepEqual(names, [
      'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
      'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CreateGoal', 'UpdateGoal', 'GetGoal',
    ])
    const bash = builtinTools({ dialect: 'pwsh', platform: 'win32', only: ['Bash'], shellProgram: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })[0]
    assert.match(bash.definition.description, /This is PowerShell 7, not bash/)
    assert.match(bash.definition.description, /Chain commands that depend on each other with &&/)
    const legacy = builtinTools({ dialect: 'pwsh', platform: 'win32', only: ['Bash'], shellProgram: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })[0]
    assert.match(legacy.definition.description, /Runs a command in Windows PowerShell and/)
    assert.match(legacy.definition.description, /This is Windows PowerShell 5\.1, not bash/)
    assert.match(legacy.definition.description, /has no && or \|\|/)
    assert.doesNotMatch(legacy.definition.description, /Chain commands that depend on each other with &&/)
    const gitBash = builtinTools({ dialect: 'bash', platform: 'win32', only: ['Bash'] })[0]
    assert.match(gitBash.definition.description, /Runs a command in Git Bash/)
    const registry = createToolRegistry({ dialect: 'bash', platform: 'linux', subagentTypes: BUILTIN_SUBAGENT_TYPES, skills: [{ name: 's', description: 'd' }], completion: true })
    assert.ok(registry.has('Task') && registry.has('Skill') && registry.has('attempt_completion'))
    assert.deepEqual(registry.definitions('plan').map((tool) => tool.name).includes('Write'), false)
    assert.equal(registry.check('ExitPlanMode', { plan: 'x' }, 'code'), 'ExitPlanMode is not available in code mode.')
    assert.equal(registry.check('EnterPlanMode', {}, 'plan'), 'EnterPlanMode is not available in plan mode.')
    assert.equal(registry.check('EnterPlanMode', {}, 'ask'), 'EnterPlanMode is not available in ask mode.')
    assert.equal(registry.check('EnterPlanMode', { reason: 'x' }, 'code'), undefined)
  })
})
