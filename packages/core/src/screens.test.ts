import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { textBlock, userText, type AssistantMessage, type ImageBlock, type Message, type ToolResultBlock, type UserMessage } from '@encode/providers'
import { KEEP_SCREENS, pruneScreens, SCREEN_REMOVED, withoutScreens, withoutScreensFrom } from './screens'

const screen = (data: string): ImageBlock => ({ type: 'image', mediaType: 'image/png', data, transient: true })
const photo = (data: string): ImageBlock => ({ type: 'image', mediaType: 'image/png', data })

const result = (id: string, text: string, ...images: ImageBlock[]): UserMessage => ({
  role: 'user',
  content: [{ type: 'tool-result', toolUseId: id, content: [textBlock(text), ...images] } satisfies ToolResultBlock],
})

const step = (id: string, thinking = true): AssistantMessage => ({
  role: 'assistant',
  content: [...(thinking ? [{ type: 'thinking' as const, text: `thought ${id}`, signature: `sig-${id}` }] : []), { type: 'tool-use', id, name: 'Computer', input: { action: 'screenshot' } }],
})

const imagesOf = (message: Message): string[] =>
  message.role !== 'user'
    ? []
    : message.content.flatMap((block) => (block.type === 'tool-result' ? block.content : [block])).flatMap((block) => (block.type === 'image' ? [block.data] : []))

const textsOf = (message: Message): string[] =>
  message.role !== 'user' ? [] : message.content.flatMap((block) => (block.type === 'tool-result' ? block.content : [block])).flatMap((block) => (block.type === 'text' ? [block.text] : []))

describe('what a log keeps of a screenshot', () => {
  it('is the note that it was removed, in the place of the image, with the rest of the result untouched', () => {
    const message = result('a', 'Screenshot s1 is 800x600 pixels.', screen('AAAA'))
    const stored = withoutScreens(message)
    assert.deepEqual(imagesOf(stored), [])
    assert.deepEqual(textsOf(stored), ['Screenshot s1 is 800x600 pixels.', SCREEN_REMOVED])
    assert.deepEqual(imagesOf(message), ['AAAA'], 'the message in memory is not changed')
  })

  it('leaves a message without screenshots as it is, and an image the user attached', () => {
    const plain = result('a', 'done')
    assert.equal(withoutScreens(plain), plain)
    const attached: UserMessage = { role: 'user', content: [textBlock('look at this'), photo('PHOTO')] }
    assert.equal(withoutScreens(attached), attached)
    const mixed = result('b', 'both', photo('KEEP'), screen('DROP'))
    assert.deepEqual(imagesOf(withoutScreens(mixed)), ['KEEP'])
  })

  it('treats a screenshot outside a tool result the same way', () => {
    const loose: UserMessage = { role: 'user', content: [textBlock('here'), screen('LOOSE')] }
    assert.deepEqual(withoutScreens(loose).content, [textBlock('here'), textBlock(SCREEN_REMOVED)])
  })

  it('does a whole conversation at once, and returns the same list when there is nothing to remove', () => {
    const quiet = [userText('hi'), step('a'), result('a', 'ok')]
    assert.equal(withoutScreensFrom(quiet), quiet)
    const loud = [userText('hi'), step('a'), result('a', 'ok', screen('ONE'))]
    const stored = withoutScreensFrom(loud)
    assert.notEqual(stored, loud)
    assert.equal(stored.length, loud.length)
    assert.deepEqual(stored.flatMap(imagesOf), [])
  })
})

describe('what a conversation keeps of its screenshots', () => {
  const run = (count: number): Message[] => {
    const messages: Message[] = [userText('open the settings')]
    for (let i = 1; i <= count; i++) messages.push(step(`c${i}`), result(`c${i}`, `Screenshot s${i}`, screen(`IMG${i}`)))
    return messages
  }

  it('keeps the newest one', () => {
    assert.equal(KEEP_SCREENS, 1)
    const pruned = pruneScreens(run(4))
    assert.deepEqual(pruned.flatMap(imagesOf), ['IMG4'])
    assert.equal(pruned.length, 9, 'the count and the order of the messages do not change')
    assert.deepEqual(textsOf(pruned[2]), ['Screenshot s1', SCREEN_REMOVED], 'an older result says its screenshot is gone')
    assert.deepEqual(textsOf(pruned[8]), ['Screenshot s4'])
  })

  it('returns the very same list when there is nothing to drop', () => {
    const one = run(1)
    assert.equal(pruneScreens(one), one)
    const none: Message[] = [userText('hi')]
    assert.equal(pruneScreens(none), none)
  })

  it('keeps as many as it is told to', () => {
    assert.deepEqual(pruneScreens(run(5), 2).flatMap(imagesOf), ['IMG4', 'IMG5'])
    assert.deepEqual(pruneScreens(run(5), 0).flatMap(imagesOf), [])
  })

  it('drops thinking from the first message it changed, and not before', () => {
    const pruned = pruneScreens(run(3))
    const thinking = (message: Message) => message.role === 'assistant' && message.content.some((block) => block.type === 'thinking')
    // [user, step 1, result 1, step 2, result 2, step 3, result 3]: results 1 and 2 lose their screenshots,
    // so the steps written after result 1 lose their thinking, and step 1, written before it, keeps its own.
    assert.deepEqual(pruned.map(thinking), [false, true, false, false, false, false, false])
  })

  it('leaves the messages it did not change as the same objects', () => {
    const messages = run(3)
    const pruned = pruneScreens(messages)
    assert.equal(pruned[0], messages[0])
    assert.equal(pruned[6], messages[6], 'the newest result still carries its screenshot')
    assert.notEqual(pruned[2], messages[2])
  })

  it('counts every screenshot, including two in one message, newest first', () => {
    const batch: Message[] = [userText('go'), step('p'), result('p', 'two at once', screen('FIRST'), screen('SECOND'))]
    assert.deepEqual(pruneScreens(batch).flatMap(imagesOf), ['SECOND'])
  })

  it('never touches an image the user attached', () => {
    const messages: Message[] = [{ role: 'user', content: [textBlock('what is this'), photo('PHOTO')] }, ...run(3).slice(1)]
    assert.deepEqual(pruneScreens(messages).flatMap(imagesOf), ['PHOTO', 'IMG3'])
  })
})
