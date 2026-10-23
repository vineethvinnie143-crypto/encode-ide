import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import zlib from 'node:zlib'
import { PdfDocument } from './document'
import { decodeStream } from './filters'
import { parsePages, readPdf, type PdfReadOptions } from './index'
import { PdfDict, PdfName } from './objects'
import { build, HELVETICA, latin1, line, pages, type Body } from './testing'

const FIXTURES = path.join(process.cwd(), 'packages/tools/src/pdf/fixtures')
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

const OPTIONS: PdfReadOptions = { maxPages: 20, maxChars: 30_000, timeMs: 20_000 }

async function read(bytes: Uint8Array, options: Partial<PdfReadOptions> = {}) {
  const result = await readPdf(bytes, { ...OPTIONS, ...options })
  if (!result.ok) assert.fail(result.error)
  return result.reading
}

async function textOf(bytes: Uint8Array, options: Partial<PdfReadOptions> = {}): Promise<string> {
  return (await read(bytes, options)).pages.map((page) => page.text).join('\n\f\n')
}


// ---------------------------------------------------------------------------

describe('pdf: page lists', () => {
  it('reads single pages, ranges, open ranges and lists, in the order given and once each', () => {
    assert.deepEqual(parsePages('3', 10, 20), [3])
    assert.deepEqual(parsePages('1-5', 10, 20), [1, 2, 3, 4, 5])
    assert.deepEqual(parsePages(' 1, 3,5-7 ', 10, 20), [1, 3, 5, 6, 7])
    assert.deepEqual(parsePages('8-', 10, 20), [8, 9, 10])
    assert.deepEqual(parsePages('2,1-3', 10, 20), [2, 1, 3])
    assert.deepEqual(parsePages('9-30', 10, 20), [9, 10], 'a range past the end stops at the last page')
  })

  it('says what is wrong with a list it cannot use', () => {
    assert.equal(parsePages('12', 10, 20), 'has 10 pages, so page 12 is past its end.')
    assert.equal(parsePages('7-3', 10, 20), 'pages "7-3" runs backwards; write it as "3-7".')
    assert.equal(parsePages('0', 10, 20), 'pages start at 1.')
    assert.match(String(parsePages('one', 10, 20)), /is not a page list/)
    assert.equal(parsePages('1-30', 40, 20), 'pages "1-30" names more than 20 pages; Read takes at most 20 at a time, such as "1-20".')
  })
})

describe('pdf: files from real writers', () => {
  it('reads Chromium output: Unicode, ligatures, code indentation, a table, two columns and a figure page', async () => {
    const reading = await read(fixture('chromium.pdf'))
    assert.equal(reading.pageCount, 2)
    assert.equal(reading.title, 'Chromium sample')
    const [first, second] = reading.pages
    assert.match(first.text, /Curly “quotes”, an em dash — and accents: café, naïve, Zürich\./)
    assert.match(first.text, /Ligatures: office, efficient, flow\./)
    assert.match(first.text, /\ndef add\(a, b\):\n {4}return a \+ b\n/, 'indentation drawn as spaces is kept')
    assert.match(first.text, /\nName Count\napples 3\npears 12\n/)
    assert.match(first.text, /in the left\ncolumn\.\n\nThe right column/, 'the left column is whole before the right one')
    assert.match(first.text, /^Design notes\n\nCurly/, 'a heading is a paragraph of its own')
    assert.equal(first.visual, false)
    assert.equal(second.text, 'A figure\n\nFigure 1: a gradient.')
    assert.equal(second.visual, true, 'a page whose image covers much of it has something to see')
    assert.equal(reading.unknownGlyphs, 0)
  })

  it('reads LibreOffice output with its outline, numbered lists and symbols', async () => {
    const reading = await read(fixture('libreoffice.pdf'))
    assert.deepEqual(reading.outline, [{ title: 'Decisions', depth: 0, page: 1 }])
    const text = reading.pages[0].text
    assert.match(text, /^Meeting minutes\n\nAttendees: Ana, Bo, Chidi\./)
    assert.match(text, /1\. Adopt the new schedule\.\n2\. Review the budget in March\./)
    assert.match(text, /Prices: €12\.50, £8, ¥300\. Math: x² \+ y² = z², α β γ\./)
  })

  it('keeps columns apart, a superscript on its line, and reads a page turned on its side upright', async () => {
    const reading = await read(fixture('reportlab.pdf'))
    assert.deepEqual(reading.outline, [
      { title: 'Two columns', depth: 0, page: 1 },
      { title: 'Rotated page', depth: 0, page: 2 },
    ])
    const [first, second] = reading.pages.map((page) => page.text)
    assert.match(first, /^The left column starts here and\ncontinues down the page with\nseveral lines of text\.\n\nThe right column is separate\n/)
    assert.match(first, /\nE = mc2 holds\.\n/)
    assert.match(first, /\nName {3}Value\nalpha {3}0\.5\n/, 'a wide gap on a line, as in a table, is three spaces')
    assert.match(first, /\n\narXiv:2410\.00001v1 \[cs\.CL\] 1 Oct 2024$/, 'text turned sideways in the margin comes after the page')
    assert.equal(second, 'This page is rotated ninety degrees.\nSecond line of the rotated page.')
  })

  for (const name of ['rc4-40', 'rc4-128', 'aes-128', 'aes-256']) {
    it(`opens a file encrypted with ${name} and no user password`, async () => {
      assert.equal(await textOf(fixture(`encrypted-${name}.pdf`)), await textOf(fixture('reportlab.pdf')))
      assert.equal((await read(fixture(`encrypted-${name}.pdf`))).title, 'Canvas test', 'strings are decrypted too')
    })
  }

  it('says a file needs its password, rather than showing nothing', async () => {
    const result = await readPdf(fixture('password.pdf'), OPTIONS)
    assert.deepEqual(result, { ok: false, error: 'is protected by a password, so it cannot be opened without it. Ask the user for a copy without the password.' })
  })

  it('refuses what is not a PDF, and a PDF without pages', async () => {
    assert.deepEqual(await readPdf(latin1('hello'), OPTIONS), { ok: false, error: 'could not be read as a PDF: The file does not start like a PDF.' })
    const empty = build(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'])
    assert.deepEqual(await readPdf(empty, OPTIONS), { ok: false, error: 'is damaged: no pages could be found in it.' })
  })
})

describe('pdf: text', () => {
  it('turns wide kerning into a space and keeps narrow kerning inside a word', async () => {
    assert.equal(await textOf(pages(['BT /F1 12 Tf 72 700 Td [(Hel) 20 (lo) -300 (world) 40 (!)] TJ ET'])), 'Hello world!')
  })

  it('spells glyph names out: ligatures, quotes and dashes from a Differences array', async () => {
    const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /Type /Encoding /Differences [1 /fi /fl /quoteright /endash /uni00E9 /g123] >> >>'
    const bytes = pages(['BT /F2 12 Tf 72 700 Td (\\001nd the \\002ow, it\\003s \\004 caf\\005 \\006) Tj ET'], { resources: '', extra: [font] })
    // The page's font dictionary names /F1 only; point /F2 at the custom font.
    const text = await textOf(latin1(Buffer.from(bytes).toString('latin1').replace('/Font << /F1 3 0 R >>', '/Font << /F1 3 0 R /F2 4 0 R >>')))
    assert.equal(text, 'find the flow, it’s – café')
    assert.equal((await read(latin1(Buffer.from(bytes).toString('latin1').replace('/Font << /F1 3 0 R >>', '/Font << /F1 3 0 R /F2 4 0 R >>')))).unknownGlyphs, 1, 'a glyph named g123 says nothing')
  })

  it('reads a composite font through its ToUnicode map, ranges, arrays and surrogate pairs included', async () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <0048> <0004> <D83DDE00> endbfchar',
      '2 beginbfrange <0002> <0003> <0069> <0010> <0011> [<0066006C> <00660066>] endbfrange',
      'endcmap end end',
    ].join('\n')
    const bytes = build([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      { dict: '', data: 'BT /F1 12 Tf 72 700 Td <000100020004> Tj 0 -20 Td <00100011> Tj ET' },
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
      { dict: '', data: cmap },
    ])
    assert.equal(await textOf(bytes), `Hi${String.fromCodePoint(0x1f600)}\nflff`)
  })

  it('reads text inside forms, placed by their matrix, and does not loop on a form that draws itself', async () => {
    const bytes = pages([line('Before the form', 72, 700) + 'q 1 0 0 1 0 -100 cm /Fm1 Do Q\n'], {
      resources: '/XObject << /Fm1 4 0 R >>',
      extra: [{ dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0 0 1 0 -50] /Resources << /Font << /F1 3 0 R >> /XObject << /Fm1 4 0 R >> >>', data: `${line('Inside the form', 72, 700)}/Fm1 Do` }],
    })
    assert.equal(await textOf(bytes), 'Before the form\n\nInside the form')
  })

  it('skips inline image data, even when it holds the bytes EI', async () => {
    const data = 'BI /W 4 /H 1 /BPC 8 /CS /G ID \x00EI\x01\xff EI\n' + line('After the image')
    const reading = await read(pages([data]))
    assert.equal(reading.pages[0].text, 'After the image')
  })

  it('uses ActualText in place of what is drawn', async () => {
    const content = 'BT /F1 12 Tf 72 700 Td /Span << /ActualText <FEFF00530074007200610DF00065> >> BDC (Strasse) Tj EMC ( ist lang) Tj ET'
    assert.equal(await textOf(pages([content.replace('0DF0', '00DF')])), 'Straße ist lang')
  })

  it('drops the second copy of text overprinted a hair to the side to fake bold', async () => {
    assert.equal(await textOf(pages([`${line('Bold title', 72, 700)}${line('Bold title', 72.3, 700)}${line('Plain text', 72, 680)}`])), 'Bold title\nPlain text')
  })

  it('reads a page whose text is drawn out of order top to bottom', async () => {
    const order = [5, 1, 4, 2, 3, 7, 6, 9, 8]
    const content = order.map((n) => line(`Line ${n}`, 72, 700 - n * 14)).join('')
    assert.equal(await textOf(pages([content])), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Line ${n}`).join('\n'))
  })

  it('reads text drawn with T*, quote operators, leading and a scaled text matrix', async () => {
    const content = "BT /F1 1 Tf 12 0 0 12 72 700 Tm 1.2 TL (First) Tj T* (Second) Tj (Third) ' 2 0 (Fourth) \" ET"
    assert.equal(await textOf(pages([content])), 'First\nSecond\nThird\nFourth')
  })
})

describe('pdf: damaged and unusual files', () => {
  it('finds the objects by scanning when the table points at the wrong places', async () => {
    const good = pages([line('Still readable')])
    const shifted = latin1(Buffer.from(good).toString('latin1').replace(/(\d{10}) 00000 n/g, (_, offset: string) => `${String(Number(offset) + 7).padStart(10, '0')} 00000 n`))
    const reading = await read(shifted)
    assert.equal(reading.pages[0].text, 'Still readable')
    assert.equal(reading.repaired, true)
  })

  it('reads a file with no cross-reference table at all', async () => {
    const objects: Body[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      HELVETICA,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      { dict: '', data: line('No table') },
    ]
    const reading = await read(build(objects, { noTable: true }))
    assert.equal(reading.pages[0].text, 'No table')
    assert.equal(reading.repaired, true)
  })

  it('reads objects packed in an object stream behind a compressed cross-reference stream with a PNG predictor', async () => {
    // Objects 3 (the font) and 4 (the page) live in object stream 6; object 7 is the xref stream.
    const packed = `3 0 4 ${HELVETICA.length + 1} ${HELVETICA} << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`
    const first = `3 0 4 ${HELVETICA.length + 1} `.length
    const head: Body[] = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>']
    const content: Body = { dict: '/Filter /FlateDecode', data: zlib.deflateSync(latin1(line('Packed away'))) }
    const objstm: Body = { dict: `/Type /ObjStm /N 2 /First ${first} /Filter /FlateDecode`, data: zlib.deflateSync(latin1(packed)) }
    // Lay out objects 1, 2, 5, 6 first to learn their offsets, then the xref stream.
    const draft = build([...head, 'null', 'null', content, objstm])
    const text = Buffer.from(draft).toString('latin1')
    const offsetOf = (num: number) => text.indexOf(`\n${num} 0 obj`) + 1
    const rows: number[][] = [
      [0, 0, 255],
      [1, offsetOf(1), 0],
      [1, offsetOf(2), 0],
      [2, 6, 0],
      [2, 6, 1],
      [1, offsetOf(5), 0],
      [1, offsetOf(6), 0],
      [1, text.indexOf('xref'), 0],
    ]
    // PNG Up predictor: each row is a filter byte (2) and its bytes minus the row above.
    const raw: number[] = []
    let previous = [0, 0, 0, 0, 0, 0]
    for (const [type, field, gen] of rows) {
      const row = [type, (field >> 24) & 0xff, (field >> 16) & 0xff, (field >> 8) & 0xff, field & 0xff, gen]
      raw.push(2, ...row.map((byte, i) => (byte - previous[i] + 256) & 0xff))
      previous = row
    }
    const stream = zlib.deflateSync(Buffer.from(raw))
    const xrefAt = text.indexOf('xref')
    const xrefObject = `7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >> /Length ${stream.length} >>\nstream\n`
    const bytes = Buffer.concat([latin1(text.slice(0, xrefAt)), latin1(xrefObject), stream, latin1(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`)])
    const reading = await read(new Uint8Array(bytes))
    assert.equal(reading.pages[0].text, 'Packed away')
    assert.equal(reading.repaired, false, 'read through the cross-reference stream, not by scanning')
  })

  it('stops a stream that would decompress into more than a read may hold', async () => {
    const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20))
    const bytes = pages(['ignored', line('Second page')], { extra: [] })
    const withBomb = latin1(Buffer.from(bytes).toString('latin1').replace(/(5 0 obj\n<<) \/Length \d+>>\nstream\nignored/, `$1/Filter /FlateDecode /Length ${bomb.length}>>\nstream\n${bomb.toString('latin1')}`))
    const reading = await read(withBomb)
    assert.equal(reading.pages[0].partial, true)
    assert.equal(reading.pages[1].text, 'Second page')
  })

  it('cuts a page short at the time limit instead of hanging', async () => {
    const busy = Array.from({ length: 5000 }, () => '0 0 m 1 1 l S').join('\n')
    const reading = await read(pages([busy + line('late')]), { timeMs: 0 })
    assert.equal(reading.pages[0].partial, true)
  })
})

describe('pdf: what a page shows', () => {
  it('tells a page with a picture or a chart from a page of text, and a scan from a figure', async () => {
    const image: Body = { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: '\x80' }
    const strokes = Array.from({ length: 200 }, (_, i) => `${i} 100 m ${i} 200 l S`).join('\n')
    const bytes = pages(['q 612 0 0 792 0 0 cm /Im1 Do Q', `q 300 0 0 200 72 400 cm /Im1 Do Q\n${line('Figure 2: the plan')}`, strokes, line('Only text'), 'q 20 0 0 20 72 700 cm /Im1 Do Q\n' + line('With a logo')], {
      resources: '/XObject << /Im1 4 0 R >>',
      extra: [image],
    })
    const reading = await read(bytes)
    assert.deepEqual(
      reading.pages.map((page) => [page.visual, page.scanned]),
      [
        [true, true],
        [true, false],
        [true, false],
        [false, false],
        [false, false],
      ],
    )
  })

  it('stops at the character budget and says which pages are left, cutting a first page that is too long', async () => {
    const long = (n: number) => Array.from({ length: 40 }, (_, i) => line(`Page ${n} line ${i} ${'x'.repeat(100)}`, 72, 760 - i * 18)).join('')
    const bytes = pages([1, 2, 3, 4].map(long))
    const reading = await read(bytes, { maxChars: 11_000 })
    assert.deepEqual(
      reading.pages.map((page) => page.number),
      [1, 2],
    )
    assert.deepEqual(reading.rest, [3, 4])
    const cut = await read(bytes, { maxChars: 1_000, pages: '3,1' })
    assert.deepEqual(
      cut.pages.map((page) => [page.number, page.text.length, page.partial]),
      [[3, 1_000, true]],
    )
    assert.deepEqual(cut.rest, [1])
    assert.equal(cut.chosen, true)
  })

  it('reads at most maxPages pages', async () => {
    const reading = await read(pages(Array.from({ length: 5 }, (_, i) => line(`Page ${i + 1}`))), { maxPages: 2 })
    assert.deepEqual(
      reading.pages.map((page) => page.text),
      ['Page 1', 'Page 2'],
    )
    assert.deepEqual(reading.rest, [3, 4, 5])
  })
})

describe('pdf: pages of their own', () => {
  it('copies chosen pages into a PDF that reads the same, rotation and all, without encryption', async () => {
    const reading = await read(fixture('encrypted-aes-256.pdf'))
    const subset = reading.subset([2], 1024 * 1024)
    assert.ok(subset)
    assert.match(Buffer.from(subset.subarray(0, 9)).toString('latin1'), /^%PDF-1\.7\n/)
    const copy = await read(subset)
    assert.equal(copy.pageCount, 1)
    assert.equal(copy.pages[0].text, reading.pages[1].text)
    assert.equal(copy.repaired, false, 'its cross-reference table is right')
    assert.equal(PdfDocument.open(subset, { perStream: 1e6, left: 1e7 }).pages()[0].rotate, 90)
    assert.equal(Buffer.from(subset).toString('latin1').includes('/Encrypt'), false)
  })

  it('leaves links and other pages behind, and gives up when the copy would be too big', async () => {
    const bytes = pages([line('One'), line('Two')], { page: '/Annots [<< /Type /Annot /Subtype /Link /Dest [6 0 R /Fit] >>]' })
    const reading = await read(bytes)
    const subset = reading.subset([1], 1024 * 1024)!
    const text = Buffer.from(subset).toString('latin1')
    assert.equal(text.includes('/Annots'), false)
    assert.equal((await read(subset)).pageCount, 1)
    assert.equal(reading.subset([1, 2], 200), undefined)
  })
})

describe('pdf: filters', () => {
  const decode = (filter: string, data: Uint8Array) => {
    const dict = new PdfDict(new Map([['Filter', new PdfName(filter)]]))
    return Buffer.from(decodeStream(dict, data, { perStream: 1e6, left: 1e7 }, (value) => value)!).toString('latin1')
  }

  it('undoes ASCIIHex, ASCII85, RunLength and LZW', () => {
    assert.equal(decode('ASCIIHexDecode', latin1('48 65 6C6c6F 2>')), 'Hello ')
    assert.equal(decode('ASCII85Decode', latin1('<~87cURD]i,"Ebo80~>')), 'Hello World!')
    assert.equal(decode('ASCII85Decode', latin1('87cURD]j7BEbo7~>')), 'Hello world', 'a last group of fewer than five')
    assert.equal(decode('RunLengthDecode', Uint8Array.from([4, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 254, 0x21, 128])), 'Hello!!!')
    // "-----A---B" from the PDF reference's LZW example (7.4.4.2), early change on.
    assert.equal(decode('LZWDecode', Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01])), '-----A---B')
  })

  it('refuses a filter it does not know, and leaves image data alone', () => {
    const dict = (name: string) => new PdfDict(new Map([['Filter', new PdfName(name)]]))
    assert.throws(() => decodeStream(dict('Mystery'), new Uint8Array(1), { perStream: 1e6, left: 1e7 }, (value) => value), /Mystery/)
    assert.equal(decodeStream(dict('DCTDecode'), new Uint8Array(1), { perStream: 1e6, left: 1e7 }, (value) => value), undefined)
  })
})
