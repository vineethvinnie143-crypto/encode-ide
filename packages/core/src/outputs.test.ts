import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { createOutputStore } from './outputs'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-outputs-')))
  made.push(dir)
  return dir
}

const DAY = 24 * 60 * 60 * 1000

describe('the store of long tool results', () => {
  it('keeps each result whole in the session folder, under a name nothing in it can lead out of', async () => {
    const dir = await tempDir()
    const store = createOutputStore({ dir })
    const file = await store.keep('s1', 'Bash-call_1', 'all of it\n')
    assert.equal(file, path.join(dir, 's1', 'Bash-call_1.txt'))
    assert.equal(await fs.readFile(file!, 'utf8'), 'all of it\n')
    if (process.platform !== 'win32') assert.equal((await fs.stat(file!)).mode & 0o777, 0o600)
    // The model chose the call's id.
    const odd = await store.keep('s1', 'mcp__srv__get-../../../escape', 'x')
    assert.equal(path.dirname(odd!), path.join(dir, 's1'))
    assert.equal(path.basename(odd!), 'mcp__srv__get-.._.._.._escape.txt')
    assert.equal(await store.keep('s1', 'Bash-call_1', 'again'), path.join(dir, 's1', 'Bash-call_1-2.txt'), 'never over another')
    assert.equal(await store.keep('../s2', 'Bash-1', 'x'), undefined, 'a session id that is not one of the store’s')
    assert.equal(await store.keep('..', 'Bash-1', 'x'), undefined, 'nor the folder above')
    await store.remove('..')
    assert.ok(await fs.stat(file!), 'nothing above the store is removed')
    assert.equal(store.folder('s1'), path.join(dir, 's1'))
  })

  it('keeps no more for a session than its ceiling, and makes room in all by removing the oldest other sessions', async () => {
    const dir = await tempDir()
    let now = 10 * DAY
    const store = createOutputStore({ dir, maxSessionBytes: 100, maxTotalBytes: 250, now: () => now })
    assert.ok(await store.keep('a', 'one', 'x'.repeat(60)))
    assert.equal(await store.keep('a', 'two', 'x'.repeat(60)), undefined, 'over what one session may keep')
    assert.equal(await store.keep('a', 'big', 'x'.repeat(101)), undefined)
    await fs.utimes(path.join(dir, 'a', 'one.txt'), new Date(now - 3000), new Date(now - 3000))
    assert.ok(await store.keep('b', 'one', 'x'.repeat(90)))
    assert.ok(await store.keep('c', 'one', 'x'.repeat(90)))
    // 240 kept; 30 more do not fit until the oldest session goes.
    now += 1000
    assert.ok(await store.keep('d', 'one', 'x'.repeat(30)))
    assert.equal(await fs.stat(path.join(dir, 'a')).catch(() => undefined), undefined, 'the oldest went')
    assert.ok(await fs.stat(path.join(dir, 'b', 'one.txt')))
  })

  it('removes folders nothing was kept in for two weeks, and a session’s folder with the session', async () => {
    const dir = await tempDir()
    const now = Date.now()
    await fs.mkdir(path.join(dir, 'old'), { recursive: true })
    await fs.writeFile(path.join(dir, 'old', 'Bash-1.txt'), 'old')
    await fs.utimes(path.join(dir, 'old', 'Bash-1.txt'), new Date(now - 15 * DAY), new Date(now - 15 * DAY))
    await fs.mkdir(path.join(dir, 'recent'), { recursive: true })
    await fs.writeFile(path.join(dir, 'recent', 'Bash-1.txt'), 'recent')
    const store = createOutputStore({ dir })
    assert.ok(await store.keep('new', 'Grep-1', 'text'))
    assert.equal(await fs.stat(path.join(dir, 'old')).catch(() => undefined), undefined)
    assert.ok(await fs.stat(path.join(dir, 'recent', 'Bash-1.txt')))
    await store.remove('new')
    assert.equal(await fs.stat(path.join(dir, 'new')).catch(() => undefined), undefined)
  })

  it('keeps results that arrive at once, each in its own file', async () => {
    const dir = await tempDir()
    const store = createOutputStore({ dir })
    const files = await Promise.all(Array.from({ length: 8 }, (_, index) => store.keep('s', 'Read', `part ${index}`)))
    assert.equal(new Set(files).size, 8)
    assert.deepEqual((await Promise.all(files.map((file) => fs.readFile(file!, 'utf8')))).sort(), Array.from({ length: 8 }, (_, index) => `part ${index}`))
  })
})
