/**
 * What a request taught, offered for the project's instructions file (ADR 0097): which requests teach, what the
 * model's lines become, where they are written, and the offer through the loop and the session.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, ModelClient } from '@encode/providers'
import { tempWorkspace } from '@encode/tools/testing'
import { CONVENTIONS_SYSTEM, instructionsAt, parseConventions, saveConventions, teaches, withConventions } from './conventions'
import { createScriptedClient } from './scripted'
import { closeHarnesses, loopHarness, sessionHarness, stubShell, type SessionHarness } from './testing'

after(closeHarnesses)

const textOf = (request: CompletionRequest) =>
  request.payload.messages
    .at(-1)!
    .content.map((block) => ('text' in block ? block.text : ''))
    .join('')
const lines = (...rules: string[]) => '```json\n' + JSON.stringify({ lines: rules }) + '\n```'
const offers = (h: SessionHarness) => h.session.history().entries.filter((entry) => entry.suggestion)

describe('what a request taught', () => {
  it('comes from a rule meant for later requests, by its words', () => {
    for (const text of ['From now on use pnpm', 'We never use default exports here', 'always run the linter first', "Don't ever touch generated files", 'Use vitest instead of jest', 'In this repo, tabs.']) {
      assert.ok(teaches(text), text)
    }
    for (const text of ['Fix the login bug', 'Add a dark mode toggle', 'What does this function do?']) assert.ok(!teaches(text), text)
  })

  it("keeps at most three new, flat lines of the model's answer, without what the file already says", () => {
    const answer = lines('- Use `pnpm`, never `npm`.', 'Use `pnpm`, never `npm`.', '1. Keep\nlines short', 'Run `pnpm test` before a commit.', 'Name files in kebab-case.', 'One too many.')
    assert.deepEqual(parseConventions(answer, '# Project\n\n- run `pnpm test` before a commit.\n'), ['Use `pnpm`, never `npm`.', 'Keep lines short', 'Name files in kebab-case.'])
    assert.deepEqual(parseConventions('{"lines": []}', null), [])
    assert.equal(parseConventions('Use pnpm.', null), undefined, 'no JSON: nothing to read')
    const [line] = parseConventions(lines(`Set the key to sk-or-v1-${'a'.repeat(48)}`), null)!
    assert.ok(!line.includes('a'.repeat(48)), 'a key in a line is removed')
  })

  it('go under the Conventions heading, made at the end when there is none, in the file’s own line endings', () => {
    assert.equal(withConventions(null, ['Use `pnpm`.']), '## Conventions\n\n- Use `pnpm`.\n')
    assert.equal(withConventions('# App\n\nNotes.\n\n\n', ['Use `pnpm`.']), '# App\n\nNotes.\n\n## Conventions\n\n- Use `pnpm`.\n')
    assert.equal(
      withConventions('# App\n\n## Conventions\n\n- Tabs.\n\n## Layout\n\nsrc/\n', ['Use `pnpm`.', 'No default exports.']),
      '# App\n\n## Conventions\n\n- Tabs.\n- Use `pnpm`.\n- No default exports.\n\n## Layout\n\nsrc/\n',
    )
    assert.equal(withConventions('# App\r\n\r\n## Conventions\r\n- Tabs.\r\n', ['Use `pnpm`.']), '# App\r\n\r\n## Conventions\r\n- Tabs.\r\n- Use `pnpm`.\r\n')
  })

  it('are written to the instructions file the agent reads, and never through a link out of the project', async () => {
    const root = await tempWorkspace({ 'AGENTS.md': '# Agents\n' })
    assert.deepEqual(await instructionsAt(root), { file: 'AGENTS.md', text: '# Agents\n' })
    assert.deepEqual(await saveConventions(root, ['Use `pnpm`.']), { ok: true, file: 'AGENTS.md' })
    assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), '# Agents\n\n## Conventions\n\n- Use `pnpm`.\n')

    const empty = await tempWorkspace({})
    assert.deepEqual(await instructionsAt(empty), { file: 'ENCODE.md', text: null })
    assert.deepEqual(await saveConventions(empty, ['Tabs.']), { ok: true, file: 'ENCODE.md' })
    assert.equal(await fs.readFile(path.join(empty, 'ENCODE.md'), 'utf8'), '## Conventions\n\n- Tabs.\n')

    const outside = await tempWorkspace({ 'notes.md': 'mine\n' })
    const linked = await tempWorkspace({})
    try {
      await fs.symlink(path.join(outside, 'notes.md'), path.join(linked, 'ENCODE.md'))
    } catch {
      return // Windows without the right to make links: nothing to test.
    }
    const refused = await saveConventions(linked, ['Tabs.'])
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.error, /leads outside the project/)
    assert.equal(await fs.readFile(path.join(outside, 'notes.md'), 'utf8'), 'mine\n')
  })

  it('learns from a command that failed and the one that worked after it, with no rule in the words', async () => {
    const h = await loopHarness({
      script: [
        { calls: [{ name: 'Bash', input: { command: 'npm install', description: 'Install' } }] },
        { calls: [{ name: 'Bash', input: { command: 'pnpm install', description: 'Install' } }] },
        { text: 'Installed.' },
        { text: lines('Install with `pnpm install`; `npm install` fails here.') },
      ],
      shell: (root) => ({
        ...stubShell(root),
        run: async (command) =>
          command.startsWith('npm') ? { output: 'npm ERR! Use pnpm: this project has pnpm-lock.yaml', exitCode: 1, timedOut: false, interrupted: false, cwd: root } : { output: 'ok', exitCode: 0, timedOut: false, interrupted: false, cwd: root },
      }),
      settings: { policy: 'full-access', learnConventions: 'on' },
      requests: () => ['install the dependencies'],
      suggested: () => [],
    })
    await h.run('install the dependencies')
    assert.equal(h.client.requests.length, 3, 'nothing is asked before the turn is over')
    await h.loop.offerConventions(new AbortController().signal)
    const call = h.client.requests[3]
    assert.deepEqual([call.role, call.tool, call.payload.tools.length, call.payload.system[0].text], ['utility', 'Conventions', 0, CONVENTIONS_SYSTEM])
    const prompt = textOf(call)
    assert.match(prompt, /<messages-[0-9a-f]+>\ninstall the dependencies\n<\/messages-/)
    assert.match(prompt, /- `npm install` failed: npm ERR! Use pnpm: this project has pnpm-lock\.yaml[^\n]*\n {2}then `pnpm install` worked/)
    assert.match(prompt, /<file-[0-9a-f]+>\n\(it does not exist yet\)\n<\/file-/)
    const offer = h.surface.settled.at(-1)!
    assert.equal(offer.text, 'Keep what this request taught in ENCODE.md?')
    assert.deepEqual(offer.suggestion, { file: 'ENCODE.md', lines: ['Install with `pnpm install`; `npm install` fails here.'], state: 'open' })

    await h.loop.offerConventions(new AbortController().signal)
    assert.equal(h.client.requests.length, 4, 'once a request')
  })

  it('asks nothing after a request that taught nothing, that was stopped, or when turned off', async () => {
    const plain = await loopHarness({ script: [{ text: 'Fixed.' }], settings: { learnConventions: 'on' }, requests: () => ['fix the login bug'] })
    await plain.run('fix the login bug')
    await plain.loop.offerConventions(new AbortController().signal)
    assert.equal(plain.client.requests.length, 1)

    const off = await loopHarness({ script: [{ text: 'Noted.' }], settings: { learnConventions: 'off' }, requests: () => ['always use pnpm'] })
    await off.run('always use pnpm')
    await off.loop.offerConventions(new AbortController().signal)
    assert.equal(off.client.requests.length, 1)

    const stopped = new AbortController()
    const late = await loopHarness({ script: [{ text: 'Noted.' }, { text: lines('Use `pnpm`.') }], settings: { learnConventions: 'on' }, requests: () => ['always use pnpm'] })
    await late.run('always use pnpm')
    stopped.abort()
    await late.loop.offerConventions(stopped.signal)
    assert.ok(!late.surface.settled.some((entry) => entry.suggestion), 'the next request started first')
  })
})

describe('the offer in a session', () => {
  const RULE = 'From now on, always use pnpm in this repo'
  const script = (rules: string[]) => (request: CompletionRequest) => (request.tool === 'Conventions' ? { text: lines(...rules) } : { text: 'Understood.' })

  it('comes after the turn, adds the lines only on Add, and never offers the same line twice', async () => {
    const h = await sessionHarness({ script: script(['Use `pnpm`, never `npm`.']), settings: { learnConventions: 'on' }, files: { 'ENCODE.md': '# Project\n' } })
    const end = await h.session.start({ text: RULE, mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'Understood.' })
    await h.session.learned()
    const [offer] = offers(h)
    assert.deepEqual(offer.suggestion, { file: 'ENCODE.md', lines: ['Use `pnpm`, never `npm`.'], state: 'open' })
    assert.equal(await fs.readFile(path.join(h.root, 'ENCODE.md'), 'utf8'), '# Project\n', 'nothing written before Add')

    assert.deepEqual(await h.session.answerSuggestion(offer.id, true), { ok: true, file: 'ENCODE.md' })
    assert.equal(await fs.readFile(path.join(h.root, 'ENCODE.md'), 'utf8'), '# Project\n\n## Conventions\n\n- Use `pnpm`, never `npm`.\n')
    assert.equal(offers(h)[0].suggestion?.state, 'saved')
    assert.deepEqual(await h.session.answerSuggestion(offer.id, true), { ok: false, error: 'This suggestion was already answered.' })

    await h.session.start({ text: 'Always use pnpm, I said', mode: 'code' })
    await h.session.learned()
    assert.equal(offers(h).length, 1, 'the line was offered already')
  })

  it('closes the card on Dismiss and writes nothing; the next request stops an offer still on its way', async () => {
    const h = await sessionHarness({ script: script(['Use `pnpm`.']), settings: { learnConventions: 'on' } })
    await h.session.start({ text: RULE, mode: 'code' })
    await h.session.learned()
    const [offer] = offers(h)
    assert.deepEqual(await h.session.answerSuggestion(offer.id, false), { ok: true })
    assert.equal(offers(h)[0].suggestion?.state, 'dismissed')
    await assert.rejects(fs.stat(path.join(h.root, 'ENCODE.md')))

    // The offer waits on its model until the next request has started, which stops it.
    const inner = createScriptedClient(script(['Use `pnpm`.']))
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (started = resolve))
    const client: ModelClient = {
      ...inner,
      complete: async (request) => {
        if (request.tool !== 'Conventions') return inner.complete(request)
        started()
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
        throw request.signal.reason
      },
    }
    const slow = await sessionHarness({ settings: { learnConventions: 'on' }, env: { client } })
    await slow.session.start({ text: RULE, mode: 'code' })
    await waiting
    await slow.session.start({ text: 'Add a test for the parser', mode: 'code' })
    await slow.session.learned()
    assert.equal(offers(slow).length, 0)
  })
})
