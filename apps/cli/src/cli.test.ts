import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { ConversationEntry, DiffHunk } from '@encode/core'
import { USAGE, UsageError, parseArgs } from './args'
import { NO_MODEL, chooseModel, modelConfig } from './model'
import { Renderer, describeTool, shownPath, toolOutcome, usageLine } from './render'
import { ago } from './session'
import { COLOR, NO_COLOR, firstLine, plain, safeJson, styleFor } from './text'
import { VERSION } from './version'
import { requestText } from './main'

const ESC = String.fromCharCode(0x1b)
const RLO = String.fromCharCode(0x202e)
const ZWSP = String.fromCharCode(0x200b)
const LINE_SEPARATOR = String.fromCharCode(0x2028)

describe('arguments', () => {
  it('starts the prompt in this folder with the defaults', () => {
    const options = parseArgs([])
    assert.equal(options.command, 'chat')
    assert.equal(options.prompt, '')
    assert.equal(options.print, false)
    assert.equal(options.outputFormat, 'text')
    assert.equal(options.mode, 'code')
    assert.equal(options.sandbox, true)
    assert.equal(options.trust, false)
    assert.equal(options.policy, undefined)
    assert.equal(options.model, undefined)
  })

  it('reads a request, print mode and the options around it', () => {
    const options = parseArgs(['-p', 'fix', 'the', 'test', '--model=openrouter:a/b', '--policy', 'read-only', '--mode', 'plan', '-C', 'src', '--max-steps', '12', '--no-sandbox', '--trust', '--verbose', '--no-color'])
    assert.equal(options.prompt, 'fix the test')
    assert.equal(options.print, true)
    assert.equal(options.model, 'openrouter:a/b')
    assert.equal(options.policy, 'read-only')
    assert.equal(options.mode, 'plan')
    assert.equal(options.cwd, 'src')
    assert.equal(options.maxSteps, 12)
    assert.equal(options.sandbox, false)
    assert.equal(options.trust, true)
    assert.equal(options.verbose, true)
    assert.equal(options.color, false)
  })

  it('takes what follows -- as words, even when it looks like an option', () => {
    assert.equal(parseArgs(['-p', '--', '--explain', '-v']).prompt, '--explain -v')
  })

  it('takes the model and server from the environment unless given', () => {
    const env = { ENCODE_MODEL: ' anthropic:x ', ENCODE_BASE_URL: 'http://localhost:9/v1' }
    assert.equal(parseArgs([], env).model, 'anthropic:x')
    assert.equal(parseArgs([], env).baseUrl, 'http://localhost:9/v1')
    assert.equal(parseArgs(['-m', 'demo'], env).model, 'demo')
  })

  it('knows its commands', () => {
    assert.equal(parseArgs(['--help']).command, 'help')
    assert.equal(parseArgs(['help']).command, 'help')
    assert.equal(parseArgs(['-v']).command, 'version')
    assert.equal(parseArgs(['sessions']).command, 'sessions')
    // A request that starts with the word is still a request.
    assert.equal(parseArgs(['sessions', 'are', 'slow']).command, 'chat')
  })

  it('says what is wrong with an option', () => {
    const wrong: [string[], RegExp][] = [
      [['--bogus'], /unknown option --bogus/],
      [['--model'], /--model needs a value/],
      [['--model', '-p'], /--model needs a value/],
      [['--policy', 'yolo'], /--policy is one of read-only, workspace-write, full-access, auto-review/],
      [['--mode', 'fast'], /--mode is one of code, ask, plan/],
      [['--output-format', 'json'], /--output-format goes with --print/],
      [['-p', '--output-format', 'xml'], /--output-format is one of/],
      [['--max-steps', '0'], /1 to 100/],
      [['--max-steps', '2.5'], /1 to 100/],
      [['--max-steps', '101'], /1 to 100/],
      [['--color', '--no-color'], /not both/],
      [['-c', '-r', 'abc'], /not both/],
      [['--trust=yes'], /unknown option --trust=yes/],
    ]
    for (const [argv, message] of wrong) assert.throws(() => parseArgs(argv), (error: unknown) => error instanceof UsageError && message.test(error.message), argv.join(' '))
  })

  it('has help that names every option it reads', () => {
    for (const flag of ['--model', '--base-url', '--continue', '--resume', '--mode', '--policy', '--max-steps', '--cwd', '--trust', '--no-sandbox', '--print', '--output-format', '--verbose', '--no-color', '--help', '--version']) assert.ok(USAGE.includes(flag), flag)
  })

  it('has the version of its package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'apps', 'cli', 'package.json'), 'utf8')) as { version: string }
    assert.equal(VERSION, pkg.version)
  })
})

describe('terminal text', () => {
  it('turns escape sequences, controls and direction characters into ?', () => {
    assert.equal(plain(`ok${ESC}]0;owned${String.fromCharCode(7)} done`), 'ok?]0;owned? done')
    assert.equal(plain(`a${RLO}b${ZWSP}c`), 'a?b?c')
    assert.equal(plain('tab\there\r\nnext\rline'), 'tab\there\nnextline')
    assert.equal(plain(String.fromCharCode(0x9b) + '31m'), '?31m')
  })

  it('writes JSON a terminal shows as it is', () => {
    const line = safeJson({ text: `a${RLO}b${LINE_SEPARATOR}c` })
    assert.equal(line, '{"text":"a\\u202eb\\u2028c"}')
    assert.deepEqual(JSON.parse(line), { text: `a${RLO}b${LINE_SEPARATOR}c` })
  })

  it('cuts to the first line', () => {
    assert.equal(firstLine('  one\ntwo'), 'one')
    assert.equal(firstLine('abcdef', 4), 'abc…')
  })

  it('colours only a terminal, and never against NO_COLOR', () => {
    assert.equal(styleFor(true, {}), COLOR)
    assert.equal(styleFor(false, {}), NO_COLOR)
    assert.equal(styleFor(true, { NO_COLOR: '1' }), NO_COLOR)
    assert.equal(styleFor(true, { TERM: 'dumb' }), NO_COLOR)
    assert.equal(styleFor(false, { FORCE_COLOR: '1' }), COLOR)
    assert.equal(styleFor(false, { FORCE_COLOR: '0' }), NO_COLOR)
    assert.equal(styleFor(false, { NO_COLOR: '1' }, true), COLOR)
    assert.equal(styleFor(true, {}, false), NO_COLOR)
  })
})

describe('models', () => {
  it('names a provider and a model', () => {
    assert.deepEqual(modelConfig('openrouter:qwen/qwen3-coder', undefined, {}), { provider: 'openrouter', providers: { openrouter: { type: 'openrouter' } }, ref: 'openrouter:qwen/qwen3-coder', keyName: 'OPENROUTER_API_KEY' })
    assert.equal(modelConfig('deepseek:deepseek-chat', undefined, {}).providers.deepseek && (modelConfig('deepseek:deepseek-chat', undefined, {}).providers.deepseek as { baseUrl: string }).baseUrl, 'https://api.deepseek.com/v1')
    const local = modelConfig('ollama:qwen2.5-coder', undefined, { ENCODE_OLLAMA_URL: 'http://box:11434/v1' })
    assert.deepEqual(local.providers.ollama, { type: 'openai-compatible', baseUrl: 'http://box:11434/v1' })
    assert.equal(local.keyName, undefined)
  })

  it('reaches only zero-priced models for @free', () => {
    assert.equal(modelConfig('@free', undefined, {}).ref, '@free')
  })

  it('takes any OpenAI-compatible server with --base-url', () => {
    const custom = modelConfig('my-model', 'http://localhost:8080/v1/', {})
    assert.deepEqual(custom, { provider: 'custom', providers: { custom: { type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' } }, ref: 'custom:my-model', keyName: 'ENCODE_API_KEY' })
    assert.throws(() => modelConfig('openai:gpt', 'http://localhost/v1', {}), /server's own model id/)
    assert.throws(() => modelConfig('m', 'not a url', {}), /not an address/)
    assert.throws(() => modelConfig('m', 'file:///etc/passwd', {}), /http or https/)
  })

  it('says how to choose one', async () => {
    await assert.rejects(chooseModel(undefined, undefined, {}, () => {}), (error: unknown) => error instanceof UsageError && error.message === NO_MODEL)
    await assert.rejects(chooseModel('gpt-5', undefined, {}, () => {}), /not a model eNCode knows how to reach/)
    await assert.rejects(chooseModel('openrouter:', undefined, {}, () => {}), /not a model/)
  })

  it('asks for the key by its name, from the environment', async () => {
    await assert.rejects(chooseModel('anthropic:x', undefined, {}, () => {}), /Set ANTHROPIC_API_KEY to use anthropic:x/)
    await assert.rejects(chooseModel('@free', undefined, { OPENROUTER_API_KEY: '  ' }, () => {}), /Set OPENROUTER_API_KEY/)
  })

  it('has an offline demo', async () => {
    const choice = await chooseModel('demo', undefined, {}, () => {})
    assert.equal(choice.label, 'demo (offline)')
    assert.deepEqual(choice.secrets, [])
  })
})

const tool = (name: string, input: Record<string, unknown>, more: Partial<NonNullable<ConversationEntry['tool']>> = {}): NonNullable<ConversationEntry['tool']> => ({ id: 't', name, input, state: 'done', ...more }) as NonNullable<ConversationEntry['tool']>

describe('what the agent does, as lines', () => {
  const root = path.resolve('/work/project')

  it('shows paths inside the folder relative to it', () => {
    assert.equal(shownPath(path.join(root, 'src', 'a.ts'), root), 'src/a.ts')
    assert.equal(shownPath(root, root), '.')
    assert.equal(shownPath(path.resolve('/elsewhere/b.ts'), root), path.resolve('/elsewhere/b.ts'))
    assert.equal(shownPath('rel/c.ts', root), 'rel/c.ts')
  })

  it('names a call by what it is about', () => {
    assert.equal(describeTool(tool('Read', { file_path: path.join(root, 'README.md') }), root), 'Read README.md')
    assert.equal(describeTool(tool('Bash', { command: 'pnpm test\npnpm lint' }), root), 'Bash pnpm test')
    assert.equal(describeTool(tool('TodoWrite', {}), root), 'TodoWrite')
  })

  it('says how a call went', () => {
    assert.deepEqual(toolOutcome(tool('Bash', { command: 'x' }, { output: 'line 1\nline 2\n12 passed' })), { ok: true, text: '12 passed (3 lines)' })
    assert.deepEqual(toolOutcome(tool('Read', {}, { output: 'first\nsecond' })), { ok: true, text: 'first (2 lines)' })
    const diff: DiffHunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [{ type: 'del', text: 'a' }, { type: 'add', text: 'b' }, { type: 'add', text: 'c' }] }] as DiffHunk[]
    assert.deepEqual(toolOutcome(tool('Edit', {}, { diff })), { ok: true, text: '+2 -1' })
    assert.deepEqual(toolOutcome(tool('Write', {}, { state: 'rejected', output: 'Rejected by user.' })), { ok: false, text: 'declined: Rejected by user.' })
    assert.deepEqual(toolOutcome(tool('Bash', {}, { state: 'error', ok: false, output: `no such file${ESC}[2J` })), { ok: false, text: 'no such file?[2J' })
  })

  it('sums up a request', () => {
    assert.equal(usageLine(undefined, 1500), '1.5 s')
    assert.equal(usageLine({ inputTokens: 12_345, cachedTokens: 2_000, outputTokens: 300, cost: 0.0042, calls: 2 } as never, 4000), '12.3k in (2.0k cached) · 300 out · $0.0042 · 4.0 s')
  })

  it('streams the reply, makes it plain, and puts each call on its own lines', () => {
    let out = ''
    const renderer = new Renderer({ style: NO_COLOR, root, write: (text) => (out += text) })
    renderer.event({ type: 'worktree', worktree: null } as never)
    renderer.event({ type: 'delta', entryId: 'a1', text: `Looking${ESC}[31m` } as never)
    renderer.event({ type: 'delta', entryId: 'a1', text: ' around.' } as never)
    renderer.event({ type: 'entry', entry: { id: 't1', kind: 'tool', tool: tool('Read', { file_path: path.join(root, 'a.ts') }, { state: 'running' }) } } as never)
    renderer.event({ type: 'entry', entry: { id: 't1', kind: 'tool', tool: tool('Read', { file_path: path.join(root, 'a.ts') }, { output: 'export const a = 1' }) } } as never)
    renderer.event({ type: 'entry', entry: { id: 'a1', kind: 'assistant', text: 'Looking around.' } } as never)
    renderer.event({ type: 'todos', todos: [{ id: '1', text: 'Read a.ts', status: 'completed' }, { id: '2', text: 'Fix it', status: 'in_progress' }] } as never)
    assert.equal(out, '\nLooking?[31m around.\n• Read a.ts\n  └ export const a = 1\n  Tasks\n  [x] Read a.ts\n  [>] Fix it\n')
  })
})

describe('sessions and requests', () => {
  it('says when, in words', () => {
    const now = Date.UTC(2026, 9, 24, 12)
    assert.equal(ago(now - 10_000, now), 'just now')
    assert.equal(ago(now - 5 * 60_000, now), '5 min ago')
    assert.equal(ago(now - 3 * 3_600_000, now), '3 h ago')
    assert.equal(ago(now - 26 * 3_600_000, now), 'yesterday')
    assert.equal(ago(now - 40 * 86_400_000, now), '2026-09-14')
  })

  it('puts the words before what came on the pipe', () => {
    assert.equal(requestText('review this', 'diff --git a b\n\n'), 'review this\n\ndiff --git a b')
    assert.equal(requestText('', 'only the pipe\n'), 'only the pipe')
    assert.equal(requestText('only words', '  \n'), 'only words')
  })
})
