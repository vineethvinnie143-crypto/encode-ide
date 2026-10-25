/**
 * The checks before a turn ends, and the claim check, through the loop (ADR 0095).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { AgentShell } from '@encode/tools'
import type { UserMessage } from '@encode/providers'
import { CheckLedger, type ProjectCheck, type ProjectChecks } from './checks'
import { loopHarness, sessionHarness, stubManagedShell, stubShell, type Harness } from './testing'

const TEST: ProjectCheck = { command: 'npm test', kind: 'test', source: 'package.json' }
const TYPES: ProjectCheck = { command: 'npm run typecheck', kind: 'typecheck', source: 'package.json' }

/** A shell that answers each command from `answers`, in order for repeated commands, and records what ran. */
function answering(root: string, ran: string[], answers: Record<string, Array<{ output: string; exitCode?: number; timedOut?: boolean }>>): AgentShell {
  return {
    ...stubShell(root),
    run: async (command) => {
      ran.push(command)
      const next = answers[command]?.shift() ?? { output: 'ok' }
      return { output: next.output, exitCode: next.exitCode ?? 0, timedOut: next.timedOut ?? false, interrupted: false, cwd: root }
    },
  }
}

function checksOf(list: ProjectCheck[], ledger = new CheckLedger()): ProjectChecks {
  return { list: async () => list, ledger }
}

/** The reminders eNCode added to the conversation, in order. */
function reminders(h: Harness): string[] {
  return h.conversation
    .messages()
    .filter((message): message is UserMessage => message.role === 'user')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' && block.text.startsWith('<system-reminder>') ? [block.text] : [])))
}

const write = (root: string, name: string, content = 'export const a = 1\n') => ({ calls: [{ name: 'Write', input: { file_path: path.join(root, name), content } }] })

describe('the checks before the agent finishes', () => {
  it('run after a change, send the agent back with what failed, and run again after its fix', async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }, write(root, 'src/a.ts', 'export const a = 2\n'), { text: 'Fixed the failing test.' }],
      shell: (root) => answering(root, ran, { 'npm test': [{ output: '▶ sum\n  ✖ adds (1ms)\n\nnot ok', exitCode: 1 }, { output: '✔ adds (1ms)' }] }),
      services: { checks: checksOf([TEST]) },
    })
    const end = await h.run('make the sum right')
    assert.deepEqual(end, { kind: 'done', reply: 'Fixed the failing test.' })
    assert.deepEqual(ran, ['npm test', 'npm test'])
    const [sent] = reminders(h)
    assert.match(sent, /eNCode ran the project's checks after your changes\.\n`npm test` failed:\n▶ sum\n {2}✖ adds \(1ms\)/)
    assert.match(sent, /no run of it from before this request to compare with/)
    assert.match(sent, /Fix what your changes broke, then finish\./)
    assert.equal(reminders(h).length, 1)
    // The person sees each run as a step, and why the agent went on.
    assert.ok(h.surface.settled.some((entry) => entry.kind === 'notice' && /checks failed after the agent's changes/.test(entry.text ?? '')))
    assert.equal(h.surface.settled.filter((entry) => entry.tool?.name === 'Bash' && entry.tool.input.description === 'Check the changes: tests').length, 2)
  })

  it('run typechecks first, and the tests only once those pass', async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }, { text: 'The error is in a generated file; not mine.' }],
      shell: (root) => answering(root, ran, { 'npm run typecheck': [{ output: "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2 }] }),
      services: { checks: checksOf([TYPES, TEST]) },
    })
    await h.run('go')
    assert.deepEqual(ran, ['npm run typecheck'], 'no tests while the types fail, and no second run without a change')
    assert.match(reminders(h)[0], /Not run until this passes: `npm test`\./)
  })

  it('do not run when the turn changed no code, nor when only prose changed', async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'NOTES.md', '# notes\n'), { text: 'Wrote the notes.' }],
      shell: (root) => answering(root, ran, {}),
      services: { checks: checksOf([TEST]) },
    })
    await h.run('take notes')
    assert.deepEqual(ran, [])
  })

  it('leave failures that were there before the request to the person, and send back only new ones', async () => {
    const ran: string[] = []
    const ledger = new CheckLedger()
    const failing = '✖ old flaky test (2ms)'
    const h = await loopHarness({
      scriptFor: (root) => [
        // Request one: the agent runs the tests before changing anything; one was failing already.
        { calls: [{ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] },
        write(root, 'src/a.ts'),
        { text: 'Done; the old flaky test still fails as before.' },
        // Request two: its change breaks another test.
        write(root, 'src/b.ts'),
        { text: 'Done.' },
        { text: 'The new failure is expected; the test is wrong.' },
      ],
      shell: (root) =>
        answering(root, ran, {
          'npm test': [
            { output: failing, exitCode: 1 },
            { output: failing, exitCode: 1 },
            { output: `${failing}\n✖ adds (1ms)`, exitCode: 1 },
          ],
        }),
      services: { checks: checksOf([TEST], ledger) },
    })
    await h.run('first')
    assert.deepEqual(reminders(h), [], 'the same failure as before the change: not sent back')
    assert.ok(h.surface.settled.some((entry) => entry.kind === 'notice' && entry.text === '`npm test` fails as it did before this request.'))
    await h.run('second')
    assert.equal(ran.length, 3)
    assert.match(reminders(h)[0], /New since this request: adds\. Failing before it too, not yours unless asked: old flaky test\./)
  })

  it("use the agent's own passing run after its last change instead of running again", async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { calls: [{ name: 'Bash', input: { command: 'npm run test', description: 'Run the tests' } }] }, { text: 'Done; all tests pass.' }],
      shell: (root) => answering(root, ran, { 'npm run test': [{ output: '✔ adds (1ms)' }] }),
      services: { checks: checksOf([TEST]) },
    })
    const end = await h.run('go')
    assert.deepEqual(ran, ['npm run test'])
    assert.deepEqual(end, { kind: 'done', reply: 'Done; all tests pass.' }, 'and the claim that they pass holds')
    assert.deepEqual(reminders(h), [])
  })

  it('go through approval like any command: refused once, they are not asked for again this turn', async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }],
      shell: (root) => answering(root, ran, {}),
      services: { checks: checksOf([TYPES, TEST]) },
    })
    h.surface.decide = (prompt) => prompt.tool !== 'Bash'
    const end = await h.run('go')
    assert.deepEqual(end, { kind: 'done', reply: 'Done.' })
    assert.deepEqual(ran, [])
    assert.equal(h.surface.approvals.filter((prompt) => prompt.tool === 'Bash').length, 1, 'asked for the first check only')
    assert.deepEqual(reminders(h), [], 'a refusal is not the agent’s to hear')
  })

  it('stop after their rounds, do not wait for a run that times out, and are off when turned off', async () => {
    const ran: string[] = []
    const h = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }, write(root, 'src/a.ts', '2'), { text: 'Again.' }, write(root, 'src/a.ts', '3'), { text: 'Gave up.' }],
      shell: (root) => answering(root, ran, { 'npm test': [1, 2, 3].map(() => ({ output: '✖ adds (1ms)', exitCode: 1 })) }),
      services: { checks: checksOf([TEST]) },
    })
    const end = await h.run('go')
    assert.deepEqual(end, { kind: 'done', reply: 'Gave up.' })
    assert.equal(reminders(h).length, 2, 'auto sends the agent back twice')

    const slow: string[] = []
    const timed = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }],
      shell: (root) => answering(root, slow, { 'npm test': [{ output: 'running…', exitCode: 1, timedOut: true }] }),
      services: { checks: checksOf([TEST]) },
    })
    assert.deepEqual(await timed.run('go'), { kind: 'done', reply: 'Done.' })
    assert.ok(timed.surface.settled.some((entry) => entry.kind === 'notice' && entry.text === '`npm test` did not finish, so eNCode does not wait for it.'))

    const none: string[] = []
    const off = await loopHarness({
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'All tests pass.' }],
      shell: (root) => answering(root, none, {}),
      services: { checks: checksOf([TEST]) },
      settings: { checkGate: 'off' },
    })
    assert.deepEqual(await off.run('go'), { kind: 'done', reply: 'All tests pass.' })
    assert.deepEqual(none, [])
  })
})

describe('the claim check', () => {
  it('sends the agent back once for tests it says pass with no passing run', async () => {
    const h = await loopHarness({
      script: [{ text: 'I fixed it. All tests pass.' }, { text: 'I did not run the tests; I only read the code.' }],
      services: { checks: checksOf([]) },
    })
    const end = await h.run('does it work?', 'ask')
    assert.deepEqual(end, { kind: 'done', reply: 'I did not run the tests; I only read the code.' })
    const [sent] = reminders(h)
    assert.match(sent, /It says "All tests pass\.", but no command that checks the code passed after your last change\. Run it, or say that you did not\./)
    assert.ok(h.surface.settled.some((entry) => entry.kind === 'notice' && /could not confirm something the agent's reply says/.test(entry.text ?? '')))
  })

  it('finds files that are not there, unless the session named them, and names a file does not hold', async () => {
    const h = await loopHarness({
      files: { 'src/auth.ts': 'export function checkToken() {}\n', 'src/old.ts': '' },
      scriptFor: (root) => [
        { calls: [{ name: 'Read', input: { file_path: path.join(root, 'src/auth.ts') } }] },
        { text: 'See `src/auth.ts:1`, `src/session.ts` and `lib/gone.ts`. I added `validateToken()` to `src/auth.ts`.' },
        { text: 'Corrected: the function is `checkToken()`, and there is no session file.' },
      ],
      services: { checks: checksOf([]) },
    })
    await h.conversation.add({ role: 'user', content: [{ type: 'text', text: 'lib/gone.ts was deleted yesterday' }] }, { turnId: 't0' })
    await h.run('where is the token checked?', 'ask')
    const [sent] = reminders(h)
    assert.match(sent, /It names a file that does not exist: `src\/session\.ts`\. If you meant files to create, say so\./)
    assert.doesNotMatch(sent, /lib\/gone\.ts/, 'the person named it')
    assert.match(sent, /It says `validateToken` is in `src\/auth\.ts`, which does not contain that name\./)
    assert.equal(reminders(h).length, 1, 'once a turn')
  })

  it('lets a reply through that holds, and stays quiet for subagents and when turned off', async () => {
    const h = await loopHarness({
      files: { 'src/auth.ts': 'export function checkToken() {}\n' },
      script: [{ text: 'The token is checked by `checkToken()` in `src/auth.ts`.' }],
      services: { checks: checksOf([]) },
    })
    await h.run('where?', 'ask')
    assert.deepEqual(reminders(h), [])
    const off = await loopHarness({ script: [{ text: 'All tests pass. See `src/none.ts`.' }], services: { checks: checksOf([]) }, settings: { checkGate: 'off' } })
    await off.run('go', 'ask')
    assert.deepEqual(reminders(off), [])
  })

  it('tests only files the agent may read without asking, so a reply learns nothing of the others', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-claims-outside-'))
    try {
      await fs.writeFile(path.join(outside, 'secrets.ts'), 'export const other = 1\n')
      const h = await loopHarness({
        script: [{ text: `I added \`apiToken\` to \`${path.join(outside, 'secrets.ts')}\` and wrote \`${path.join(outside, 'none', 'x.ts')}\`.` }],
        services: { checks: checksOf([]) },
      })
      await h.run('go', 'ask')
      assert.deepEqual(reminders(h), [], 'outside the workspace: neither there nor not')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('the hand-back check', () => {
  const look = (root: string) => ({ calls: [{ name: 'Read', input: { file_path: path.join(root, 'server.cfg') } }] })

  it('sends an answer that leaves a check to the person back once, to make it or say why it cannot', async () => {
    const h = await loopHarness({
      files: { 'server.cfg': 'port 7777\n' },
      scriptFor: (root) => [
        look(root),
        { text: 'The port is 7777. I have not tested a real join, so that last mile needs you.' },
        { text: 'Probed 7777 from outside: it answers the query. A real join needs your game client, which I do not have.' },
      ],
      services: { checks: checksOf([]) },
    })
    const end = await h.run('why can no one join?', 'code')
    assert.equal(end.kind, 'done')
    const [sent, ...more] = reminders(h)
    assert.match(sent, /Your answer leaves a check to the user: "I have not tested a real join, so that last mile needs you\."/)
    assert.match(sent, /make that check yourself if any harmless way exists/)
    assert.match(sent, /say why in one line/)
    assert.deepEqual(more, [], 'once a request')
    assert.ok(h.surface.settled.some((entry) => entry.kind === 'notice' && /left a check to you/.test(entry.text ?? '')))
  })

  it('lets the second answer through, and stays quiet without steps, outside Code mode and when checks are off', async () => {
    const twice = await loopHarness({
      files: { 'server.cfg': 'port 7777\n' },
      scriptFor: (root) => [look(root), { text: 'I could not test a join.' }, { text: 'I still could not test a join: it needs your client.' }],
      services: { checks: checksOf([]) },
    })
    assert.deepEqual(await twice.run('go', 'code'), { kind: 'done', reply: 'I still could not test a join: it needs your client.' })
    const glob = { calls: [{ name: 'Glob', input: { pattern: '*' } }] }
    const chat = await loopHarness({ script: [{ text: 'I have not tested it; you will need to test it.' }], services: { checks: checksOf([]) } })
    await chat.run('go', 'code')
    assert.deepEqual(reminders(chat), [], 'no steps')
    const ask = await loopHarness({ script: [glob, { text: 'I have not tested it.' }], services: { checks: checksOf([]) } })
    await ask.run('go', 'ask')
    assert.deepEqual(reminders(ask), [], 'Ask mode')
    const off = await loopHarness({ script: [glob, { text: 'I have not tested it.' }], services: { checks: checksOf([]) }, settings: { checkGate: 'off' } })
    await off.run('go', 'code')
    assert.deepEqual(reminders(off), [], 'checks off')
  })
})

describe('a session', () => {
  it("finds the project's checks where its shell is, and runs them for its agent; a settings list replaces them", async () => {
    const ran: string[] = []
    const shell = (root: string) => ({ ...stubManagedShell(root), ...answering(root, ran, { 'pnpm test': [{ output: '✔ adds (1ms)' }] }) })
    const h = await sessionHarness({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'pnpm-lock.yaml': '' },
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }],
      createShell: shell,
      // Nobody answers an approval here.
      settings: { policy: 'full-access' },
    })
    await h.session.start({ text: 'add a', mode: 'code' })
    assert.deepEqual(ran, ['pnpm test'])

    const named: string[] = []
    const configured = await sessionHarness({
      files: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
      scriptFor: (root) => [write(root, 'src/a.ts'), { text: 'Done.' }],
      createShell: (root) => ({ ...stubManagedShell(root), ...answering(root, named, {}) }),
      env: { checks: () => ['make check'] },
      settings: { policy: 'full-access' },
    })
    await configured.session.start({ text: 'add a', mode: 'code' })
    assert.deepEqual(named, ['make check'])
  })
})
