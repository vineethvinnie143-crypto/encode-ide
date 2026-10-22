import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'
import { linkOrSkip, tempWorkspace } from '@encode/tools/testing'
import { insideRealSync, readSmallFile } from './safe-files'

describe('reading a small file', () => {
  it('returns the text of a regular file, and nothing for a missing one, a folder or a big one', async () => {
    const dir = await tempWorkspace({ 'a.md': 'hello', 'big.md': 'x'.repeat(2_000), 'sub/b.md': 'b' })
    const options = { maxBytes: 1_000, followLinks: false }
    assert.equal(readSmallFile(path.join(dir, 'a.md'), options), 'hello')
    assert.equal(readSmallFile(path.join(dir, 'missing.md'), options), null)
    assert.equal(readSmallFile(path.join(dir, 'sub'), options), null)
    assert.equal(readSmallFile(path.join(dir, 'big.md'), options), null)
    assert.equal(readSmallFile(path.join(dir, 'big.md'), { maxBytes: 5_000, followLinks: false }), 'x'.repeat(2_000))
  })

  it('refuses a link unless links are followed, and then reads what it points at', async (t) => {
    const dir = await tempWorkspace({ 'real.md': 'real' })
    const outside = await tempWorkspace({ 'secret.md': 'secret' })
    if (!linkOrSkip(t, path.join(outside, 'secret.md'), path.join(dir, 'link.md'), 'file')) return
    assert.equal(readSmallFile(path.join(dir, 'link.md'), { maxBytes: 100, followLinks: false }), null)
    assert.equal(readSmallFile(path.join(dir, 'link.md'), { maxBytes: 100, followLinks: true }), 'secret')
  })

  it('does not wait on a named pipe, whether it is the file or the target of a link', async (t) => {
    if (process.platform === 'win32') return t.skip('no named pipes here')
    const dir = await tempWorkspace()
    const pipe = path.join(dir, 'pipe.md')
    execFileSync('mkfifo', [pipe])
    assert.equal(readSmallFile(pipe, { maxBytes: 100, followLinks: false }), null)
    assert.equal(readSmallFile(pipe, { maxBytes: 100, followLinks: true }), null)
    if (!linkOrSkip(t, pipe, path.join(dir, 'via.md'), 'file')) return
    assert.equal(readSmallFile(path.join(dir, 'via.md'), { maxBytes: 100, followLinks: true }), null)
  })
})

describe('being inside a folder once links are resolved', () => {
  it('is true for the folder itself and for what is in it, false for the rest', async () => {
    const root = await tempWorkspace({ 'a/b.txt': 'b' })
    const other = await tempWorkspace({ 'c.txt': 'c' })
    assert.equal(insideRealSync(root, root), true)
    assert.equal(insideRealSync(root, path.join(root, 'a')), true)
    assert.equal(insideRealSync(root, path.join(root, 'a', 'b.txt')), true)
    assert.equal(insideRealSync(root, other), false)
    assert.equal(insideRealSync(root, path.join(root, 'missing')), false)
    assert.equal(insideRealSync(path.join(root, 'missing'), root), false)
  })

  it('is false for a folder that is a link leading out', async (t) => {
    const root = await tempWorkspace()
    const other = await tempWorkspace({ 'c.txt': 'c' })
    if (!linkOrSkip(t, other, path.join(root, 'out'), 'junction')) return
    assert.equal(insideRealSync(root, path.join(root, 'out')), false)
    assert.equal(insideRealSync(root, path.join(root, 'out', 'c.txt')), false)
  })
})
