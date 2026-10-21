import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Text } from '@encode/text'
import { Highlighter, languageForPath, T } from '@encode/editor'
import { check, gen } from '@encode/testkit'
import { controlLabel, hasControl, isSimpleText, segmentsOf } from './line'

describe('segmentsOf', () => {
  it('splits a line along its tokens', () => {
    const segments = segmentsOf('const x = 1', [0, T.keyword, 5, T.plain, 6, T.variable, 7, T.plain, 10, T.number])
    assert.deepEqual(
      segments.map((segment) => [segment.text, segment.kind]),
      [
        ['const', T.keyword],
        [' ', T.plain],
        ['x', T.variable],
        [' = ', T.plain],
        ['1', T.number],
      ],
    )
  })

  it('treats a line without tokens as plain text', () => {
    assert.deepEqual(segmentsOf('abc', []), [{ text: 'abc', kind: T.plain, control: false, start: 0 }])
    assert.deepEqual(segmentsOf('', []), [])
  })

  it('does not lose characters before the first token', () => {
    const segments = segmentsOf('  foo', [2, T.variable])
    assert.equal(segments.map((segment) => segment.text).join(''), '  foo')
  })

  it('cuts out a window of the line', () => {
    const segments = segmentsOf('abcdefghij', [0, T.plain, 3, T.string, 6, T.plain], 2, 8)
    assert.deepEqual(
      segments.map((segment) => [segment.text, segment.kind]),
      [
        ['c', T.plain],
        ['def', T.string],
        ['gh', T.plain],
      ],
    )
  })

  it('draws control and bidi characters as markers of their own', () => {
    const RLO = String.fromCharCode(0x202e)
    const ZWSP = String.fromCharCode(0x200b)
    const segments = segmentsOf(`a${RLO}b${ZWSP}c`, [0, T.string])
    assert.deepEqual(
      segments.map((segment) => [segment.text, segment.control]),
      [
        ['a', false],
        [RLO, true],
        ['b', false],
        [ZWSP, true],
        ['c', false],
      ],
    )
    assert.equal(controlLabel(RLO), 'U+202E')
    assert.ok(hasControl('x\0y'))
    assert.ok(!hasControl('plain text\twith tab'))
  })

  it('marks invisible filler characters and the tag block, which is two UTF-16 units per character', () => {
    for (const code of [0x34f, 0x115f, 0x1160, 0x17b4, 0x180b, 0x3164, 0xffa0]) {
      assert.ok(hasControl(`a${String.fromCodePoint(code)}b`), `U+${code.toString(16)} is a marker`)
    }
    const tag = String.fromCodePoint(0xe0041)
    assert.equal(tag.length, 2)
    const segments = segmentsOf(`a${tag}${tag}b`, [])
    assert.deepEqual(
      segments.map((segment) => [segment.text, segment.control, segment.start]),
      [
        ['a', false, 0],
        [tag, true, 1],
        [tag, true, 3],
        ['b', false, 5],
      ],
    )
    assert.equal(controlLabel(tag), 'U+E0041')
    // Visible characters next to them stay text: emoji, a flag's regional indicators, variation selector 16, the code point after the block.
    for (const text of [`smile ${String.fromCodePoint(0x1f600)}`, `heart${String.fromCodePoint(0x2764, 0xfe0f)}`, String.fromCodePoint(0x1f1e9, 0x1f1ea), String.fromCodePoint(0xe0080)]) {
      assert.ok(!hasControl(text), text)
    }
    // A lone surrogate is not a tag character: the unit stays text.
    assert.ok(!hasControl(String.fromCharCode(0xdb40)))
  })

  it('keeps every character of highlighted source, whatever the language', async () => {
    const alphabet = `ab ={}()[]"'\`/*-#<>\\\t:;,.0123456789${String.fromCharCode(0x202e, 0x200b)}`
    for (const path of ['a.ts', 'a.py', 'a.lua', 'a.css', 'a.md', 'a.json', 'a.html', 'a.sh', 'a.sql']) {
      const language = languageForPath(path)
      await check(gen.array(gen.string(alphabet, 0, 30), 1, 12), (lines) => {
        const doc = Text.of(lines.join('\n'))
        const highlighter = new Highlighter(language.tokenizer, doc)
        for (let number = 1; number <= doc.lineCount; number++) {
          const text = doc.line(number).text
          const rebuilt = segmentsOf(text, highlighter.line(number).tokens)
            .map((segment) => segment.text)
            .join('')
          assert.equal(rebuilt, text, `${path} line ${number}`)
        }
      }, { runs: 60 })
    }
  })
})

describe('segmentsOf offsets', () => {
  it('reports where each segment starts, for the whole line and for any window of it', async () => {
    const alphabet = `ab {}"'/\t0${String.fromCharCode(0x202e, 0x200b, 0)}`
    const tokenised = gen.map(gen.tuple(gen.string(alphabet, 0, 40), gen.array(gen.int(0, 12), 0, 8), gen.int(0, 45), gen.int(0, 45)), ([text, cuts, a, b]) => {
      const tokens: number[] = []
      let last = -1
      for (const cut of [...new Set(cuts)].sort((x, y) => x - y)) {
        if (cut <= last || cut >= text.length) continue
        tokens.push(cut, (cut % 5) + 1)
        last = cut
      }
      return { text, tokens, from: Math.min(a, b), to: Math.max(a, b) }
    })
    await check(tokenised, ({ text, tokens, from, to }) => {
      for (const [lo, hi] of [[0, text.length], [from, to]] as const) {
        const start = Math.min(lo, text.length)
        const end = Math.min(hi, text.length)
        const segments = segmentsOf(text, tokens, lo, hi)
        let at = start
        for (const segment of segments) {
          assert.equal(segment.start, at, 'segments follow each other')
          assert.equal(text.slice(segment.start, segment.start + segment.text.length), segment.text)
          assert.ok(segment.text.length > 0)
          if (segment.control) assert.equal([...segment.text].length, 1)
          at += segment.text.length
        }
        assert.equal(at, Math.max(start, end), 'and cover the window')
      }
    })
  })
})

describe('isSimpleText', () => {
  it('accepts text whose width is columns times the character width', () => {
    assert.ok(isSimpleText('const x = "hello";\t// ok'))
    assert.ok(isSimpleText('café Ünïcode ñ Привет αβγ'))
    assert.ok(isSimpleText(''))
  })

  it('sends everything else to the DOM', () => {
    assert.ok(!isSimpleText('日本語'))
    assert.ok(!isSimpleText('emoji 😀'))
    assert.ok(!isSimpleText(`e${String.fromCharCode(0x301)}`))
    assert.ok(!isSimpleText(`soft${String.fromCharCode(0xad)}hyphen`))
    assert.ok(!isSimpleText(`zero${String.fromCharCode(0x200b)}width`))
  })
})
