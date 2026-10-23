import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { TransportError, type CompletionOutcome, type PauseReason } from '@encode/providers'
import { describeError, detailsOf, FAULT_TEXT, MAX_DETAILS, plainError, problemFromError, shownError } from './problems'
import { sessionHarness } from './testing'
import type { ConversationEntry, ProblemAction } from './ui'

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'

/** What must never be in a sentence the chat shows: a provider's raw answer, a stack, an error class, a key. */
const RAW: readonly RegExp[] = [
  /\bHTTP \d{3}\b/,
  /[{[]\s*"/,
  /^\s*at\s/m,
  /:\d+:\d+\)?\s*$/m,
  /\b[A-Z][a-z]+Error\b/,
  /^Error\b/,
  /\bE[A-Z]{3,}\b/,
  /\bsk-[A-Za-z0-9]/,
  /\bBearer\s/,
  /\bundefined\b|\[object Object\]/,
]

function assertPlain(text: string | undefined, where: string): void {
  assert.ok(text?.trim(), `${where} says nothing`)
  for (const shape of RAW) assert.doesNotMatch(text!, shape, `${where} shows raw text: ${text}`)
}

const systemError = (code: string, syscall: string, file: string) => Object.assign(new Error(`${code}: oops, ${syscall} '${file}'`), { code, syscall, path: file })

describe('problems: plain words for what went wrong', () => {
  it('says what a system error means, with the path, and nothing else of it', () => {
    assert.equal(plainError(systemError('ENOENT', 'open', 'C:\\work\\a.txt')), 'C:\\work\\a.txt does not exist.')
    assert.equal(plainError(systemError('EBUSY', 'unlink', '/w/b.log')), '/w/b.log is in use by another program.')
    assert.equal(plainError(systemError('ENOSPC', 'write', '/w/c')), 'The disk is full.')
    assert.equal(plainError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })), 'Access was denied.')
  })

  it('keeps the first line of any other error, without its class, its stack or a key', () => {
    const error = new TypeError(`Cannot read properties of undefined (reading 'x')`)
    assert.equal(plainError(error), "Cannot read properties of undefined (reading 'x')")
    assert.equal(plainError(new Error(`Error: request failed with ${KEY}\n    at fetch (net.js:1:1)`)), 'request failed with [redacted]')
    assert.equal(plainError(''), 'It failed without saying why.')
    assert.equal(plainError('x'.repeat(400)).length, 301)
  })

  it("shows a person a fault in eNCode's own code as one fixed sentence, and the model what it said", () => {
    const fault = new TypeError("Cannot read properties of undefined (reading 'path')")
    assert.equal(shownError(fault), FAULT_TEXT)
    assert.equal(plainError(fault), "Cannot read properties of undefined (reading 'path')")
    assert.equal(shownError(new Error('The folder is not open.')), 'The folder is not open.')
  })

  it('describes an error fully for the details: class, code, frames and cause', () => {
    const cause = new Error('socket closed')
    const error = Object.assign(new Error('fetch failed', { cause }), { code: 'UND_ERR_SOCKET' })
    const text = describeError(error)
    assert.match(text, /^Error \[UND_ERR_SOCKET\]: fetch failed\n\s+at /)
    assert.match(text, /\nCaused by Error: socket closed$/)
    assert.equal(describeError('plain'), 'plain')
  })

  it('keeps keys and the home folder out of the details, and cuts them short', () => {
    const home = path.join(path.sep, 'home', 'ana')
    assert.equal(detailsOf(`HTTP 401 for ${KEY} reading ${path.join(home, 'x')}`, home), `HTTP 401 for [redacted] reading ${path.join('~', 'x')}`)
    assert.equal(detailsOf('Authorization: Bearer abcdefgh12345678'), 'Authorization: [redacted]')
    assert.equal(detailsOf('   '), undefined)
    assert.equal(detailsOf('y'.repeat(MAX_DETAILS + 50))!.length, MAX_DETAILS + 1)
  })

  it('makes a plain problem of anything thrown, and keeps what was thrown for the details', () => {
    const transport = problemFromError(new TransportError('auth', `HTTP 401: {"error":"invalid key ${KEY}"}`, { status: 401 }))
    assert.equal(transport.text, 'The model provider did not accept the API key.')
    assert.deepEqual(transport.problem, { code: 'auth', actions: ['settings', 'switch-model'] })
    assert.match(transport.details!, /HTTP 401/)
    assert.doesNotMatch(transport.details!, /sk-or-v1/)

    const system = problemFromError(systemError('EMFILE', 'open', '/w/d'))
    assert.equal(system.text, 'This request stopped: too many files are open at once.')
    assert.deepEqual(system.problem.actions, ['retry', 'diagnostics'])

    const bug = problemFromError(new RangeError('Maximum call stack size exceeded'))
    assert.equal(bug.text, 'Something went wrong inside eNCode, and this request stopped.')
    assert.equal(bug.problem.code, 'internal')
    assert.match(bug.details!, /^RangeError: Maximum call stack size exceeded\n\s+at /)
    for (const shown of [transport, system, bug]) assertPlain(shown.text, 'a thrown error')
  })
})

/** The entry a failed request ends on. */
const errorEntry = (entries: ConversationEntry[]) => entries.filter((entry) => entry.kind === 'error').at(-1)

describe('problems in a session: the chat stays clean', () => {
  const pauses: Array<{ reason: PauseReason; actions: ProblemAction[] }> = [
    { reason: 'auth', actions: ['settings', 'switch-model'] },
    { reason: 'payment', actions: ['switch-model', 'settings'] },
    { reason: 'quota', actions: ['switch-model', 'retry'] },
    { reason: 'rate-limit', actions: ['retry', 'switch-model'] },
    { reason: 'network', actions: ['retry'] },
    { reason: 'unavailable', actions: ['retry', 'switch-model'] },
    { reason: 'no-model', actions: ['switch-model', 'settings'] },
    { reason: 'refused', actions: ['switch-model'] },
  ]

  for (const { reason, actions } of pauses) {
    it(`ends on a ${reason} pause with its sentence, its actions and the provider's words folded away`, async () => {
      const retryAt = Date.now() + 3_600_000
      const outcome: CompletionOutcome = {
        kind: 'paused',
        reason,
        message: 'openrouter did not answer.',
        detail: `openrouter:m: HTTP 429: {"error":{"message":"slow down","key":"${KEY}"}}`,
        retryAt,
      }
      const h = await sessionHarness({ script: [{ outcome }] })
      const end = await h.session.start({ text: 'hello', mode: 'code' })
      assert.equal(end.kind, 'paused')
      const entry = errorEntry((await h.session.history()).entries)!
      if (actions.includes('retry')) assert.match(entry.text!, /^openrouter did not answer\. You can try again at \d{1,2}:\d{2}/)
      else assert.equal(entry.text, 'openrouter did not answer.', 'no time is given where trying again does not help')
      assertPlain(entry.text, `the ${reason} entry`)
      assert.deepEqual(entry.problem, { code: reason, actions, retryAt })
      assert.match(entry.details!, /HTTP 429: \{"error"/)
      assert.doesNotMatch(entry.details!, /sk-or-v1/)
      const [event] = h.of('error')
      assert.equal(event.message, entry.text)
      assert.equal(event.entryId, entry.id)
      assert.deepEqual(event.problem, entry.problem)
    })
  }

  it('ends a request whose model throws with a plain line, the stack in the details and the log', async () => {
    const warnings: string[] = []
    const h = await sessionHarness({
      script: () => {
        throw new TypeError(`Cannot read properties of undefined (reading 'choices') at ${KEY}`)
      },
      env: { warn: (message) => warnings.push(message) },
    })
    const end = await h.session.start({ text: 'hello', mode: 'code' })
    assert.deepEqual(end.kind === 'failed' && [end.code, end.message], ['internal', 'Something went wrong inside eNCode, and this request stopped.'])
    const entry = errorEntry((await h.session.history()).entries)!
    assertPlain(entry.text, 'the internal entry')
    assert.deepEqual(entry.problem, { code: 'internal', actions: ['retry', 'diagnostics'] })
    assert.match(entry.details!, /^TypeError: Cannot read properties of undefined \(reading 'choices'\) at \[redacted\]\n\s+at /)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /ended on a problem \(internal\)/)
    assert.doesNotMatch(warnings.join('\n'), /sk-or-v1/)
  })

  it('names the ends of the loop itself: a reply that never comes and a conversation too long for any window', async () => {
    const empty = await sessionHarness({ script: [{ text: '' }] })
    await empty.session.start({ text: 'hello', mode: 'code' })
    const quiet = errorEntry((await empty.session.history()).entries)!
    assert.equal(quiet.text, 'The model kept sending empty replies. Try again, or choose another model.')
    assert.deepEqual(quiet.problem, { code: 'empty', actions: ['retry', 'switch-model'] })

    const tight = await sessionHarness({ script: [{ outcome: { kind: 'compact', window: 1_000 } }] })
    await tight.session.start({ text: 'hello', mode: 'code' })
    const long = errorEntry((await tight.session.history()).entries)!
    assert.match(long.text!, /^The conversation does not fit the model's context window/)
    assert.deepEqual(long.problem, { code: 'context', actions: ['switch-model'] })
  })

  it('tells a switch and a wait in one plain line each, with what the router knew folded under it', async () => {
    const h = await sessionHarness({
      script: (request) => {
        request.onEvent?.({ type: 'switch', from: 'p-1:deepseek/v3', to: 'p-2:qwen/coder', reason: 'deepseek/v3 is getting too many requests right now.', detail: `HTTP 429 ${KEY}` })
        request.onEvent?.({ type: 'wait', until: Date.now() + 1000, reason: 'The free models take only so many requests a minute.' })
        return { text: 'Done.' }
      },
    })
    await h.session.start({ text: 'hello', mode: 'code' })
    const notices = (await h.session.history()).entries.filter((entry) => entry.kind === 'notice')
    assert.equal(notices[0].text, 'Switched to qwen/coder (p-2). deepseek/v3 is getting too many requests right now.')
    assert.equal(notices[0].details, 'HTTP 429 [redacted]')
    assert.match(notices[1].text!, /^The free models take only so many requests a minute\. Waiting until \d{1,2}:\d{2}/)
    assert.equal(notices[1].details, undefined)
    for (const notice of notices) assertPlain(notice.text, 'a notice')
  })

  it('says a hook could not run, and folds what it said', async () => {
    const h = await sessionHarness({
      script: [{ text: 'Hi.' }],
      hooks: {
        userPromptSubmit: async () => {
          throw new Error(`exit 1: Traceback (most recent call last): token=${KEY}`)
        },
      },
    })
    await h.session.start({ text: 'hello', mode: 'code' })
    const notice = (await h.session.history()).entries.find((entry) => entry.kind === 'notice')!
    assert.equal(notice.text, 'The UserPromptSubmit hook could not run.')
    assert.match(notice.details!, /^Error: exit 1: Traceback/)
    assert.doesNotMatch(notice.details!, /sk-or-v1/)
  })
})

describe('trying a request again', () => {
  it('runs the same request on from where it stopped, and the problem it ended on gives up its buttons', async () => {
    const h = await sessionHarness({
      script: (_request, step) =>
        step === 0 ? { outcome: { kind: 'paused', reason: 'network', message: 'eNCode could not reach openrouter.' } } : { text: 'Back again.' },
    })
    await h.session.start({ text: 'hello', mode: 'code' })
    const before = (await h.session.history()).entries
    assert.equal(before.filter((entry) => entry.kind === 'user').length, 1)

    const end = await h.session.retry()
    assert.equal(end.kind, 'done')
    const after = (await h.session.history()).entries
    assert.equal(after.filter((entry) => entry.kind === 'user').length, 1, 'no second message')
    assert.equal(errorEntry(after)!.problem!.resolved, true)
    assert.equal(after.at(-1)!.text, 'Back again.')
    assert.equal(h.client.requests.length, 2)
    assert.deepEqual(
      h.client.requests[1].payload.messages.filter((message) => message.role === 'user').length,
      1,
      'the model sees the one request, once',
    )

    // Reopened from the log, the problem still offers nothing.
    const reopened = await h.reopen()
    assert.equal(errorEntry((await reopened.history()).entries)!.problem!.resolved, true)
  })

  it('refuses when there is nothing to try again, or the session is busy', async () => {
    const h = await sessionHarness({ script: [{ text: 'All done.' }] })
    await assert.rejects(h.session.retry(), /nothing to try again/)
    await h.session.start({ text: 'hello', mode: 'code' })
    await assert.rejects(h.session.retry(), /The last request finished, so there is nothing to try again\. Send a new message\./)
  })
})
