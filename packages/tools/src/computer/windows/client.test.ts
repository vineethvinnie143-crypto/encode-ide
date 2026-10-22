import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { DesktopError } from '../contract'
import { HelperClient, type ClientOptions } from './client'
import { spawnFakeHelper, writeFakeHelper } from './fake-helper'

let folder: string
let script: string
let counter = 0

before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-client-'))
  script = await writeFakeHelper(folder)
})

after(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

const clients: HelperClient[] = []
after(async () => {
  await Promise.all(clients.map((client) => client.dispose()))
})

function start(env: Record<string, string> = {}, options: Partial<ClientOptions> = {}): { client: HelperClient; log: string } {
  const log = path.join(folder, `requests-${++counter}.jsonl`)
  const client = new HelperClient({ spawn: () => spawnFakeHelper(script, { FAKE_LOG: log, ...env }), ...options })
  clients.push(client)
  return { client, log }
}

async function requests(log: string): Promise<{ id?: number; op: string; args?: unknown }[]> {
  try {
    return (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

async function failure(work: Promise<unknown>): Promise<DesktopError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof DesktopError, String(error))
    return error
  }
  return assert.fail('The call should have failed.')
}

const never = () => new AbortController().signal

describe('the helper client', () => {
  it('waits for hello, then answers requests by their ids, in whatever order they finish', async () => {
    const { client } = start()
    await client.start()
    assert.equal(client.alive, true)
    assert.ok(client.pid > 0)
    const [a, b] = await Promise.all([client.request('echo', { n: 1 }, { signal: never(), timeoutMs: 5_000 }), client.request('echo', { n: 2 }, { signal: never(), timeoutMs: 5_000 })])
    assert.deepEqual(a, { n: 1 })
    assert.deepEqual(b, { n: 2 })
  })

  it('reads an answer that arrives in pieces, even in the middle of a character', async () => {
    const { client } = start()
    await client.start()
    const answer = await client.request('split', {}, { signal: never(), timeoutMs: 5_000 })
    assert.equal(answer, String.fromCodePoint(0x68, 0xe9, 0x6c, 0x6c, 0x6f, 0x20, 0x65e5, 0x672c, 0x8a9e))
  })

  it('ignores lines it cannot use and answers for ids it never asked', async () => {
    const lines: string[] = []
    const { client } = start({}, { log: (line) => lines.push(line) })
    await client.start()
    assert.equal(await client.request('garbage', {}, { signal: never(), timeoutMs: 5_000 }), 'after garbage')
    assert.ok(lines.some((line) => /unreadable line/.test(line)))
  })

  it('turns the helper\'s failures into errors the model can read, keeping the code', async () => {
    const { client } = start()
    await client.start()
    const known = await failure(client.request('fail', { code: 'covered', message: 'Notepad is on top of (3, 4).' }, { signal: never(), timeoutMs: 5_000 }))
    assert.equal(known.code, 'covered')
    assert.equal(known.message, 'Notepad is on top of (3, 4).')
    const odd = await failure(client.request('fail', { code: 'banana', message: 'x' }, { signal: never(), timeoutMs: 5_000 }))
    assert.equal(odd.code, 'failed', 'a code the contract does not know is a plain failure')
    const empty = await failure(client.request('fail', {}, { signal: never(), timeoutMs: 5_000 }))
    assert.equal(empty.code, 'failed')
    assert.match(empty.message, /without saying why/)
  })

  it('tells the helper to stop when the caller gives up, and the caller gets the reason at once', async () => {
    const { client, log } = start()
    await client.start()
    const controller = new AbortController()
    const pending = client.request('slow', {}, { signal: controller.signal, timeoutMs: 30_000 })
    await until(async () => (await requests(log)).some((request) => request.op === 'slow'), 'the request to arrive')
    const reason = new Error('the user pressed stop')
    controller.abort(reason)
    await assert.rejects(pending, (error: unknown) => error === reason)
    await until(async () => (await requests(log)).some((request) => request.op === 'cancel'), 'the cancel message')
    const sent = await requests(log)
    assert.equal(sent.find((request) => request.op === 'cancel')?.id, sent.find((request) => request.op === 'slow')?.id)
    assert.equal(client.alive, true, 'a helper that stops when told is kept')
    assert.deepEqual(await client.request('echo', 'again', { signal: never(), timeoutMs: 5_000 }), 'again')
  })

  it('refuses a request whose signal has already fired, without sending it', async () => {
    const { client, log } = start()
    await client.start()
    const controller = new AbortController()
    controller.abort(new Error('no'))
    await assert.rejects(client.request('echo', {}, { signal: controller.signal, timeoutMs: 1_000 }), /no/)
    assert.equal((await requests(log)).filter((request) => request.op === 'echo').length, 0)
  })

  it('gives up on a request that takes too long, and says which', async () => {
    const { client, log } = start()
    await client.start()
    const error = await failure(client.request('slow', {}, { signal: never(), timeoutMs: 80 }))
    assert.equal(error.code, 'timeout')
    assert.match(error.message, /did not answer slow/)
    await until(async () => (await requests(log)).some((request) => request.op === 'cancel'), 'the cancel message')
  })

  it('restarts a helper that does not stop when told to', async () => {
    const lines: string[] = []
    const { client } = start({ FAKE_MODE: 'deaf' }, { stuckMs: 150, log: (line) => lines.push(line) })
    await client.start()
    const controller = new AbortController()
    const pending = client.request('slow', {}, { signal: controller.signal, timeoutMs: 30_000 })
    const settled = pending.catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 60))
    controller.abort(new Error('stop'))
    await settled
    await until(() => !client.alive, 'the stuck helper to be killed')
    assert.ok(lines.some((line) => /did not stop after it was cancelled/.test(line)))
    const next = await failure(client.request('echo', {}, { signal: never(), timeoutMs: 1_000 }))
    assert.equal(next.code, 'unavailable')
  })

  it('fails what is waiting when the helper dies, and says how it ended', async () => {
    const { client } = start()
    await client.start()
    const [a, b] = await Promise.all([failure(client.request('crash', {}, { signal: never(), timeoutMs: 5_000 })), failure(client.request('slow', {}, { signal: never(), timeoutMs: 5_000 }))])
    for (const error of [a, b]) {
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /stopped \(exit code 3\)/)
    }
    assert.equal(client.alive, false)
    assert.equal((await failure(client.request('echo', {}, { signal: never(), timeoutMs: 1_000 }))).code, 'unavailable')
  })

  it('does not start a helper that speaks another protocol', async () => {
    const { client } = start({ FAKE_PROTOCOL: '99' })
    const error = await failure(client.start())
    assert.equal(error.code, 'unavailable')
    assert.match(error.message, /protocol 99, not 1/)
    assert.equal(client.alive, false)
  })

  it('gives up on a helper that never says hello, and mentions antivirus programs', async () => {
    const { client } = start({ FAKE_MODE: 'silent' }, { helloTimeoutMs: 150 })
    const error = await failure(client.start())
    assert.equal(error.code, 'unavailable')
    assert.match(error.message, /did not start within/)
    assert.match(error.message, /antivirus/)
  })

  it('stops waiting for hello when the caller gives up', async () => {
    const { client } = start({ FAKE_MODE: 'silent' }, { helloTimeoutMs: 30_000 })
    const controller = new AbortController()
    const starting = client.start(controller.signal)
    setTimeout(() => controller.abort(new Error('cancelled')), 50)
    await assert.rejects(starting, /cancelled/)
    assert.equal(client.alive, false, 'the helper that never answered is stopped')
  })

  it('reports a program that cannot be started', async () => {
    const client = new HelperClient({
      spawn: () => {
        throw new Error('spawn EACCES')
      },
    })
    const error = await failure(client.start())
    assert.equal(error.code, 'unavailable')
    assert.match(error.message, /EACCES/)
    assert.match(error.message, /antivirus/)
    const missing = new HelperClient({ spawn: () => spawnFakeHelper(path.join(folder, 'missing.mjs')) })
    const gone = await failure(missing.start())
    assert.equal(gone.code, 'unavailable')
  })

  it('lets go of the helper when disposed: it ends its input and the helper exits', async () => {
    const { client } = start()
    await client.start()
    const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child
    await client.dispose()
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(client.alive, false)
    assert.equal((await failure(client.request('echo', {}, { signal: never(), timeoutMs: 1_000 }))).code, 'unavailable')
    await client.dispose()
  })
})
