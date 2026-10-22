import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { userText, type Message, type ToolResultBlock } from '@encode/providers'
import { FakeDesktop, type FakeElement, type FakeWindow } from '@encode/tools/testing'
import { SCREEN_REMOVED } from './screens'
import { SUBAGENT_EXCLUDED } from './subagents'
import { desktopServices, loopHarness, type HarnessOptions } from './testing'

/** A text editor with a menu and an edit field. */
function notepad(): FakeWindow {
  const file: FakeElement = { role: 'menuitem', name: 'File', can: ['invoke'] }
  return {
    app: 'notepad.exe',
    label: 'Notepad',
    title: 'Untitled - Notepad',
    elements: [{ role: 'menubar', children: [file] }, { role: 'edit', name: 'Text editor', value: '', can: ['set_value'] }],
  }
}

const terminal = (): FakeWindow => ({ app: 'windowsterminal.exe', label: 'Windows Terminal', title: 'PS C:\\', elements: [] })

const computer = (input: Record<string, unknown>) => ({ name: 'Computer', input })

function setup(windows: FakeWindow[], options: HarnessOptions & { vision?: boolean } = {}) {
  const backend = new FakeDesktop(windows)
  const { vision, ...rest } = options
  return {
    backend,
    options: {
      ...rest,
      services: { desktop: desktopServices(backend), ...rest.services },
      client: { ...(vision !== undefined ? { images: vision } : {}), ...rest.client },
    } satisfies HarnessOptions,
  }
}

function results(messages: readonly Message[]): ToolResultBlock[] {
  return messages.flatMap((message) => (message.role === 'user' ? message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result') : []))
}

const text = (block: ToolResultBlock): string => block.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
const imagesIn = (messages: readonly Message[]): number => results(messages).reduce((sum, block) => sum + block.content.filter((part) => part.type === 'image').length, 0)

describe('the Computer tool in the loop', () => {
  it('asks before the first use of an application, shows what it will do, and carries on unasked afterwards', async () => {
    const { options } = setup([notepad()], {
      script: [
        { calls: [computer({ action: 'windows' })] },
        { calls: [computer({ action: 'screenshot', window: 'w1' })] },
        { calls: [computer({ action: 'left_click', window: 'w1', element: 'e2' })] },
        { calls: [computer({ action: 'screenshot', window: 'w1' })] },
        { text: 'Opened the File menu.' },
      ],
    })
    const h = await loopHarness(options)
    assert.deepEqual(await h.run('open the file menu in notepad'), { kind: 'done', reply: 'Opened the File menu.' })
    assert.equal(h.surface.approvals.length, 1, 'one question for the application, none for the later steps')
    const [prompt] = h.surface.approvals
    assert.equal(prompt.tool, 'Computer')
    assert.equal(prompt.title, 'Use Notepad')
    assert.match(prompt.detail, /w1 "Untitled - Notepad" \(notepad\.exe\)/)
    assert.match(prompt.detail, /First step: screenshot/)
    assert.match(prompt.reason ?? '', /Approving allows Notepad until the session ends/)
    assert.equal(prompt.grant, undefined, 'the loop remembers the application; there is nothing to grant')
    assert.ok(h.approvedApps.has('notepad.exe'))
    assert.deepEqual(h.surface.tools().map((tool) => [tool.name, tool.state]), [['Computer', 'done'], ['Computer', 'done'], ['Computer', 'done'], ['Computer', 'done']])
  })

  it('does nothing when the user says no, and tells the model so', async () => {
    const { backend, options } = setup([notepad()], {
      script: [{ calls: [computer({ action: 'screenshot', window: 'w1' })] }, { text: 'Understood.' }],
    })
    const h = await loopHarness(options)
    h.surface.decide = () => false
    await h.run('look at notepad')
    assert.ok(!h.approvedApps.has('notepad.exe'))
    assert.deepEqual(h.surface.tools().map((tool) => tool.state), ['rejected'])
    assert.match(text(results(h.conversation.messages())[0]), /The user rejected this action/)
    assert.deepEqual(backend.calls.filter((call) => call.op !== 'ready' && call.op !== 'windows'), [], 'the application was not looked at or touched')
  })

  it('does not ask under Full access, and does not ask for what the policy refuses', async () => {
    const full = setup([notepad(), terminal()], {
      settings: { policy: 'full-access' },
      script: [{ calls: [computer({ action: 'screenshot', window: 'w1' })] }, { calls: [computer({ action: 'screenshot', window: 'w2' })] }, { text: 'Done.' }],
    })
    const h = await loopHarness(full.options)
    await h.run('look')
    assert.equal(h.surface.approvals.length, 0)
    const [first, second] = results(h.conversation.messages())
    assert.match(text(first), /^w1 Notepad/)
    assert.equal(second.isError, true, 'a terminal is never used, whatever the policy')
    assert.match(text(second), /Refused by the approval policy: Windows Terminal is never used: terminals and shells run commands without the command approval/)

    const readOnly = setup([notepad()], { settings: { policy: 'read-only' }, script: [{ calls: [computer({ action: 'screenshot', window: 'w1' })] }, { text: 'No.' }] })
    const r = await loopHarness(readOnly.options)
    await r.run('look')
    assert.equal(r.surface.approvals.length, 0)
    assert.match(text(results(r.conversation.messages())[0]), /Refused by the approval policy: .*Read Only/)
  })

  it('treats a hook that allows the call as the user\'s approval of the application', async () => {
    const { options } = setup([notepad()], {
      hooks: { preToolUse: async () => ({ decision: 'allow' }) },
      script: [{ calls: [computer({ action: 'screenshot', window: 'w1' })] }, { text: 'Seen.' }],
    })
    const h = await loopHarness(options)
    await h.run('look')
    assert.equal(h.surface.approvals.length, 0)
    assert.match(text(results(h.conversation.messages())[0]), /^w1 Notepad/)
    assert.ok(h.approvedApps.has('notepad.exe'))
  })

  it('is not offered in Ask and Plan mode', async () => {
    const { options } = setup([notepad()], { script: [{ calls: [computer({ action: 'windows' })] }, { text: 'Cannot.' }] })
    const h = await loopHarness(options)
    await h.run('what is open?', 'ask')
    assert.equal(text(results(h.conversation.messages())[0]), 'Computer is not available in ask mode.')
    assert.equal(h.surface.approvals.length, 0)
  })

  it('is not given to subagents, which run side by side', () => {
    assert.ok(SUBAGENT_EXCLUDED.includes('Computer'))
  })
})

describe('screenshots in the loop', () => {
  const looks = (count: number) => [
    ...Array.from({ length: count }, () => ({ calls: [computer({ action: 'screenshot', window: 'w1' })] })),
    { text: 'Done.' },
  ]

  it('reach a model that reads images, and nobody else', async () => {
    for (const [vision, expected] of [[true, 1], [false, 0], [undefined, 0]] as const) {
      const { options } = setup([notepad()], { vision, settings: { policy: 'full-access' }, script: looks(1) })
      const h = await loopHarness(options)
      await h.run('look')
      assert.equal(imagesIn(h.conversation.messages()), expected, `vision ${String(vision)}`)
    }
  })

  it('are marked transient, so nothing downstream keeps more than the newest', async () => {
    const { options } = setup([notepad()], { vision: true, settings: { policy: 'full-access' }, script: looks(1) })
    const h = await loopHarness(options)
    await h.run('look')
    const image = results(h.conversation.messages())[0].content.find((part) => part.type === 'image')
    assert.equal(image?.type === 'image' && image.transient, true)
  })

  it('are kept one at a time: an older result says its screenshot is gone, and what is sent has one', async () => {
    const { options } = setup([notepad()], { vision: true, settings: { policy: 'full-access' }, script: looks(3) })
    const h = await loopHarness(options)
    await h.run('look three times')
    assert.equal(imagesIn(h.conversation.messages()), 1)
    const [first, second, third] = results(h.conversation.messages())
    assert.match(text(first), new RegExp(`${SCREEN_REMOVED.replace(/[[\]]/g, '\\$&')}$`))
    assert.match(text(second), /\[screenshot removed/)
    assert.ok(third.content.some((part) => part.type === 'image'))
    const sent = h.client.requests.map((request) => imagesIn(request.payload.messages))
    assert.deepEqual(sent, [0, 1, 1, 1], 'no request carried more than one screenshot')
  })

  it('are not sent to a model that cannot read them, even when the conversation holds one', async () => {
    const { options } = setup([notepad()], { vision: false, script: [{ text: 'Fine.' }] })
    const h = await loopHarness(options)
    await h.conversation.add(userText('earlier'), { turnId: 'before' })
    await h.conversation.add({ role: 'assistant', content: [{ type: 'tool-use', id: 'old', name: 'Computer', input: { action: 'screenshot', window: 'w1' } }] }, { turnId: 'before' })
    await h.conversation.add(
      { role: 'user', content: [{ type: 'tool-result', toolUseId: 'old', content: [{ type: 'text', text: 'Screenshot s1' }, { type: 'image', mediaType: 'image/png', data: 'AAAA', transient: true }] }] },
      { turnId: 'before' },
    )
    await h.run('carry on')
    assert.equal(imagesIn(h.client.requests[0].payload.messages), 0)
    assert.equal(h.client.requests[0].requirements.images, false, 'so the router is free to pick a model without vision')
  })
})
