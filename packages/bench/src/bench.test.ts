import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { createScriptedClient, type ScriptedStep } from '@encode/core'
import { spendingCap, type CompletionRequest, type ModelClient } from '@encode/providers'
import { main, plain } from './cli'
import { compareReports, dropChance, findPrograms, formatReport, gate, meanInterval, meteredClient, parseReport, parseTask, playReplay, ratioInterval, readTask, readTasks, t95, AS_WRITTEN, REFERENCE_SETTINGS, referenceClient, runBench, runPair, runTask, summarize, TaskError, type BenchReport, type ModelCall, type TaskRun } from './index'

const TASKS = path.join(process.cwd(), 'packages', 'bench', 'tasks')
const made: string[] = []

after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** A task folder of a test's own: task.json from `task`, the project's files, the checks' files. */
async function makeTask(task: Record<string, unknown>, files: Record<string, string> = {}, checks: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-task-'))
  made.push(root)
  const dir = path.join(root, String(task.id))
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
  await write(path.join(dir, 'task.json'), JSON.stringify(task))
  await fs.mkdir(path.join(dir, 'project'), { recursive: true })
  for (const [name, text] of Object.entries(files)) await write(path.join(dir, 'project', name), text)
  for (const [name, text] of Object.entries(checks)) await write(path.join(dir, 'checks', name), text)
  return dir
}

const base = { id: 'sample', title: 'A sample', prompt: 'Write done.txt.', checks: [{ kind: 'file', path: 'done.txt', includes: ['done'] }] }
const idle: ScriptedStep[] = [{ text: 'I looked, and there is nothing to change.' }]

describe('the built-in tasks', async () => {
  const { tasks, broken } = await readTasks(TASKS)
  const programs = await findPrograms(tasks.flatMap((task) => task.requires))

  test('all read, and each has a reference run', () => {
    assert.deepEqual(broken.map((error) => error.message), [])
    assert.ok(tasks.length >= 12, `${tasks.length} tasks`)
    for (const task of tasks) assert.ok(task.solution?.length || task.replay, `${task.id} has a solution`)
  })

  // A task kept from a report of a request plays its steps again: each call does what replay.json says it does now.
  for (const task of tasks.filter((candidate) => candidate.replay)) {
    test(`${task.id}: the replay does what it is kept to do`, async () => {
      const { comparison } = await playReplay(task)
      assert.equal(comparison.differs, 0, JSON.stringify(comparison.rows))
    })
  }

  for (const task of tasks.filter((candidate) => candidate.solution)) {
    test(`${task.id}: the project as it comes fails its checks, and the reference run passes them`, async (t) => {
      const missing = task.requires.filter((program) => !programs[program])
      if (missing.length) return t.skip(`needs ${missing.join(', ')}`)
      const untouched = await runTask(task, { client: createScriptedClient(idle), programs })
      assert.equal(untouched.outcome, 'failed', `${task.id} passes without any change: ${JSON.stringify(untouched.checks)}`)
      const reference = await runTask(task, { client: referenceClient(task)!, programs, settings: REFERENCE_SETTINGS })
      assert.equal(reference.outcome, 'passed', JSON.stringify(reference.checks.filter((check) => !check.passed), null, 2))
      // A reference run is the model doing everything right: no call fails, and nothing it runs is declined.
      assert.equal(reference.metrics.toolFailures, 0, JSON.stringify(reference.metrics.byTool))
      assert.equal(reference.metrics.declined, 0)
      assert.equal(reference.metrics.questions, 0)
    })
  }
})

describe('task.json', () => {
  const problems = (json: unknown): string[] => {
    try {
      parseTask(json, '/tasks/sample')
      return []
    } catch (error) {
      assert.ok(error instanceof TaskError)
      return error.problems
    }
  }

  test('a plain task reads, with its defaults', () => {
    const task = parseTask({ ...base, checks: [...base.checks, { kind: 'command', run: ['{{python}}', '-B', '{{checks}}/x.py'] }] }, '/tasks/sample')
    assert.equal(task.maxSteps, 30)
    assert.equal(task.timeoutMs, 600_000)
    assert.deepEqual(task.requires, ['python'])
    assert.deepEqual(task.allow, [])
    assert.equal(task.checks[0]!.name, 'done.txt as asked')
    assert.equal(task.debug, false)
  })

  test('a debugging task reads, with a check that the agent used the debugger', () => {
    const task = parseTask({ ...base, debug: true, checks: [...base.checks, { kind: 'used', tools: ['Debug'] }] }, '/tasks/sample')
    assert.equal(task.debug, true)
    assert.deepEqual(task.checks[1], { kind: 'used', name: 'used Debug', tools: ['Debug'] })
  })

  test('refuses what a task must not hold, and says what is wrong with each', () => {
    const cases: [unknown, RegExp][] = [
      [{ ...base, id: 'Sample' }, /id must be lower-case/],
      [{ ...base, id: 'other' }, /not the name of its folder/],
      [{ ...base, prompt: '' }, /prompt must be text/],
      [{ ...base, checks: [] }, /at least one check/],
      [{ ...base, allow: ['Bash'] }, /not a Bash rule for one program/],
      [{ ...base, allow: ['Bash(*)'] }, /not a Bash rule for one program/],
      [{ ...base, allow: ['Edit(**)'] }, /not a Bash rule for one program/],
      [{ ...base, requires: ['perl'] }, /none of node, python, lua/],
      [{ ...base, rename: { '../x': 'y' } }, /not between two paths of the project/],
      [{ ...base, maxSteps: 500 }, /maxSteps must be a whole number from 1 to 200/],
      [{ ...base, checks: [{ kind: 'command', run: ['/bin/sh', '-c', 'x'] }] }, /must start with \{\{node\}\}/],
      [{ ...base, checks: [{ kind: 'file', path: '/etc/passwd' }] }, /path must be a path inside the project/],
      [{ ...base, checks: [{ kind: 'file', path: 'a\\b.txt' }] }, /path must be a path inside the project/],
      [{ ...base, checks: [{ kind: 'search', paths: ['src/../..'], pattern: 'x', expect: 'none' }] }, /not a path inside the project/],
      [{ ...base, checks: [{ kind: 'search', paths: ['src'], pattern: '(', expect: 'none' }] }, /is not a pattern/],
      [{ ...base, checks: [{ kind: 'search', paths: ['src'], pattern: 'x', flags: 'g', expect: 'none' }] }, /flags may hold only/],
      [{ ...base, checks: [{ kind: 'reply' }] }, /needs matches or excludes/],
      [{ ...base, checks: [{ kind: 'exec' }] }, /kind must be/],
      [{ ...base, debug: 'yes' }, /debug must be true or false/],
      [{ ...base, checks: [{ kind: 'used', tools: [] }] }, /tools must name 1 to 5 tools/],
      [{ ...base, checks: [{ kind: 'used', tools: ['Debug; rm'] }] }, /tools must name 1 to 5 tools/],
    ]
    for (const [json, expected] of cases) {
      const found = problems(json)
      assert.ok(found.some((problem) => expected.test(problem)), `${JSON.stringify(json)}: ${found.join('; ')}`)
    }
  })

  test('a solution holds only what a model could send', async () => {
    const dir = await makeTask(base)
    await fs.writeFile(path.join(dir, 'solution.json'), JSON.stringify({ steps: [{ text: 'hi', outcome: { kind: 'paused' } }] }))
    await assert.rejects(readTask(dir), /may hold only text and calls/)
  })

  test('a task that cannot be read is set aside, and the others still are', async () => {
    const good = await makeTask(base)
    const root = path.dirname(good)
    await fs.mkdir(path.join(root, 'broken', 'project'), { recursive: true })
    await fs.writeFile(path.join(root, 'broken', 'task.json'), '{ not json')
    const { tasks, broken } = await readTasks(root)
    assert.deepEqual(tasks.map((task) => task.id), ['sample'])
    assert.equal(broken.length, 1)
    assert.match(broken[0]!.message, /task\.json is not JSON/)
    assert.ok(path.isAbsolute(tasks[0]!.dir))
  })
})

describe('a run', () => {
  test('declines what the task does not allow, tells a question to choose, and counts both', async () => {
    const dir = await makeTask({ ...base, allow: ['Bash(node --version)'] })
    const task = await readTask(dir)
    const client = createScriptedClient([
      { calls: [{ name: 'Bash', input: { command: 'node --version' } }] },
      { calls: [{ name: 'Bash', input: { command: 'curl https://example.com' } }] },
      { calls: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which name?', header: 'Name', multiSelect: false, options: [{ label: 'done.txt', description: 'As asked' }, { label: 'ok.txt', description: 'Shorter' }] }] } }] },
      { calls: [{ name: 'Write', input: { file_path: 'done.txt', content: 'done\n' } }] },
      { text: 'Wrote done.txt.' },
    ])
    const run = await runTask(task, { client, programs: await findPrograms([]), settings: AS_WRITTEN })
    assert.equal(run.outcome, 'passed')
    assert.equal(run.metrics.declined, 1)
    assert.equal(run.metrics.questions, 1)
    assert.deepEqual(run.changes, { added: ['done.txt'], changed: [], removed: [] })
    assert.equal(run.reply, 'Wrote done.txt.')
    assert.deepEqual(run.metrics.byTool.Bash, { calls: 2, failed: 0 })
    const sent = JSON.stringify(client.requests.at(-1)!.payload.messages)
    assert.match(sent, /it allows only these commands: `node --version`\. Do the task without this call, or with one of them\. A declined call is no reason to stop checking your work\./)
    assert.match(sent, /No one can answer during this benchmark run/)
  })

  test("gives a debugging task the folder's debugger: its starts are approved, the rest still declined (ADR 0146)", { timeout: 120_000 }, async () => {
    const checks = [...base.checks, { kind: 'used', name: 'the debugger stopped the program', tools: ['Debug'] }]
    const files = { 'count.js': 'let total = 0\nfor (const n of [1, 2, 3]) total += n\nconsole.log(total)\n' }
    const script = (): ScriptedStep[] => [
      { calls: [{ name: 'ToolSearch', input: { query: 'select:Debug' } }] },
      { calls: [{ name: 'Debug', input: { action: 'start', file: 'count.js', breakpoints: [{ file: 'count.js', line: 3 }] } }] },
      { calls: [{ name: 'Debug', input: { action: 'stop' } }] },
      { calls: [{ name: 'Bash', input: { command: 'curl https://example.com' } }] },
      { calls: [{ name: 'Write', input: { file_path: 'done.txt', content: 'done\n' } }] },
      { text: 'Wrote done.txt.' },
    ]
    const programs = await findPrograms([])
    const debugging = await readTask(await makeTask({ ...base, id: 'debugging', debug: true, checks }, files))
    const client = createScriptedClient(script())
    const run = await runTask(debugging, { client, programs, settings: AS_WRITTEN })
    assert.equal(run.outcome, 'passed', JSON.stringify(run.checks))
    assert.equal(run.metrics.declined, 1)
    assert.deepEqual(run.metrics.byTool.Debug, { calls: 2, failed: 0 })
    assert.match(JSON.stringify(client.requests[2]!.payload.messages), /paused at count\.js:3/)

    // Without it the folder has no debugger to offer, and the check says so.
    const plain = await readTask(await makeTask({ ...base, id: 'plain', checks }, files))
    const without = await runTask(plain, { client: createScriptedClient(script()), programs, settings: AS_WRITTEN })
    assert.equal(without.outcome, 'failed')
    assert.deepEqual(without.checks.at(-1), { name: 'the debugger stopped the program', kind: 'used', passed: false, detail: 'Debug did its job in no call' })
  })

  test("runs its checks without the environment's secrets, and with the folders they need", async () => {
    const dir = await makeTask(
      { ...base, checks: [{ kind: 'command', run: ['{{node}}', '{{checks}}/env.mjs'] }] },
      {},
      {
        'env.mjs': [
          "import fs from 'node:fs'",
          "if (process.env.BENCH_FAKE_API_KEY) process.exit(3)",
          "if (!fs.existsSync(process.env.BENCH_ROOT) || !fs.existsSync(process.env.BENCH_CHECKS)) process.exit(4)",
          "if (process.cwd() !== fs.realpathSync(process.env.BENCH_ROOT) && process.cwd() !== process.env.BENCH_ROOT) process.exit(5)",
        ].join('\n'),
      },
    )
    process.env.BENCH_FAKE_API_KEY = 'sk-not-a-real-key'
    try {
      const run = await runTask(await readTask(dir), { client: createScriptedClient(idle), programs: await findPrograms([]) })
      assert.equal(run.outcome, 'passed', JSON.stringify(run.checks))
    } finally {
      delete process.env.BENCH_FAKE_API_KEY
    }
  })

  test('a check whose program cannot start measures nothing: the run is an error, not a failure', async () => {
    const dir = await makeTask({ ...base, checks: [{ kind: 'command', name: 'the tests pass', run: ['{{node}}', '--version'] }] })
    const task = await readTask(dir)
    const missing = await runTask(task, { client: createScriptedClient(idle), programs: {} })
    assert.equal(missing.outcome, 'error')
    assert.match(missing.reason ?? '', /A check could not run \(the tests pass\): node is not installed here/)
    const broken = await runTask(task, { client: createScriptedClient(idle), programs: { node: [path.join(dir, 'no-such-node')] } })
    assert.equal(broken.outcome, 'error')
    assert.match(broken.reason ?? '', /could not start/)
  })

  test('a model that cannot be reached is an error, not a failure', async () => {
    const task = await readTask(await makeTask(base))
    const run = await runTask(task, { client: createScriptedClient([{ outcome: { kind: 'paused', reason: 'auth', message: 'The key was refused.' } }]), programs: await findPrograms([]) })
    assert.equal(run.outcome, 'error')
    assert.match(run.reason ?? '', /key was refused/)
  })

  test('a turn over its time is stopped and still checked; a cancelled run is not', async () => {
    const task = await readTask(await makeTask(base))
    const slow = () => createScriptedClient([{ text: 'word '.repeat(600) }], { delayMs: 20 })
    const late = await runTask(task, { client: slow(), programs: await findPrograms([]), timeoutMs: 300 })
    assert.equal(late.stopped, 'timeout')
    assert.equal(late.outcome, 'failed')
    assert.equal(late.checks.length, 1)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const cancelled = await runTask(task, { client: slow(), programs: await findPrograms([]), signal: controller.signal })
    assert.equal(cancelled.stopped, 'cancelled')
    assert.equal(cancelled.outcome, 'error')
    assert.deepEqual(cancelled.checks, [])
  })

  test('a task whose checks need a program this machine lacks is skipped', async () => {
    const task = await readTask(await makeTask({ ...base, requires: ['lua'] }))
    const run = await runTask(task, { client: createScriptedClient(idle), programs: { node: [process.execPath] } })
    assert.equal(run.outcome, 'skipped')
    assert.match(run.reason ?? '', /needs lua/)
  })

  test('leaves no folder behind, unless asked to keep it', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-work-'))
    made.push(workDir)
    const task = await readTask(await makeTask(base))
    await runTask(task, { client: createScriptedClient(idle), programs: await findPrograms([]), workDir })
    assert.deepEqual(await fs.readdir(workDir), [])
    let kept = ''
    await runTask(task, { client: createScriptedClient(idle), programs: await findPrograms([]), workDir, keep: true, onKept: (dir) => (kept = dir) })
    const left = await fs.readdir(kept)
    for (const name of ['home', 'sample', 'sessions']) assert.ok(left.includes(name), `${name} in ${left.join(', ')}`)
  })
})

describe('what a run spent', () => {
  test('counts tokens, cost and models per call, and each tool result once', async () => {
    const inner: ModelClient = {
      budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }),
      complete: async () => ({
        kind: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'openrouter', model: 'some/model', family: 'other' } },
        usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0, cost: 0.002 },
        finish: 'stop',
      }),
    }
    const client = meteredClient(inner)
    const request = (messages: CompletionRequest['payload']['messages']): CompletionRequest => ({ role: 'main', payload: { system: [], messages, tools: [] }, requirements: {}, signal: new AbortController().signal }) as unknown as CompletionRequest
    const call = { role: 'assistant' as const, content: [{ type: 'tool-use' as const, id: 't1', name: 'Read', input: {} }] }
    const result = { role: 'user' as const, content: [{ type: 'tool-result' as const, toolUseId: 't1', content: [{ type: 'text' as const, text: 'x'.repeat(120) }] }] }
    await client.complete(request([call, result]))
    await client.complete(request([call, result, { role: 'user', content: [{ type: 'text', text: 'more' }] }]))
    assert.deepEqual(client.resultChars, { Read: 120 })
    assert.equal(client.calls.length, 2)
    assert.deepEqual(client.calls[0], { role: 'main', model: 'openrouter:some/model', outcome: 'done', inputTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, cost: 0.002, ms: client.calls[0]!.ms })
  })

  test('counts a call stopped before it began as costing nothing, and one stopped later as unknown without a price (ADR 0139)', async () => {
    const inner: ModelClient = {
      budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }),
      complete: async () => {
        throw new Error('aborted')
      },
    }
    const client = meteredClient(inner)
    const request = (signal: AbortSignal) => ({ role: 'utility', payload: { system: [], messages: [], tools: [] }, requirements: {}, signal }) as unknown as CompletionRequest
    await assert.rejects(client.complete(request(AbortSignal.abort())))
    await assert.rejects(client.complete(request(new AbortController().signal)))
    assert.deepEqual(client.calls.map((call) => [call.outcome, call.cost]), [['failed', 0], ['failed', undefined]])
  })

  test('guesses what a call stopped midway cost by the listed prices, and adds the attempts given up on to a reply', async () => {
    let stopped = true
    const inner: ModelClient = {
      budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000, price: { input: 0.3, output: 1.2 } }),
      complete: async (call) => {
        call.onEvent?.({ type: 'attempt', attempt: 1, key: 'openrouter:m', provider: 'openrouter', model: 'm' })
        call.onEvent?.({ type: 'thinking', text: 'x'.repeat(3_500) })
        if (stopped) throw new Error('The Reviewer did not answer in time.')
        call.onEvent?.({ type: 'discard', reason: 'The stream ended before the reply was complete.' })
        return { kind: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 10_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 }, finish: 'stop' }
      },
    }
    const client = meteredClient(inner)
    const request = { role: 'reviewer', payload: { system: [], messages: [], tools: [] }, requirements: { promptTokens: 10_000 }, signal: new AbortController().signal } as unknown as CompletionRequest
    await assert.rejects(client.complete(request), /did not answer in time/)
    stopped = false
    await client.complete(request)
    const [late, retried] = client.calls
    assert.ok(Math.abs(late!.cost! - 0.0042) < 1e-12 && late!.unreported === late!.cost, JSON.stringify(late))
    assert.ok(Math.abs(retried!.cost! - 0.0142) < 1e-12 && Math.abs(retried!.unreported! - 0.0042) < 1e-12, JSON.stringify(retried))
  })

  test("counts a call whose agent's history was rewritten, not one that only grew, nor a summary's own", async () => {
    const inner: ModelClient = {
      budget: async () => ({ model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }),
      complete: async () => ({ kind: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, finish: 'stop' }),
    }
    const client = meteredClient(inner)
    const tools = [{ name: 'Read', description: 'Read a file', inputSchema: {} }]
    const request = (role: string, messages: CompletionRequest['payload']['messages'], agent?: string): CompletionRequest =>
      ({ role, ...(agent ? { agent } : {}), payload: { system: [], messages, tools: role === 'summarizer' ? [] : tools }, requirements: {}, signal: new AbortController().signal }) as unknown as CompletionRequest
    const text = (words: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: words }] })
    await client.complete(request('main', [text('a')]))
    await client.complete(request('main', [text('a'), text('b')]))
    await client.complete(request('main', [text('a'), text('b')]))
    await client.complete(request('explore', [text('x')], 'explore-1'))
    await client.complete(request('summarizer', [text('summarize a and b')]))
    await client.complete(request('summarizer', [text('summarize more')]))
    await client.complete(request('main', [text('summary of a'), text('b'), text('c')]))
    await client.complete(request('explore', [text('x'), text('y')], 'explore-1'))
    assert.deepEqual(client.calls.map((call) => call.rewrote ?? false), [false, false, false, false, false, false, true, false])
  })
})

describe('reports', () => {
  const run = (task: string, outcome: TaskRun['outcome'], metrics: Partial<TaskRun['metrics']> = {}): TaskRun => ({
    task,
    attempt: 1,
    outcome,
    checks: outcome === 'failed' ? [{ name: 'the tests pass', kind: 'command', passed: false, detail: 'exit code 1\n2 failing' }] : [],
    changes: { added: [], changed: [], removed: [] },
    reply: '',
    calls: [],
    tools: [],
    metrics: {
      requests: 4, byRole: { main: 4 }, inputTokens: 10_000, cachedTokens: 6_000, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0, rewrites: 0, summaries: 0, cost: 0.01, costReported: 4, models: ['x:y'],
      toolCalls: 5, toolFailures: 0, commandFailures: 0, byTool: {}, editMisses: 0, readChars: 2_000, toolChars: 3_000, declined: 0, questions: 0, durationMs: 4_000, ...metrics,
    },
  })
  const report = (model: string, runs: TaskRun[]): BenchReport => ({ kind: 'encode-bench', version: 1, model, startedAt: '2026-10-24T00:00:00.000Z', platform: 'linux', runs })

  test('sums up each task and the whole, leaving out what could not be measured', () => {
    const { tasks, all } = summarize(report('m', [run('a', 'passed'), run('a', 'failed', { inputTokens: 20_000 }), run('b', 'error'), run('c', 'skipped')]))
    assert.deepEqual(tasks.map((summary) => [summary.task, summary.passed, summary.failed, summary.errors, summary.skipped]), [['a', 1, 1, 0, 0], ['b', 0, 0, 1, 0], ['c', 0, 0, 0, 1]])
    assert.equal(tasks[0]!.passRate, 0.5)
    assert.equal(tasks[0]!.mean.inputTokens, 15_000)
    assert.equal(all.passRate, 0.5)
    assert.equal(all.cost, 0.02)
    assert.equal(all.costPerSolved, 0.02)
  })

  test('says no cost when a call did not report one', () => {
    const { all } = summarize(report('m', [run('a', 'passed', { costReported: 3 })]))
    assert.equal(all.cost, undefined)
  })

  test('lists the declined calls and the failed commands, the most frequent first', () => {
    const tools = (calls: TaskRun['tools']) => ({ ...run('a', 'passed'), tools: calls })
    const text = formatReport(
      report('m', [
        tools([
          { tool: 'Bash', ok: false, declined: true, input: 'npx jest test/a.test.js', output: 'Declined: the task allows only node --test.' },
          { tool: 'Bash', ok: false, input: 'node --test test/', output: "Error: Cannot find module '/p/test'" },
          { tool: 'Read', ok: true },
        ]),
        tools([
          { tool: 'Bash', ok: false, declined: true, input: 'npx  jest test/b.test.js' },
          { tool: 'Bash', ok: false, declined: true, byEncode: true, input: 'npm run lint' },
          { tool: 'Edit', ok: false, input: '{"file_path":"a.js"}' },
        ]),
      ]),
    )
    assert.match(text, /^Declined: 3, the most frequent first\n  1× Bash: npx jest test\/a\.test\.js\n  1× Bash: npx jest test\/b\.test\.js\n  1× eNCode Bash: npm run lint$/m)
    assert.match(text, /^Failed commands: 1, the most frequent first\n  1× Bash: node --test test\/$/m)
    assert.doesNotMatch(text, /Edit:/, 'only commands are listed among the failures')
    assert.doesNotMatch(formatReport(report('m', [run('a', 'passed')])), /Declined:|Failed commands:/)
  })

  test("says how the Reviewer's calls went: how many failed, and the median time and reasoning of the rest (ADR 0142)", () => {
    const reviewer = (ms: number, reasoningTokens: number, outcome: ModelCall['outcome'] = 'done'): ModelCall => ({ role: 'reviewer', outcome, inputTokens: 1_400, cachedTokens: 640, cacheWriteTokens: 0, outputTokens: reasoningTokens + 100, reasoningTokens, ms })
    const calls = (list: ModelCall[]) => ({ ...run('a', 'passed'), calls: list })
    const slow = report('m', [calls([reviewer(40_000, 2_000), reviewer(240_000, 0, 'failed')]), calls([reviewer(98_900, 4_067), reviewer(7_460, 317)])])
    assert.match(formatReport(slow), /^Reviewer: 4 calls, 1 failed, a median of 40 s and 2,000 reasoning tokens for those that answered$/m)
    const quick = report('m', [calls([reviewer(9_000, 300)])])
    assert.match(compareReports(slow, quick).text, /^Reviewer: 4 calls, 1 failed, a median of 40 s .* → 1 call, 0 failed, a median of 9 s and 300 reasoning tokens for those that answered$/m)
    assert.match(compareReports(slow, report('m', [run('a', 'passed')])).text, /→ no calls$/m)
    assert.doesNotMatch(formatReport(report('m', [run('a', 'passed')])), /Reviewer:/)
  })

  test('says how much of the cost is guessed for calls stopped midway', () => {
    assert.match(formatReport(report('m', [run('a', 'passed', { unreportedCost: 0.004 }), run('b', 'passed')])), /^Of the \$0\.020, \$0\.0040 is guessed: calls that failed or were stopped midway, which no provider reports$/m)
    assert.doesNotMatch(formatReport(report('m', [run('a', 'passed')])), /is guessed/)
  })

  test('prints a table and why each run that did not pass did not', () => {
    const text = formatReport(report('openrouter:some/model', [run('a', 'passed'), run('b', 'failed')]))
    assert.match(text, /^openrouter:some\/model, 2026-10-24/)
    assert.match(text, /\ba\s+1\/1\s+1\/1\s+4\s+10,000\s+60%/)
    assert.match(text, /b #1 failed: the tests pass: exit code 1$/m)
  })

  test('says how many tasks passed on every run, and where the tokens went', () => {
    const text = formatReport(report('m', [run('a', 'passed', { cacheWriteTokens: 1_000, reasoningTokens: 200 }), run('a', 'failed'), run('b', 'passed'), run('b', 'passed')]))
    assert.match(text, /Tasks that passed on every run: 1 of 2 \(pass\^2\)/)
    assert.match(text, /Too few runs to tell a change from noise/)
    assert.match(text, /Tokens per run: 10,000 read, 4,000 of them not from the cache, 250 written to it; 500 written, 50 of them reasoning/)
  })

  test('reads a report written before cache writes were counted', () => {
    const old = report('m', [run('a', 'passed')])
    delete (old.runs[0]!.metrics as Partial<TaskRun['metrics']>).cacheWriteTokens
    const { all } = summarize(parseReport(JSON.parse(JSON.stringify(old))))
    assert.equal(all.mean.cacheWriteTokens, 0)
  })

  /** `passes` of `runs` runs of a task, each costing `cost`. */
  const runs = (task: string, passes: number, total: number, cost = 0.01) => Array.from({ length: total }, (_, index) => run(task, index < passes ? 'passed' : 'failed', { cost }))
  const tasks = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']

  test('with five runs a task, flags only a drop beyond chance', () => {
    const before = report('before', tasks.flatMap((task) => runs(task, 5, 5)))
    const afterward = report('after', [...runs('t1', 1, 5), ...runs('t2', 4, 5), ...tasks.slice(2).flatMap((task) => runs(task, 5, 5))])
    const comparison = compareReports(before, afterward)
    assert.equal(comparison.enoughRuns, true)
    assert.deepEqual(comparison.regressions, ['t1'], 'five of five to four of five is noise; to one of five is not')
    assert.ok(comparison.passChange!.low < 0 && comparison.passChange!.high > 0, 'one task in eight does not move the whole beyond its interval')
    assert.match(comparison.text, /Pass rate: -12\.5 points \(95% interval -36\.0 to \+11\.0, 8 tasks\)/)
    assert.match(comparison.text, /Passed less often, beyond chance: t1/)
    assert.doesNotMatch(comparison.text, /Too few runs/)
  })

  test('flags the whole when every task slips', () => {
    const before = report('before', tasks.flatMap((task) => runs(task, 5, 5)))
    const afterward = report('after', tasks.flatMap((task) => runs(task, 3, 5)))
    const comparison = compareReports(before, afterward)
    assert.deepEqual(comparison.regressions, ['all'], 'no task alone is beyond chance, all of them together are')
    assert.ok(comparison.passEveryChange!.high < 0)
  })

  test('keeps a change by the gate only when it is 25% cheaper per task solved and costs nothing in accuracy', () => {
    const before = report('before', tasks.flatMap((task) => runs(task, 5, 5, 0.02)))
    const cheaper = report('after', tasks.flatMap((task, index) => runs(task, 5, 5, index % 2 ? 0.014 : 0.013)))
    const kept = gate(compareReports(before, cheaper), 0.25)
    assert.deepEqual(kept, { passed: true, reasons: [] })
    const comparison = compareReports(before, cheaper)
    assert.match(comparison.text, /Cost per run: -33% \(95% interval -35% to -30%, 8 tasks\)/)
    assert.match(comparison.text, /Cost per task solved: \$0\.020 → \$0\.014 \(-32%\)/)

    const notEnough = report('after', tasks.flatMap((task) => runs(task, 5, 5, 0.017)))
    assert.deepEqual(gate(compareReports(before, notEnough), 0.25).reasons, ['The cost per task solved fell 15%, short of 25%.'])
    const worse = report('after', [...runs('t1', 0, 5, 0.01), ...tasks.slice(1).flatMap((task) => runs(task, 5, 5, 0.01))])
    assert.deepEqual(gate(compareReports(before, worse), 0.25).reasons, ['Passed less often: t1.'])
    const once = report('after', tasks.map((task) => run(task, 'passed', { cost: 0.01 })))
    assert.match(gate(compareReports(before, once), 0.25).reasons[0]!, /3 runs or more/)
  })

  test('compares before and after, and names the tasks that passed less often', () => {
    const before = report('before', [run('a', 'passed'), run('b', 'passed'), run('gone', 'passed')])
    const afterward = report('after', [run('a', 'passed', { inputTokens: 5_000 }), run('b', 'failed'), run('new', 'passed')])
    const { text, regressions } = compareReports(before, afterward)
    assert.deepEqual(regressions, ['b', 'all'])
    assert.match(text, /\ba\s+100% → 100%\s+yes → yes\s+=\s+-50%/)
    assert.doesNotMatch(text, /95% interval/, 'one run a task gives no interval worth printing')
    assert.match(text, /Too few runs to tell a change from noise: every drop counts/)
    assert.match(text, /Only before: gone/)
    assert.match(text, /Only after: new/)
  })

  test('reads back only a benchmark report', () => {
    const written = report('m', [run('a', 'passed')])
    assert.deepEqual(parseReport(JSON.parse(JSON.stringify(written))), written)
    assert.throws(() => parseReport({ kind: 'other' }), /not a benchmark report/)
    assert.throws(() => parseReport({ ...written, version: 2 }), /version 2/)
    assert.throws(() => parseReport({ ...written, runs: [{ task: 'a', outcome: 'passed', metrics: {} }] }), /has no requests/)
  })

  test('runs a set of tasks with their reference runs into one report', async () => {
    const task = await readTask(await makeTask(base))
    const solved = await readTask(await makeTask({ ...base, id: 'solved' }))
    solved.solution = [{ calls: [{ name: 'Write', input: { file_path: 'done.txt', content: 'done\n' } }] }]
    const seen: string[] = []
    const result = await runBench([task, solved], { client: 'reference', model: 'reference', repeat: 2, onRun: (done) => seen.push(`${done.task}#${done.attempt} ${done.outcome}`) })
    // Round by round: every task once, then every task again.
    assert.deepEqual(seen, ['sample#1 skipped', 'solved#1 passed', 'sample#2 skipped', 'solved#2 passed'])
    assert.equal(result.model, 'reference')
    assert.equal(parseReport(JSON.parse(JSON.stringify(result))).runs.length, 4)
  })
})

describe('a bench that stops at its cap, and a pair of setups (ADR 0137)', () => {
  /** Writes done.txt, then says so: two calls a run, each billed at `cost`. */
  const writer = (cost: number) =>
    createScriptedClient((request) => (request.payload.messages.some((message) => message.content.some((block) => block.type === 'tool-result')) ? { text: 'Done.' } : { calls: [{ name: 'Write', input: { file_path: 'done.txt', content: 'done\n' } }] }), { costPerCall: cost })
  const tasks = async () => [await readTask(await makeTask(base)), await readTask(await makeTask({ ...base, id: 'other' }))]

  test('stops the run whose next call could pass the cap, and makes no other', async () => {
    const seen: string[] = []
    const report = await runBench(await tasks(), { client: writer(0.1), model: 'm', repeat: 3, settings: REFERENCE_SETTINGS, cap: spendingCap(0.35), onRun: (done) => seen.push(`${done.task}#${done.attempt} ${done.outcome}`) })
    assert.deepEqual(seen, ['sample#1 passed', 'other#1 error'])
    assert.match(report.runs[1]!.reason ?? '', /^The benchmark stopped: it reached its spending cap \(\$0\.30 of \$0\.35 spent; the next call could cost \$0\.10\)\.$/)
    assert.deepEqual(report.spending, { limit: 0.35, spent: 0.30000000000000004 })
    assert.match(report.endedEarly ?? '', /spending cap/)
    assert.match(formatReport(report), /^Spent \$0\.300 of the \$0\.350 cap$/m)
  })

  test('hands over the reports so far after every run, marked partial, with what was spent (ADR 0139)', async () => {
    const saved: BenchReport[][] = []
    const report = await runBench(await tasks(), { client: writer(0.1), model: 'm', repeat: 1, settings: REFERENCE_SETTINGS, cap: spendingCap(1), onProgress: (reports) => void saved.push([...reports]) })
    assert.deepEqual(saved.map(([first]) => [first!.partial, first!.runs.length, Math.round(first!.spending!.spent * 100)]), [[true, 1, 20], [true, 2, 40]])
    assert.equal(report.partial, undefined, 'the whole report, at the end')
    assert.equal(report.runs.length, 2)
    assert.equal(saved[0]![0]!.runs.length, 1, 'a snapshot, not the report the bench goes on writing to')
    assert.match(formatReport(saved[0]![0]!), /^Partial: written while the bench went on, which then did not finish\.$/m)
  })

  test('starts a round only when what is left pays for one like the last', async () => {
    const report = await runBench(await tasks(), { client: writer(0.1), model: 'm', repeat: 5, settings: REFERENCE_SETTINGS, cap: spendingCap(1) })
    // A round costs $0.40: two rounds leave $0.20.
    assert.deepEqual(report.runs.map((done) => `${done.task}#${done.attempt} ${done.outcome}`), ['sample#1 passed', 'other#1 passed', 'sample#2 passed', 'other#2 passed'])
    assert.equal(report.endedEarly, 'round 3 would cost about $0.40, and $0.20 of the spending cap is left')
  })

  test('runs every task both ways, taking turns to go first, and ends when told', async () => {
    const seen: string[] = []
    const rounds: boolean[] = []
    const [plainReport, lightReport] = await runPair(
      await tasks(),
      {
        client: writer(0.01),
        model: 'm',
        repeat: 3,
        settings: { ...REFERENCE_SETTINGS, reasoning: 'high' },
        onRun: (done, _task, setup) => seen.push(`${done.task}#${done.attempt}:${setup}`),
        stopIf: (_reports, round, roundDone) => {
          if (roundDone) rounds.push(true)
          return round === 2 && roundDone ? 'enough' : undefined
        },
      },
      { lightSteps: true },
    )
    assert.deepEqual(seen, ['sample#1:0', 'sample#1:1', 'other#1:0', 'other#1:1', 'sample#2:1', 'sample#2:0', 'other#2:1', 'other#2:0'])
    assert.equal(rounds.length, 2)
    assert.equal(plainReport.lightSteps, undefined)
    assert.equal(lightReport.lightSteps, true)
    assert.equal(lightReport.effort, 'high')
    assert.equal(plainReport.endedEarly, 'enough')
    assert.equal(lightReport.runs.length, 4)
  })
})

describe('telling a change from noise', () => {
  test("uses Student's t for few tasks and the normal point past thirty", () => {
    assert.equal(t95(1), 12.706)
    assert.equal(t95(7), 2.365)
    assert.equal(t95(31), 1.96)
  })

  test('gives a mean and its 95% interval, and nothing for one value', () => {
    assert.equal(meanInterval([0.2]), undefined)
    const same = meanInterval([0.5, 0.5, 0.5])!
    assert.deepEqual([same.low, same.mean, same.high], [0.5, 0.5, 0.5])
    const spread = meanInterval([-1, 0, 0, 0, 0, 0, 0, 0])!
    assert.equal(spread.mean, -0.125)
    assert.ok(Math.abs(spread.high - (-0.125 + 2.365 * Math.sqrt(0.125 / 8))) < 1e-9)
  })

  test('averages ratios on their logarithms, leaving out what is not a ratio', () => {
    const halves = ratioInterval([0.5, 0.5, 0, Number.NaN])!
    assert.equal(halves.n, 2)
    assert.ok(Math.abs(halves.mean - 0.5) < 1e-12)
    assert.ok(Math.abs(ratioInterval([0.25, 4])!.mean - 1) < 1e-12, 'a quarter and four times cancel out')
  })

  test("gives Fisher's chance of a drop at least this large", () => {
    assert.ok(Math.abs(dropChance(5, 5, 1, 5) - 5 / 210) < 1e-12)
    assert.ok(Math.abs(dropChance(5, 5, 2, 5) - 10 / 120) < 1e-12)
    assert.equal(dropChance(5, 5, 5, 5), 1)
    assert.equal(dropChance(0, 5, 0, 5), 1)
  })
})

describe('the command line', () => {
  const cli = async (argv: string[], extra: { env?: NodeJS.ProcessEnv; client?: ModelClient } = {}) => {
    const lines: string[] = []
    const code = await main(argv, { root: process.cwd(), env: extra.env ?? {}, print: (text) => lines.push(text), ...(extra.client ? { client: extra.client } : {}), now: () => new Date('2026-10-24T01:02:03Z') })
    return { code, text: lines.join('\n') }
  }

  test('runs tasks into a report it can show and compare', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cli-'))
    made.push(dir)
    const before = path.join(dir, 'before.json')
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit,crlf-preserve', '--out', before])
    assert.equal(ran.code, 0, ran.text)
    assert.match(ran.text, /^✓ json-config-edit #1 /m)
    assert.match(ran.text, /^all\s+2\/2/m)
    const after = path.join(dir, 'after.json')
    const idled = await cli(['run', '--model', 'idle', '--only', 'json-config-edit', '--out', after], { client: createScriptedClient(idle) })
    assert.equal(idled.code, 1)
    assert.match(idled.text, /^✗ json-config-edit #1 .*: the flags are as asked/m)
    assert.match((await cli(['show', after])).text, /^idle, 2026-10-24T01:02:03\.000Z/)
    const compared = await cli(['compare', before, after, '--fail-on-regression'])
    assert.equal(compared.code, 1)
    assert.match(compared.text, /Passed less often: json-config-edit, all/)
    assert.equal((await cli(['compare', before, after])).code, 0)
    const gated = await cli(['compare', before, after, '--gate', '25'])
    assert.equal(gated.code, 1)
    assert.match(gated.text, /Gate not passed:\n- Each task needs 3 runs or more in both reports\.\n- Passed less often: json-config-edit, all\./)
    assert.match((await cli(['compare', before, after, '--gate', '95'])).text, /--gate is a whole number from 1 to 90/)
  })

  test('holds every run to a squeezed window when asked, and says so', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cli-'))
    made.push(dir)
    const out = path.join(dir, 'squeezed.json')
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit', '--window', '16000', '--out', out])
    assert.equal(ran.code, 0, ran.text)
    assert.match(ran.text, /^1 task, on reference, in a 16k window$/m)
    assert.match(ran.text, /^reference in a 16k window, /m)
    assert.match(ran.text, /^Context per run: 0 rewrites/m)
    assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).window, 16_000)
    assert.match((await cli(['run', '--reference', '--window', '4000'])).text, /--window is a whole number from 12000 to 1000000/)
  })

  test('asks every step for an effort, and steps that read results for low, when asked (ADR 0135)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cli-'))
    made.push(dir)
    const out = path.join(dir, 'light.json')
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit', '--effort', 'high', '--light-steps', '--out', out])
    assert.equal(ran.code, 0, ran.text)
    assert.match(ran.text, /^1 task, on reference, at high effort, with light steps$/m)
    assert.match(ran.text, /^reference at high effort with light steps, /m)
    const report = JSON.parse(await fs.readFile(out, 'utf8'))
    assert.equal(report.effort, 'high')
    assert.equal(report.lightSteps, true)
    assert.match((await cli(['run', '--reference', '--effort', 'huge'])).text, /--effort is one of low, medium, high, xhigh, max/)
  })

  test('runs a pair into two reports and their comparison, under a cap (ADR 0137)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cli-'))
    made.push(dir)
    const out = path.join(dir, 'pair.json')
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit', '--repeat', '2', '--pair', 'light-steps', '--max-cost', '2.90', '--out', out])
    assert.equal(ran.code, 0, ran.text)
    assert.match(ran.text, /^1 task, 2 runs each, on reference, with and without light-steps, stopping at \$2\.90$/m)
    assert.match(ran.text, /^Round 2 of 2$/m)
    assert.match(ran.text, /^✓ json-config-edit #1 light-off .*\[\$0\.00 of \$2\.90\]$/m)
    assert.match(ran.text, /^✓ json-config-edit #2 light-on /m)
    assert.match(ran.text, /^reference \(.*\) → reference with light steps \(/m)
    assert.match(ran.text, /^Spent \$0\.00 of the \$2\.90 cap$/m)
    const off = JSON.parse(await fs.readFile(path.join(dir, 'pair-light-off.json'), 'utf8'))
    const on = JSON.parse(await fs.readFile(path.join(dir, 'pair-light-on.json'), 'utf8'))
    assert.equal(off.lightSteps, undefined)
    assert.equal(on.lightSteps, true)
    assert.deepEqual(on.spending, { limit: 2.9, spent: 0 })
    assert.equal(off.partial, undefined, 'written in full at the end')
    assert.deepEqual((await fs.readdir(dir)).sort(), ['pair-light-off.json', 'pair-light-on.json'], 'and nothing half-written left beside it')
  })

  test('runs a pair without and with the notes for the model family (ADR 0142)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cli-'))
    made.push(dir)
    const out = path.join(dir, 'notes.json')
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit', '--pair', 'model-notes', '--light-steps', '--out', out])
    assert.equal(ran.code, 0, ran.text)
    assert.match(ran.text, /^1 task, on reference, with light steps, with and without model-notes$/m)
    assert.match(ran.text, /^✓ json-config-edit #1 notes-off /m)
    assert.match(ran.text, /^✓ json-config-edit #1 notes-on /m)
    assert.match(ran.text, /^reference with light steps without model notes \(.*\) → reference with light steps \(/m)
    const off = JSON.parse(await fs.readFile(path.join(dir, 'notes-notes-off.json'), 'utf8'))
    const on = JSON.parse(await fs.readFile(path.join(dir, 'notes-notes-on.json'), 'utf8'))
    assert.deepEqual([off.modelNotes, off.lightSteps], ['off', true])
    assert.deepEqual([on.modelNotes, on.lightSteps], [undefined, true], 'light steps in both, as asked')
  })

  test('ends a pair whose light steps never happen', async () => {
    const ran = await cli(['run', '--reference', '--only', 'json-config-edit,crlf-preserve', '--repeat', '3', '--pair', 'light-steps', '--out', path.join(os.tmpdir(), `bench-never-${process.pid}.json`)])
    assert.match(ran.text, /^Ended early: no step was light in the runs with light steps/m)
    assert.doesNotMatch(ran.text, /^Round 2/m)
  })

  test('refuses a cap, a pair or a gate it cannot keep', async () => {
    assert.match((await cli(['run', '--reference', '--max-cost', '0'])).text, /--max-cost is a number of dollars above 0, such as 2\.90/)
    assert.match((await cli(['run', '--reference', '--max-cost', 'lots'])).text, /--max-cost is a number of dollars/)
    assert.match((await cli(['run', '--reference', '--pair', 'window'])).text, /--pair is one of light-steps, model-notes/)
    assert.match((await cli(['run', '--reference', '--pair', 'light-steps', '--light-steps'])).text, /leave out --light-steps/)
    assert.match((await cli(['run', '--reference', '--gate', '25'])).text, /--gate goes with compare, or with run --pair/)
  })

  test('wants a key for a model, from the environment, and says which', async () => {
    const missing = await cli(['run', '--model', 'openrouter:qwen/qwen3-coder', '--only', 'json-config-edit'])
    assert.equal(missing.code, 2)
    assert.match(missing.text, /Set OPENROUTER_API_KEY to run openrouter:qwen\/qwen3-coder/)
    assert.match((await cli(['run', '--model', 'nonsense'])).text, /--model is openrouter:<id>/)
    assert.match((await cli(['run', '--reference', '--model', 'x'])).text, /give --model <model> or --reference/)
    assert.match((await cli(['run', '--reference', '--only', 'no-such-task'])).text, /no task no-such-task/)
    assert.match((await cli(['run', '--base-url', 'file:///x', '--model', 'm'])).text, /must be an http or https address/)
    assert.match((await cli(['run', '--reference', '--repeat', '0'])).text, /--repeat is a whole number from 1 to 20/)
    assert.match((await cli(['run', '--reference', '--out', ''])).text, /--out needs a value/, 'an empty path is not the folder it runs in')
  })

  test('prints what a run wrote as plain text', () => {
    assert.equal(plain(`ok\u001b[2J\u202eevil\tdone\n`), 'ok?[2J?evil\tdone\n')
  })
})
