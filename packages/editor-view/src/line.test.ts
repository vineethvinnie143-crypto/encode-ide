import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Text } from '@encode/text'
import { Highlighter, languageForPath, T } from '@encode/editor'
import { check, gen } from '@encode/testkit'
import { BRACKET_SHIFT, controlLabel, DEPRECATED, hasControl, hasRtl, isolatesOf, isSimpleText, segmentsOf, tokenClass, withSemantic, type SemanticSpan } from './line'

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

  it('draws the joiner inside an emoji sequence as itself, and every other joiner as a marker', () => {
    const zwj = String.fromCharCode(0x200d)
    const emoji = (...codes: number[]) => String.fromCodePoint(...codes)
    const family = [0x1f468, 0x1f469, 0x1f467].map((code) => emoji(code)).join(zwj)
    // A family, a coder with a skin tone, a rainbow flag (with variation selector 16), a pirate flag.
    for (const text of [family, emoji(0x1f469, 0x1f3fd) + zwj + emoji(0x1f4bb), emoji(0x1f3f3, 0xfe0f) + zwj + emoji(0x1f308), emoji(0x1f3f4) + zwj + emoji(0x2620, 0xfe0f)]) {
      assert.ok(!hasControl(`x = "${text}"`), text)
      assert.ok(segmentsOf(`"${text}"`, []).every((segment) => !segment.control), text)
    }
    // Between letters, at either end, or with only one picture next to it, it stays a marker.
    for (const text of [`a${zwj}b`, `${zwj}${emoji(0x1f600)}`, `${emoji(0x1f600)}${zwj}`, `${emoji(0x1f600)}${zwj}a`, `a${zwj}${emoji(0x1f600)}`, `${emoji(0x1f600)}${zwj}${zwj}${emoji(0x1f600)}`]) {
      assert.ok(hasControl(text), JSON.stringify(text))
    }
    // A sequence cut by a token boundary is judged by the whole line.
    const line = `${emoji(0x1f468)}${zwj}${emoji(0x1f469)}`
    assert.ok(segmentsOf(line, [0, T.string, 2, T.plain, 3, T.string]).every((segment) => !segment.control))
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

/** The kind of every character of a line of `length` from its flat tokens. */
function kindsOf(tokens: readonly number[], length: number): number[] {
  const out: number[] = []
  for (let at = 0; at < length; at++) {
    let kind = T.plain
    for (let index = 0; index < tokens.length && tokens[index] <= at; index += 2) kind = tokens[index + 1]
    out.push(kind)
  }
  return out
}

describe('withSemantic', () => {
  it('draws the stretches a server named over the highlighter\'s tokens', () => {
    // `let count = add(n)`: the lexer has a keyword and plain text; the server names `count`, `add` and `n`.
    const tokens = [0, T.keyword, 3, T.plain, 12, T.function, 15, T.punct, 16, T.plain, 17, T.punct]
    const spans: SemanticSpan[] = [
      { from: 4, to: 9, kind: T.variable },
      { from: 12, to: 15, kind: T.function | DEPRECATED },
      { from: 16, to: 17, kind: T.variable },
    ]
    assert.deepEqual(withSemantic(tokens, spans, 18), [0, T.keyword, 3, T.plain, 4, T.variable, 9, T.plain, 12, T.function | DEPRECATED, 15, T.punct, 16, T.variable, 17, T.punct])
    // Nothing named: the same tokens.
    assert.equal(withSemantic(tokens, [], 18), tokens)
    // A stretch past the line's end is cut to it; one before the line's first token makes it start at 0.
    assert.deepEqual(withSemantic([2, T.keyword], [{ from: 0, to: 1, kind: T.type }, { from: 3, to: 99, kind: T.type }], 5), [0, T.type, 1, T.plain, 2, T.keyword, 3, T.type])
  })

  it('draws a deprecated name struck through', () => {
    assert.match(tokenClass(T.function | DEPRECATED), /^tok-function enc-deprecated$/)
    assert.equal(tokenClass(T.function), 'tok-function')
  })

  it('gives every character the kind of the first stretch over it, or its own, with well-formed tokens', async () => {
    await check(
      (random, size) => {
        const length = Math.floor(random() * (size * 4 + 1))
        const tokens: number[] = []
        for (let at = Math.floor(random() * 3); at < length; at += 1 + Math.floor(random() * 4)) tokens.push(at, Math.floor(random() * 5))
        const spans: SemanticSpan[] = []
        for (let at = 0; at < length + 2; ) {
          const from = at + Math.floor(random() * 4)
          const to = from + Math.floor(random() * 4)
          spans.push({ from, to, kind: 10 + Math.floor(random() * 3) })
          at = random() < 0.2 ? Math.max(0, from - 1) : to
        }
        return { tokens, spans, length }
      },
      ({ tokens, spans, length }) => {
        const out = withSemantic(tokens, spans, length)
        const expected = kindsOf(tokens, length)
        let reach = 0
        for (const span of spans) {
          const from = Math.max(span.from, reach)
          const to = Math.min(span.to, length)
          if (to <= from) continue
          for (let at = from; at < to; at++) expected[at] = span.kind
          reach = to
        }
        assert.deepEqual(kindsOf(out, length), expected)
        if (!spans.some((span) => Math.min(span.to, length) > span.from)) return
        for (let index = 2; index < out.length; index += 2) {
          assert.ok(out[index] > out[index - 2], 'starts go up')
          assert.notEqual(out[index + 1], out[index - 1], 'no two tokens in a row of one kind')
        }
        if (out.length) assert.equal(out[0], 0)
      },
    )
  })
})

describe('isolatesOf', () => {
  const ch = (...points: number[]) => String.fromCodePoint(...points)
  const shalom = ch(0x5e9, 0x5dc, 0x5d5, 0x5dd)
  const salam = ch(0x633, 0x644, 0x627, 0x645)

  it('finds right-to-left letters, Hebrew, Arabic and the scripts past the first plane', () => {
    assert.equal(hasRtl(shalom), true)
    assert.equal(hasRtl(salam), true)
    assert.equal(hasRtl(ch(0x1e900)), true, 'Adlam')
    assert.equal(hasRtl('plain ascii, café, \u00e9'), false)
    assert.equal(hasRtl(ch(0x4e2d, 0x6587)), false)
  })

  it('takes the strings and comments that have right-to-left text, escapes in a string with it', () => {
    // const s = "<shalom>\n" // <salam>
    const text = `const s = "${shalom}\\n" // ${salam}`
    const quote = text.indexOf('"')
    const escape = text.indexOf('\\')
    const comment = text.indexOf('//')
    const tokens = [0, T.keyword, 5, T.plain, quote, T.string, escape, T.escape, escape + 2, T.string, escape + 3, T.plain, comment, T.comment]
    assert.deepEqual(isolatesOf(text, tokens, false), [
      [quote, escape + 3],
      [comment, text.length],
    ])
  })

  it('leaves code, and strings without right-to-left text, in stored order', () => {
    const text = `x = "abc"; ${shalom} = 1`
    const tokens = [0, T.plain, 4, T.string, 9, T.punct, 10, T.plain]
    assert.deepEqual(isolatesOf(text, tokens, false), [])
    assert.deepEqual(isolatesOf('no letters here', [], false), [])
  })

  it('reads a bracket-coloured or deprecated token by its kind', () => {
    const text = `"${shalom}"`
    assert.deepEqual(isolatesOf(text, [0, T.string | (1 << BRACKET_SHIFT) | DEPRECATED], false), [[0, text.length]])
  })

  it('takes all of prose but inline code', () => {
    const text = `# ${shalom} \`${salam}\` ${salam}`
    const tick = text.indexOf('`')
    const after = text.lastIndexOf('`') + 1
    assert.deepEqual(isolatesOf(text, [0, T.heading, tick, T.code, after, T.plain], true), [
      [0, tick],
      [after, text.length],
    ])
    assert.deepEqual(isolatesOf(shalom, [], true), [[0, shalom.length]])
  })
})
