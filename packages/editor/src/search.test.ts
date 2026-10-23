/**
 * Find and replace against models simple enough to trust: a literal search is `indexOf` from left to right; a
 * regular expression found line by line is the same expression run over the whole text; the next and previous
 * match are the nearest of all matches; replacing every literal match is `split` and `join`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { Text } from '@encode/text'
import { EditorState, compileSearch, findNext, findPrevious, replaceAll, searchMatches, type CompiledSearch } from './index'
import { CharClass, charClass, columnAt, indexAtColumn, nextCluster } from './text-utils'

/** Letters whose upper and lower case are one unit each, so `toLowerCase` folds case as the search does. */
const ALPHABET = 'aAbB é_É\t\n.1'
const docs = gen.string(ALPHABET, 0, 80)
const needles = gen.string('aAbB é_\n.', 1, 3)

const all = (doc: Text, search: CompiledSearch, from?: number, to?: number) =>
  [...searchMatches(doc, search, from, to)].map(({ from, to }) => [from, to] as const)

/** Every non-overlapping occurrence of `needle`, left to right, as `indexOf` finds them. */
function literalModel(text: string, needle: string, caseSensitive: boolean, wholeWord: boolean): [number, number][] {
  const hay = caseSensitive ? text : text.toLowerCase()
  const find = caseSensitive ? needle : needle.toLowerCase()
  const found: [number, number][] = []
  const isWord = (pos: number) => pos >= 0 && pos < text.length && charClass(text[pos]) === CharClass.Word
  for (let at = hay.indexOf(find); at !== -1; at = hay.indexOf(find, at + find.length)) {
    const end = at + find.length
    if (wholeWord && ((isWord(at) && isWord(at - 1)) || (isWord(end - 1) && isWord(end)))) {
      // The search moves on one character past a match it rejects, not past the whole of it.
      at = at + 1 - find.length
      continue
    }
    found.push([at, end])
  }
  return found
}

describe('search', () => {
  it('finds literal text where indexOf does, in any case and as whole words, within lines and across them', async () => {
    await check(gen.tuple(docs, needles, gen.int(0, 3)), ([text, needle, flags]) => {
      const caseSensitive = (flags & 1) === 1
      const wholeWord = (flags & 2) === 2
      const search = compileSearch({ search: needle, caseSensitive, wholeWord })
      assert.deepEqual(all(Text.of(text), search), literalModel(text, needle, caseSensitive, wholeWord))
    }, { runs: 600 })
  })

  it('finds a regular expression line by line exactly where it would over the whole text', async () => {
    // Patterns that cannot match a line break, empty matches and anchors among them.
    const patterns = gen.oneOf('a', 'a+', 'a*', '[ab]+', '^a', 'b$', '^', '$', '\\ba\\w*', '(?<=a)b', 'a(?=b)', 'é|É', '(a)(b)?', '\\d', 'x?')
    await check(gen.tuple(docs, patterns, gen.int(0, 1), gen.int(0, 100), gen.int(0, 100)), ([text, pattern, insensitive, a, b]) => {
      const doc = Text.of(text)
      const search = compileSearch({ search: pattern, regexp: true, caseSensitive: insensitive === 0 })
      assert.equal(search.multiline, false)
      const whole = { ...search, multiline: true }
      assert.deepEqual(all(doc, search), all(doc, whole))
      // A part of the document: the matches that lie in it, starting from its start.
      const from = Math.round((Math.min(a, b) / 100) * text.length)
      const to = Math.round((Math.max(a, b) / 100) * text.length)
      for (const [start, end] of all(doc, search, from, to)) assert.ok(start >= from && end <= to)
    }, { runs: 600 })
  })

  it('goes to the nearest match after and before a place, wrapping around', async () => {
    await check(gen.tuple(docs, needles, gen.int(0, 100)), ([text, needle, where]) => {
      const doc = Text.of(text)
      const search = compileSearch({ search: needle })
      const matches = all(doc, search)
      const pos = Math.round((where / 100) * text.length)
      // The next match is searched for from the place itself, so it can overlap one found from the start.
      const next = findNext(doc, search, pos)
      const after = text.toLowerCase().indexOf(needle.toLowerCase(), pos)
      const expectedNext = after >= 0 ? ([after, after + needle.length] as const) : matches[0]
      assert.deepEqual(next && [next.from, next.to], expectedNext ?? null)
      const previous = findPrevious(doc, search, pos)
      const before = matches.filter(([, to]) => to <= pos)
      const expectedPrevious = before[before.length - 1] ?? matches[matches.length - 1]
      assert.deepEqual(previous && [previous.from, previous.to], expectedPrevious ?? null)
    }, { runs: 600 })
  })

  it('replaces every literal match as split and join do', async () => {
    await check(gen.tuple(docs, needles, gen.string('Zz\n', 0, 3)), ([text, needle, replacement]) => {
      const state = EditorState.create({ doc: text })
      const spec = replaceAll(state, compileSearch({ search: needle, caseSensitive: true }), replacement)
      const result = spec ? state.update(spec).state.doc.toString() : text
      assert.equal(result, text.split(needle).join(replacement))
    }, { runs: 600 })
  })
})

describe('search, as the fuzzer found it', () => {
  it('finds the only match when the place is inside it, forwards and backwards', () => {
    const doc = Text.of('aaaaaaaabaa')
    const search = compileSearch({ search: 'ab' })
    assert.deepEqual([findNext(doc, search, 8)?.from, findPrevious(doc, search, 8)?.from], [7, 7])
  })

  it('finds a whole word that overlaps a match it rejected', () => {
    const search = compileSearch({ search: 'b b', wholeWord: true })
    assert.deepEqual(all(Text.of('ab b b a'), search), [[3, 6]])
    assert.deepEqual(all(Text.of('ab b b a\nx'), { ...search, multiline: true }), [[3, 6]])
  })
})

describe('columns', () => {
  it('a cluster boundary is found again from its column, through tabs, accents and wide characters', async () => {
    const pieces = ['a', ' ', '\t', '漢', '😀', `e${String.fromCodePoint(0x301)}`, 'é']
    await check(gen.tuple(gen.array(gen.oneOf(...pieces), 0, 40), gen.oneOf(2, 4, 8)), ([parts, tabSize]) => {
      const text = parts.join('')
      for (let index = 0; index <= text.length; index = index < text.length ? nextCluster(text, index) : index + 1) {
        assert.equal(indexAtColumn(text, columnAt(text, index, tabSize), tabSize), index, `index ${index} of ${JSON.stringify(text)}`)
      }
    }, { runs: 400 })
  })
})
