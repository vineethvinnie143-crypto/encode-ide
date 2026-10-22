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
