import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { createScriptedClient, type ScriptedClient, type ScriptedStep } from '@encode/core'
import { spendingCap, type ModelClient } from '@encode/providers'
import { parseArgs, UsageError } from './args'
import { main, readAll, type MainIo } from './main'
import type { ModelChoice } from './model'
import { NOBODY_ANSWERS, NOBODY_APPROVES, runPrint, type PrintIo, type PrintResult } from './print'
import { runRepl } from './repl'

const ESC = String.fromCharCode(0x1b)
const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** A home, a profile and a project folder of a test's own. */
async function place(): Promise<{ home: string; profile: string; project: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-cli-test-'))
  made.push(dir)
  const project = path.join(dir, 'project')
  await fs.mkdir(path.join(dir, 'home'), { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, 'a.txt'), 'hello\n')
  return { home: path.join(dir, 'home'), profile: path.join(dir, 'profile'), project: await fs.realpath(project) }
}

const choice = (client: ModelClient, secrets: string[] = []): ModelChoice => ({ client, label: 'scripted', secrets, free: false })

async function print(argv: string[], script: ScriptedStep[] | ModelClient, secrets: string[] = []) {
  const where = await place()
  const client: ModelClient = Array.isArray(script) ? createScriptedClient(script) : script
  let stdout = ''
  let stderr = ''
  const io: PrintIo = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    stderrTty: false,
    env: {},
    home: where.home,
    profile: where.profile,
    onInterrupt: () => () => {},
  }
  const options = parseArgs(['-p', '--no-sandbox', ...argv])
  const code = await runPrint(options, options.prompt, choice(client, secrets), where.project, io)
  return { code, stdout, stderr, requests: 'requests' in client ? (client as ScriptedClient).requests : [], where }
}

describe('print mode', () => {
  it('stops at the spending cap, says so, and exits 1 (ADR 0138)', async () => {
    const where = await place()
    const reads = createScriptedClient([{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }], { costPerCall: 0.3 })
    const cap = spendingCap(0.5)
    let stdout = ''
    let stderr = ''
    const options = parseArgs(['-p', '--no-sandbox', '--output-format', 'json', '--max-cost', '0.5', 'read it again and again'])
    const code = await runPrint(options, options.prompt, { ...choice(cap.wrap(reads)), cap }, where.project, {
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      stderrTty: false,
      env: {},
      home: where.home,
      profile: where.profile,
      onInterrupt: () => () => {},
    })
    assert.equal(code, 1)
    assert.equal(reads.requests.length, 1, 'the second call could have passed $0.50, so it was never made')
    const result = JSON.parse(stdout) as PrintResult
    assert.equal(result.error, 'Stopped: it reached its spending cap ($0.30 of $0.50 spent; the next call could cost $0.30).')
    assert.equal(cap.spent(), 0.3)
  })

  it('writes the reply, and only the reply, to standard output', async () => {
    const run = await print(['read a.txt'], [{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }, { text: 'It says hello.' }])
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'It says hello.\n')
    assert.equal(run.stderr, '')
  })

  it('refuses what nobody can approve, with a note the agent can act on', async () => {
    const run = await print(['fetch it'], [{ calls: [{ name: 'Bash', input: { command: 'curl https://example.com' } }] }, { text: 'Could not fetch it here.' }])
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'Could not fetch it here.\n')
    assert.ok(JSON.stringify(run.requests[1]).includes(NOBODY_APPROVES), 'the refusal reached the model with its note')
  })

  it('tells a question to choose', async () => {
    const run = await print(['name it'], [
      { calls: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which name?', header: 'Name', multiSelect: false, options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }] }] } }] },
      { text: 'Chose a.' },
    ])
    assert.equal(run.code, 0)
    assert.ok(JSON.stringify(run.requests[1]).includes(NOBODY_ANSWERS))
  })

  it('makes the reply plain and keeps keys out of it', async () => {
    const run = await print(['hi'], [{ text: `Key sk-test-1234567890 ${ESC}]0;owned${String.fromCharCode(7)}done` }], ['sk-test-1234567890'])
    assert.ok(!run.stdout.includes('sk-test-1234567890'))
    assert.ok(!run.stdout.includes(ESC))
    assert.match(run.stdout, /\?\]0;owned\?done/)
  })

  it('gives one result object with --output-format json', async () => {
    const run = await print(['--output-format', 'json', 'hi'], [{ text: 'Hello.' }])
    const result = JSON.parse(run.stdout) as PrintResult
    assert.equal(result.type, 'result')
    assert.equal(result.ok, true)
    assert.equal(result.result, 'Hello.')
    assert.equal(result.error, null)
    assert.equal(result.details, null)
    assert.equal(result.model, 'scripted')
    assert.equal(result.usage.calls, 1)
    assert.ok(result.session)
  })

  it('gives every event as a line of JSON with --output-format stream-json', async () => {
    const run = await print(['--output-format', 'stream-json', 'hi'], [{ text: 'Hello.' }])
    const events = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; sessionId: string })
    assert.ok(events.length > 2)
    assert.ok(events.every((event) => event.sessionId === events[0]!.sessionId))
    assert.ok(events.some((event) => event.type === 'entry'))
  })

  it('ends with status 1 and says why when the request fails', async () => {
    const down: ModelClient = { budget: createScriptedClient([]).budget, complete: async () => Promise.reject(new Error('the model is down')) }
    const run = await print(['hi'], down)
    assert.equal(run.code, 1)
    assert.match(run.stderr, /^eNCode: Something went wrong inside eNCode, and this request stopped\.\n {2}.*the model is down/)
  })

  it('carries on with the folder\'s latest session with --continue', async () => {
    const where = await place()
    const io: PrintIo = { stdout: () => {}, stderr: () => {}, stderrTty: false, env: {}, home: where.home, profile: where.profile, onInterrupt: () => () => {} }
    const first = parseArgs(['-p', '--no-sandbox', '--output-format', 'json', 'one'])
    let out = ''
    await runPrint(first, 'one', choice(createScriptedClient([{ text: 'First.' }])), where.project, { ...io, stdout: (text) => (out += text) })
    const session = (JSON.parse(out) as PrintResult).session
    out = ''
    const second = parseArgs(['-p', '--no-sandbox', '-c', '--output-format', 'json', 'two'])
    const client = createScriptedClient([{ text: 'Second.' }])
    await runPrint(second, 'two', choice(client), where.project, { ...io, stdout: (text) => (out += text) })
    assert.equal((JSON.parse(out) as PrintResult).session, session)
    assert.ok(JSON.stringify(client.requests[0]).includes('First.'), 'the earlier reply is in the conversation')
  })
})

function mainIo(where: { home: string; profile: string; project: string }, argv: string[], stdin?: string): MainIo & { out(): string; err(): string } {
  let out = ''
  let err = ''
  const sink = (add: (text: string) => void) => {
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => add(chunk.toString('utf8')))
    return stream
  }
  const input = stdin === undefined ? Object.assign(new PassThrough(), { isTTY: true }) : Readable.from([stdin])
  return {
    argv,
    env: {},
    cwd: where.project,
    stdin: input,
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    home: where.home,
    profile: where.profile,
    onInterrupt: () => () => {},
    out: () => out,
    err: () => err,
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('the encode command', () => {
  it('says its version and its help', async () => {
    const where = await place()
    const version = mainIo(where, ['--version'])
    assert.equal(await main(version), 0)
    await settle()
    assert.match(version.out(), /^eNCode \d+\.\d+\.\d+(?: [a-z]+, commit [0-9a-f]{7}(?: \+ local changes)?)?\n$/)
    const help = mainIo(where, ['-h'])
    assert.equal(await main(help), 0)
    await settle()
    assert.match(help.out(), /^Usage: encode/)
  })

  it('ends with status 2 for a wrong option, a missing folder or no model', async () => {
    const where = await place()
    for (const [argv, message] of [
      [['--nope'], /unknown option --nope/],
      [['-C', 'missing', '-p', 'hi', '-m', 'demo'], /is not a folder/],
      [['-p', 'hi'], /Choose a model/],
      [['-p', '-m', 'demo'], /print mode needs a request/],
      [['-p', 'hi', '-m', 'openai:x'], /Set OPENAI_API_KEY/],
    ] as const) {
      const io = mainIo(where, [...argv])
      assert.equal(await main(io), 2, argv.join(' '))
      await settle()
      assert.match(io.err(), message)
    }
  })

  it('answers a request that comes on a pipe, and lists the session after', async () => {
    const where = await place()
    const io = mainIo(where, ['--no-sandbox', '-m', 'demo'], 'look around\n')
    assert.equal(await main(io), 0)
    await settle()
    assert.match(io.out(), /ends the demo/)
    const sessions = mainIo(where, ['sessions'])
    assert.equal(await main(sessions), 0)
    await settle()
    assert.match(sessions.out(), /^[0-9a-z]{8} {2}look around/)
  })

  it('takes no more than it can use from a pipe', async () => {
    await assert.rejects(readAll(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), { limit: 16 }), UsageError)
    assert.equal(await readAll(Readable.from([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text')])), 'text')
  })

  it('does not wait on an input that stays open and silent when the request is in words', async () => {
    const silent = new PassThrough()
    const started = Date.now()
    assert.equal(await readAll(silent, { quietMs: 50 }), '')
    assert.ok(Date.now() - started < 2_000)
    // Input that has begun is read to its end, however slowly it comes.
    const slow = new PassThrough()
    const reading = readAll(slow, { quietMs: 50 })
    slow.write('first ')
    await new Promise((resolve) => setTimeout(resolve, 120))
    slow.end('second')
    assert.equal(await reading, 'first second')
  })
})

/** The prompt, driven line by line: each line is typed once the output shows what it answers. */
async function prompt(argv: string[], script: ScriptedStep[]) {
  const where = await place()
  const input = new PassThrough()
  const output = new PassThrough()
  let out = ''
  output.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  const client = createScriptedClient(script)
  const options = parseArgs(['--no-sandbox', ...argv])
  const done = runRepl(options, options.prompt, choice(client), where.project, { input, output, env: {}, home: where.home, profile: where.profile })
  let seen = 0
  const until = async (text: string) => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      const at = out.indexOf(text, seen)
      if (at >= 0) {
        seen = at + text.length
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`never saw ${JSON.stringify(text)} in:\n${out}`)
  }
  const type = (line: string) => void input.write(`${line}\n`)
  return { done, until, type, client, output: () => out, where }
}

describe('the prompt', () => {
  it('asks about trust first, then takes requests and commands', async () => {
    const run = await prompt([], [{ text: 'Hello there.' }])
    await run.until('Trust it? [y/N]')
    run.type('n')
    await run.until('Not trusted.')
    run.type('/mode ask')
    await run.until('Mode: ask')
    run.type('say hi')
    await run.until('Hello there.')
    await run.until(' s\n')
    run.type('/nope')
    await run.until('No command /nope.')
    run.type('/exit')
    assert.equal(await run.done, 0)
    assert.equal(run.client.requests.length, 1)
  })

  it('takes an approval answer in words as what to do instead', async () => {
    const run = await prompt(['--trust'], [{ calls: [{ name: 'Bash', input: { command: 'curl https://example.com' } }] }, { text: 'Used the cached copy.' }])
    await run.until('Type a request.')
    run.type('fetch it')
    await run.until('Allow? [Y/n')
    run.type('use the cached copy instead')
    await run.until('Used the cached copy.')
    // The request is over once its usage line is written; a command typed before that waits for it.
    await run.until(' s\n')
    run.type('/exit')
    assert.equal(await run.done, 0)
    assert.ok(JSON.stringify(run.client.requests[1]).includes('use the cached copy instead'))
  })

  it('offers a proposed plan, and carries it out when told to', async () => {
    const run = await prompt(['--trust', '--mode', 'plan'], [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Read a.txt\n2. Say what it says' } }] }, { text: 'It says hello.' }])
    await run.until('Type a request.')
    run.type('plan the reading')
    await run.until('Carry out this plan? [y/N]')
    run.type('y')
    await run.until('It says hello.')
    // The request is over once its usage line is written; a command typed before that waits for it.
    await run.until(' s\n')
    run.type('/exit')
    assert.equal(await run.done, 0)
    assert.ok(JSON.stringify(run.client.requests.at(-1)).includes('Execute the approved plan:'))
    assert.ok(run.output().includes('Mode: code'))
  })
})
