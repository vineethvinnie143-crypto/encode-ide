import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorResponse, Harness, OPENROUTER_KEY, sseResponse } from '../testing/harness'

/** Everything a client can see of a response: the status, every header and the whole body. */
async function seen(response: Response): Promise<string> {
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
  return `${response.status}\n${headers}\n${await response.text()}`
}

/** What a buggy or hostile upstream might answer with if it echoed the credential it was sent. */
const echoes: Array<[string, () => Response]> = [
  ['a 401 that names the key', () => errorResponse(401, `No auth credentials found for ${OPENROUTER_KEY}`, { 'x-debug-key': OPENROUTER_KEY })],
  ['a 402 that names the key', () => errorResponse(402, `Key ${OPENROUTER_KEY} is out of credit`)],
  ['a 429 that names the key', () => errorResponse(429, `Slow down ${OPENROUTER_KEY}`, { 'retry-after': '1' })],
  ['a 400 that names the key', () => errorResponse(400, `Invalid request for key ${OPENROUTER_KEY}`)],
  ['a 403 that names the key', () => errorResponse(403, `Input flagged for ${OPENROUTER_KEY}`)],
  ['a 500 with the key in a body field', () => new Response(JSON.stringify({ detail: OPENROUTER_KEY }), { status: 500 })],
  ['an error chunk before any content', () => sseResponse([{ error: { code: 502, message: `echo ${OPENROUTER_KEY}` } }], false)],
]

describe('the OpenRouter key', () => {
  for (const stream of [false, true]) {
    for (const [name, respond] of echoes) {
      it(`never reaches a ${stream ? 'streaming' : 'plain'} client or the log after ${name}`, async () => {
        const harness = await Harness.create()
        const { access_token: token } = await harness.signIn()
        harness.openrouter.script.push(respond, respond, respond)
        const response = await harness.chat(token, { stream })
        const text = await seen(response)
        await harness.idle()
        assert.ok(harness.openrouter.chats.length >= 1, 'the upstream was never asked')
        assert.ok(!text.includes(OPENROUTER_KEY), 'the client saw the key')
        assert.ok(!harness.log.text().includes(OPENROUTER_KEY), 'the log holds the key')
      })
    }
  }

  it('is the only credential the upstream receives, and the client sends none of its own along', async () => {
    const harness = await Harness.create()
    const { access_token: token } = await harness.signIn()
    const response = await harness.chat(
      token,
      { stream: false },
      {
        headers: {
          cookie: 'session=abc',
          'x-api-key': 'client-supplied-key',
          'x-forwarded-for': '198.51.100.9',
          'http-referer': 'https://attacker.example.test',
          'x-title': 'not the gateway title',
          'openai-organization': 'org-client',
        },
      },
    )
    assert.equal(response.status, 200)
    await harness.idle()
    const [sent] = harness.openrouter.chats
    assert.deepEqual([...sent.headers.keys()].sort(), ['accept', 'authorization', 'content-type', 'http-referer', 'x-title'])
    assert.equal(sent.headers.get('authorization'), `Bearer ${OPENROUTER_KEY}`)
    assert.equal(sent.headers.get('http-referer'), harness.config.appUrl)
    assert.equal(sent.headers.get('x-title'), harness.config.appTitle)
    assert.ok(!JSON.stringify(sent.body).includes(token), 'the client token never goes upstream')
  })
})
