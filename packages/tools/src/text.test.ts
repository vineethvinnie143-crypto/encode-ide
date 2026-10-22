import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeText, encodeText, looksLikeText, UnencodableTextError } from './text'

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
