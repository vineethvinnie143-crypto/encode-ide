import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SkillService, migrateLegacySkills } from './skills'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'encode-skills-'))

describe('moving skills to the user\'s folder', () => {
  it('copies what is missing, keeps what is there, and leaves the originals', () => {
    const legacy = temp()
    const target = path.join(temp(), 'skills')
    fs.writeFileSync(path.join(legacy, 'notes.md'), 'old notes')
    fs.writeFileSync(path.join(legacy, 'keep.md'), 'old keep')
    fs.mkdirSync(path.join(legacy, 'release'))
    fs.writeFileSync(path.join(legacy, 'release', 'SKILL.md'), 'release steps')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.md'), 'new keep')

    assert.equal(migrateLegacySkills(legacy, target), 2)
    assert.equal(fs.readFileSync(path.join(target, 'notes.md'), 'utf8'), 'old notes')
    assert.equal(fs.readFileSync(path.join(target, 'keep.md'), 'utf8'), 'new keep')
    assert.equal(fs.readFileSync(path.join(target, 'release', 'SKILL.md'), 'utf8'), 'release steps')
    assert.equal(fs.existsSync(path.join(legacy, 'notes.md')), true)
    assert.equal(migrateLegacySkills(legacy, target), 0)
  })

  it('does nothing when there was no earlier folder', () => {
    assert.equal(migrateLegacySkills(path.join(temp(), 'missing'), path.join(temp(), 'skills')), 0)
  })
})

describe('the skill list', () => {
  it('reads the user folder and the workspace folder, and creates skills in the user folder', async () => {
    const userDir = temp()
    const root = temp()
    fs.mkdirSync(path.join(userDir, 'skills'))
    fs.writeFileSync(path.join(userDir, 'skills', 'deploy.md'), '---\nname: deploy\ndescription: Ship it\n---\nsteps')
    fs.mkdirSync(path.join(root, '.encode', 'skills', 'review'), { recursive: true })
    fs.writeFileSync(path.join(root, '.encode', 'skills', 'review', 'SKILL.md'), 'Review a change carefully.')
    const opened: string[] = []
    const skills = new SkillService(() => root, userDir, async (dir) => void opened.push(dir))

    assert.deepEqual(
      skills.list().map((skill) => [skill.name, skill.source, skill.description]),
      [
        ['deploy', 'user', 'Ship it'],
        ['review', 'workspace', 'Review a change carefully.'],
      ],
    )
    assert.match(skills.read('deploy'), /steps/)
    assert.throws(() => skills.read('missing'), /Unknown skill/)

    const created = skills.create('Release notes!')
    assert.equal(created.name, 'Release-notes')
    assert.equal(path.dirname(created.path), path.join(userDir, 'skills'))
    assert.equal(skills.list().length, 3)

    await skills.openFolder()
    assert.deepEqual(opened, [path.join(userDir, 'skills')])
  })

  it('lists a name once, as the agent loads it: the project\'s skill over the user\'s', () => {
    const userDir = temp()
    const root = temp()
    fs.mkdirSync(path.join(userDir, 'skills'))
    fs.writeFileSync(path.join(userDir, 'skills', 'release.md'), '---\ndescription: My release\n---\nmine')
    fs.mkdirSync(path.join(root, '.encode', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(root, '.encode', 'skills', 'release.md'), '---\ndescription: The project release\n---\nours')
    const skills = new SkillService(() => root, userDir)
    assert.deepEqual(
      skills.list().map((skill) => [skill.name, skill.source, skill.description]),
      [['release', 'workspace', 'The project release']],
    )
    assert.match(skills.read('release'), /ours/)
  })
})

describe('removing and showing skills', () => {
  it('moves only the user\'s own skill to the bin, a folder skill as its folder, and shows a file where it is', async () => {
    const userDir = temp()
    const root = temp()
    fs.mkdirSync(path.join(userDir, 'skills', 'release'), { recursive: true })
    fs.writeFileSync(path.join(userDir, 'skills', 'release', 'SKILL.md'), '---\ndescription: Release\n---\nsteps')
    fs.writeFileSync(path.join(userDir, 'skills', 'notes.md'), '---\ndescription: Notes\n---\nnotes')
    fs.mkdirSync(path.join(root, '.encode', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(root, '.encode', 'skills', 'theirs.md'), '---\ndescription: Theirs\n---\nx')
    const trashed: string[] = []
    const shown: string[] = []
    const skills = new SkillService(() => root, userDir, undefined, (file) => void shown.push(file), async (target) => void trashed.push(target))

    await skills.remove('release')
    await skills.remove('notes')
    assert.deepEqual(trashed, [path.join(userDir, 'skills', 'release'), path.join(userDir, 'skills', 'notes.md')])
    await assert.rejects(skills.remove('theirs'), /not one of your skills/, 'a project\'s skill belongs to the project')
    skills.reveal('theirs')
    assert.deepEqual(shown, [path.join(root, '.encode', 'skills', 'theirs.md')])
  })
})

describe('the agent list', () => {
  it('lists the built-in agents, then the user\'s and the project\'s with their files, and makes new ones in the user folder', async () => {
    const userDir = temp()
    const root = temp()
    fs.mkdirSync(path.join(root, '.encode', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.encode', 'agents', 'docs.md'), '---\ndescription: Writes the docs\nrole: utility\n---\nBe brief.')
    const trashed: string[] = []
    const skills = new SkillService(() => root, userDir, undefined, undefined, async (target) => void trashed.push(target))

    const before = skills.agents()
    assert.deepEqual(
      before.filter((agent) => agent.source === 'builtin').map((agent) => agent.name),
      ['general-purpose', 'Explore', 'Plan', 'Review'],
    )
    const docs = before.find((agent) => agent.name === 'docs')!
    assert.equal(docs.source, 'workspace')
    assert.equal(docs.role, 'utility')
    assert.equal(docs.path, path.join(root, '.encode', 'agents', 'docs.md'))
    assert.equal(before.find((agent) => agent.name === 'Explore')!.path, undefined, 'a built-in agent has no file')

    const made = skills.createAgent({ name: 'security-reviewer', description: 'Reviews\na change for\tinjection.', readOnly: true, role: 'reviewer' })
    assert.equal(made.source, 'user')
    assert.equal(made.description, 'Reviews a change for injection.', 'the description is one line')
    assert.equal(made.role, 'reviewer')
    assert.ok(made.tools?.includes('Read') && !made.tools.includes('Edit'), 'read-only gets the read-only tools')
    assert.match(skills.readAgent('security-reviewer'), /What this agent does/)
    const free = skills.createAgent({ name: 'builder', description: 'Builds things.', readOnly: false })
    assert.equal(free.tools, undefined, 'an agent that may change files gets every tool')

    assert.throws(() => skills.createAgent({ name: 'Explore', description: 'Mine', readOnly: true }), /already an agent/)
    assert.throws(() => skills.createAgent({ name: 'docs', description: 'Mine', readOnly: true }), /already an agent/)
    assert.throws(() => skills.createAgent({ name: '../escape', description: 'x', readOnly: true }), /starts with a letter/)
    assert.throws(() => skills.createAgent({ name: 'blank', description: '  ', readOnly: true }), /when the main agent/)
    assert.equal(fs.existsSync(path.join(userDir, 'agents', 'blank.md')), false)

    await skills.removeAgent('builder')
    assert.deepEqual(trashed, [path.join(userDir, 'agents', 'builder.md')])
    await assert.rejects(skills.removeAgent('docs'), /not one of your agents/)
    await assert.rejects(skills.removeAgent('Explore'), /not one of your agents/)
  })
})
