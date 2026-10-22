import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_TITLE_CHARS, cleanTitle, titleFrom, titlePrompt, worthNaming } from './title'

describe('titleFrom', () => {
  it('takes the first line on one line, and keeps a short one whole', () => {
    assert.equal(titleFrom('Fix the build\nand then the tests'), 'Fix the build')
    assert.equal(titleFrom('  Fix   the\tbuild  '), 'Fix the build')
  })

  it('cuts a long one at a word, with an ellipsis, within the limit', () => {
    const title = titleFrom('Create a short note that says hello from eNCode and then also list every file in the project')
    assert.equal(title, 'Create a short note that says hello from eNCode and then…')
    assert.ok(title.length <= MAX_TITLE_CHARS)
  })

  it('cuts in the middle of a word only when there is no earlier space to cut at', () => {
    const title = titleFrom('x'.repeat(100))
    assert.equal(title.length, MAX_TITLE_CHARS)
    assert.ok(title.endsWith('…'))
  })
})

describe('worthNaming', () => {
  it('skips a greeting, a short request and a slash command', () => {
    assert.equal(worthNaming('Hi'), false)
    assert.equal(worthNaming('fix the build'), false)
    assert.equal(worthNaming('/compact'), false)
    assert.equal(worthNaming('/review the last commit and tell me what you think'), false)
  })

  it('names a request that is longer than a title', () => {
    assert.equal(worthNaming('Create a short note that says hello from eNCode'), true)
    assert.equal(worthNaming('Why does the checkout test fail one run in ten?\nIt only happens on CI.'), true)
  })
})

describe('titlePrompt', () => {
  it('sends the start of a long message only', () => {
    assert.equal(titlePrompt('  hello  '), 'hello')
    assert.equal(titlePrompt('a'.repeat(5_000)).length, 800)
  })
})

describe('cleanTitle', () => {
  it('takes a plain name as it is', () => {
    assert.equal(cleanTitle('Hello note'), 'Hello note')
    assert.equal(cleanTitle('Fix flaky checkout test'), 'Fix flaky checkout test')
  })

  it('removes quotes, markdown, a label and a full stop', () => {
    assert.equal(cleanTitle('"Hello note."'), 'Hello note')
    assert.equal(cleanTitle('**Hello note**'), 'Hello note')
    assert.equal(cleanTitle('Title: Hello note'), 'Hello note')
    assert.equal(cleanTitle('`Title`: "Hello note"!'), 'Hello note')
    assert.equal(cleanTitle('# Hello note'), 'Hello note')
  })

  it('uses the first non-empty line', () => {
    assert.equal(cleanTitle('\n\nHello note\nbecause the user wanted one'), 'Hello note')
  })

  it('keeps other languages and symbols inside the name', () => {
    assert.equal(cleanTitle('Korrigiere den Bug in utils.ts'), 'Korrigiere den Bug in utils.ts')
    assert.equal(cleanTitle('构建失败的原因'), '构建失败的原因')
  })

  it('refuses what is not a name: nothing, a sentence, a paragraph', () => {
    assert.equal(cleanTitle(''), null)
    assert.equal(cleanTitle('  \n \n'), null)
    assert.equal(cleanTitle('"" '), null)
    assert.equal(cleanTitle('I would call this conversation a short note about saying hello to the world'), null)
    assert.equal(cleanTitle('x'.repeat(61)), null)
  })
})
