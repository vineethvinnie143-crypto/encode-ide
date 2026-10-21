import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { tempWorkspace } from '@encode/tools/testing'
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
      { name: 'reviewer', description: 'Reviews diffs', tools: ['Read', 'Grep'], role: 'reviewer', prompt: 'Be strict.', source: 'workspace' },
    ])
  })
})
