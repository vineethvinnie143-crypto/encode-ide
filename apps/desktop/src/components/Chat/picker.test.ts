import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileMention, fileOptions, findSlash, indexFiles, parseSlash, replaceTrigger, skillOptions, slashOptions, SLASH_COMMANDS, triggerAt } from './picker'

describe('what opens a picker', () => {
  it('opens slash commands only for the first word, while the caret is in it', () => {
    assert.deepEqual(triggerAt('/comp', 5), { kind: 'slash', start: 0, end: 5, query: 'comp' })
    assert.deepEqual(triggerAt('/', 1), { kind: 'slash', start: 0, end: 1, query: '' })
    assert.deepEqual(triggerAt('/plan add tests', 3), { kind: 'slash', start: 0, end: 5, query: 'pl' })
    assert.equal(triggerAt('/plan add tests', 10), null, 'the arguments are typing')
    assert.equal(triggerAt('see /etc/hosts', 6), null, 'a slash later in the message is text')
    assert.equal(triggerAt('/etc/hosts is broken', 4), null, 'a path is not a command')
  })

  it('opens files after an @ and skills after a $ at the start of a word', () => {
    assert.deepEqual(triggerAt('look at @src/ap', 15), { kind: 'file', start: 8, end: 15, query: 'src/ap' })
    assert.deepEqual(triggerAt('@', 1), { kind: 'file', start: 0, end: 1, query: '' })
    assert.deepEqual(triggerAt('use $depl now', 9), { kind: 'skill', start: 4, end: 9, query: 'depl' })
    assert.deepEqual(triggerAt('$rel please', 2), { kind: 'skill', start: 0, end: 4, query: 'r' }, 'the word ends where it ends, the query at the caret')
  })

  it('stays shut for an address, a variable with a slash and a quoted path', () => {
    assert.equal(triggerAt('mail me@example.com', 19), null)
    assert.equal(triggerAt('echo $HOME/bin', 14), null)
    assert.equal(triggerAt('open @"my file.ts"', 18), null)
    assert.equal(triggerAt('nothing here', 4), null)
    assert.equal(triggerAt('abc', 9), null)
  })
})

describe('what a pick writes', () => {
  it('replaces the word and leaves one space after it', () => {
    assert.deepEqual(replaceTrigger('look at @src/ap', { start: 8, end: 15 }, '@src/app.ts'), { text: 'look at @src/app.ts ', caret: 20 })
    assert.deepEqual(replaceTrigger('use $de now', { start: 4, end: 7 }, '$deploy'), { text: 'use $deploy now', caret: 12 })
  })

  it('quotes a path with a space', () => {
    assert.equal(fileMention('src/app.ts'), '@src/app.ts')
    assert.equal(fileMention('docs/my notes.md'), '@"docs/my notes.md"')
  })
})

describe('slash commands', () => {
  it('reads the command and its arguments', () => {
    assert.deepEqual(parseSlash('/plan add a login page'), { name: 'plan', args: 'add a login page' })
    assert.deepEqual(parseSlash('  /Compact  '), { name: 'compact', args: '' })
    assert.deepEqual(parseSlash('/goal\nship the release'), { name: 'goal', args: 'ship the release' })
    assert.equal(parseSlash('/etc/hosts'), null)
    assert.equal(parseSlash('plan this'), null)
  })

  it('finds a command by its name or another name for it', () => {
    assert.equal(findSlash('policy')?.name, 'policy')
    assert.equal(findSlash('Permissions')?.name, 'policy')
    assert.equal(findSlash('nope'), undefined)
    const names = SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])])
    assert.equal(new Set(names).size, names.length, 'no name is used twice')
  })

  it('lists every command before anything is typed, then the skills', () => {
    const options = slashOptions('', [{ name: 'deploy', description: 'Ship it' }])
    assert.equal(options.length, SLASH_COMMANDS.length + 1)
    assert.equal(options.at(-1)?.kind, 'skill')
  })

  it('puts the command a query starts first', () => {
    assert.equal(slashOptions('comp', [])[0]?.name, 'compact')
    assert.equal(slashOptions('perm', [])[0]?.name, 'policy')
    assert.equal(slashOptions('re', [])[0]?.name, 'rewind', 'ties keep the list order')
    assert.deepEqual(slashOptions('zzzz', []), [])
  })
})

describe('skills and files', () => {
  it('finds skills by name first', () => {
    const skills = [
      { name: 'release-notes', description: 'Write the notes for a release' },
      { name: 'deploy', description: 'Ship it to production' },
    ]
    assert.deepEqual(
      skillOptions('dep', skills).map((option) => option.name),
      ['deploy'],
    )
    assert.equal(skillOptions('release', skills)[0]?.name, 'release-notes')
    assert.equal(skillOptions('', skills).length, 2)
  })

  it('finds files by their name first, then their path, and lists open files first when nothing is typed', () => {
    const index = indexFiles(['src/app.ts', 'src/apply/index.ts', 'docs/app-notes.md', 'README.md'])
    assert.equal(fileOptions('app', index)[0]?.name, 'src/app.ts')
    assert.deepEqual(
      fileOptions('apply', index).map((option) => option.name),
      ['src/apply/index.ts'],
    )
    assert.deepEqual(
      fileOptions('', index, ['README.md', 'gone.ts']).map((option) => option.name),
      ['README.md', 'src/app.ts', 'src/apply/index.ts', 'docs/app-notes.md'],
    )
    assert.equal(fileOptions('', index, [], 2).length, 2)
  })
})
