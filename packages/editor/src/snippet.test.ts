import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { fuzzyMatch, parseSnippet, type Snippet } from './index'

/** The text of each stop's ranges, in Tab order, to compare against. */
function shape(snippet: Snippet): [number, string[]][] {
  return snippet.stops.map((stop) => [stop.index, stop.ranges.map((range) => snippet.text.slice(range.from, range.to))])
}

describe('snippets', () => {
  it('expand tab stops, placeholders and the final stop', () => {
    const snippet = parseSnippet('for (const ${1:item} of ${2:items}) {\n\t$0\n}')
    assert.equal(snippet.text, 'for (const item of items) {\n\t\n}')
    assert.deepEqual(shape(snippet), [
      [1, ['item']],
      [2, ['items']],
      [0, ['']],
    ])
    assert.deepEqual(snippet.stops[2].ranges, [{ from: 29, to: 29 }])
  })

  it('put the final stop at the end when the snippet has none', () => {
    const snippet = parseSnippet('push($1)')
    assert.equal(snippet.text, 'push()')
    assert.deepEqual(snippet.stops, [
      { index: 1, ranges: [{ from: 5, to: 5 }] },
      { index: 0, ranges: [{ from: 6, to: 6 }] },
    ])
  })

  it('mirror a placeholder wherever its number comes again, before or after it', () => {
    const snippet = parseSnippet('$1 = ${1:name}; use(${1})')
    assert.equal(snippet.text, 'name = name; use(name)')
    // The placeholder is first: it is the main selection.
    assert.deepEqual(snippet.stops[0].ranges, [
      { from: 7, to: 11 },
      { from: 0, to: 4 },
      { from: 17, to: 21 },
    ])
  })

  it('nest placeholders, in the order of their numbers', () => {
    const snippet = parseSnippet('${1:new ${2:Thing}()}$0')
    assert.equal(snippet.text, 'new Thing()')
    assert.deepEqual(shape(snippet), [
      [1, ['new Thing()']],
      [2, ['Thing']],
      [0, ['']],
    ])
  })

  it('offer choices, inserting the first', () => {
    const snippet = parseSnippet('${1|let,const,var|} x')
    assert.equal(snippet.text, 'let x')
    assert.deepEqual(snippet.stops[0], { index: 1, ranges: [{ from: 0, to: 3 }], choices: ['let', 'const', 'var'] })
    assert.deepEqual(parseSnippet('${1|a\\,b,c\\|d|}').stops[0].choices, ['a,b', 'c|d'])
  })

  it('keep escaped and stray characters as text', () => {
    assert.equal(parseSnippet('\\$1 costs \\} and \\\\').text, '$1 costs } and \\')
    assert.equal(parseSnippet('a } b').text, 'a } b')
    assert.equal(parseSnippet('$ and ${ and ${1 and ${1:open').text, '$ and ${ and ${1 and ${1:open')
    assert.equal(parseSnippet('price: \\n $').text, 'price: \\n $')
  })

  it('fill variables, with their defaults and transforms, and make unknown ones placeholders', () => {
    const variable = (name: string) => ({ TM_FILENAME: 'user-card.tsx', TM_LINE_NUMBER: '7' })[name]
    assert.equal(parseSnippet('// ${TM_FILENAME} line $TM_LINE_NUMBER', { variable }).text, '// user-card.tsx line 7')
    assert.equal(parseSnippet('${TM_SELECTED_TEXT:nothing}', { variable }).text, 'nothing')
    assert.equal(parseSnippet('${TM_FILENAME/(.*)\\..+$/${1:/pascalcase}/}', { variable }).text, 'UserCard')
    assert.equal(parseSnippet('${TM_FILENAME/(user)?-card(x)?.*/${1:+has user}${2:?yes:no}/}', { variable }).text, 'has userno')
    const unknown = parseSnippet('$1 ${UNKNOWN} $2', { variable })
    assert.equal(unknown.text, ' UNKNOWN ')
    assert.deepEqual(shape(unknown), [
      [1, ['']],
      [2, ['']],
      [3, ['UNKNOWN']],
      [0, ['']],
    ])
  })

  it('indent their lines like the line they go on, and turn tabs into its unit', () => {
    const snippet = parseSnippet('if (${1:ok}) {\n\t$0\n}', { indent: '    ', indentUnit: '  ' })
    assert.equal(snippet.text, 'if (ok) {\n      \n    }')
    assert.deepEqual(snippet.stops[1].ranges, [{ from: 16, to: 16 }])
  })

  it('never fail, and keep every range inside the text, whatever they are given', async () => {
    const pieces = gen.oneOf('$', '{', '}', '\\', ':', '|', ',', '/', '1', '0', 'a', 'B', '_', ' ', '\n', '\t', '${', '${1:', '${2|', '$TM_', '|}')
    await check(gen.map(gen.array(pieces, 0, 40), (parts) => parts.join('')), (source) => {
      const snippet = parseSnippet(source, { indent: '  ', indentUnit: '    ', variable: (name) => (name === 'A' ? 'value' : undefined) })
      assert.equal(snippet.stops.at(-1)!.index, 0)
      let previous = -1
      for (const stop of snippet.stops) {
        if (stop.index !== 0) {
          assert.ok(stop.index > previous, 'stops in order')
          previous = stop.index
        }
        for (const range of stop.ranges) assert.ok(range.from >= 0 && range.from <= range.to && range.to <= snippet.text.length, JSON.stringify(range))
      }
    })
  })

  it('insert the text of a snippet without stops as it is', async () => {
    const plain = gen.string('abcxyz ()[];=.\n', 0, 30)
    await check(plain, (source) => {
      const snippet = parseSnippet(source)
      assert.equal(snippet.text, source)
      assert.equal(snippet.stops.length, 1)
    })
  })
})

describe('the fuzzy match of suggestions', () => {
  it('finds the letters at the starts of the parts of a word', () => {
    assert.deepEqual(fuzzyMatch('gEBI', 'getElementById')?.matches, [0, 3, 10, 12])
    assert.deepEqual(fuzzyMatch('str', 'toString')?.matches, [2, 3, 4])
    assert.deepEqual(fuzzyMatch('fb', 'foo_bar')?.matches, [0, 4])
    assert.ok(fuzzyMatch('', 'anything'))
  })

  it('wants the first letter at the start of a part', () => {
    assert.equal(fuzzyMatch('ring', 'toString'), null)
    assert.equal(fuzzyMatch('xyz', 'abc'), null)
    assert.equal(fuzzyMatch('long pattern', 'short'), null)
  })

  it('ranks a prefix above letters spread out, and the same case above another', () => {
    const score = (pattern: string, word: string) => fuzzyMatch(pattern, word)?.score ?? -Infinity
    assert.ok(score('con', 'console') > score('con', 'createObjectNode'))
    assert.ok(score('con', 'console') > score('con', 'myConsole'))
    assert.ok(score('Con', 'Console') > score('Con', 'console'))
    assert.ok(score('push', 'push') > score('push', 'pushAll'))
    assert.ok(score('gs', 'getString') > score('gs', 'gases'))
  })

  it('matches every letter in order, at increasing places, whatever the input', async () => {
    const letters = gen.string('abAB_c.Cd1', 0, 12)
    await check(gen.tuple(letters, letters), ([pattern, word]) => {
      const found = fuzzyMatch(pattern, word)
      if (!found) return
      assert.equal(found.matches.length, pattern.length)
      found.matches.forEach((at, index) => {
        assert.equal(word[at].toLowerCase(), pattern[index].toLowerCase())
        if (index) assert.ok(at > found.matches[index - 1])
      })
    })
  })
})
