import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseHooksConfig } from './config'
import { createCommandHooks, type HookEvent } from './hooks'
import { loadHookGroups } from './index'
import { createProcessRunner, type HookRun, type HookRunner } from './runner'

const BASE: HookEvent = { sessionId: 's1', agentId: 'main', root: '/ws', mode: 'code' }
const TOOL = { ...BASE, tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } }

/** A runner that answers by command, and records what each command was given. */
function fakeRunner(answers: Record<string, Partial<HookRun> | ((stdin: string) => Partial<HookRun>)>) {
  const calls: Array<{ command: string; stdin: Record<string, unknown>; env: Record<string, string> }> = []
  const runner: HookRunner = async (command, options) => {
    calls.push({ command, stdin: JSON.parse(options.stdin), env: options.env })
    const answer = answers[command]
    const result = typeof answer === 'function' ? answer(options.stdin) : answer
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result }
  }
  return { runner, calls }
}

function hooksFor(config: unknown, answers: Parameters<typeof fakeRunner>[0]) {
  const { groups, problems } = loadHookGroups([{ scope: 'user', config }])
  assert.deepEqual(problems, [])
  const { runner, calls } = fakeRunner(answers)
  const notices: string[] = []
  const hooks = createCommandHooks(groups, { env: { PATH: '/bin' }, runner, notice: (text) => notices.push(text) })
  return { hooks, calls, notices }
}

describe('hook configuration', () => {
  it('reads Claude Code hook settings and reports what it skips', () => {
    const { groups, problems } = parseHooksConfig(
      {
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: './check.sh', timeout: 5 }] },
          { matcher: '(', hooks: [{ type: 'command', command: 'x' }] },
          { matcher: '*', hooks: [{ type: 'prompt', prompt: 'x' }, { type: 'command', command: '' }, { type: 'command', command: 'y', timeout: -1 }] },
        ],
        Stop: [{ matcher: 'ignored(', hooks: [{ type: 'command', command: 'npm test', timeout: 9999 }] }],
        Unknown: [],
        PostToolUse: 'nope',
      },
      'project',
    )
    assert.equal(groups.length, 2)
    assert.equal(groups[0].matcher.test('Edit'), true)
    assert.equal(groups[0].matcher.test('MultiEdit'), false)
    assert.deepEqual(groups[0].hooks, [{ command: './check.sh', timeout: 5 }])
    assert.equal(groups[1].event, 'Stop')
    assert.equal(groups[1].hooks[0].timeout, 600)
    assert.equal(problems.length, 6)
    assert.match(problems.join('\n'), /not a valid regular expression/)
    assert.match(problems.join('\n'), /other hook types are not supported/)
    assert.match(problems.join('\n'), /Unknown is not an event/)
  })
})

describe('command hooks', () => {
  it("passes Claude Code's input on stdin and the project directory in the environment", async () => {
    const { hooks, calls } = hooksFor({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] }, { guard: {} })
    await hooks.preToolUse(TOOL)
    assert.deepEqual(calls[0].stdin, {
      session_id: 's1',
      transcript_path: null,
      cwd: '/ws',
      hook_event_name: 'PreToolUse',
      permission_mode: 'code',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 't1',
    })
    assert.equal(calls[0].env.CLAUDE_PROJECT_DIR, '/ws')
    assert.equal(calls[0].env.ENCODE_PROJECT_DIR, '/ws')
    assert.equal(calls[0].env.PATH, '/bin')
  })

  it('runs only hooks whose matcher accepts the tool, each command once', async () => {
    const { hooks, calls } = hooksFor(
      {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'edit-only' }] },
          { hooks: [{ type: 'command', command: 'all' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'all' }] },
        ],
      },
      {},
    )
    await hooks.preToolUse(TOOL)
    assert.deepEqual(calls.map((call) => call.command), ['all'])
  })

  it('denies a call on exit 2, with stderr as the reason', async () => {
    const { hooks } = hooksFor({ PreToolUse: [{ hooks: [{ type: 'command', command: 'guard' }] }] }, { guard: { exitCode: 2, stderr: 'no rm here\n' } })
    assert.deepEqual(await hooks.preToolUse(TOOL), { decision: 'deny', reason: 'no rm here' })
  })

  it('reads permission decisions and changed input from JSON', async () => {
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'safe' } })
    const ask = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'check this' } })
    const rewrite = JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'ls -la' } } })
    const legacy = JSON.stringify({ decision: 'block', reason: 'old style' })
    const config = (command: string) => ({ PreToolUse: [{ hooks: [{ type: 'command', command }] }] })
    assert.deepEqual(await hooksFor(config('a'), { a: { stdout: allow } }).hooks.preToolUse(TOOL), { decision: 'allow', reason: 'safe' })
    assert.deepEqual(await hooksFor(config('a'), { a: { stdout: ask } }).hooks.preToolUse(TOOL), { decision: 'ask', reason: 'check this' })
    assert.deepEqual(await hooksFor(config('a'), { a: { stdout: rewrite } }).hooks.preToolUse(TOOL), { input: { command: 'ls -la' } })
    assert.deepEqual(await hooksFor(config('a'), { a: { stdout: legacy } }).hooks.preToolUse(TOOL), { decision: 'deny', reason: 'old style' })
    assert.deepEqual(await hooksFor(config('a'), { a: { stdout: '{"continue": false, "stopReason": "halt"}' } }).hooks.preToolUse(TOOL), {
      decision: 'deny',
      reason: 'halt',
    })
  })

  it('combines several answers as deny, then ask, then allow', async () => {
    const two = { PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] }
    const allow = { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) }
    const ask = { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'hmm' } }) }
    assert.equal((await hooksFor(two, { a: allow, b: { exitCode: 2, stderr: 'no' } }).hooks.preToolUse(TOOL)).decision, 'deny')
    assert.deepEqual(await hooksFor(two, { a: allow, b: ask }).hooks.preToolUse(TOOL), { decision: 'ask', reason: 'hmm' })
    const one = { stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'a' } } }) }
    const other = { stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'b' } } }) }
    const conflict = await hooksFor(two, { a: one, b: other }).hooks.preToolUse(TOOL)
    assert.equal(conflict.decision, 'ask')
    assert.deepEqual(conflict.input, { command: 'a' })
  })

  it('denies when a PreToolUse hook cannot run or times out, and only reports other failures', async () => {
    const pre = (command: string) => ({ PreToolUse: [{ hooks: [{ type: 'command', command }] }] })
    const timedOut = hooksFor(pre('slow'), { slow: { timedOut: true, exitCode: null } })
    assert.equal((await timedOut.hooks.preToolUse(TOOL)).decision, 'deny')
    assert.match(timedOut.notices[0], /did not finish in time/)
    const broken = hooksFor(pre('x'), { x: { error: 'ENOENT', exitCode: null } })
    assert.equal((await broken.hooks.preToolUse(TOOL)).decision, 'deny')
    const failing = hooksFor(pre('x'), { x: { exitCode: 1, stderr: 'oops' } })
    assert.deepEqual(await failing.hooks.preToolUse(TOOL), {})
    assert.match(failing.notices[0], /failed \(exit 1\): oops/)
    const post = hooksFor({ PostToolUse: [{ hooks: [{ type: 'command', command: 'slow' }] }] }, { slow: { timedOut: true, exitCode: null } })
    assert.deepEqual(await post.hooks.postToolUse({ ...TOOL, ok: true, output: 'x' }), {})
  })

  it('adds context and refuses prompts', async () => {
    const prompt = (answer: Partial<HookRun>) =>
      hooksFor({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'p' }] }] }, { p: answer }).hooks.userPromptSubmit({
        ...BASE,
        messageId: 'm1',
        prompt: 'hello',
      })
    assert.deepEqual(await prompt({ stdout: 'Today is Tuesday.\n' }), { context: 'Today is Tuesday.' })
    assert.deepEqual(await prompt({ exitCode: 2, stderr: 'no secrets in prompts' }), { block: 'no secrets in prompts' })
    assert.deepEqual(await prompt({ stdout: '{"decision":"block","reason":"policy"}' }), { block: 'policy' })
    assert.deepEqual(await prompt({ stdout: '{"hookSpecificOutput":{"additionalContext":"ctx"}}' }), { context: 'ctx' })
    const long = await prompt({ stdout: 'x'.repeat(20_000) })
    assert.ok(long.context!.length < 10_100)
  })

  it('sends the agent back from Stop at most three times in a row', async () => {
    const { hooks, calls, notices } = hooksFor({ Stop: [{ hooks: [{ type: 'command', command: 'tests' }] }] }, { tests: { exitCode: 2, stderr: 'tests fail' } })
    const stop = (continued: boolean) => hooks.beforeStop({ ...BASE, lastMessage: 'done', continued })
    assert.deepEqual(await stop(false), { continue: 'tests fail' })
    assert.deepEqual(await stop(true), { continue: 'tests fail' })
    assert.deepEqual(await stop(true), { continue: 'tests fail' })
    assert.deepEqual(await stop(true), {})
    assert.match(notices[0], /3 times in a row/)
    assert.equal(calls[1].stdin.stop_hook_active, true)
    assert.deepEqual(await stop(false), { continue: 'tests fail' })
    // A subagent's stop runs SubagentStop hooks instead.
    assert.deepEqual(await hooks.beforeStop({ ...BASE, agentId: 'sub1', lastMessage: '', continued: false }), {})
  })

  it('matches SessionStart sources and PreCompact triggers', async () => {
    const { hooks, calls } = hooksFor(
      {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'fresh' }] }],
        PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'keep' }] }],
      },
      { fresh: { stdout: 'branch: main' }, keep: { stdout: '{"hookSpecificOutput":{"additionalContext":"keep the plan"}}' } },
    )
    assert.deepEqual(await hooks.sessionStart({ ...BASE, source: 'new' }), { context: 'branch: main' })
    assert.deepEqual(await hooks.sessionStart({ ...BASE, source: 'resume' }), {})
    assert.deepEqual(await hooks.preCompact({ ...BASE, trigger: 'manual' }), { instructions: 'keep the plan' })
    assert.deepEqual(await hooks.preCompact({ ...BASE, trigger: 'auto' }), {})
    assert.equal(calls[0].stdin.source, 'startup')
  })
})

describe('process runner', () => {
  // Node is the "shell" here, so the commands are JavaScript and the test runs the same on every platform.
  const run = createProcessRunner({ file: process.execPath, args: (command) => ['-e', command] })
  const options = { stdin: '{"a":1}', env: { ...process.env } as Record<string, string>, cwd: process.cwd(), timeoutMs: 10_000 }

  it('feeds stdin and collects stdout, stderr and the exit code', async () => {
    const result = await run(
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('got '+JSON.parse(s).a);process.stderr.write('err');process.exit(2)})",
      options,
    )
    assert.deepEqual(result, { exitCode: 2, stdout: 'got 1', stderr: 'err', timedOut: false })
  })

  it('does not fail when the command ignores stdin', async () => {
    const result = await run("process.stdout.write('ok')", { ...options, stdin: 'x'.repeat(1_000_000) })
    assert.equal(result.stdout, 'ok')
    assert.equal(result.exitCode, 0)
  })

  it('stops a command that runs too long, with the processes it started', async () => {
    const started = Date.now()
    const result = await run(
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>{},60000)",
      { ...options, timeoutMs: 1500 },
    )
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.ok(Date.now() - started < 15_000)
    const child = Number(result.stdout.trim())
    assert.ok(child > 0, `no child pid in ${JSON.stringify(result.stdout)}`)
    // The grandchild must be gone too; give the system a moment to reap it.
    let alive = true
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try {
        process.kill(child, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'the process the hook started is still running')
  })

  it('reports a shell that cannot start', async () => {
    const missing = createProcessRunner({ file: '/no/such/shell', args: (command) => ['-c', command] })
    const result = await missing('true', options)
    assert.equal(result.exitCode, null)
    assert.match(result.error ?? '', /ENOENT/)
  })
})
