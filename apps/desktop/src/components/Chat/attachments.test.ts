import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fitWithin, kindOf, looksBinary, pictureName, sizeText, startInput, type ComposerAttachment } from './attachments'

describe('what the chat box attaches (ADR 0113)', () => {
  it('tells pictures, PDFs and text files apart, by type or else by name', () => {
    assert.equal(kindOf({ name: 'shot.png', type: 'image/png' }), 'picture')
    assert.equal(kindOf({ name: 'scan.bmp', type: 'image/bmp' }), 'picture')
    assert.equal(kindOf({ name: 'photo.JPG', type: '' }), 'picture')
    assert.equal(kindOf({ name: 'report.pdf', type: 'application/pdf' }), 'pdf')
    assert.equal(kindOf({ name: 'notes.md', type: 'text/markdown' }), 'text')
    assert.equal(kindOf({ name: 'config.json', type: 'application/json' }), 'text')
    assert.equal(kindOf({ name: 'client.lua', type: '' }), 'text', 'a type the system does not know is read, and told by its bytes')
    assert.equal(kindOf({ name: 'logo.svg', type: 'image/svg+xml' }), 'text')
    assert.equal(kindOf({ name: 'photo.heic', type: 'image/heic' }), 'other')
    assert.equal(kindOf({ name: 'setup.exe', type: 'application/x-msdownload' }), 'other')
    assert.equal(kindOf({ name: 'brief.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'other')
  })

  it('reads a file as text only when it is UTF-8 without NUL bytes', () => {
    assert.equal(looksBinary(new TextEncoder().encode('local x = 1 -- ünïcode')), false)
    assert.equal(looksBinary(new Uint8Array([0x4d, 0x5a, 0x00, 0x01])), true)
    assert.equal(looksBinary(new Uint8Array([0xff, 0xfe, 0x41])), true)
  })

  it('makes a picture smaller to fit, never larger', () => {
    assert.deepEqual(fitWithin(3840, 2160, 1568), { width: 1568, height: 882 })
    assert.deepEqual(fitWithin(1080, 2400, 1568), { width: 706, height: 1568 })
    assert.deepEqual(fitWithin(800, 600, 1568), { width: 800, height: 600 })
  })

  it('numbers pasted screenshots, and keeps the names of files', () => {
    assert.equal(pictureName('image.png', true, 2), 'Screenshot 2.png')
    assert.equal(pictureName('', true, 1), 'Screenshot 1.png')
    assert.equal(pictureName('diagram.png', true, 3), 'diagram.png')
    assert.equal(pictureName('image.png', false, 1), 'image.png')
    assert.equal(sizeText(512), '512 bytes')
    assert.equal(sizeText(48 * 1024), '48 KB')
    assert.equal(sizeText(12.34 * 1024 * 1024), '12.3 MB')
  })

  it('sends text as files and pictures and PDFs as media, and nothing for none', () => {
    const items: ComposerAttachment[] = [
      { id: '1', kind: 'file', path: 'src/a.ts', content: 'export {}' },
      { id: '2', kind: 'picture', name: 'Screenshot 1.png', mediaType: 'image/png', data: 'AAAA', preview: 'data:image/jpeg;base64,BBBB', width: 2, height: 2 },
      { id: '3', kind: 'pdf', name: 'spec.pdf', data: 'CCCC', bytes: 3 },
    ]
    assert.deepEqual(startInput(items), {
      attachments: [{ path: 'src/a.ts', content: 'export {}' }],
      media: [
        { name: 'Screenshot 1.png', mediaType: 'image/png', data: 'AAAA', preview: 'data:image/jpeg;base64,BBBB' },
        { name: 'spec.pdf', mediaType: 'application/pdf', data: 'CCCC' },
      ],
    })
    assert.deepEqual(startInput([]), {})
  })
})
