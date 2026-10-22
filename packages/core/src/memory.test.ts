import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { tempWorkspace } from '@encode/tools/testing'
import { loadMemory, memoryFingerprint, renderMemory, MAX_FILE_CHARS } from './memory'

const names = (files: { path: string }[], root: string) => files.map((file) => path.relative(root, file.path).split(path.sep).join('/'))

describe('project memory', () => {
  it('reads the first instruction file of a folder, and the private one after it', async () => {
    const root = await tempWorkspace({ 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude', 'ENCODE.local.md': 'private' })
    const home = await tempWorkspace()
    const files = await loadMemory({ root, home })
    assert.deepEqual(names(files, root), ['AGENTS.md', 'ENCODE.local.md'])
    assert.deepEqual(files.map((file) => file.scope), ['project', 'local'])

    await fs.writeFile(path.join(root, 'ENCODE.md'), 'ours')
    assert.deepEqual(names(await loadMemory({ root, home }), root), ['ENCODE.md', 'ENCODE.local.md'])
  })

  it('puts the user\'s own file first and the most specific last, climbing to the repository root', async () => {
    const repo = await tempWorkspace({ '.git/HEAD': 'ref: refs/heads/main', 'ENCODE.md': 'repo', 'packages/app/ENCODE.md': 'app' })
    const home = await tempWorkspace({ '.encode/ENCODE.md': 'me' })
    const files = await loadMemory({ root: path.join(repo, 'packages', 'app'), home })
    assert.deepEqual(files.map((file) => file.content), ['me', 'repo', 'app'])
    assert.deepEqual(files.map((file) => file.scope), ['user', 'project', 'project'])
  })

  it('does not climb out of a folder that is not in a repository', async () => {
    const outer = await tempWorkspace({ 'ENCODE.md': 'outer', 'inner/readme.txt': 'x' })
    const files = await loadMemory({ root: path.join(outer, 'inner'), home: await tempWorkspace() })
    assert.deepEqual(files, [])
  })

  it('follows @imports inside the workspace, and says when it refuses one outside it', async () => {
    const outside = await tempWorkspace({ 'secret.md': 'top secret' })
    const root = await tempWorkspace({
      'ENCODE.md': `Rules\n@docs/style.md\n@${path.join(outside, 'secret.md').replace(/\\/g, '/')}\n\`\`\`\n@docs/ignored.md\n\`\`\`\n`,
      'docs/style.md': 'Use tabs.\n@more.md',
      'docs/more.md': 'Nested.',
      'docs/ignored.md': 'Never read.',
    })
    const [file] = await loadMemory({ root, home: await tempWorkspace() })
    assert.match(file.content, /Use tabs\./)
    assert.match(file.content, /Nested\./)
    assert.doesNotMatch(file.content, /top secret/)
    assert.match(file.content, /Import of .*secret\.md skipped/)
    assert.doesNotMatch(file.content, /Never read/)
  })

  it('survives import cycles and cuts a long file in the middle', async () => {
    const root = await tempWorkspace({ 'ENCODE.md': `start\n@a.md\n${'x'.repeat(MAX_FILE_CHARS * 2)}`, 'a.md': 'A\n@ENCODE.md' })
    const [file] = await loadMemory({ root, home: await tempWorkspace() })
    assert.ok(file.content.length <= MAX_FILE_CHARS + 200)
    assert.match(file.content, /^start/)
  })

  it('ignores empty files and a byte order mark', async () => {
    const root = await tempWorkspace({ 'ENCODE.md': '   \n', 'AGENTS.md': String.fromCharCode(0xfeff) + 'Real rules' })
    const [file] = await loadMemory({ root, home: await tempWorkspace() })
    assert.equal(file.content, 'Real rules')
  })

  it('fingerprints what the agent would be told, and renders the change as a replacement', async () => {
    const root = await tempWorkspace({ 'ENCODE.md': 'one' })
    const home = await tempWorkspace()
    const before = await loadMemory({ root, home })
    assert.equal(memoryFingerprint(before), memoryFingerprint(await loadMemory({ root, home })))
    await fs.writeFile(path.join(root, 'ENCODE.md'), 'two')
    const after = await loadMemory({ root, home })
    assert.notEqual(memoryFingerprint(before), memoryFingerprint(after))
    assert.match(renderMemory(after, true)!, /changed since you last read them/)
    assert.match(renderMemory(after)!, /Instructions for this project follow/)
    assert.equal(renderMemory([]), undefined)
  })
})
