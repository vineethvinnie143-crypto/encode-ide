import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { LanguageClient } from './client'
import { fakeServer, type FakeServer } from './fake-server'

/** Real child processes: the fake server speaks the wire format over its standard input and output. */

let fake: FakeServer
let root: string

before(async () => {
  fake = await fakeServer()
  root = path.join(fake.dir, 'project')
  await mkdir(root)
})

after(async () => {
  await fake.dispose()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await wait(10)
  }
}

function start(mode = '', options: Partial<Parameters<typeof LanguageClient.start>[0]> = {}) {
  const exits: string[] = []
  const proc = fake.start(mode)
  const client = LanguageClient.start({ name: 'fake-ls', root, process: proc, settings: { fake: { option: 'on' } }, onExit: (reason) => exits.push(reason), ...options })
  return { client, proc, exits }
}

const file = (name: string) => path.join(root, name)

describe('a language server', () => {
  it('shakes hands, answers settings by section, and gives the server no choices to make', async () => {
    const { client } = start()
    const c = await client
    assert.equal(c.supports('definition'), true)
    assert.equal(c.supports('pullDiagnostics'), false)
    await until('the server to log its settings', () => c.logs().some((line) => line.startsWith('choice')))
    const logs = c.logs()
    assert.ok(logs.some((line) => line.startsWith('init ') && line.includes(JSON.stringify(`file://${root.split('/').map(encodeURIComponent).join('/')}`))), logs.join('\n'))
    assert.ok(logs.includes('config ["on",null]'), logs.join('\n'))
    assert.ok(logs.includes('choice null'))
    assert.ok(logs.includes('settings {"fake":{"option":"on"}}'))
    await c.stop()
  })

  it('waits for the diagnostics of the text it last sent, by version', async () => {
    const c = await start().client
    const a = file('a.fk')
    c.sync(a, 'fake', 'fine\nERROR here\n')
    const first = await c.diagnostics(a, { waitMs: 2_000 })
    assert.equal(first.fresh, true)
    assert.deepEqual(first.items.map((item) => [item.range.start.line, item.severity, item.message]), [[1, 1, 'Something is wrong here']])
    c.sync(a, 'fake', 'fine\nWARN now\n')
    const second = await c.diagnostics(a, { waitMs: 2_000 })
    assert.deepEqual(second.items.map((item) => item.severity), [2])
    assert.equal(c.document(a)?.version, 2)
    await c.stop()
  })

  it('tells a new publish from an old one when the server gives no version', async () => {
    const c = await start('noversion').client
    const a = file('b.fk')
    const since = c.publishCount(a)
    c.sync(a, 'fake', 'ERROR')
    const result = await c.diagnostics(a, { waitMs: 2_000, since })
    assert.equal(result.fresh, true)
    assert.equal(result.items.length, 1)
    await c.stop()
  })

  it('waits a moment for the second of two publishes', async () => {
    const c = await start('twice').client
    const a = file('c.fk')
    c.sync(a, 'fake', 'ERROR ERROR\nWARN')
    const result = await c.diagnostics(a, { waitMs: 2_000 })
    assert.equal(result.items.length, 2)
    await c.stop()
  })

  it('says when the time ran out before the server spoke', async () => {
    const c = await start('slow').client
    const a = file('d.fk')
    c.sync(a, 'fake', 'ERROR')
    const result = await c.diagnostics(a, { waitMs: 50 })
    assert.equal(result.fresh, false)
    assert.deepEqual(result.items, [])
    await c.stop()
  })

  it('asks a server that answers pulls instead of waiting for a push', async () => {
    const c = await start('pull').client
    assert.equal(c.supports('pullDiagnostics'), true)
    const a = file('e.fk')
    c.sync(a, 'fake', 'x\nERROR')
    const result = await c.diagnostics(a, { waitMs: 2_000 })
    assert.equal(result.fresh, true)
    assert.equal(result.items[0].range.start.line, 1)
    await c.stop()
  })

  it('sends a save when the server wants one, and ranges when it takes them', async () => {
    const c = await start('incremental').client
    const a = file('f.fk')
    c.sync(a, 'fake', 'one\ntwo\n')
    c.edit(a, 'one\nERROR\n', [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, text: 'ERROR' }])
    const result = await c.diagnostics(a, { waitMs: 2_000 })
    assert.equal(result.items.length, 1, 'the server applied the range to its copy')
    c.sync(a, 'fake', 'one\nERROR\n', { saved: true })
    await until('the save', () => c.logs().includes('save f.fk'))
    c.close(a)
    await until('the close', () => c.logs().includes('close f.fk'))
    assert.equal(c.document(a), undefined)
    await c.stop()
  })

  it('refuses an edit the server asks for unprompted', async () => {
    const c = await start('rogue').client
    await until('the rogue edit', () => c.logs().some((line) => line.startsWith('rogue')))
    assert.ok(c.logs().includes('rogue {"applied":false,"failureReason":"eNCode applies an edit only for a command it asked to run."}'), c.logs().join('\n'))
    await c.stop()
  })

  it('lets a command it runs apply its edit, and only while it runs', async () => {
    const c = await start().client
    const a = file('g.fk')
    c.sync(a, 'fake', 'ERROR\nok\nERROR')
    const seen: unknown[] = []
    const result = await c.executeCommand({ command: 'fake.fixAll', arguments: [c.document(a)!.uri] }, async (edit) => {
      seen.push(edit)
      return { applied: true }
    })
    assert.deepEqual(result, { applied: true, failureReason: null })
    const change = (seen[0] as { documentChanges: { edits: unknown[] }[] }).documentChanges[0]
    assert.equal(change.edits.length, 2)
    await c.stop()
  })

  it('stops a server cleanly without calling it a crash', async () => {
    const { client, proc, exits } = start()
    const c = await client
    await c.stop()
    await proc.exited
    assert.deepEqual(exits, [])
    await assert.rejects(c.request('textDocument/hover', {}), /was stopped/)
  })

  it('kills a server that does not answer the request to stop', async () => {
    const { client, proc, exits } = start('deaf')
    const c = await client
    await c.stop()
    const ended = await proc.exited
    assert.equal(ended.signal, process.platform === 'win32' ? null : 'SIGKILL')
    assert.deepEqual(exits, [])
  })

  it('reports a crash with the last thing the server said', async () => {
    const { client, exits } = start('crash')
    const c = await client
    c.sync(file('h.fk'), 'fake', 'x')
    await until('the crash', () => exits.length > 0)
    assert.match(exits[0], /exited with code 1/)
    assert.match(exits[0], /boom: the fake server fell over/)
    assert.ok(c.exited)
    const result = await c.diagnostics(file('h.fk'), { waitMs: 500 })
    assert.equal(result.fresh, false)
  })

  it('says why a server did not start', async () => {
    await assert.rejects(start('nostart').client, /fake-ls did not start: .*cannot start: no project found/)
    const hung = start('hang', { initializeTimeoutMs: 150 })
    await assert.rejects(hung.client, /did not answer initialize/)
    await hung.proc.exited
  })
})
