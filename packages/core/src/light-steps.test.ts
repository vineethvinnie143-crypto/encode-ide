import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { BudgetQuery, ModelRole } from '@encode/providers'
import { closeHarnesses, loopHarness, stubShell, type Harness, type HarnessOptions } from './testing'

after(closeHarnesses)

/** A shell whose command fails when it says `fail`. */
const shell = (root: string) => ({
  ...stubShell(root),
  run: async (command: string) => ({ output: command.includes('fail') ? 'boom' : 'ok', exitCode: command.includes('fail') ? 1 : 0, timedOut: false, interrupted: false, cwd: root }),
})

/** A harness whose model keeps its cache when the effort changes, unless `cacheSafe` is false. */
async function harness(options: HarnessOptions & { cacheSafe?: boolean }): Promise<Harness> {
  const h = await loopHarness({ shell, maxSteps: 20, ...options, settings: { reasoning: 'high', lightSteps: true, ...options.settings } })
  const plain = h.client.budget.bind(h.client)
  h.client.budget = async (role: ModelRole, query?: BudgetQuery) => ({ ...(await plain(role, query)), ...(options.cacheSafe === false ? {} : { effortPerStep: true as const }) })
  return h
}

const efforts = (h: Harness) => h.client.requests.map((request) => request.payload.reasoning)

describe('light steps (ADR 0135)', () => {
  it('thinks at low effort after reads, searches and commands that worked, and at the effort set elsewhere', async () => {
    const h = await harness({
      files: { 'a.txt': 'one\n' },
      script: [
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { calls: [{ name: 'Grep', input: { pattern: 'one' } }] },
        { calls: [{ name: 'Edit', input: { file_path: 'a.txt', old_string: 'one', new_string: 'two' } }] },
        { calls: [{ name: 'Bash', input: { command: 'npm test' } }] },
        { calls: [{ name: 'Bash', input: { command: 'npm test fail' } }] },
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'Changed one to two.' },
      ],
    })
    await h.run('change it')
    // The first step, then after Read and Grep; after the edit; after a passing command; after a failing one; after a
    // Read, whose answer is asked again at the effort set.
    assert.deepEqual(efforts(h), ['high', 'low', 'low', 'high', 'low', 'high', 'low', 'high'])
    assert.deepEqual(
      h.client.requests.map((request) => request.light === true),
      [false, true, true, false, true, false, true, false],
      'a light step says so, so the effort the person set for the role does not take its place',
    )
  })

  it('asks a light step that would answer again, at the effort set, and shows only that answer', async () => {
    const h = await harness({
      files: { 'a.txt': 'one\n' },
      script: [{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }, { text: 'A quick answer.' }, { text: 'The considered answer.' }],
    })
    const end = await h.run('what is in a.txt?')
    assert.deepEqual(efforts(h), ['high', 'low', 'high'])
    assert.equal(end.kind === 'done' ? end.reply : end.kind, 'The considered answer.')
    const shown = h.surface.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.text)
    assert.deepEqual(shown, ['The considered answer.'])
    assert.ok(!JSON.stringify(h.conversation.messages()).includes('A quick answer.'), 'the light answer is not kept')
    assert.equal(h.surface.usages.length, 3, 'what the light answer cost still counts')
  })

  it('shows a light step\'s text with its calls', async () => {
    const h = await harness({
      files: { 'a.txt': 'one\n', 'b.txt': 'two\n' },
      script: [
        { calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'Now the other file.', calls: [{ name: 'Read', input: { file_path: 'b.txt' } }] },
        { text: 'Both read.' },
        { text: 'Both read.' },
      ],
    })
    await h.run('read both')
    assert.deepEqual(efforts(h), ['high', 'low', 'low', 'high'])
    assert.ok(h.surface.settled.some((entry) => entry.kind === 'assistant' && entry.text === 'Now the other file.'))
  })

  it('keeps the effort set when the setting is off, the model would lose its cache, or the effort is already low', async () => {
    const script = [{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }, { text: 'done' }]
    for (const [label, options] of [
      ['setting off', { settings: { lightSteps: false } }],
      ['cache would go', { cacheSafe: false }],
      ['already low', { settings: { reasoning: 'low' as const } }],
    ] as const) {
      const h = await harness({ files: { 'a.txt': 'one\n' }, script, ...options })
      await h.run('look')
      assert.equal(h.client.requests.length, 2, label)
      assert.ok(h.client.requests.every((request) => !request.light), label)
    }
  })

  it('thinks at the effort set on the step after a message of the person\'s', async () => {
    const h = await harness({
      files: { 'a.txt': 'one\n' },
      script: [{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }] }, { text: 'done' }],
    })
    await h.run('look')
    await h.run('and again')
    assert.equal(h.client.requests.at(-1)?.light, undefined, 'a new request starts at the effort set')
  })
})
