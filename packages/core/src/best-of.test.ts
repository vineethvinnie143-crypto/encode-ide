/**
 * Best of N (ADR 0098): the attempts side by side in their worktrees, the Reviewer's verdict and the fallback by the
 * checks, the card, and what keeping one or discarding them all does to the project and the next request.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { CompletionRequest, Message, ModelClient } from '@encode/providers'
import { attemptCount, bestPrompt, fallbackPick, keepAttempt, onlyInside, parseBest } from './best-of'
import { createScriptedClient, type ScriptedStep } from './scripted'
import type { ManagedShell } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { closeHarnesses, sessionHarness, stubManagedShell, type SessionHarness } from './testing'
import type { BestAttempt, ConversationEntry, EntryBest } from './ui'
import type { WorktreeGit } from './worktrees'

after(closeHarnesses)

async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const textOf = (message: Message): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? JSON.stringify(block.content) : '')).join('\n')
const lastUser = (request: CompletionRequest) => textOf(request.payload.messages.at(-1)!)

/** The files under `dir`, relative with `/`, without the worktrees. */
async function filesIn(dir: string, base = ''): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name
    if (relative === '.encode-worktrees') continue
    if (entry.isDirectory()) for (const [file, bytes] of await filesIn(dir, relative)) out.set(file, bytes)
    else out.set(relative, await fs.readFile(path.join(dir, relative)))
  }
  return out
}

/** git as best of N sees it: real folders, the seed kept in memory. */
function seedingGit(options: { unavailable?: string } = {}) {
  const removed: string[] = []
  const seeds = new Map<string, Map<string, Buffer>>()
  const git: Required<WorktreeGit> = {
    unavailable: async () => options.unavailable,
    async create(root, name) {
      const folder = path.join(root, '.encode-worktrees', name)
      await fs.mkdir(folder, { recursive: true })
      return { name, path: await fs.realpath(folder), branch: `encode/${name}`, base: 'a'.repeat(40) }
    },
    work: async () => ({ changed: [], commits: 0 }),
    async remove(_root, worktree) {
      removed.push(worktree.name)
      await fs.rm(worktree.path, { recursive: true, force: true })
    },
    async seed(root, worktree) {
      const files = await filesIn(root)
      for (const [file, bytes] of files) {
        await fs.mkdir(path.dirname(path.join(worktree.path, file)), { recursive: true })
        await fs.writeFile(path.join(worktree.path, file), bytes)
      }
      seeds.set(worktree.path, files)
      return { base: 'b'.repeat(40), linked: [] }
    },
    async changes(worktree) {
      const seed = seeds.get(worktree.path) ?? new Map()
      const now = await filesIn(worktree.path)
      const out: { path: string; kind: 'added' | 'modified' | 'deleted' }[] = []
      for (const [file, bytes] of now) if (!seed.has(file)) out.push({ path: file, kind: 'added' })
      else if (!seed.get(file)!.equals(bytes)) out.push({ path: file, kind: 'modified' })
      for (const file of seed.keys()) if (!now.has(file)) out.push({ path: file, kind: 'deleted' })
      return out.sort((a, b) => (a.path < b.path ? -1 : 1))
    },
    original: async (worktree, _seed, file) => seeds.get(worktree.path)?.get(file) ?? null,
    unlink: async () => undefined,
  }
  return { git, removed }
}

const verdict = (best: number, reason = 'It adds; the other subtracts.') => ({ text: '```json\n' + JSON.stringify({ best, reason, notes: { 1: 'Subtracts instead of adding.', 2: 'Adds, as asked.' } }) + '\n```' })

/** Each attempt by its own steps, the Reviewer's verdict, and the main agent's answers. */
function routed(attempts: Record<number, ScriptedStep[]>, judge: ScriptedStep = verdict(2), main: ScriptedStep = { text: 'Noted.' }) {
  const seen: Record<string, CompletionRequest[]> = {}
  const script = (request: CompletionRequest): ScriptedStep => {
    const who = request.tool === 'BestOf' ? 'judge' : (request.agent ?? 'main')
    const list = (seen[who] ??= [])
    list.push(request)
    if (who === 'judge') return judge
    if (who === 'main') return main
    const steps = attempts[Number(who.split('-')[1])] ?? [{ text: 'Nothing to do.' }]
    return steps[Math.min(list.length - 1, steps.length - 1)]
  }
  return { script, seen }
}

const sum = (sign: '+' | '-') => `export const sum = (a: number, b: number) => a ${sign} b\n`
const writes = (file: string, content: string, reply: string): ScriptedStep[] => [{ calls: [{ name: 'Write', input: { file_path: file, content } }] }, { text: reply }]
const cardOf = (h: SessionHarness): ConversationEntry & { best: EntryBest } => h.session.history().entries.find((entry) => entry.best) as ConversationEntry & { best: EntryBest }

/** A shell that moves where it is told, as each attempt's must. */
function movable(root: string): ManagedShell {
  let cwd = root
  return {
    ...stubManagedShell(root),
    state: () => ({ cwd, env: {}, dialect: 'bash' }),
    setCwd: async (dir) => {
      cwd = path.resolve(root, dir)
      return true
    },
  }
}

async function harness(attempts: Record<number, ScriptedStep[]>, options: { judge?: ScriptedStep; git?: ReturnType<typeof seedingGit>; client?: (inner: ModelClient) => ModelClient; policy?: 'full-access' | 'workspace-write' } = {}) {
  const fake = options.git ?? seedingGit()
  const route = routed(attempts, options.judge)
  const inner = createScriptedClient(route.script)
  const h = await sessionHarness({
    files: { 'src/one.ts': 'export const one = 1\n', 'README.md': '# App\n' },
    settings: { policy: options.policy ?? 'full-access' },
    createShell: movable,
    env: { worktrees: fake.git, client: options.client ? options.client(inner) : inner },
  })
  return { h, fake, seen: route.seen }
}

describe('best of N', () => {
  it('makes the attempts side by side in worktrees, has them judged, and changes nothing before the person keeps one', async () => {
    const { h, fake, seen } = await harness({ 1: writes('src/sum.ts', sum('-'), 'Wrote sum.'), 2: writes('src/sum.ts', sum('+'), 'Wrote sum, adding.') })
    const end = await h.session.start({ text: 'Add a sum function', mode: 'code', best: 2 })
    assert.deepEqual(end, { kind: 'done', reply: 'Attempt 2 looks best.' })
    await assert.rejects(fs.stat(path.join(h.root, 'src', 'sum.ts')), 'the project is unchanged')

    const card = cardOf(h)
    assert.equal(card.kind, 'notice')
    assert.equal(card.best.state, 'ready')
    assert.deepEqual([card.best.pick, card.best.pickedBy, card.best.reason], [2, 'reviewer', 'It adds; the other subtracts.'])
    assert.deepEqual(
      card.best.attempts.map((attempt) => [attempt.n, attempt.state, attempt.reply, attempt.files, attempt.note, attempt.steps]),
      [
        [1, 'done', 'Wrote sum.', [{ path: 'src/sum.ts', kind: 'added', added: 1, removed: 0 }], 'Subtracts instead of adding.', 1],
        [2, 'done', 'Wrote sum, adding.', [{ path: 'src/sum.ts', kind: 'added', added: 1, removed: 0 }], 'Adds, as asked.', 1],
      ],
    )
    for (const attempt of card.best.attempts) assert.ok(attempt.worktree?.path.includes(`${path.sep}.encode-worktrees${path.sep}best-`), 'kept until the person decides')

    // Each attempt: the main agent's request, a note of its own, and none of the tools only the main agent has.
    const first = seen['attempt-1'][0]
    assert.match(first.payload.system.map((part) => part.text).join('\n'), /You are one attempt of several[\s\S]*attempt 1\b[\s\S]*Change only your copy/)
    assert.match(lastUser(first), /Add a sum function/)
    const tools = first.payload.tools.map((tool) => tool.name)
    for (const name of ['Task', 'AskUserQuestion', 'EnterWorktree', 'TodoWrite', 'LSP']) assert.ok(!tools.includes(name), name)
    assert.ok(tools.includes('Write') && tools.includes('Bash'))

    // The Reviewer: both attempts, numbered, with no tools.
    const [judge] = seen.judge
    assert.deepEqual([judge.role, judge.payload.tools.length], ['reviewer', 0])
    const prompt = lastUser(judge)
    assert.match(prompt, /<attempt-[0-9a-f]+ n="1">[\s\S]*Its reply:[\s\S]*Wrote sum\.[\s\S]*\+1 \| export const sum = \(a: number, b: number\) => a - b/)
    assert.match(prompt, /<attempt-[0-9a-f]+ n="2">[\s\S]*\+1 \| export const sum = \(a: number, b: number\) => a \+ b/)

    assert.deepEqual(await h.session.answerBest(card.id, 2), { ok: true, files: ['src/sum.ts'] })
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'sum.ts'), 'utf8'), sum('+'))
    assert.deepEqual(fake.removed.length, 2, 'every worktree is removed')
    assert.deepEqual([cardOf(h).best.state, cardOf(h).best.kept], ['kept', 2])
    assert.ok(h.of('file-changed').some((event) => event.path === path.join(h.root, 'src', 'sum.ts')))
    assert.deepEqual(await h.session.answerBest(card.id, 1), { ok: false, error: 'These attempts were already answered.' })

    // The next request knows what was tried and what the person kept.
    await h.session.start({ text: 'Thanks', mode: 'code' })
    const next = seen.main.at(-1)!
    const all = next.payload.messages.map(textOf).join('\n')
    assert.match(all, /eNCode made 2 attempts at this request[\s\S]*Attempt 2 \(picked\): finished; changed src\/sum\.ts/)
    assert.match(lastUser(next), /The person kept attempt 2 of the request "Add a sum function": its changes are now in the project \(src\/sum\.ts\)/)
  })

  it('writes an attempt only into its own copy, finds a file the person changed meanwhile, and discards', async () => {
    const fake = seedingGit()
    let root = ''
    // The project's folder is made with the harness: the step reads it when the attempt asks.
    const outside = {
      get calls() {
        return [{ name: 'Write', input: { file_path: path.join(root, 'notes.md'), content: 'from attempt 1\n' } }]
      },
    } as ScriptedStep
    const { h, seen } = await harness({ 1: [outside, ...writes('notes.md', 'from attempt 1\n', 'Wrote notes.')], 2: writes('notes.md', 'from attempt 2\nand more\n', 'Wrote notes.') }, { judge: { text: 'I cannot decide.' }, git: fake })
    root = h.root
    await h.session.start({ text: 'Write notes', mode: 'code', best: 2 })
    await assert.rejects(fs.stat(path.join(h.root, 'notes.md')), 'the write outside the attempt was refused')
    assert.match(JSON.stringify(seen['attempt-1'][1].payload.messages.at(-1)), /changes only its own copy of the project/)
    const card = cardOf(h)
    // No verdict to read: the checks say nothing, so the smaller change wins.
    assert.deepEqual([card.best.state, card.best.pick, card.best.pickedBy], ['ready', 1, 'checks'])
    assert.match(card.best.reason ?? '', /the Reviewer gave no verdict\. \(its answer could not be read\.\)/)

    await fs.writeFile(path.join(h.root, 'notes.md'), 'the person wrote this\n')
    const refused = await h.session.answerBest(card.id, 1)
    assert.deepEqual(refused, { ok: false, error: 'notes.md was changed in the project after the attempts started.', conflicts: ['notes.md'] })
    assert.equal(await fs.readFile(path.join(h.root, 'notes.md'), 'utf8'), 'the person wrote this\n')
    assert.equal(cardOf(h).best.state, 'ready', 'still open')

    assert.deepEqual(await h.session.answerBest(card.id, 'discard'), { ok: true })
    assert.equal(cardOf(h).best.state, 'discarded')
    assert.equal(await fs.readFile(path.join(h.root, 'notes.md'), 'utf8'), 'the person wrote this\n')
    assert.equal(fake.removed.length, 2)
    for (const attempt of cardOf(h).best.attempts) assert.equal(attempt.worktree, undefined)
  })

  it('keeps an attempt over the person’s change when told to', async () => {
    // Writing over a file the attempt did not read is refused, so each reads it first.
    const read = (n: number, content: string): ScriptedStep[] => [{ calls: [{ name: 'Read', input: { file_path: 'README.md' } }] }, ...writes('README.md', content, `Attempt ${n} done.`)]
    const { h } = await harness({ 1: read(1, '# App\n\nUsage.\n'), 2: read(2, '# App\n\nOther.\n') }, { judge: verdict(1) })
    await h.session.start({ text: 'Add usage to the README', mode: 'code', best: 2 })
    const card = cardOf(h)
    assert.deepEqual(card.best.attempts[0].files, [{ path: 'README.md', kind: 'modified', added: 2, removed: 0 }])
    await fs.writeFile(path.join(h.root, 'README.md'), '# Mine\n')
    assert.equal((await h.session.answerBest(card.id, 1)).ok, false)
    assert.deepEqual(await h.session.answerBest(card.id, 1, true), { ok: true, files: ['README.md'] })
    assert.equal(await fs.readFile(path.join(h.root, 'README.md'), 'utf8'), '# App\n\nUsage.\n')
  })

  it('keeps an attempt through the checkpoints, as one call of eNCode’s under the request', async () => {
    const change = (sign: '+' | '-'): ScriptedStep[] => [{ calls: [{ name: 'Read', input: { file_path: 'src/sum.ts' } }] }, ...writes('src/sum.ts', sum(sign), 'Done.')]
    const route = routed({ 1: change('-'), 2: change('+') })
    const recorded: { file: string; previous: string | null; turnId: string; toolUseId: string }[] = []
    const wrote: string[] = []
    const h = await sessionHarness({
      files: { 'src/sum.ts': 'export const sum = 0\n' },
      settings: { policy: 'full-access' },
      createShell: movable,
      env: {
        worktrees: seedingGit().git,
        client: createScriptedClient(route.script),
        beforeWrite: async (file, previous, info) => void recorded.push({ file, previous: previous?.toString('utf8') ?? null, ...info }),
        checkpoints: {
          info: async () => ({ available: true, turns: [], canUndo: false }),
          plan: async (turn) => ({ kind: 'rewind', turn, known: true, files: [], fingerprint: '' }),
          planRedo: async () => null,
          apply: async () => ({ ok: false, reason: 'unavailable', message: 'Not in this test.' }),
          wrote: async (toolUseId) => void wrote.push(toolUseId),
        },
      },
    })
    await h.session.start({ text: 'Make sum add', mode: 'code', best: 2 })
    assert.equal(recorded.length, 0, 'an attempt writes its own copy, which the checkpoints do not record')
    assert.deepEqual(await h.session.answerBest(cardOf(h).id, 2), { ok: true, files: ['src/sum.ts'] })
    const request = h.session.history().entries.find((entry) => entry.kind === 'user')!
    assert.deepEqual(
      recorded.map(({ file, previous, turnId }) => ({ file, previous, turnId })),
      [{ file: path.join(h.root, 'src', 'sum.ts'), previous: 'export const sum = 0\n', turnId: request.id }],
    )
    assert.match(recorded[0].toolUseId, /^best-of-2-[0-9a-f]{12}$/)
    assert.deepEqual(wrote, [recorded[0].toolUseId], 'what the keep left is recorded once it is written')
    assert.equal(await fs.readFile(path.join(h.root, 'src', 'sum.ts'), 'utf8'), sum('+'))
  })

  it('asks the person under the card, labelled with the attempt', async () => {
    const bash: ScriptedStep[] = [{ calls: [{ name: 'Bash', input: { command: 'echo hi > out.txt', description: 'Write a file' } }] }, { text: 'Ran it.' }]
    const { h } = await harness({ 1: bash, 2: [{ text: 'Nothing needed.' }] }, { policy: 'workspace-write' })
    const running = h.session.start({ text: 'Run it', mode: 'code', best: 2 })
    const { request } = await until(() => h.of('approval-request')[0])
    assert.match(request.title, /^Attempt 1: /)
    assert.equal(request.entryId, cardOf(h).id)
    h.session.resolveApproval(request.id, false)
    await running
    // Neither attempt changed a file: there is nothing to keep, and nothing is left behind.
    const card = cardOf(h)
    assert.deepEqual([card.best.state, card.best.error], ['failed', 'No attempt changed a file, so there is nothing to keep.'])
    for (const attempt of card.best.attempts) assert.equal(attempt.worktree, undefined)
  })

  it('removes the worktrees when the person stops the attempts', async () => {
    const fake = seedingGit()
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (started = resolve))
    const { h } = await harness(
      { 1: writes('a.ts', 'a\n', 'Done.'), 2: writes('a.ts', 'b\n', 'Done.') },
      {
        git: fake,
        client: (inner) => ({
          ...inner,
          complete: async (request) => {
            if (request.agent !== 'attempt-2') return inner.complete(request)
            started()
            await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
            throw request.signal.reason
          },
        }),
      },
    )
    const running = h.session.start({ text: 'Do it', mode: 'code', best: 2 })
    await waiting
    h.session.cancel()
    assert.deepEqual(await running, { kind: 'cancelled' })
    assert.equal(cardOf(h).best.state, 'discarded')
    assert.equal(fake.removed.length, 2)
    await assert.rejects(fs.stat(path.join(h.root, 'a.ts')))
  })

  it('says plainly when it cannot run', async () => {
    const { h } = await harness({})
    await assert.rejects(h.session.start({ text: 'Explain this', mode: 'ask', best: 2 }), /runs in Code mode/)
    const { h: none } = await harness({}, { git: seedingGit({ unavailable: 'This folder is not a git repository.' }) })
    await assert.rejects(none.session.start({ text: 'Do it', mode: 'code', best: 2 }), /Best of N makes a git worktree for each attempt\. This folder is not a git repository\./)
    const plain = await sessionHarness({ env: { worktrees: { ...seedingGit().git, seed: undefined } } })
    await assert.rejects(plain.session.start({ text: 'Do it', mode: 'code', best: 3 }), /needs git worktrees/)
  })

  it('removes the attempts a reset takes out of the conversation', async () => {
    const { h, fake } = await harness({ 1: writes('x.ts', 'x\n', 'Done.'), 2: writes('x.ts', 'y\n', 'Done.') })
    await h.session.start({ text: 'Make x', mode: 'code', best: 2 })
    assert.equal(fake.removed.length, 0)
    await h.session.reset()
    assert.equal(fake.removed.length, 2)
  })

  it('leaves the attempts of a run eNCode closed in the middle of to be discarded after a restart', async () => {
    const { h, fake } = await harness({ 1: writes('x.ts', 'x\n', 'Done.'), 2: writes('x.ts', 'y\n', 'Done.') })
    await h.session.start({ text: 'Make x', mode: 'code', best: 2 })
    const card = cardOf(h)
    // As the log would hold it had eNCode closed while the attempts ran.
    const running: ConversationEntry = structuredClone({ ...card, best: { ...card.best, state: 'running', attempts: card.best.attempts.map((attempt) => ({ ...attempt, state: 'running' as const, activity: '✓ Write x.ts' })) } })
    await (h.session as unknown as { write(record: unknown): Promise<unknown> }).write({ type: 'entry', entry: running })
    const reopened = await h.reopen()
    const after = reopened.history().entries.find((entry) => entry.best)!.best!
    assert.deepEqual([after.state, after.error], ['failed', 'eNCode closed before the attempts ended.'])
    assert.deepEqual(after.attempts.map((attempt) => [attempt.state, attempt.activity]), [['stopped', undefined], ['stopped', undefined]])
    assert.equal((await reopened.answerBest(card.id, 1)).ok, false)
    assert.deepEqual(await reopened.answerBest(card.id, 'discard'), { ok: true })
    assert.equal(fake.removed.length, 2)
  })
})

describe('the parts of best of N', () => {
  it('reads the count, the verdict and the fallback', () => {
    assert.deepEqual([attemptCount(undefined), attemptCount(1), attemptCount(3), attemptCount(9), attemptCount('3')], [undefined, 2, 3, 4, undefined])
    assert.deepEqual(parseBest('{"best": 2, "reason": "Adds.", "notes": {"1": "Subtracts.", "2": "Adds."}}', [1, 2]), { best: 2, reason: 'Adds.', notes: new Map([[1, 'Subtracts.'], [2, 'Adds.']]) })
    assert.deepEqual(parseBest('{"best": "1", "notes": [{"n": 1, "note": "Fine."}, {"attempt": 7, "note": "?"}]}', [1, 2]), { best: 1, reason: '', notes: new Map([[1, 'Fine.']]) })
    assert.equal(parseBest('{"best": 5}', [1, 2]), undefined, 'not one of the attempts')
    assert.equal(parseBest('Attempt 2.', [1, 2]), undefined)

    const attempt = (n: number, checks: BestAttempt['checks'], size: number, state: BestAttempt['state'] = 'done', scan = 0) => ({ n, checks, state, scan, files: size ? [{ path: 'a', kind: 'modified' as const, added: size, removed: 0 }] : [] })
    assert.equal(fallbackPick([attempt(1, 'failed', 1), attempt(2, 'passed', 50), attempt(3, 'none', 2)]), 2, 'the checks first')
    assert.equal(fallbackPick([attempt(1, 'none', 9), attempt(2, 'none', 3, 'done', 1), attempt(3, 'none', 4)]), 3, 'then the scan, then the size')
    assert.equal(fallbackPick([attempt(1, 'passed', 2, 'failed'), attempt(2, 'none', 5)]), 2, 'a finished attempt before one that ran out of steps')
    assert.equal(fallbackPick([attempt(1, 'passed', 0)]), undefined, 'nothing changed')
  })

  it('shows the Reviewer each attempt whole, and refuses a write outside the attempt', async () => {
    const prompt = bestPrompt(
      {
        requests: ['Add a sum function'],
        attempts: [
          { n: 1, ended: 'finished', reply: 'Done.', checksText: 'passed: `npm test`.', scan: [], texts: [{ path: 'src/sum.ts', before: null, after: 'a - b\n' }] },
          { n: 2, ended: 'ran out of steps (30) before it finished', reply: '', checksText: 'failed: `npm test`.', scan: [{ rule: 'eval', file: 'src/sum.ts', line: 1, code: 'eval(x)', message: 'eval runs text as code.' }], texts: [{ path: 'src/sum.ts', before: null, after: 'eval(x)\n' }] },
        ],
      },
      'abc123',
    )
    assert.match(prompt, /<requests-abc123>\n1\. Add a sum function\n<\/requests-abc123>/)
    assert.match(prompt, /<attempt-abc123 n="1">\nIt finished\.\nIts reply:\n<reply-abc123>\nDone\.\n<\/reply-abc123>\nThe project's checks after its last change: passed: `npm test`\.\neNCode's scan of its added lines noted:\n\(nothing\)\nReview what attempt 1 changed: 1 file changed\./)
    assert.match(prompt, /<attempt-abc123 n="2">\nIt ran out of steps \(30\) before it finished\.\nIts reply:\n<reply-abc123>\n\(none\)[\s\S]*- `src\/sum\.ts:1` `eval\(x\)`: eval runs text as code\.[\s\S]*\+1 \| eval\(x\)/)

    const inside = onlyInside(path.resolve('/work/.encode-worktrees/best-1'))
    await inside(path.resolve('/work/.encode-worktrees/best-1/src/a.ts'), null, { turnId: 't', toolUseId: 'u' })
    await assert.rejects(inside(path.resolve('/work/src/a.ts'), null, { turnId: 't', toolUseId: 'u' }), /changes only its own copy of the project/)
  })

  it('never writes through a link in the project, or into a folder that leads out of it', async () => {
    const outside = await tempWorkspace({ 'notes.md': 'mine\n', 'deep/x.ts': 'x\n' })
    const root = await tempWorkspace({ 'src/a.ts': 'a\n' })
    try {
      await fs.symlink(path.join(outside, 'notes.md'), path.join(root, 'notes.md'))
      await fs.symlink(path.join(outside, 'deep'), path.join(root, 'deep'), 'junction')
    } catch {
      return // Windows without the right to make links: nothing to test.
    }
    const fake = seedingGit()
    const worktree = await fake.git.create(root, 'best-link-1')
    await fs.mkdir(path.join(worktree.path, 'deep'), { recursive: true })
    await fs.writeFile(path.join(worktree.path, 'notes.md'), 'theirs\n')
    await fs.writeFile(path.join(worktree.path, 'deep', 'x.ts'), 'theirs\n')
    const attempt: BestAttempt = { n: 1, state: 'done', steps: 1, files: [], checks: 'none', worktree, seed: { base: 'b'.repeat(40), linked: [] } }
    const git = (file: string) => ({ ...fake.git, changes: async () => [{ path: file, kind: 'modified' as const }], original: async () => Buffer.from('mine\n') })

    const link = await keepAttempt({ root, git: git('notes.md'), attempt, force: true, turnId: 't' })
    assert.deepEqual(link, { ok: false, error: 'notes.md in the project is not a plain file, so eNCode does not write over it.' })
    const folder = await keepAttempt({ root, git: git('deep/x.ts'), attempt, force: true, turnId: 't' })
    assert.deepEqual(folder, { ok: false, error: 'deep/x.ts leads outside the project, so eNCode does not write it.' })
    assert.equal(await fs.readFile(path.join(outside, 'notes.md'), 'utf8'), 'mine\n')
    assert.equal(await fs.readFile(path.join(outside, 'deep', 'x.ts'), 'utf8'), 'x\n')
  })
})
