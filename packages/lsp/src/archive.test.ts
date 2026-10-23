import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { ArchiveRefused, readTar, readZip, safeEntryPath, writeFiles } from './archive'
import { header, longName, makeTar, makeZip, pad, paxPath } from './test-archives'

const LIMITS = { maxFiles: 1000, maxBytes: 10 * 1024 * 1024 }

function refused(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof ArchiveRefused && pattern.test(error.message))
}

describe('archive paths', () => {
  it('keeps relative paths and refuses anything that could land elsewhere or read as something else on Windows', () => {
    assert.equal(safeEntryPath('a/b.txt'), 'a/b.txt')
    assert.equal(safeEntryPath('./a//./b/'), 'a/b')
    assert.equal(safeEntryPath('a\\b\\c.js'), 'a/b/c.js')
    assert.equal(safeEntryPath('package/lib/x.js', 1), 'lib/x.js')
    assert.equal(safeEntryPath('package/', 1), '')
    for (const bad of ['/etc/passwd', 'C:/Windows/x', 'c:x', '../x', 'a/../../x', 'a\\..\\b', 'CON', 'con.txt', 'a/aux.js', 'lpt1', 'a:stream', 'name.', 'name ', 'a/b<c', `a${String.fromCodePoint(0)}b`, 'a\nb', '']) {
      assert.equal(safeEntryPath(bad), null, JSON.stringify(bad))
    }
  })
})

describe('reading tar archives', () => {
  it('reads files, folders, executable modes, gzip, long names, pax paths and the ustar prefix', () => {
    const long = `deep/${'d'.repeat(120)}/file.js`
    const tar = Buffer.concat([
      header('package/', 0, '5', 0o755),
      header('package/bin/run', 3, '0', 0o755),
      pad(Buffer.from('run')),
      ...longName(`package/${long}`),
      header('package/ignored-short-name', 4, '0', 0o644),
      pad(Buffer.from('long')),
      ...paxPath('package/from pax.txt'),
      header('package/short', 3, '0', 0o644),
      pad(Buffer.from('pax')),
      header('file.txt', 6, '0', 0o644, '', 'package/prefixed'),
      pad(Buffer.from('prefix')),
      Buffer.alloc(1024),
    ])
    for (const archive of [tar, zlib.gzipSync(tar)]) {
      const files = readTar(archive, { ...LIMITS, strip: 1 })
      assert.deepEqual(
        files.map((file) => [file.path, file.data.toString(), file.executable]),
        [
          ['bin/run', 'run', true],
          [long, 'long', false],
          ['from pax.txt', 'pax', false],
          ['prefixed/file.txt', 'prefix', false],
        ],
      )
    }
  })

  it('refuses links, devices, paths that leave the folder, broken headers and archives too large to keep', () => {
    refused(() => readTar(makeTar([{ name: 'a', type: '2', link: '/etc/passwd' }]), LIMITS), /is a link/)
    refused(() => readTar(makeTar([{ name: 'a', type: '1', link: 'b' }]), LIMITS), /is a link/)
    refused(() => readTar(makeTar([{ name: 'dev', type: '3' }]), LIMITS), /not a file or a folder/)
    refused(() => readTar(makeTar([{ name: '../evil', data: 'x' }]), LIMITS), /outside its folder/)
    refused(() => readTar(makeTar([{ name: '/abs', data: 'x' }]), LIMITS), /outside its folder/)
    refused(() => readTar(Buffer.concat([...longName('../../escape'), makeTar([{ name: 'short', data: 'x' }])]), LIMITS), /outside its folder/)
    const broken = makeTar([{ name: 'a', data: 'x' }])
    broken[0] = 'b'.charCodeAt(0)
    refused(() => readTar(broken, LIMITS), /checksum/)
    refused(() => readTar(makeTar([{ name: 'a', data: 'x'.repeat(2000) }]).subarray(0, 1024), LIMITS), /cut short/)
    refused(() => readTar(makeTar([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }]), { maxFiles: 1, maxBytes: 100 }), /more than 1 files/)
    refused(() => readTar(makeTar([{ name: 'a', data: 'x'.repeat(200) }]), { maxFiles: 10, maxBytes: 100 }), /unpacks to more than 100 bytes/)
    // A small gzip that unpacks to far more than the limit is stopped while it unpacks.
    refused(() => readTar(zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024)), { maxFiles: 10, maxBytes: 1024 * 1024 }), /unpacks to too much/)
  })
})

describe('reading zip archives', () => {
  it('reads stored and deflated files with their executable mode, and skips folders', () => {
    const zip = makeZip([
      { name: 'bin/', mode: 0o040755 },
      { name: 'bin/server', data: 'program', mode: 0o100755 },
      { name: 'meta/a.lua', data: 'x'.repeat(5000) },
      { name: 'readme.txt', data: 'stored', method: 0 },
    ])
    const files = readZip(zip, LIMITS)
    assert.deepEqual(
      files.map((file) => [file.path, file.data.length, file.executable]),
      [
        ['bin/server', 7, true],
        ['meta/a.lua', 5000, false],
        ['readme.txt', 6, false],
      ],
    )
  })

  it('refuses links, encryption, other packings, a bad checksum, Zip64 and paths that leave the folder', () => {
    refused(() => readZip(makeZip([{ name: 'link', data: '/etc', mode: 0o120777 }]), LIMITS), /is a link/)
    refused(() => readZip(makeZip([{ name: 'secret', data: 'x', flags: 0x801 }]), LIMITS), /encrypted/)
    refused(() => readZip(makeZip([{ name: '../../x', data: 'x' }]), LIMITS), /outside its folder/)
    refused(() => readZip(makeZip([{ name: 'C:\\Windows\\x', data: 'x' }]), LIMITS), /outside its folder/)
    refused(() => readZip(makeZip([{ name: 'a', data: 'x', crc: 1 }]), LIMITS), /checksum/)
    refused(() => readZip(makeZip([{ name: 'a', data: 'x' }], { zip64: true }), LIMITS), /Zip64/)
    refused(() => readZip(Buffer.from('not a zip at all, not even close to one'), LIMITS), /not a zip/)
    refused(() => readZip(makeZip([{ name: 'a', data: 'x'.repeat(300) }]), { maxFiles: 10, maxBytes: 100 }), /unpacks to more than 100 bytes/)
  })
})

describe('writing what an archive held', () => {
  it('writes the files under a new folder, and refuses one already there or a path given twice', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-archive-'))
    try {
      const dir = path.join(parent, 'out')
      writeFiles(readZip(makeZip([{ name: 'bin/server', data: 'run', mode: 0o100755 }, { name: 'lib/a.txt', data: 'a' }]), LIMITS), dir)
      assert.equal(fs.readFileSync(path.join(dir, 'bin', 'server'), 'utf8'), 'run')
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'bin', 'server')).mode & 0o111, 0o111)
      assert.throws(() => writeFiles([], dir))
      refused(() => writeFiles([{ path: 'a.txt', data: Buffer.from('1'), executable: false }, { path: 'A.TXT', data: Buffer.from('2'), executable: false }], path.join(parent, 'twice')), /twice/)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('reads back any tree it is given, and a damaged archive is refused or read, never anything else', async () => {
    const part = gen.string('abcxyz-_.', 1, 6)
    const name = gen.map(gen.array(part, 1, 3), (parts) => parts.join('/'))
    // Paths that are safe, different even to Windows, and never a file and a folder at once.
    const entries = gen.map(gen.array(gen.tuple(name, gen.string(`ab\n${String.fromCodePoint(0xe9)}`, 0, 40), gen.int(0, 1)), 1, 6), (list) => {
      const seen = new Set<string>()
      const kept = list.filter(([file]) => safeEntryPath(file) === file && !seen.has(file.toLowerCase()) && seen.add(file.toLowerCase()))
      return kept.filter(([file]) => !kept.some(([other]) => other.toLowerCase().startsWith(`${file.toLowerCase()}/`)))
    })
    await check(gen.tuple(entries, gen.int(0, 2), gen.array(gen.tuple(gen.int(0, 100_000), gen.int(0, 255)), 0, 6)), ([list, kind, damage]) => {
      const archive =
        kind === 2
          ? makeZip(list.map(([file, data, executable]) => ({ name: file, data, mode: executable ? 0o100755 : 0o100644 })))
          : makeTar(list.map(([file, data, executable]) => ({ name: file, data, mode: executable ? 0o755 : 0o644 })), kind === 1)
      const read = (buffer: Buffer) => (kind === 2 ? readZip(buffer, LIMITS) : readTar(buffer, LIMITS))
      const files = read(archive)
      assert.deepEqual(
        files.map((file) => [file.path, file.data.toString('utf8'), file.executable ? 1 : 0]),
        list.map(([file, data, executable]) => [file, data, executable]),
      )
      if (!damage.length) return
      const broken = Buffer.from(archive)
      for (const [at, value] of damage) broken[at % broken.length] = value
      try {
        for (const file of read(broken)) assert.equal(safeEntryPath(file.path), file.path)
      } catch (error) {
        if (!(error instanceof ArchiveRefused)) throw error
      }
    })
  })
})
