import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collapseRepeats, decodeText, encodeText, excerpt, looksLikeText, UnencodableTextError } from './text'

const char = (code: number) => String.fromCodePoint(code)

describe('decodeText', () => {
  it('reads UTF-8 with and without a byte order mark, and UTF-16 LE with its mark', () => {
    assert.deepEqual(decodeText(Buffer.from(`caf${char(0xe9)}\n`)), { text: `caf${char(0xe9)}\n`, encoding: 'utf8' })
    assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ab')])), { text: 'ab', encoding: 'utf8-bom' })
    assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')])), { text: 'ab', encoding: 'utf16le' })
  })

  it('reads an older Windows file as Windows-1252, and writes it back byte for byte', () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20, 0x93, 0x71, 0x94, 0x0d, 0x0a])
    const decoded = decodeText(bytes)
    assert.equal(decoded?.encoding, 'windows-1252')
    assert.equal(decoded?.text, `caf${char(0xe9)} ${char(0x20ac)} ${char(0x201c)}q${char(0x201d)}\r\n`)
    assert.deepEqual(encodeText(decoded!.text, 'windows-1252'), bytes)
  })

  it('gives each of the bytes 0x80 to 0xFF a character and each character its byte, even the five Windows leaves undefined', () => {
    const high = Buffer.from(Array.from({ length: 128 }, (_, index) => 0x80 + index))
    const decoded = decodeText(Buffer.concat([Buffer.from('abcd'), high]))
    assert.equal(decoded?.encoding, 'windows-1252')
    assert.equal(new Set(decoded!.text).size, decoded!.text.length)
    assert.deepEqual(encodeText(decoded!.text, 'windows-1252'), Buffer.concat([Buffer.from('abcd'), high]))
  })

  it('counts data with a NUL byte or many control bytes as binary', () => {
    assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), undefined)
    assert.equal(decodeText(Buffer.from(Array.from({ length: 400 }, (_, index) => (index % 3 === 0 ? 0xe9 : (index % 7) + 1)))), undefined)
    assert.equal(decodeText(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00, 0xe9])])), undefined)
  })

  it('tells a file that can be text from one that cannot', () => {
    assert.equal(looksLikeText(Buffer.from('plain text')), true)
    assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0x61, 0x00])), true)
    assert.equal(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), false)
  })
})

describe('encodeText', () => {
  it('refuses a character the file encoding has no byte for, and says which', () => {
    const cjk = char(0x65e5)
    assert.throws(() => encodeText(`a${cjk}`, 'windows-1252'), (error) => error instanceof UnencodableTextError && error.character === cjk && error.encoding === 'windows-1252')
    assert.throws(() => encodeText(char(0x1f600), 'windows-1252'), (error) => error instanceof UnencodableTextError && error.character === char(0x1f600))
    assert.deepEqual(encodeText(cjk, 'utf8'), Buffer.from(cjk))
  })
})

describe('collapseRepeats', () => {
  it('replaces a run of identical lines by the line and a count, and leaves the rest as it was', () => {
    const warning = 'warning: unused variable `index` in the loop'
    const text = ['start', ...Array(120).fill(warning), 'done'].join('\n')
    assert.equal(collapseRepeats(text), `start\n${warning}\n… (the line above is repeated 119 more times)\ndone`)
    const other = ['a long line, once', 'a long line, once', 'a long line, once', 'a different long line'].join('\n')
    assert.equal(collapseRepeats(other), other, 'three in a row is not a run')
  })

  it('does not touch short lines, blank lines or text without a run', () => {
    const dots = Array(50).fill('.').join('\n')
    assert.equal(collapseRepeats(dots), dots)
    const blanks = ['a', '', '', '', '', '', '', 'b'].join('\n')
    assert.equal(collapseRepeats(blanks), blanks)
    const plain = 'one line only'
    assert.equal(collapseRepeats(plain), plain)
    const varied = Array.from({ length: 30 }, (_, index) => `line number ${index} of the output`).join('\n')
    assert.equal(collapseRepeats(varied), varied)
  })

  it('collapses each run on its own and keeps a count for every one', () => {
    const text = [...Array(5).fill('first repeated line'), 'between', ...Array(7).fill('second repeated line')].join('\n')
    assert.equal(collapseRepeats(text), 'first repeated line\n… (the line above is repeated 4 more times)\nbetween\nsecond repeated line\n… (the line above is repeated 6 more times)')
  })
})

describe('excerpt', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

  it('keeps whole lines at both ends, and its line numbers are those of the whole text', () => {
    const text = numbered(1000)
    const cut = excerpt(text, 100, 60)
    assert.equal(cut.lines, 1000)
    assert.ok(cut.head.length <= 100 && cut.tail.length <= 60)
    assert.equal(cut.head.split('\n').at(-1), `line ${cut.headTo}`)
    assert.equal(cut.tail.split('\n')[0], `line ${cut.tailFrom}`)
    assert.equal(cut.tail.split('\n').at(-1), 'line 1000')
    const middle = text.split('\n').slice(cut.headTo, cut.tailFrom - 1).join('\n')
    assert.equal(cut.omitted, middle.length + 2, 'the lines between, and the line ends around them')
    assert.equal(`${cut.head}\n${middle}\n${cut.tail}`, text)
  })

  it('comes back whole when both parts hold it', () => {
    assert.deepEqual(excerpt('a\nb\nc', 100, 100), { head: 'a\nb\nc', tail: '', lines: 3, headTo: 3, tailFrom: 4, omitted: 0 })
  })

  it('cuts inside a line too long for its part, and says so', () => {
    const long = 'x'.repeat(500)
    const one = excerpt(long, 100, 50)
    assert.equal(one.head, `${'x'.repeat(100)}…`)
    assert.equal(one.tail, `…${'x'.repeat(50)}`)
    assert.deepEqual([one.headTo, one.tailFrom, one.omitted], [1, 1, 350])
    const ends = excerpt(`${long}\nshort\n${'y'.repeat(500)}`, 100, 50)
    assert.equal(ends.head, `${'x'.repeat(100)}…`)
    assert.equal(ends.tail, `…${'y'.repeat(50)}`)
    assert.deepEqual([ends.headTo, ends.tailFrom], [1, 3])
  })
})
