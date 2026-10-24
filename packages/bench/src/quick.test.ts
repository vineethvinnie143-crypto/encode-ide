import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import { createScriptedClient, type ScriptedClient } from '@encode/core'
import { messageText, type CompletionOutcome, type CompletionRequest, type ModelClient } from '@encode/providers'
import { estimateTest, findPrograms, readTasks, REFERENCE_SETTINGS, REVIEW_PROBES, ROLE_SKILL, runModelTest, testPlan, type BenchTask } from './index'

const TASKS = path.join(process.cwd(), 'packages', 'bench', 'tasks')

/**
 * A model that does every task right: each task's reference run, picked by the request it was given, and reviews that
 * find the bug in the broken change and nothing serious in the sound one.
 */
function goodModel(tasks: readonly BenchTask[], usage: { cost?: number } = {}): ModelClient {
  const scripts = new Map<string, ScriptedClient>()
  for (const task of tasks) if (task.solution) scripts.set(task.prompt, createScriptedClient([...task.solution, { text: 'Done.' }]))
  const any = createScriptedClient([])
  const charged = (outcome: CompletionOutcome): CompletionOutcome =>
    outcome.kind === 'done'
      ? {
          ...outcome,
          usage: {
            ...outcome.usage,
            inputTokens: 10_000,
            outputTokens: 500,
            ...usage,
          },
        }
      : outcome
  return {
    budget: (role, query) => any.budget(role, query),
    async complete(request: CompletionRequest) {
      if (request.tool === 'CodeReview') {
        const asked = messageText(request.payload.messages[0]!)
        const findings = asked.includes('src/refunds.js')
          ? [
              {
                file: 'src/refunds.js',
                line: 11,
                priority: 'P0',
                title: 'SQL injection through reason',
                body: 'Use a bound parameter.',
              },
            ]
          : []
        return charged(await createScriptedClient([{ text: JSON.stringify({ summary: 'Reviewed.', findings }) }]).complete(request))
      }
      const first = messageText(request.payload.messages.find((message) => message.role === 'user')!)
      const script = [...scripts].find(([prompt]) => first.includes(prompt))?.[1]
      return charged(await (script ?? createScriptedClient([{ text: 'I cannot help with that.' }])).complete(request))
    },
  }
}

describe('Test this model', async () => {
  const { tasks } = await readTasks(TASKS)
  const programs = await findPrograms([])

  test('runs four writing tasks, two questions and two reviews, and scores each role by its skill', () => {
    const plan = testPlan(tasks)
    assert.deepEqual(
      plan.map((step) => [step.id, step.skill]),
      [
        ['fix-failing-test', 'writing'],
        ['json-config-edit', 'writing'],
        ['rename-across-files', 'writing'],
        ['crlf-preserve', 'writing'],
        ['question-no-change', 'exploring'],
        ['trace-event-handler', 'exploring'],
        ['review-finds-injection', 'reviewing'],
        ['review-sound-change', 'reviewing'],
      ],
    )
    for (const step of plan.filter((candidate) => candidate.task)) assert.deepEqual(step.task!.requires, [], `${step.id} needs only Node.js`)
    assert.deepEqual(ROLE_SKILL, {
      main: 'writing',
      planner: 'writing',
      explore: 'exploring',
      reviewer: 'reviewing',
    })
    // The broken change numbers its lines as in the file, the query on line 11.
    assert.match(REVIEW_PROBES[0]!.input.files[0]!.text, /^\+11 \| {3}await db\.run\(`INSERT INTO refunds/m)
  })

  test('says beforehand what it may cost: a range at the catalog price, nothing for a free model, no number without a price', () => {
    const priced = estimateTest(6, 2, { price: { input: 0.28, output: 0.42 } })
    assert.deepEqual(priced.requests, [20, 92])
    assert.deepEqual(priced.inputTokens, [245_000, 1_208_000])
    assert.ok(priced.cost && priced.cost[0] > 0.06 && priced.cost[0] < 0.08 && priced.cost[1] > 0.35 && priced.cost[1] < 0.37, JSON.stringify(priced.cost))
    assert.deepEqual(estimateTest(6, 2, { free: true, price: { input: 0, output: 0 } }).cost, [0, 0])
    assert.equal(estimateTest(6, 2, {}).cost, undefined)
  })

  test('a model that does everything right scores full marks, and the cost is the tokens at its price where the provider says none', async () => {
    const seen: number[] = []
    const result = await runModelTest({
      client: goodModel(tasks),
      ref: 'ds:deepseek-chat',
      model: 'deepseek-chat',
      tasks,
      programs,
      budget: { price: { input: 0.28, output: 0.42 } },
      settings: REFERENCE_SETTINGS,
      onProgress: (progress) => seen.push(progress.done),
      now: () => new Date('2026-10-24T09:00:00Z'),
    })
    assert.deepEqual(
      result.skills,
      {
        writing: { passed: 4, total: 4 },
        exploring: { passed: 2, total: 2 },
        reviewing: { passed: 2, total: 2 },
      },
      JSON.stringify(result.items, null, 2),
    )
    assert.equal(result.at, '2026-10-24T09:00:00.000Z')
    assert.equal(result.stopped, undefined)
    assert.equal(result.costKnown, true)
    // Each call read 10,000 tokens and wrote 500, at $0.28 and $0.42 a million.
    assert.ok(Math.abs(result.cost - (result.requests * (10_000 * 0.28 + 500 * 0.42)) / 1_000_000) < 1e-9)
    assert.equal(
      result.items.reduce((all, item) => all + item.requests, 0),
      result.requests,
    )
    assert.deepEqual(seen, [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8])
  })

  test('a model that cannot do the tasks scores none, the provider’s own cost is used, and the run stops at its limit', async () => {
    const unhelpful: ModelClient = goodModel([], { cost: 0.01 })
    const result = await runModelTest({
      client: unhelpful,
      ref: 'or:x/y',
      model: 'x/y',
      tasks,
      programs,
      budget: {},
      settings: REFERENCE_SETTINGS,
    })
    assert.deepEqual(result.skills.writing, { passed: 0, total: 4 })
    assert.equal(result.skills.exploring?.passed, 0)
    // It reviews as well as the good one: the review is answered the same way.
    assert.deepEqual(result.skills.reviewing, { passed: 2, total: 2 })
    assert.ok(Math.abs(result.cost - result.requests * 0.01) < 1e-9)
    // A failed task says which of its checks it missed.
    assert.match(result.items.find((item) => item.id === 'fix-failing-test')?.reason ?? '', /^Not met: .*the project's tests pass/)

    const limited = await runModelTest({
      client: unhelpful,
      ref: 'or:x/y',
      model: 'x/y',
      tasks,
      programs,
      budget: {},
      settings: REFERENCE_SETTINGS,
      limit: 0.005,
    })
    assert.equal(limited.stopped, 'limit')
    assert.equal(limited.items.length, 1)
    assert.equal(limited.items[0]!.outcome, 'error', 'a task cut short by the limit is not scored')
    assert.deepEqual(limited.skills, {})
  })

  test('says when the cost is not known, and stops when asked', async () => {
    const controller = new AbortController()
    const result = await runModelTest({
      client: goodModel(tasks),
      ref: 'local:qwen',
      model: 'qwen',
      tasks,
      programs,
      budget: {},
      settings: REFERENCE_SETTINGS,
      signal: controller.signal,
      onProgress: (progress) => progress.done === 2 && controller.abort(),
    })
    assert.equal(result.costKnown, false)
    assert.equal(result.stopped, 'cancelled')
    assert.equal(result.items.length, 2)
    assert.deepEqual(result.skills, { writing: { passed: 2, total: 2 } })
  })
})
