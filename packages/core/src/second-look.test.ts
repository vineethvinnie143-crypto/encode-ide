/**
 * The second look before a hard-to-undo command that would run unseen (ADR 0097), through the loop.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SECOND_LOOK_SYSTEM, parseSecondLook } from './second-look'
import { loopHarness, recordingShell, type Harness } from './testing'

const bash = (command: string) => ({ calls: [{ name: 'Bash', input: { command, description: 'Run it' } }] })
const lastUser = (h: Harness, index: number) =>
  h.client.requests[index].payload.messages
    .at(-1)!
    .content.map((block) => ('text' in block ? block.text : ''))
    .join('')
const steps = (h: Harness) => h.surface.settled.filter((entry) => entry.kind === 'tool' && entry.tool?.name === 'Bash')

async function fullAccess(command: string, answer: string, ran: string[], decide?: Harness['surface']['decide']) {
  const h = await loopHarness({
    script: [bash(command), { text: answer }, { text: 'Done.' }],
    shell: (root) => recordingShell(root, ran),
    settings: { policy: 'full-access', askAgain: 'on' },
    requests: () => ['clean up the old sources'],
  })
  if (decide) h.surface.decide = decide
  await h.run('clean up the old sources')
  return h
}

describe('the second look before a hard-to-undo command', () => {
  it("runs it when the agent's model, asked again with only the requests, says so", async () => {
    const ran: string[] = []
    const h = await fullAccess('rm -rf src', JSON.stringify({ run: true, reason: 'You asked to remove the old sources.' }), ran)
    assert.deepEqual(ran, ['rm -rf src'])
    assert.equal(h.surface.approvals.length, 0, 'Full access: the person is not asked')
    const call = h.client.requests[1]
    assert.deepEqual([call.role, call.tool, call.payload.tools.length, call.payload.system[0].text], ['main', 'SecondLook', 0, SECOND_LOOK_SYSTEM])
    const prompt = lastUser(h, 1)
    assert.match(prompt, /<requests-[0-9a-f]+>\n1\. clean up the old sources\n<\/requests-/)
    assert.match(prompt, /<command-[0-9a-f]+>\nrm -rf src\n<\/command-/)
    assert.match(prompt, /What makes it hard to undo: it deletes src and everything in it\./)
    assert.deepEqual(steps(h).at(-1)?.tool?.review, { by: 'second-look', verdict: 'approved', reason: 'You asked to remove the old sources.' })
    assert.equal(h.surface.usages.length, 3, 'the second look counts toward the request')
  })

  it('leaves it to the person when the answers differ, or the second cannot be read', async () => {
    const ran: string[] = []
    const h = await fullAccess('git push --force origin main', JSON.stringify({ run: false, reason: 'Nothing you asked needs a force push.' }), ran, () => false)
    assert.deepEqual(ran, [], 'declined, so not run')
    const [card] = h.surface.approvals
    assert.equal(card.reason, "This command overwrites history on the remote. Asked again before it ran, the agent's model did not confirm it.")
    assert.deepEqual(card.review, { by: 'second-look', reason: 'Nothing you asked needs a force push.' })
    assert.equal(card.grant, undefined, 'one approval, not one for the session')

    const unread: string[] = []
    const garbled = await fullAccess('rm -rf src', 'Sure, go ahead!', unread, () => true)
    assert.deepEqual(unread, ['rm -rf src'], 'the person allowed it')
    assert.deepEqual(garbled.surface.approvals[0].review, { by: 'second-look', reason: "eNCode could not read the model's answer." })
  })

  it('asks nothing more of a command that is easy to undo, one the person sees anyway, or when turned off', async () => {
    const ran: string[] = []
    const easy = await loopHarness({ script: [bash('rm -rf node_modules'), { text: 'Done.' }], shell: (root) => recordingShell(root, ran), settings: { policy: 'full-access', askAgain: 'on' } })
    await easy.run('reinstall')
    assert.equal(easy.client.requests.length, 2)
    const asked = await loopHarness({ script: [bash('git push origin main'), { text: 'Done.' }], shell: (root) => recordingShell(root, ran), settings: { policy: 'workspace-write', askAgain: 'on' } })
    await asked.run('push it')
    assert.equal(asked.client.requests.length, 2, 'the person was asked, so the model is not')
    assert.equal(asked.surface.approvals.length, 1)
    const off = await loopHarness({ script: [bash('rm -rf src'), { text: 'Done.' }], shell: (root) => recordingShell(root, ran), settings: { policy: 'full-access', askAgain: 'off' } })
    await off.run('remove src')
    assert.equal(off.client.requests.length, 2)
    assert.deepEqual(ran, ['rm -rf node_modules', 'git push origin main', 'rm -rf src'])
  })

  it("reads the model's answer only as a yes or a no with a reason", () => {
    assert.deepEqual(parseSecondLook('```json\n{"run": false, "reason": "Not asked\\nfor."}\n```'), { run: false, reason: 'Not asked for.' })
    assert.equal(parseSecondLook('{"run": "yes"}'), undefined)
    assert.equal(parseSecondLook('no'), undefined)
  })
})
