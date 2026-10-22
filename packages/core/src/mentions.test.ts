import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseRule, RuleSet, type RuleBehavior } from '@encode/permissions'
import { createFileStateTracker } from '@encode/tools'
import { tempWorkspace } from '@encode/tools/testing'
import { findMentions, mentionBlocks, type MentionContext } from './mentions'
import { createSkills } from './skills'

function rules(root: string, entries: Partial<Record<RuleBehavior, string[]>>): RuleSet {
  const parsed = []
  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    for (const text of entries[behavior] ?? []) {
      const result = parseRule(text, behavior, 'user')
      if (!result.ok) assert.fail(result.reason)
      parsed.push(result.rule)
    }
  }
  return new RuleSet(parsed, { root, home: root, windows: process.platform === 'win32' })
}

const long = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of a file that is long enough to be worth pointing back to`).join('\n')

async function setup(entries: Partial<Record<RuleBehavior, string[]>> = {}) {
  const root = await tempWorkspace({ 'src/a.ts': 'export const a = 1\n', 'src/lib/b.ts': 'b', 'long.txt': long, '.env': 'TOKEN=1', 'logo.png': Buffer.from('89504e470d0a1a0a', 'hex') })
  const outside = await tempWorkspace({ 'notes.md': 'mine' })
  const skillsDir = await tempWorkspace({
    'deploy/SKILL.md': '---\ndescription: Ship it\n---\nRun the deploy script.',
    'danger.md': 'Delete everything.',
    'big.md': 'x'.repeat(40_000),
    'one.md': 'One.',
    'two.md': 'Two.',
  })
  const held: string[] = []
  const context: MentionContext = {
    root,
    home: root,
    platform: process.platform,
    rules: rules(root, entries),
    files: createFileStateTracker(),
    skills: createSkills(() => [{ dir: skillsDir, source: 'user' }]),
    holds: (text) => held.includes(text),
  }
  return { root, outside, skillsDir, context, held }
}

describe('what a message mentions', () => {
  it('finds @ paths and $ skills where a word starts, once each, outside code', () => {
    assert.deepEqual(findMentions('fix @src/a.ts and @"docs/my notes.md", then $deploy. Also @src/a.ts again'), {
      files: ['src/a.ts', 'docs/my notes.md'],
      skills: ['deploy'],
    })
    assert.deepEqual(findMentions('see @a.ts, then (@b.ts)'), { files: ['a.ts,'], skills: [] }, 'a word that does not start with the sign is not one')
    assert.deepEqual(findMentions('mail me@example.com, costs 5$ and `echo $HOME @x`\n```\n@y $z\n```'), { files: [], skills: [] })
  })
})

describe('what comes with a message', () => {
  it('brings a mentioned file as Read shows it and counts it as read; a folder comes as its listing', async () => {
    const { root, context } = await setup()
    const [block] = await mentionBlocks('look at @src/a.ts and @src/, not @types/node', context)
    assert.match(block, /^<mentioned_files>\n\nThe user mentioned these with @\./)
    assert.match(block, /<file path="src\/a\.ts">\n {5}1\texport const a = 1\n<\/file>/)
    assert.match(block, /<folder path="src\/">\na\.ts\nlib\/\n<\/folder>/)
    assert.doesNotMatch(block, /types/, 'a path that is not there is not a mention')
    assert.equal(context.files.get(path.join(root, 'src', 'a.ts'))?.partial, false)
  })

  it('takes the punctuation that ends a sentence off a path', async () => {
    const { context } = await setup()
    const [block] = await mentionBlocks('what is in @src/a.ts?', context)
    assert.match(block, /<file path="src\/a\.ts">/)
  })

  it('points back to lines the conversation still holds', async () => {
    const { context } = await setup()
    await mentionBlocks('@long.txt', context)
    const [again] = await mentionBlocks('@long.txt once more', context)
    assert.match(again, /<file path="long\.txt">\n\(Unchanged since you read lines 1-40 earlier in this conversation\.\)/)
  })

  it('leaves to the tools what needs asking or is refused, and what is not text', async () => {
    const { outside, context } = await setup({ deny: ['Read(./.env)'], ask: ['Read(./long.txt)'] })
    const [block] = await mentionBlocks(`@.env @long.txt @logo.png @${path.join(outside, 'notes.md')}`, context)
    assert.match(block, /- \.env: not attached\. The user's rules do not let eNCode read it\./)
    assert.match(block, /- long\.txt: not attached, because reading it needs the user's approval/)
    assert.match(block, /- logo\.png: not attached, it is not a text file/)
    assert.match(block, /notes\.md: not attached, because reading it needs the user's approval/)
    assert.doesNotMatch(block, /TOKEN|mine|<file /)
  })

  it('reads outside the project where a rule allows it', async () => {
    const { outside, context } = await setup()
    // An absolute path is written //tmp/x or //C:/x.
    context.rules = rules(context.root, { allow: [`Read(//${path.join(outside, '**').replace(/\\/g, '/').replace(/^\//, '')})`] })
    const [block] = await mentionBlocks(`@${path.join(outside, 'notes.md')}`, context)
    assert.match(block, / {5}1\tmine/)
  })

  it('brings a called skill, once; again it only points back', async () => {
    const { skillsDir, context, held } = await setup({ deny: ['Skill(danger)'] })
    const blocks = await mentionBlocks('use $deploy, not $danger or $HOME', context)
    assert.equal(blocks.length, 1)
    assert.match(blocks[0], /^<invoked_skill name="deploy">\n\nThe user called this skill with \$deploy\. Follow it for this request\./)
    assert.ok(blocks[0].includes(`Its files are in ${path.join(skillsDir, 'deploy')}.`))
    assert.match(blocks[0], /Run the deploy script\.\n\n<\/invoked_skill>$/)
    held.push(blocks[0])
    const [again] = await mentionBlocks('$Deploy please', context)
    assert.match(again, /called this skill again with \$deploy\. Its instructions are earlier/)
    assert.doesNotMatch(again, /Run the deploy script/)
  })

  it('cuts a long skill, and brings three skills at most', async () => {
    const { skillsDir, context } = await setup()
    const [big] = await mentionBlocks('$big', context)
    assert.ok(big.length < 33_000)
    assert.ok(big.includes(`(The skill goes on: read the rest from ${path.join(skillsDir, 'big.md')}.)`))
    const many = await mentionBlocks('$one $two $deploy $big', context)
    assert.deepEqual(
      many.map((block) => /name="([^"]+)"/.exec(block)?.[1]),
      ['one', 'two', 'deploy'],
    )
  })

  it('brings nothing for a message that mentions nothing', async () => {
    const { context } = await setup()
    assert.deepEqual(await mentionBlocks('just a question', context), [])
  })
})
