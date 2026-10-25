import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message } from '@encode/providers'
import type { RuleQuery } from '@encode/permissions'
import { tempWorkspace } from '@encode/tools/testing'
import type { AgentHooks, NotificationEvent } from './hooks'
import { createSkills } from './skills'
import { closeHarnesses, sessionHarness, type SessionHarness } from './testing'

after(closeHarnesses)

const text = (message: Message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const shown = (h: SessionHarness) => h.session.history().entries.map((entry) => [entry.kind, entry.text])

describe('a session', () => {
  it('keeps each step’s prompt the start of the next one’s, so a provider’s prompt cache serves all of it (ADR 0093)', async () => {
    const h = await sessionHarness({
      files: { 'a.txt': `${'alpha\n'.repeat(400)}` },
      scriptFor: (root) => [
        { calls: [{ name: 'Read', input: { file_path: `${root}/a.txt` } }] },
        { calls: [{ name: 'TodoWrite', input: { todos: [{ content: 'Look', activeForm: 'Looking', status: 'completed' }] } }] },
        // The same lines again: answered by pointing back, which rewrites nothing.
        { calls: [{ name: 'Read', input: { file_path: `${root}/a.txt` } }] },
        { text: 'Read it.' },
        { calls: [{ name: 'Glob', input: { pattern: '*', path: root } }] },
        { text: 'Listed.' },
      ],
    })
    await h.session.start({ text: 'read a.txt', mode: 'code' })
    await h.session.start({ text: 'and list the folder', mode: 'plan' })
    const requests = h.client.requests.map((request) => request.payload)
    assert.equal(requests.length, 6)
    for (let index = 1; index < requests.length; index++) {
      const [before, after] = [requests[index - 1]!, requests[index]!]
      assert.deepEqual(after.system, before.system, `the instructions of request ${index + 1}`)
      assert.deepEqual(after.tools, before.tools, `the tools of request ${index + 1}, in another mode too`)
      assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, `request ${index + 1} starts with request ${index}`)
    }
  })

  it('adds up what each request costs on its message, as it runs, and keeps it', async () => {
    const h = await sessionHarness({ client: { costPerCall: 0.0025 }, scriptFor: (root) => [{ calls: [{ name: 'Glob', input: { pattern: '*', path: root } }] }, { text: 'Found them.' }] })
    await h.session.start({ text: 'list the files', mode: 'code' })
    const asked = () => h.session.history().entries.find((entry) => entry.kind === 'user')!
    const usage = asked().usage!
    assert.equal(usage.calls, 2)
    assert.ok(usage.inputTokens > 1_000 && usage.outputTokens > 0)
    assert.equal(usage.cost, 0.005)
    assert.deepEqual(usage.models, { scripted: { calls: 2, inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, cost: 0.005 } }, 'by the model that answered')
    const live = h.of('entry').filter((event) => event.entry.kind === 'user' && event.entry.usage)
    assert.deepEqual(live.map((event) => event.entry.usage!.calls), [1, 2], 'shown after each call')
    await h.reopen()
    assert.deepEqual(asked().usage, usage)

    const unpriced = await sessionHarness({ script: [{ text: 'ok' }] })
    await unpriced.session.start({ text: 'hi', mode: 'code' })
    const entry = unpriced.session.history().entries.find((candidate) => candidate.kind === 'user')!
    assert.equal(entry.usage?.calls, 1)
    assert.equal(entry.usage?.cost, undefined, 'no cost unless every call said one')
  })

  it('runs a turn, shows it as events and stores it', async () => {
    const h = await sessionHarness({ script: [{ text: 'Hello there' }] })
    const end = await h.session.start({ text: 'say hi', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'Hello there' })
    assert.deepEqual(shown(h), [['user', 'say hi'], ['assistant', 'Hello there']])
    assert.equal(h.session.history().status, 'done')
    assert.deepEqual(h.of('status').map((event) => event.status), ['thinking', 'done'])
    assert.equal(h.of('done').length, 1)
    assert.ok(h.events.every((event) => event.sessionId === h.session.id))
    assert.ok(h.of('usage').length >= 1)
    assert.equal(h.session.summary().title, 'say hi')

    const again = await h.reopen()
    assert.deepEqual(shown(h), [['user', 'say hi'], ['assistant', 'Hello there']])
    assert.equal(again.summary().title, 'say hi')
  })

  it('refuses a second turn while one runs, and an empty request', async () => {
    const h = await sessionHarness({ client: { delayMs: 20 }, script: [{ text: 'one two three four five six seven eight nine ten' }] })
    await assert.rejects(h.session.start({ text: '   ', mode: 'code' }), /Type a request first/)
    const running = h.session.start({ text: 'go', mode: 'code' })
    await assert.rejects(h.session.start({ text: 'again', mode: 'code' }), /already working/)
    h.session.cancel()
    await running
  })

  it('takes the next request as soon as a turn has reported its end, while that end is still being saved', async () => {
    const h = await sessionHarness({ script: [{ text: 'first' }, { text: 'second' }] })
    const flush = h.session.flush.bind(h.session)
    // A slow disk: the client has been told the turn is over and the session is still writing it down.
    h.session.flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      await flush()
    }
    let second: ReturnType<typeof h.session.start> | undefined
    const emit = h.env.emit
    h.env.emit = (event) => {
      emit(event)
      // A queued message goes out the moment the client hears "done", on a later tick as across a port.
      if (event.type === 'done' && !second) setImmediate(() => (second = h.session.start({ text: 'two', mode: 'code' })))
    }
    await h.session.start({ text: 'one', mode: 'code' })
    assert.ok(second)
    assert.deepEqual(await second, { kind: 'done', reply: 'second' })
    assert.deepEqual(shown(h), [['user', 'one'], ['assistant', 'first'], ['user', 'two'], ['assistant', 'second']])
  })

  it('stops on request, finishing what was streaming', async () => {
    const h = await sessionHarness({ client: { delayMs: 15 }, script: [{ text: 'one two three four five six seven eight nine ten eleven twelve' }] })
    const running = h.session.start({ text: 'talk', mode: 'code' })
    await until(() => h.of('delta')[0])
    h.session.cancel()
    const end = await running
    assert.equal(end.kind, 'cancelled')
    const entries = h.session.history().entries
    assert.ok(entries.every((entry) => !entry.streaming))
    assert.equal(entries.at(-1)?.text, 'Stopped.')
    assert.equal(h.session.status(), 'idle')
  })

  it('continues a stored conversation after a restart, telling the model about the environment once', async () => {
    const h = await sessionHarness({ files: { 'ENCODE.md': 'Use tabs.' }, script: [{ text: 'first' }, { text: 'second' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.reopen()
    await h.session.start({ text: 'two', mode: 'code' })

    const messages = h.client.requests.at(-1)!.payload.messages
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user'])
    assert.match(text(messages[0]), /Workspace root: /)
    assert.match(text(messages[0]), /Use tabs\./)
    assert.doesNotMatch(text(messages[2]), /Workspace root: /)
    // After a restart the agent cannot know what it was told last, so the project's instructions come again.
    assert.match(text(messages[2]), /Use tabs\./)
    assert.match(text(messages[2]), /two$/)
  })

  it('repeats the project instructions only when they change', async () => {
    const h = await sessionHarness({ files: { 'ENCODE.md': 'Use tabs.' }, script: [{ text: 'a' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.start({ text: 'two', mode: 'code' })
    await fs.writeFile(path.join(h.root, 'ENCODE.md'), 'Use spaces.')
    await h.session.start({ text: 'three', mode: 'code' })
    const messages = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user')
    assert.match(text(messages[0]), /Use tabs\./)
    assert.doesNotMatch(text(messages[1]), /Use tabs\./)
    assert.match(text(messages[2]), /changed since you last read them/)
    assert.match(text(messages[2]), /Use spaces\./)
  })

  it('reads the user\'s own instructions from their folder, and AGENTS.md as a fallback', async () => {
    const h = await sessionHarness({ homeFiles: { '.encode/ENCODE.md': 'Answer in Dutch.' }, files: { 'AGENTS.md': 'Run pnpm test.' }, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'go', mode: 'code' })
    const first = text(h.client.requests[0].payload.messages[0])
    assert.match(first, /Answer in Dutch\./)
    assert.match(first, /Run pnpm test\./)
  })

  it('sends a map of the code with the first message, pulled towards what was asked, without files the rules deny', async () => {
    const files = {
      'src/router.ts': 'export class RequestRouter {}\nexport function createRequestRouter() { return new RequestRouter() }\n',
      'src/server.ts': "import { RequestRouter } from './router'\nexport function startServer(router: RequestRouter) {}\n",
      'src/billing.ts': 'export function chargeCustomer() {}\n',
      'secret/keys.ts': 'export function loadVaultKeys() {}\n',
    }
    const rules = { evaluate: (query: RuleQuery) => (query.type === 'read' && query.paths.some((file) => file.includes(`${path.sep}secret${path.sep}`)) ? { decision: 'deny' as const, reason: 'no', rule: { behavior: 'deny' as const, tool: 'Read', source: 'user' as const, text: 'Read(secret/**)' } } : null) }
    const h = await sessionHarness({ files, env: { rules }, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'Customers are charged twice in chargeCustomer', mode: 'code' })
    await h.session.start({ text: 'and now?', mode: 'code' })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.match(users[0], /Code map \(background for you/)
    assert.match(users[0], /src\/billing\.ts\n {2}1 export function chargeCustomer\(\)\nsrc\/router\.ts/)
    assert.doesNotMatch(users[0], /loadVaultKeys|secret\/keys/)
    assert.doesNotMatch(users[1], /Code map/)
  })

  it('maps a file the agent just wrote', async () => {
    const h = await sessionHarness({
      files: { 'a.ts': 'export function alpha() {}\n' },
      scriptFor: (root) => [
        { calls: [{ name: 'CodeMap', input: { symbol: 'delta' } }] },
        { calls: [{ name: 'Write', input: { file_path: path.join(root, 'd.ts'), content: 'export function delta() {}\n' } }] },
        { calls: [{ name: 'CodeMap', input: { symbol: 'delta' } }] },
        { text: 'done' },
      ],
    })
    await h.session.start({ text: 'go', mode: 'code' })
    const results = h.client.requests.at(-1)!.payload.messages.flatMap((message) => (message.role === 'user' ? message.content : [])).filter((block) => block.type === 'tool-result')
    const shown = (index: number) => JSON.stringify(results[index])
    assert.match(shown(0), /No definition of delta/)
    assert.match(shown(2), /delta is defined at:\\nd\.ts:1 export function delta\(\)/)
  })

  it('sends no map for a project of one or two files', async () => {
    const h = await sessionHarness({ files: { 'a.ts': 'export function a() {}\n' }, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'go', mode: 'code' })
    assert.doesNotMatch(text(h.client.requests[0].payload.messages[0]), /Code map|Installed versions/)
  })

  it('names the installed versions of the project\'s dependencies in the first message, and looks up their API', async () => {
    const h = await sessionHarness({
      files: {
        'package.json': JSON.stringify({ dependencies: { zod: '^3.22.0', missing: '^1.0.0' } }),
        'node_modules/zod/package.json': JSON.stringify({ name: 'zod', version: '3.23.8', types: 'index.d.ts' }),
        'node_modules/zod/index.d.ts': '/** Parses a value, or throws. */\nexport declare function parse(value: unknown): unknown\n',
      },
      env: { natives: () => [{ name: 'GetEntityCoords', params: [{ name: 'entity', type: 'Entity', optional: false }], returns: ['vector3'], doc: ['Where the entity is.'], side: 'client' as const }] },
      script: [{ calls: [{ name: 'CodeMap', input: { package: 'zod', symbol: 'parse' } }, { name: 'CodeMap', input: { package: 'natives', symbol: 'GetEntityCoords' } }] }, { text: 'ok' }],
    })
    await h.session.start({ text: 'validate the form', mode: 'code' })
    await h.session.start({ text: 'and now?', mode: 'code' })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.match(users[0], /Installed versions of the project's dependencies \(write code for these versions; CodeMap with package shows their API as installed\):\nnpm: zod 3\.23\.8, missing not installed/)
    assert.doesNotMatch(users.at(-1)!, /Installed versions/)
    const results = h.client.requests.at(-1)!.payload.messages.flatMap((message) => (message.role === 'user' ? message.content : [])).filter((block) => block.type === 'tool-result').map((block) => JSON.stringify(block))
    assert.match(results[0], /Parses a value, or throws\./)
    assert.match(results[0], /export declare function parse\(value: unknown\): unknown/)
    assert.match(results[1], /GetEntityCoords\(entity: Entity\): vector3/)
  })

  it('announces the mode when it changes, the goal while it is active, and attached files', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.start({ text: 'two', mode: 'plan' })
    await h.session.start({ text: 'three', mode: 'plan' })
    h.session.setGoal({ text: 'Ship it', status: 'active', rounds: 0, createdAt: 1, updatedAt: 1 })
    await h.session.start({ text: 'four', mode: 'code', attachments: [{ path: 'src/a.ts', content: 'export const a = 1' }] })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.doesNotMatch(users[0], /Mode:/)
    assert.match(users[1], /Mode: plan/)
    assert.doesNotMatch(users[2], /Mode:/)
    assert.match(users[3], /Mode: code/)
    assert.match(users[3], /Active goal: Ship it/)
    assert.match(users[3], /<attached_files>\n--- src\/a\.ts ---\nexport const a = 1\n<\/attached_files>/)
    // The transcript shows what the user typed, not what was added to it.
    assert.equal(h.session.history().entries.filter((entry) => entry.kind === 'user').at(-1)?.text, 'four')
  })

  it('sends attached pictures as images before the words, and PDFs as their text (ADR 0113)', async () => {
    const pdf = (await fs.readFile(path.join(process.cwd(), 'packages/tools/src/pdf/fixtures/reportlab.pdf'))).toString('base64')
    const h = await sessionHarness({ script: [{ text: 'ok' }], client: { images: true } })
    const preview = 'data:image/jpeg;base64,AAAA'
    await h.session.start({
      text: 'what is wrong here?',
      mode: 'code',
      attachments: [{ path: 'notes.txt', content: 'x'.repeat(20_001) }],
      media: [
        { name: 'Screenshot 1.png', mediaType: 'image/png', data: 'iVBORw0KGgo=', preview },
        { name: 'report<1>.pdf', mediaType: 'application/pdf', data: pdf },
      ],
    })
    const request = h.client.requests.at(-1)!
    const content = request.payload.messages.at(-1)!.content
    assert.deepEqual(content.slice(-3), [{ type: 'text', text: '<attached_picture name="Screenshot 1.png" />' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text', text: 'what is wrong here?' }])
    const files = content.at(-4)
    assert.ok(files?.type === 'text' && files.text.startsWith('<attached_files>\n--- notes.txt ---\n'))
    assert.match(files.text, /\n\(cut here: the first 20,000 of 20,001 characters came with the message\)\n/)
    assert.match(files.text, /\n--- report1\.pdf ---\nPDF report1\.pdf: 2 pages, titled "Canvas test"\./, 'a PDF is read the way Read reads one, its name kept to one plain line')
    assert.equal(request.requirements.images, true)
    const asked = h.session.history().entries.find((entry) => entry.kind === 'user')
    assert.equal(asked?.text, 'what is wrong here?')
    assert.deepEqual(asked?.attached, [
      { name: 'notes.txt', kind: 'file' },
      { name: 'Screenshot 1.png', kind: 'picture', preview },
      { name: 'report<1>.pdf', kind: 'pdf' },
    ])
  })

  it('tells a model that cannot see pictures where they are, and the person once for each new one (ADR 0113)', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }], client: { images: false } })
    const picture = { name: 'shot.png', mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }
    await h.session.start({ text: 'look', mode: 'code', media: [picture] })
    const sent = h.client.requests.at(-1)!
    assert.equal(sent.requirements.images, false)
    assert.ok(!JSON.stringify(sent.payload.messages).includes('"type":"image"'))
    assert.match(JSON.stringify(sent.payload.messages.at(-1)), /<attached_picture name=\\"shot\.png\\" \/>.*A picture is here, but the model in use cannot see pictures\./)
    const told = () => h.session.history().entries.filter((entry) => entry.kind === 'notice' && /cannot see pictures/.test(entry.text ?? ''))
    assert.equal(told().length, 1)
    assert.match(told()[0].text ?? '', /^scripted cannot see pictures, so it was told where they are but not shown them\./)
    await h.session.start({ text: 'and now?', mode: 'code' })
    assert.equal(told().length, 1, 'the same picture is not told of again')
    await h.session.start({ text: 'another', mode: 'code', media: [picture] })
    assert.equal(told().length, 2)
  })

  it('sends the pictures again as notes, at once, when the model turns out not to read them (ADR 0117)', async () => {
    const client = { images: true as boolean }
    const h = await sessionHarness({
      client,
      // The router sent the picture, the preset's model refused it and is now known not to read pictures.
      script: (_request, step) => {
        if (step > 0) return { text: 'ok' }
        client.images = false
        return { outcome: { kind: 'paused', reason: 'no-model', message: 'None of the models chosen for the main agent that are ready can read images.' } }
      },
    })
    await h.session.start({ text: 'look', mode: 'code', media: [{ name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] })
    const [first, second] = h.client.requests
    assert.equal(h.client.requests.length, 2)
    assert.equal(first.requirements.images, true)
    assert.equal(second.requirements.images, false)
    assert.match(JSON.stringify(second.payload.messages.at(-1)), /A picture is here, but the model in use cannot see pictures\./)
    assert.ok(shown(h).some(([kind, text]) => kind === 'assistant' && text === 'ok'))
    assert.ok(shown(h).some(([kind, text]) => kind === 'notice' && /cannot see pictures/.test(text ?? '')))
  })

  it('notes a new day to the model', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    ;(h.session as unknown as { turn: { date?: string } }).turn.date = '2001-01-01'
    await h.session.start({ text: 'two', mode: 'code' })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.match(users[1], /Today's date is now \d{4}-\d{2}-\d{2}\./)
  })

  it('brings the files and skills a message mentions, and counts a mentioned file as read', async () => {
    const skills = await tempWorkspace({ 'deploy/SKILL.md': '---\ndescription: Ship it\n---\nRun the deploy script.' })
    const h = await sessionHarness({
      files: { 'src/a.ts': 'export const a = 1\n' },
      env: { skills: createSkills(() => [{ dir: skills, source: 'user' }]) },
      scriptFor: (root) => [
        // The file came with the message, so an edit works without a Read first.
        { calls: [{ name: 'Edit', input: { file_path: path.join(root, 'src', 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' } }] },
        { text: 'done' },
        { text: 'again' },
      ],
    })
    await h.session.start({ text: 'use $deploy on @src/a.ts', mode: 'code' })
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'a.ts'), 'utf8'), 'export const a = 2\n')
    const first = text(h.client.requests[0].payload.messages[0])
    assert.match(first, /<mentioned_files>[\s\S]*<file path="src\/a\.ts">\n {5}1\texport const a = 1/)
    assert.match(first, /<invoked_skill name="deploy">[\s\S]*Run the deploy script\./)
    await h.session.start({ text: 'again with $deploy', mode: 'code' })
    const users = h.client.requests.at(-1)!.payload.messages.filter((message) => message.role === 'user').map(text)
    assert.match(users.at(-1)!, /called this skill again/)
    assert.doesNotMatch(users.at(-1)!, /Run the deploy script/)
    // The transcript and the title keep what the user typed.
    assert.equal(h.session.history().entries.find((entry) => entry.kind === 'user')?.text, 'use $deploy on @src/a.ts')
    assert.equal(h.session.summary().title, 'use $deploy on @src/a.ts')
  })

  it('lets a hook refuse a request before the model sees it', async () => {
    const h = await sessionHarness({ hooks: { async userPromptSubmit() { return { block: 'not today' } } }, script: [{ text: 'never' }] })
    const end = await h.session.start({ text: 'go', mode: 'code' })
    assert.equal(end.kind, 'cancelled')
    assert.equal(h.client.requests.length, 0)
    assert.match(h.session.history().entries.at(-1)?.text ?? '', /not today/)
    assert.equal(h.session.status(), 'idle')
  })
})

describe('steering a turn', () => {
  const lastUser = (request: CompletionRequest) => request.payload.messages.at(-1)!

  it('takes a message sent while a step runs with that step\'s results, and shows it where it was taken', async () => {
    // Set from inside the script, which the compiler cannot follow.
    let steered = null as { id: string } | null
    const h = await sessionHarness({
      files: { 'src/a.ts': 'export const a = 1\n' },
      scriptFor: (root) => (_request, step) => {
        if (step === 0) {
          steered = h.session.steer('  use tabs, not spaces  ')
          return { text: 'Reading it.', calls: [{ name: 'Read', input: { file_path: path.join(root, 'src', 'a.ts') } }] }
        }
        return { text: 'Done, with tabs.' }
      },
    })
    const end = await h.session.start({ text: 'tidy src/a.ts', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'Done, with tabs.' })
    assert.ok(steered)

    // The model reads it right after the results of the step it came in during, in the same message.
    const results = lastUser(h.client.requests[1])
    assert.equal(results.role, 'user')
    assert.deepEqual(results.content.map((block) => block.type), ['tool-result', 'text', 'text'])
    assert.match(text(results), /while you were working/)
    assert.match(text(results), /use tabs, not spaces$/)
    assert.deepEqual(h.client.requests[1].payload.messages.map((message) => message.role), ['user', 'assistant', 'user'])

    // The transcript shows it where the turn took it, under the id the caller was given, and keeps it.
    const kinds = () => h.session.history().entries.map((entry) => entry.kind)
    assert.deepEqual(kinds(), ['user', 'assistant', 'tool', 'steer', 'assistant'])
    const entry = h.session.history().entries[3]
    assert.equal(entry.id, steered!.id)
    assert.equal(entry.text, 'use tabs, not spaces')
    await h.reopen()
    assert.deepEqual(kinds(), ['user', 'assistant', 'tool', 'steer', 'assistant'])
  })

  it('answers a message that came in while the reply was written, before the turn ends', async () => {
    const h = await sessionHarness({
      script: (_request, step) => {
        if (step === 0) {
          h.session.steer('and say bye')
          return { text: 'Hello.' }
        }
        return { text: 'Bye.' }
      },
    })
    const end = await h.session.start({ text: 'say hello', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'Bye.' })
    assert.equal(h.client.requests.length, 2)
    const second = h.client.requests[1].payload.messages
    assert.deepEqual(second.map((message) => message.role), ['user', 'assistant', 'user'])
    assert.match(text(second[2]), /while you were working[\s\S]*and say bye$/)
    assert.deepEqual(shown(h), [['user', 'say hello'], ['assistant', 'Hello.'], ['steer', 'and say bye'], ['assistant', 'Bye.']])
  })

  it('takes nothing when no turn runs, nor once the turn is past taking it', async () => {
    let late: { id: string } | null | undefined
    const h = await sessionHarness({
      settings: { completionTool: true },
      script: (_request, step) => {
        // A tool ends this turn: a message sent during its step is left for the next request, not lost unread.
        if (step === 0) {
          late = h.session.steer('one more thing')
          return { calls: [{ name: 'attempt_completion', input: { result: 'All done.' } }] }
        }
        return { text: 'never' }
      },
    })
    assert.equal(h.session.steer('anyone there?'), null)
    assert.throws(() => h.session.steer('   '), /Type a message first/)
    const end = await h.session.start({ text: 'finish up', mode: 'code' })
    assert.equal(end.kind, 'stopped')
    assert.ok(late, 'the turn took the message while it ran')
    assert.equal(h.client.requests.length, 1)
    assert.ok(!h.session.history().entries.some((entry) => entry.kind === 'steer'))
    assert.equal(h.session.steer('too late'), null)
  })

  it('puts a message through the userPromptSubmit hook, and brings what it mentions', async () => {
    const prompts: string[] = []
    const h = await sessionHarness({
      files: { 'src/b.ts': 'export const b = 2\n' },
      hooks: {
        async userPromptSubmit(event) {
          prompts.push(event.prompt)
          return /secret/.test(event.prompt) ? { block: 'no secrets' } : undefined
        },
      },
      script: (_request, step) => {
        if (step === 0) {
          h.session.steer('the secret is 42')
          h.session.steer('look at @src/b.ts too')
          return { calls: [{ name: 'Glob', input: { pattern: '**/*.ts' } }] }
        }
        return { text: 'ok' }
      },
    })
    await h.session.start({ text: 'go', mode: 'code' })
    assert.deepEqual(prompts, ['go', 'the secret is 42', 'look at @src/b.ts too'])
    const sent = text(lastUser(h.client.requests[1]))
    assert.doesNotMatch(sent, /secret/)
    assert.match(sent, /<mentioned_files>[\s\S]*export const b = 2/)
    assert.match(sent, /look at @src\/b\.ts too$/)
    // Both are shown as sent; the refused one with the hook's reason after it.
    const entries = h.session.history().entries
    assert.deepEqual(entries.filter((entry) => entry.kind === 'steer').map((entry) => entry.text), ['the secret is 42', 'look at @src/b.ts too'])
    assert.ok(entries.some((entry) => entry.kind === 'notice' && /A hook refused this message: no secrets/.test(entry.text ?? '')))
  })

  it('gives the request its whole step limit again once it takes a message', async () => {
    const h = await sessionHarness({
      settings: { maxSteps: 2 },
      script: (_request, step) => {
        if (step === 0) h.session.steer('also look at the tests')
        return step < 3 ? { calls: [{ name: 'Glob', input: { pattern: '*' } }] } : { text: 'Both are checked.' }
      },
    })
    const end = await h.session.start({ text: 'look at the source', mode: 'code' })
    // One step before the message and two after it, then the closing reply: not one step after it.
    assert.deepEqual(end, { kind: 'max-steps', steps: 2, reply: 'Both are checked.' })
    assert.deepEqual(h.client.requests.map((request) => request.payload.toolChoice), [undefined, undefined, undefined, 'none'])
  })

  it('drops what a stopped turn did not take', async () => {
    const h = await sessionHarness({ client: { delayMs: 15 }, script: [{ text: 'one two three four five six seven eight nine ten eleven twelve' }, { text: 'next' }] })
    const running = h.session.start({ text: 'talk', mode: 'code' })
    await until(() => h.of('delta')[0])
    assert.ok(h.session.steer('wait'))
    h.session.cancel()
    assert.equal((await running).kind, 'cancelled')
    assert.ok(!h.session.history().entries.some((entry) => entry.kind === 'steer'))
    // The next turn starts clean: nothing left over from the stopped one reaches the model.
    await h.session.start({ text: 'again', mode: 'code' })
    assert.doesNotMatch(text(lastUser(h.client.requests.at(-1)!)), /wait/)
  })

  it('names the entry with the id the caller chose, and refuses an id that is not a fresh UUID', async () => {
    const chosen = '0f8c2b1e-3d4a-4b5c-9d6e-7f8091a2b3c4'
    const h = await sessionHarness({
      script: (_request, step) => {
        if (step === 0) {
          const user = h.session.history().entries[0].id
          assert.throws(() => h.session.steer('x', user), /cannot be used/)
          assert.throws(() => h.session.steer('x', 'not-a-uuid'), /cannot be used/)
          assert.throws(() => h.session.steer('x', chosen.toUpperCase()), /cannot be used/)
          assert.deepEqual(h.session.steer('shorter', chosen), { id: chosen })
          assert.throws(() => h.session.steer('again', chosen), /cannot be used/)
          return { text: 'A long answer.' }
        }
        return { text: 'Short.' }
      },
    })
    await h.session.start({ text: 'explain', mode: 'code' })
    const steer = h.session.history().entries.find((entry) => entry.kind === 'steer')
    assert.equal(steer?.id, chosen)
    // Taken, the id names an entry, so it cannot steer again.
    assert.throws(() => h.session.steer('later', chosen), /cannot be used/)
  })
})

describe('the step limit', () => {
  it('ends with what the agent wrote with tools held back, and says why the request stopped and how it goes on', async () => {
    const h = await sessionHarness({
      settings: { maxSteps: 2 },
      script: (_request, step) => (step < 2 ? { text: 'Looking.', calls: [{ name: 'Glob', input: { pattern: '*' } }] } : { text: 'The setting is in config.json; the server still needs a restart.' }),
    })
    const end = await h.session.start({ text: 'find the setting', mode: 'code' })
    assert.deepEqual(end, { kind: 'max-steps', steps: 2, reply: 'The setting is in config.json; the server still needs a restart.' })
    const entries = h.session.history().entries
    const [answer, notice] = entries.slice(-2)
    assert.deepEqual([answer.kind, answer.text], ['assistant', 'The setting is in config.json; the server still needs a restart.'])
    assert.equal(notice.kind, 'notice')
    assert.equal(notice.stepLimit, 2)
    assert.equal(notice.text, 'Stopped after 2 steps, the most one request may take. The limit is set to 2; unless set, it is 200. Send a message to let it go on.')
    assert.ok(h.of('done').some((event) => event.summary === 'Stopped after 2 steps. Send a follow-up to continue.'))
    // Kept with the conversation.
    await h.reopen()
    assert.equal(h.session.history().entries.at(-1)?.stepLimit, 2)
  })

  it('leaves out how to go on while a goal carries the work on by itself', async () => {
    const h = await sessionHarness({ settings: { maxSteps: 1 }, script: (_request, step) => (step < 1 ? { calls: [{ name: 'Glob', input: { pattern: '*' } }] } : { text: 'Halfway.' }) })
    h.session.setGoal({ text: 'tidy the repo', status: 'active', rounds: 0, createdAt: 1, updatedAt: 1 })
    await h.session.start({ text: 'go', mode: 'code' })
    assert.equal(h.session.history().entries.at(-1)?.text, 'Stopped after 1 step, the most one request may take. The limit is set to 1; unless set, it is 200.')
  })
})

describe('approvals and questions', () => {
  const writeNote = (root: string) => [
    { calls: [{ name: 'Write', input: { file_path: path.join(root, '.encode', 'note.md'), content: 'x' } }] },
    { text: 'done' },
  ]

  it('asks for protected paths, and writes once the user approves', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.equal(h.session.status(), 'awaiting-approval')
    assert.match(request.title, /note\.md/)
    assert.ok(request.preview?.length)
    assert.equal(h.session.resolveApproval(request.id, true), true)
    assert.equal(h.session.resolveApproval(request.id, true), false)
    assert.equal((await running).kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, '.encode', 'note.md'), 'utf8'), 'x')
  })

  it('tells the model when the user refuses', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, false)
    await running
    await assert.rejects(fs.stat(path.join(h.root, '.encode', 'note.md')))
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.state, 'rejected')
    const results = h.client.requests.at(-1)!.payload.messages.at(-1)!
    assert.match(JSON.stringify(results), /rejected this action/)
  })

  it('answers every waiting request when the user stops the agent', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    await until(() => h.of('approval-request')[0])
    h.session.cancel()
    assert.equal((await running).kind, 'cancelled')
    assert.equal(h.session.status(), 'idle')
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.state, 'rejected')
  })

  it('tells the model what the user said when refusing', async () => {
    const h = await sessionHarness({ scriptFor: writeNote })
    const running = h.session.start({ text: 'write', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, { approved: false, note: 'use the docs folder instead' })
    await running
    const tool = h.session.history().entries.find((entry) => entry.kind === 'tool')
    assert.equal(tool?.tool?.output, 'Rejected by user: use the docs folder instead')
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /The user said: use the docs folder instead/)
  })

  it('does not offer to remember a protected folder, and honours "for this session" elsewhere', async () => {
    const outside = await tempWorkspace({ 'one.txt': 'one', 'two.txt': 'two' })
    const h = await sessionHarness({
      script: [
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'one.txt') } }] },
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'one.txt') } }] },
        { calls: [{ name: 'Read', input: { file_path: path.join(outside, 'two.txt') } }] },
        { text: 'read them' },
      ],
    })
    const running = h.session.start({ text: 'read', mode: 'code' })
    const first = await until(() => h.of('approval-request')[0])
    assert.equal(first.request.grantable, true)
    h.session.resolveApproval(first.request.id, { approved: true, remember: 'session' })
    // The same file again runs unasked; another file asks again.
    const second = await until(() => h.of('approval-request')[1])
    assert.match(second.request.title, /two\.txt/)
    h.session.resolveApproval(second.request.id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(h.of('approval-request').length, 2)

    const guarded = await sessionHarness({ scriptFor: writeNote })
    const asked = guarded.session.start({ text: 'write', mode: 'code' })
    const protectedRequest = await until(() => guarded.of('approval-request')[0])
    assert.equal(protectedRequest.request.grantable, false)
    guarded.session.resolveApproval(protectedRequest.request.id, { approved: true, remember: 'session' })
    await asked
    // Remembering was ignored, so a second write there would ask again: nothing was granted.
    assert.equal((guarded.session as unknown as { grants: Set<string> }).grants.size, 0)
  })

  it('keeps several approvals pending at once, and shows them all when the session is opened again', async () => {
    const outside = await tempWorkspace({ 'a.txt': 'a', 'b.txt': 'b' })
    const steps = new Map<string, number>()
    const h = await sessionHarness({
      script: (request) => {
        const who = request.agent ?? 'main'
        const step = steps.get(who) ?? 0
        steps.set(who, step + 1)
        if (!request.agent) {
          return step === 0
            ? {
                calls: ['a', 'b'].map((name) => ({ name: 'Task', input: { description: `Read ${name}`, prompt: name, subagent_type: 'Explore' } })),
              }
            : { text: 'both read' }
        }
        const name = JSON.stringify(request.payload.messages[0]).includes('"a"') ? 'a' : 'b'
        return step === 0 ? { calls: [{ name: 'Read', input: { file_path: path.join(outside, `${name}.txt`) } }] } : { text: `read ${name}` }
      },
    })
    const running = h.session.start({ text: 'read both', mode: 'code' })
    await until(() => h.of('approval-request').length === 2)
    const history = h.session.history()
    assert.equal(history.approvals?.length, 2)
    assert.equal(history.approval?.id, history.approvals?.[0].id)
    assert.equal(history.status, 'awaiting-approval')
    h.session.resolveApproval(history.approvals![0].id, true)
    assert.equal(h.session.status(), 'awaiting-approval')
    assert.equal(h.session.history().approvals?.length, 1)
    h.session.resolveApproval(history.approvals![1].id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(h.session.history().approvals?.length, 0)
    assert.equal(h.session.history().approval, null)
  })

  it('puts a question to the user and passes the answer on', async () => {
    const h = await sessionHarness({
      script: [
        {
          calls: [
            {
              name: 'AskUserQuestion',
              input: {
                questions: [
                  { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'a file' }, { label: 'Postgres' }] },
                ],
              },
            },
          ],
        },
        { text: 'noted' },
      ],
    })
    const running = h.session.start({ text: 'build', mode: 'code' })
    const ask = await until(() => h.of('ask')[0])
    assert.equal(h.session.status(), 'awaiting-user')
    assert.deepEqual(ask.options, ['SQLite', 'Postgres'])
    assert.match(ask.question, /Which database\?[\s\S]*- SQLite: a file/)
    h.session.resolveAnswer(ask.id, 'Postgres')
    await running
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /Postgres/)
  })

  it('leaves a plan with the user, who answers in a new message', async () => {
    const h = await sessionHarness({ script: [{ calls: [{ name: 'ExitPlanMode', input: { plan: '1. Do it' } }] }] })
    const end = await h.session.start({ text: 'plan it', mode: 'plan' })
    assert.equal(end.kind, 'stopped')
    assert.equal(h.session.plan()?.plan, '1. Do it')
    assert.equal(h.of('plan')[0].plan?.plan, '1. Do it')
    assert.equal(h.of('done')[0].summary, 'Plan proposed.')
    await h.reopen()
    assert.equal(h.session.plan()?.plan, '1. Do it')
    h.session.setPlan(null)
    assert.equal(h.session.plan(), null)
    assert.equal(h.of('plan').at(-1)?.plan, null)
  })

  it('can review a plan on the spot, and then carry it out', async () => {
    const h = await sessionHarness({
      env: { reviewPlan: async () => ({ approved: true }) },
      scriptFor: (root) => [
        { calls: [{ name: 'ExitPlanMode', input: { plan: 'write a.txt' } }] },
        { calls: [{ name: 'Write', input: { file_path: path.join(root, 'a.txt'), content: 'a' } }] },
        { text: 'done' },
      ],
    })
    const end = await h.session.start({ text: 'plan and do it', mode: 'plan' })
    assert.equal(end.kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, 'a.txt'), 'utf8'), 'a')
  })
})

describe('plan mode the agent asks for', () => {
  const planFirst = (root: string) => [
    { calls: [{ name: 'EnterPlanMode', input: { reason: 'Three files change.' } }] },
    { calls: [{ name: 'Write', input: { file_path: path.join(root, 'a.txt'), content: 'a' } }] },
    { text: 'Here is my plan.' },
  ]

  it('asks the user, then holds the agent to reading and tells the window', async () => {
    const h = await sessionHarness({ scriptFor: planFirst })
    const running = h.session.start({ text: 'build it', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.equal(request.tool, 'EnterPlanMode')
    assert.equal(request.title, 'Plan before changing anything')
    assert.equal(request.reason, 'Three files change.')
    assert.equal(request.grantable, true)
    h.session.resolveApproval(request.id, true)
    assert.equal((await running).kind, 'done')
    assert.deepEqual(h.of('mode').map((event) => event.mode), ['plan'])
    await assert.rejects(fs.stat(path.join(h.root, 'a.txt')))
    const [, entered, refused] = h.client.requests
    assert.match(JSON.stringify(entered.payload.messages.at(-1)), /You are in plan mode now/)
    assert.match(JSON.stringify(refused.payload.messages.at(-1)), /Write is not available in plan mode/)
    // The tool told the model, so the next request in plan mode does not say it again.
    await h.session.start({ text: 'and the tests?', mode: 'plan' })
    assert.doesNotMatch(text(h.client.requests.at(-1)!.payload.messages.at(-1)!), /Mode: plan/)
  })

  it('goes straight in under Full access, and carries on without a plan when the user says no', async () => {
    const free = await sessionHarness({ settings: { policy: 'full-access' }, scriptFor: planFirst })
    assert.equal((await free.session.start({ text: 'build it', mode: 'code' })).kind, 'done')
    assert.equal(free.of('approval-request').length, 0)
    assert.deepEqual(free.of('mode').map((event) => event.mode), ['plan'])

    const h = await sessionHarness({ script: [{ calls: [{ name: 'EnterPlanMode', input: {} }] }, { text: 'ok' }] })
    const running = h.session.start({ text: 'build it', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, { approved: false, note: 'just do it' })
    await running
    assert.equal(h.of('mode').length, 0)
    const result = JSON.stringify(h.client.requests[1].payload.messages.at(-1))
    assert.match(result, /go ahead without a plan/)
    assert.match(result, /They said: just do it/)
  })

  it('asks once when the user allows it for the session', async () => {
    const h = await sessionHarness({
      script: [{ calls: [{ name: 'EnterPlanMode', input: {} }] }, { text: 'ok' }, { calls: [{ name: 'EnterPlanMode', input: {} }] }, { text: 'ok' }],
    })
    const first = h.session.start({ text: 'one', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    h.session.resolveApproval(request.id, { approved: true, remember: 'session' })
    await first
    await h.session.start({ text: 'two', mode: 'code' })
    assert.equal(h.of('approval-request').length, 1)
    assert.equal(h.of('mode').length, 2)
  })
})

describe('hooks that only look', () => {
  it('tells the Notification hooks what the agent waits for, and that it waits once a turn is over', async () => {
    const seen: NotificationEvent[] = []
    const h = await sessionHarness({
      env: { idleNoticeMs: 20 },
      hooks: {
        async notification(event) {
          seen.push(event)
        },
      },
      scriptFor: (root) => [
        {
          calls: [
            {
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] },
            },
          ],
        },
        { calls: [{ name: 'Write', input: { file_path: path.join(root, '.encode', 'note.md'), content: 'x' } }] },
        { text: 'done' },
        { calls: [{ name: 'ExitPlanMode', input: { plan: '1. Do it' } }] },
      ],
    })
    const running = h.session.start({ text: 'build', mode: 'code' })
    h.session.resolveAnswer((await until(() => h.of('ask')[0])).id, 'Postgres')
    h.session.resolveApproval((await until(() => h.of('approval-request')[0])).request.id, true)
    await running
    await until(() => seen.some((event) => event.kind === 'idle_prompt'))
    await h.session.start({ text: 'plan the next part', mode: 'plan' })
    await until(() => seen.filter((event) => event.kind === 'idle_prompt').length === 2)
    assert.deepEqual(seen.map((event) => event.kind), ['question', 'permission_prompt', 'idle_prompt', 'plan_review', 'idle_prompt'])
    assert.equal(seen[0].message, 'eNCode has a question: Which database?')
    assert.match(seen[1].message, /^eNCode needs your approval: .*note\.md/)
    assert.ok(seen.every((event) => event.sessionId === h.session.id && event.title === 'build' && event.agentId === 'main'))
  })

  it('does not say the agent waits after the user stopped it', async () => {
    const seen: string[] = []
    const h = await sessionHarness({
      env: { idleNoticeMs: 20 },
      hooks: {
        async notification(event) {
          seen.push(event.kind)
        },
      },
      scriptFor: (root) => [{ calls: [{ name: 'Write', input: { file_path: path.join(root, '.encode', 'note.md'), content: 'x' } }] }],
    })
    const running = h.session.start({ text: 'write', mode: 'code' })
    await until(() => h.of('approval-request')[0])
    h.session.cancel()
    assert.equal((await running).kind, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.deepEqual(seen, ['permission_prompt'])
  })

  it('ends a started session for the SessionEnd hooks when it is cleared, deleted or closed', async () => {
    const starts: string[] = []
    const ends: string[][] = []
    const hooks: AgentHooks = {
      async sessionStart(event) {
        starts.push(event.source)
      },
      async sessionEnd(event) {
        assert.ok(event.signal instanceof AbortSignal)
        ends.push([event.reason, event.detail])
      },
    }
    const h = await sessionHarness({ hooks, script: [{ text: 'ok' }] })
    await h.session.start({ text: 'one', mode: 'code' })
    await h.session.reset()
    await h.session.start({ text: 'two', mode: 'code' })
    await h.session.dispose('deleted')
    await h.session.dispose('quit')
    assert.deepEqual(starts, ['new', 'clear'])
    assert.deepEqual(ends, [['clear', 'cleared'], ['other', 'deleted']])

    // A session that never ran a request in this process never started, so nothing ends.
    const idle = await sessionHarness({ hooks, script: [{ text: 'ok' }] })
    await idle.session.reset()
    await idle.session.dispose('quit')
    assert.equal(ends.length, 2)

    const quitting = await sessionHarness({ hooks, script: [{ text: 'ok' }] })
    await quitting.session.start({ text: 'one', mode: 'code' })
    await quitting.session.dispose('quit')
    assert.deepEqual(ends.at(-1), ['prompt_input_exit', 'quit'])
  })
})

describe('what a session keeps', () => {
  it('keeps the task list and the goal across a restart', async () => {
    const h = await sessionHarness({
      script: [
        { calls: [{ name: 'TodoWrite', input: { todos: [{ content: 'Write it', activeForm: 'Writing it', status: 'in_progress' }] } }, { name: 'CreateGoal', input: { goal: 'Finish the job' } }] },
        { text: 'ok' },
      ],
    })
    await h.session.start({ text: 'go', mode: 'code' })
    assert.deepEqual(h.of('todos').at(-1)?.todos.map((todo) => [todo.text, todo.status]), [['Write it', 'in_progress']])
    assert.equal(h.of('goal').at(-1)?.goal?.text, 'Finish the job')
    await h.reopen()
    assert.equal(h.session.todos()[0].text, 'Write it')
    assert.equal(h.session.goal()?.status, 'active')
  })

  it('starts the conversation over on reset, keeping the title, goal and tasks', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'first request', mode: 'code' })
    h.session.setGoal({ text: 'A goal', status: 'active', rounds: 2, createdAt: 1, updatedAt: 1 })
    h.session.setTodos([{ id: 'a', text: 'Task', status: 'pending' }])
    await h.session.reset()
    assert.deepEqual(h.session.history().entries, [])
    assert.equal(h.of('session-reset').length, 1)
    assert.equal(h.session.summary().title, 'first request')
    await h.reopen()
    assert.deepEqual(h.session.history().entries, [])
    assert.equal(h.session.goal()?.text, 'A goal')
    assert.equal(h.session.todos().length, 1)
    await h.session.start({ text: 'second request', mode: 'code' })
    assert.equal(h.client.requests[1].payload.messages.length, 1)
  })

  it('goes back to before a request, and hands its text back', async () => {
    const h = await sessionHarness({ script: [{ text: 'answer' }] })
    await h.session.start({ text: 'first', mode: 'code' })
    await h.session.start({ text: 'second', mode: 'code' })
    const second = h.session.history().entries.filter((entry) => entry.kind === 'user')[1]
    assert.deepEqual(await h.session.rewind(second.id), { text: 'second' })
    assert.deepEqual(shown(h), [['user', 'first'], ['assistant', 'answer']])
    await h.session.start({ text: 'other', mode: 'code' })
    assert.deepEqual(
      h.client.requests.at(-1)!.payload.messages.map((message) => message.role),
      ['user', 'assistant', 'user'],
    )
    await h.reopen()
    assert.deepEqual(shown(h).map(([kind]) => kind), ['user', 'assistant', 'user', 'assistant'])
    await assert.rejects(h.session.rewind('nope'), /not in this session/)
  })

  it('renames, and shortens a long first request into a title', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: `${'word '.repeat(40)}\nsecond line`, mode: 'code' })
    assert.ok(h.session.summary().title.length <= 60)
    assert.ok(h.session.summary().title.endsWith('…'))
    await h.session.rename('  A better name  ')
    assert.equal((await h.store.list()).find((session) => session.id === h.session.id)?.title, 'A better name')
  })

  it('summarizes the conversation on request', async () => {
    const h = await sessionHarness({ script: (request) => (request.role === 'summarizer' ? { text: 'THE SUMMARY' } : { text: 'ok' }) })
    for (const prompt of ['one', 'two', 'three']) await h.session.start({ text: prompt, mode: 'code' })
    const result = await h.session.compact('keep file names')
    assert.ok(result.removed > 0)
    assert.match(JSON.stringify(h.client.requests.find((request) => request.role === 'summarizer')?.payload.messages), /keep file names/)
    await h.reopen()
    await h.session.start({ text: 'four', mode: 'code' })
    assert.match(text(h.client.requests.at(-1)!.payload.messages[0]), /THE SUMMARY/)
    // The transcript the user sees keeps everything.
    assert.equal(h.session.history().entries.filter((entry) => entry.kind === 'user').length, 4)
  })

  it('keeps the project, pin, archive and unread marks apart from the conversation', async () => {
    const h = await sessionHarness({ script: [{ text: 'A reply with `code` and **bold** text.' }] })
    await h.session.start({ text: 'hello', mode: 'code' })
    const before = h.session.summary()
    assert.equal(before.projectRoot, h.root)
    assert.equal(before.entryCount, 2)
    assert.equal(before.preview, 'A reply with code and bold text.')

    await h.session.update({ pinned: true, unread: true, projectRoot: null, bogus: 1, title: 'Renamed' })
    await h.session.update({ archived: true })
    const after = h.session.summary()
    assert.deepEqual([after.pinned, after.archived, after.unread, after.projectRoot, after.title], [false, true, true, null, 'Renamed'])
    assert.equal((await h.store.list({ root: null })).length, 1)
    assert.equal((await h.store.list({ root: h.root })).length, 0)

    await h.reopen()
    assert.deepEqual([h.session.summary().archived, h.session.summary().unread, h.session.summary().projectRoot], [true, true, null])
    const updatedAt = h.session.summary().updatedAt
    await h.session.update({ unread: false })
    assert.equal(h.session.summary().updatedAt, updatedAt)
  })

  it('names the model on each reply', async () => {
    const h = await sessionHarness({ script: [{ text: 'hi' }] })
    await h.session.start({ text: 'hello', mode: 'code' })
    assert.equal(h.session.history().entries.find((entry) => entry.kind === 'assistant')?.model, 'scripted')
  })

  it('exports the transcript', async () => {
    const h = await sessionHarness({ script: [{ text: 'ok' }] })
    await h.session.start({ text: 'export me', mode: 'code' })
    const data = h.session.exportData()
    assert.equal(data.title, 'export me')
    assert.match(data.transcript, /^# export me\n\n## user\n\nexport me/)
    assert.equal(JSON.parse(data.json).entries.length, 2)
  })
})

describe('naming a session', () => {
  const FIRST = 'Create a short note that says hello from eNCode'
  /** The main model answers "ok"; the utility model answers with `title`, which a function can also compute. */
  const script = (title: string | ((request: CompletionRequest) => string)) => (request: CompletionRequest) => ({
    text: request.role === 'utility' ? (typeof title === 'string' ? title : title(request)) : 'ok',
  })
  const naming = (h: SessionHarness) => h.client.requests.filter((request) => request.role === 'utility')

  it('replaces the first words with a short name once the first turn is over, with one small call', async () => {
    const h = await sessionHarness({ script: script('"Hello note."'), env: { nameSessions: true } })
    await h.session.start({ text: FIRST, mode: 'code' })
    await h.session.named()
    assert.equal(h.session.summary().title, 'Hello note')
    assert.deepEqual(h.of('title').map((event) => event.title), [FIRST, 'Hello note'])
    assert.equal((await h.store.list()).find((session) => session.id === h.session.id)?.title, 'Hello note')

    const [call] = naming(h)
    assert.equal(naming(h).length, 1)
    assert.equal(call.tool, 'Title')
    assert.ok(call.payload.maxOutputTokens! <= 24)
    assert.deepEqual(call.payload.tools, [])
    assert.equal(call.requirements.tools, false)
    assert.equal(text(call.payload.messages[0]), FIRST)
    // The conversation the agent works on is untouched by it.
    assert.deepEqual(shown(h), [['user', FIRST], ['assistant', 'ok']])
    assert.ok(h.client.requests.filter((request) => request.role !== 'utility').every((request) => !JSON.stringify(request.payload).includes('Title')))
  })

  it('keeps the first words when the model gives no usable name', async () => {
    const sentence = 'I would name this conversation a short note about saying hello to the world'
    for (const reply of ['', sentence]) {
      const h = await sessionHarness({ script: script(reply), env: { nameSessions: true } })
      await h.session.start({ text: FIRST, mode: 'code' })
      await h.session.named()
      assert.equal(h.session.summary().title, FIRST)
      assert.equal(naming(h).length, 1)
    }
  })

  it('keeps the first words when no model can answer, and the turn still ends well', async () => {
    const h = await sessionHarness({
      script: (request) => (request.role === 'utility' ? { outcome: { kind: 'paused', reason: 'rate-limit', message: 'Slow down.' } } : { text: 'ok' }),
      env: { nameSessions: true },
    })
    const end = await h.session.start({ text: FIRST, mode: 'code' })
    await h.session.named()
    assert.deepEqual(end, { kind: 'done', reply: 'ok' })
    assert.equal(h.session.summary().title, FIRST)
    assert.equal(h.session.history().status, 'done')
  })

  it('does not rename over a name the user chose meanwhile', async () => {
    let h!: SessionHarness
    h = await sessionHarness({
      script: script(() => {
        void h.session.rename('My own name')
        return 'Hello note'
      }),
      env: { nameSessions: true },
    })
    await h.session.start({ text: FIRST, mode: 'code' })
    await h.session.named()
    assert.equal(h.session.summary().title, 'My own name')
  })

  it('does not spend a call on a message that is short enough to be a title, or on a command', async () => {
    for (const first of ['Hi', 'fix the build', '/compact']) {
      const h = await sessionHarness({ script: script('A name'), env: { nameSessions: true } })
      await h.session.start({ text: first, mode: 'code' })
      await h.session.named()
      assert.equal(naming(h).length, 0, first)
      assert.equal(h.session.summary().title, first)
    }
  })

  it('names a session once, not again after later turns, and not a session that already has a name', async () => {
    const h = await sessionHarness({ script: script('Hello note'), env: { nameSessions: true } })
    await h.session.start({ text: FIRST, mode: 'code' })
    await h.session.named()
    await h.session.start({ text: 'And now write a second note about the weather today', mode: 'code' })
    await h.session.named()
    assert.equal(naming(h).length, 1)
    assert.equal(h.session.summary().title, 'Hello note')

    const reopened = await h.reopen()
    await reopened.start({ text: 'And a third one, about the sea this time of the year', mode: 'code' })
    await reopened.named()
    assert.equal(naming(h).length, 1)
  })

  it('is off when the program around the session says so', async () => {
    const h = await sessionHarness({ script: script('Hello note') })
    await h.session.start({ text: FIRST, mode: 'code' })
    await h.session.named()
    assert.equal(naming(h).length, 0)
    assert.equal(h.session.summary().title, FIRST)
  })

  it('does not name a turn that was stopped before it finished', async () => {
    const h = await sessionHarness({ script: [{ text: 'a long answer that never arrives' }], client: { delayMs: 50 }, env: { nameSessions: true } })
    const run = h.session.start({ text: FIRST, mode: 'code' })
    await until(() => h.session.isRunning())
    h.session.cancel()
    await run
    await h.session.named()
    assert.equal(naming(h).length, 0)
  })
})

describe('subagents', () => {
  const scripted = (calls: { name: string; input: Record<string, unknown> }[]) => {
    let main = 0
    let sub = 0
    return (request: { agent?: string }) => {
      if (request.agent) return sub++ === 0 ? { calls } : { text: 'Found a.txt' }
      return main++ === 0 ? { calls: [{ name: 'Task', input: { description: 'Look around', prompt: 'List the files', subagent_type: 'Explore' } }] } : { text: 'all done' }
    }
  }

  it('runs a subagent on its own conversation and returns its report', async () => {
    const h = await sessionHarness({ files: { 'a.txt': 'a' }, script: scripted([{ name: 'Glob', input: { pattern: '*.txt' } }]) })
    const end = await h.session.start({ text: 'explore', mode: 'code' })
    assert.deepEqual(end, { kind: 'done', reply: 'all done' })
    assert.deepEqual(h.client.requests.map((request) => request.role), ['main', 'explore', 'explore', 'main'])
    const subagent = h.client.requests[1]
    assert.deepEqual(subagent.payload.tools.map((tool) => tool.name).sort(), ['Bash', 'BashOutput', 'CodeMap', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'])
    assert.equal(subagent.payload.messages.length, 1)
    assert.match(text(subagent.payload.messages[0]), /List the files/)
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /Found a\.txt/)
    // Only the main agent's messages are in the session's log.
    await h.reopen()
    assert.equal(shown(h).filter(([kind]) => kind === 'tool').length, 1)
  })

  it('sends a subagent\'s approvals to the user under the Task call', async () => {
    const h = await sessionHarness({
      script: (request: { agent?: string }, step) => {
        void step
        // The subagent's first step writes, its second reports. (Its id is random, so the steps are counted.)
        if (request.agent) return h.client.requests.filter((item) => item.agent).length === 1
          ? { calls: [{ name: 'Write', input: { file_path: path.join(h.root, '.encode', 'sub.md'), content: 'y' } }] }
          : { text: 'wrote it' }
        return h.client.requests.filter((item) => !item.agent).length === 1
          ? { calls: [{ name: 'Task', input: { description: 'Write a note', prompt: 'Write it', subagent_type: 'general-purpose' } }] }
          : { text: 'ok' }
      },
    })
    const running = h.session.start({ text: 'delegate', mode: 'code' })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.match(request.title, /^Subagent: /)
    const task = h.session.history().entries.find((entry) => entry.tool?.name === 'Task')
    assert.equal(request.entryId, task?.id)
    h.session.resolveApproval(request.id, true)
    assert.equal((await running).kind, 'done')
    assert.equal(await fs.readFile(path.join(h.root, '.encode', 'sub.md'), 'utf8'), 'y')
  })

  it('starts a subagent with what the SubagentStart hooks add, before its brief', async () => {
    const types: string[] = []
    const h = await sessionHarness({
      files: { 'a.txt': 'a' },
      hooks: {
        async subagentStart(event) {
          types.push(event.agentType)
          return { context: 'Only look in src.' }
        },
      },
      script: scripted([{ name: 'Glob', input: { pattern: '*.txt' } }]),
    })
    assert.equal((await h.session.start({ text: 'explore', mode: 'code' })).kind, 'done')
    assert.deepEqual(types, ['Explore'])
    const first = h.client.requests[1].payload.messages[0]
    assert.equal(first.content.length, 2)
    assert.match(text(first), /Only look in src\.[\s\S]*List the files/)
  })

  it('offers the agents the user defines', async () => {
    const h = await sessionHarness({
      files: { '.encode/agents/linter.md': '---\ndescription: Checks style.\ntools: Read, Grep, Task\n---\nBe strict.' },
      script: [{ text: 'ok' }],
      env: {},
    })
    h.env.agentSources = () => [{ dir: path.join(h.root, '.encode', 'agents'), source: 'workspace' }]
    await h.session.start({ text: 'go', mode: 'code' })
    const task = h.client.requests[0].payload.tools.find((tool) => tool.name === 'Task')
    assert.match(task?.description ?? '', /- linter: Checks style\. \(tools: Read, Grep, Task\)/)
  })
})

describe('without a shell', () => {
  it('works for everything else and tells the model why commands fail', async () => {
    const h = await sessionHarness({
      settings: { policy: 'full-access' },
      createShell: () => {
        throw new Error('No shell was found.')
      },
      script: [{ calls: [{ name: 'Bash', input: { command: 'ls' } }] }, { text: 'sorry' }],
    })
    const end = await h.session.start({ text: 'list', mode: 'code' })
    assert.equal(end.kind, 'done')
    assert.ok(h.session.history().entries.some((entry) => entry.kind === 'notice' && /Commands cannot run/.test(entry.text ?? '')))
    assert.match(JSON.stringify(h.client.requests.at(-1)!.payload.messages.at(-1)), /No shell was found/)
  })
})
