import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { linkOrSkip, tempWorkspace } from '@encode/tools/testing'
import { createSkills, parseFrontMatter, scanSkills } from './skills'
import { loadAgentDefinitions } from './subagents'

describe('skills', () => {
  it('reads front matter and falls back to the first line of prose', () => {
    assert.deepEqual(parseFrontMatter('---\nname: x\ndescription: "Does a thing"\n---\nBody'), { fields: { name: 'x', description: 'Does a thing' }, body: 'Body' })
    assert.deepEqual(parseFrontMatter('no front matter'), { fields: {}, body: 'no front matter' })
  })

  it('finds skills as folders and as files, later folders overriding earlier ones', async () => {
    const user = await tempWorkspace({
      'release/SKILL.md': '---\ndescription: Ship a release\n---\nSteps',
      'notes.md': '# Notes\nWrite notes in the house style.',
      'ignored.txt': 'x',
    })
    const workspace = await tempWorkspace({ 'release/SKILL.md': '---\ndescription: Project release\n---\nOur steps' })
    const found = scanSkills([
      { dir: user, source: 'user' },
      { dir: workspace, source: 'workspace' },
      { dir: path.join(user, 'missing'), source: 'user' },
    ])
    assert.deepEqual(found.map((skill) => [skill.name, skill.description, skill.source]), [
      ['notes', 'Write notes in the house style.', 'user'],
      ['release', 'Project release', 'workspace'],
    ])
  })

  it('loads a skill\'s body without its front matter, and sees new files at once', async () => {
    const dir = await tempWorkspace({ 'a/SKILL.md': '---\ndescription: A\n---\nDo A.' })
    const skills = createSkills(() => [{ dir, source: 'user' }])
    assert.deepEqual(skills.list(), [{ name: 'a', description: 'A' }])
    assert.deepEqual(await skills.load('a'), { name: 'a', directory: path.join(dir, 'a'), body: 'Do A.' })
    assert.equal(await skills.load('b'), undefined)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'b.md'), 'Do B.')
    assert.deepEqual(skills.list().map((skill) => skill.name), ['a', 'b'])
  })
})

describe('skills kept in a repository', () => {
  it('ignore a skill file that is a link, where the user\'s own folder may hold one', async (t) => {
    const outside = await tempWorkspace({ 'secret.md': 'my private key' })
    const root = await tempWorkspace({ '.encode/skills/plain.md': 'A plain skill.' })
    const user = await tempWorkspace({ 'kept.md': 'Kept here.' })
    const folder = path.join(root, '.encode', 'skills')
    if (!linkOrSkip(t, path.join(outside, 'secret.md'), path.join(folder, 'stolen.md'))) return
    if (!linkOrSkip(t, path.join(outside, 'secret.md'), path.join(user, 'mine.md'))) return
    const skills = createSkills(() => [
      { dir: user, source: 'user' },
      { dir: folder, source: 'workspace' },
    ])
    assert.deepEqual(skills.list().map((skill) => skill.name), ['kept', 'mine', 'plain'])
    assert.equal(await skills.load('stolen'), undefined)
    assert.equal((await skills.load('mine'))?.body, 'my private key')
  })

  it('are not read from a skills folder that is a link leading out of the project', async (t) => {
    const outside = await tempWorkspace({ 'trick/SKILL.md': 'Not yours.', 'also.md': 'Nor this.', 'skills/deep.md': 'Nor this one.' })
    const direct = await tempWorkspace({ '.encode/readme.txt': 'x' })
    const viaParent = await tempWorkspace()
    if (!linkOrSkip(t, outside, path.join(direct, '.encode', 'skills'), 'junction')) return
    if (!linkOrSkip(t, outside, path.join(viaParent, '.encode'), 'junction')) return
    assert.deepEqual(scanSkills([{ dir: path.join(direct, '.encode', 'skills'), source: 'workspace' }]), [])
    assert.deepEqual(scanSkills([{ dir: path.join(viaParent, '.encode', 'skills'), source: 'workspace' }]), [])
    // The same folders are fine when they are the user's own.
    assert.deepEqual(scanSkills([{ dir: path.join(viaParent, '.encode', 'skills'), source: 'user' }]).map((skill) => skill.name), ['deep'])
    assert.deepEqual(scanSkills([{ dir: path.join(direct, '.encode', 'skills'), source: 'user' }]).map((skill) => skill.name), ['also', 'trick'])
  })

  it('do not follow a skill folder that is a link, where the user\'s own folder may', async (t) => {
    const elsewhere = await tempWorkspace({ 'SKILL.md': '---\ndescription: Kept in another repository\n---\nSteps' })
    const user = await tempWorkspace()
    const folder = await tempWorkspace({ '.encode/skills/real/SKILL.md': 'Real.' })
    const skills = path.join(folder, '.encode', 'skills')
    if (!linkOrSkip(t, elsewhere, path.join(user, 'linked'), 'junction')) return
    if (!linkOrSkip(t, elsewhere, path.join(skills, 'linked'), 'junction')) return
    assert.deepEqual(scanSkills([{ dir: user, source: 'user' }]).map((skill) => [skill.name, skill.description]), [['linked', 'Kept in another repository']])
    assert.deepEqual(scanSkills([{ dir: skills, source: 'workspace' }]).map((skill) => skill.name), ['real'])
  })

  it('skip a file that is too big to be a skill, and a folder named like one', async () => {
    const dir = await tempWorkspace({ 'big.md': 'x'.repeat(300 * 1024), 'ok.md': 'Fine.', 'folder.md/inside.txt': 'x' })
    assert.deepEqual(scanSkills([{ dir, source: 'user' }]).map((skill) => skill.name), ['ok'])
  })
})

describe('agent definitions', () => {
  it('loads agents from Markdown with their tools, role and prompt, and refuses built-in names', async () => {
    const dir = await tempWorkspace({
      'reviewer.md': '---\ndescription: Reviews diffs\ntools: Read, Grep\nrole: reviewer\n---\nBe strict.',
      'Explore.md': '---\ndescription: Replaces a built-in\n---\nNo.',
      'nodescription.md': 'Just text.',
      'bad name.md': '---\ndescription: x\n---\nx',
    })
    const found = loadAgentDefinitions([{ dir, source: 'workspace' }])
    assert.deepEqual(found, [
      { name: 'reviewer', description: 'Reviews diffs', tools: ['Read', 'Grep'], role: 'reviewer', prompt: 'Be strict.', source: 'workspace', file: path.join(dir, 'reviewer.md') },
    ])
  })
})
