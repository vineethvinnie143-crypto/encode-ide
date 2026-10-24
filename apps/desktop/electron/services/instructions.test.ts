import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { InstructionsService } from './instructions'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'encode-instructions-'))

describe('the person\'s own instructions', () => {
  it('reads nothing before there is a file, writes one, and refuses to overwrite an edit made elsewhere', () => {
    const userDir = path.join(temp(), '.encode')
    const service = new InstructionsService(userDir, () => null)
    const first = service.read()
    assert.deepEqual({ text: first.text, exists: first.exists, path: first.path }, { text: '', exists: false, path: path.join(userDir, 'ENCODE.md') })
    // Saving nothing makes no file.
    assert.equal(service.write('  ', '').ok, true)
    assert.equal(fs.existsSync(first.path), false)

    const saved = service.write('Prefer pnpm.\n', '')
    assert.ok(saved.ok)
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'Prefer pnpm.\n')

    // The command line changed it meanwhile: the page is told, with what the file holds now.
    fs.writeFileSync(first.path, 'Prefer pnpm.\nNo semicolons.\n')
    const refused = service.write('Prefer npm.\n', 'Prefer pnpm.\n')
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.changed.text, 'Prefer pnpm.\nNo semicolons.\n')
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'Prefer pnpm.\nNo semicolons.\n')
    assert.ok(service.write('Prefer npm.\n', 'Prefer pnpm.\nNo semicolons.\n').ok)
  })

  it('keeps Windows line ends, writes through a link, and refuses a file too large', (t) => {
    const userDir = temp()
    fs.writeFileSync(path.join(userDir, 'ENCODE.md'), 'one\r\ntwo\r\n')
    const service = new InstructionsService(userDir, () => null)
    assert.ok(service.write('one\nthree\n', 'one\r\ntwo\r\n').ok)
    assert.equal(fs.readFileSync(path.join(userDir, 'ENCODE.md'), 'utf8'), 'one\r\nthree\r\n')
    assert.throws(() => service.write('x'.repeat(300 * 1024), 'one\r\nthree\r\n'), /at most 256 KB/)

    const dotfiles = temp()
    const linked = temp()
    fs.writeFileSync(path.join(dotfiles, 'ENCODE.md'), 'kept elsewhere\n')
    try {
      fs.symlinkSync(path.join(dotfiles, 'ENCODE.md'), path.join(linked, 'ENCODE.md'))
    } catch {
      t.skip('links cannot be made here')
      return
    }
    const through = new InstructionsService(linked, () => null)
    assert.ok(through.write('changed\n', 'kept elsewhere\n').ok)
    assert.equal(fs.readFileSync(path.join(dotfiles, 'ENCODE.md'), 'utf8'), 'changed\n')
    assert.ok(fs.lstatSync(path.join(linked, 'ENCODE.md')).isSymbolicLink(), 'the link is left a link')
  })
})

describe('a project\'s instructions file', () => {
  it('names the first file the agent reads, and makes ENCODE.md only where there is none', () => {
    assert.equal(new InstructionsService(temp(), () => null).project(), null)
    const root = temp()
    const service = new InstructionsService(temp(), () => root)
    assert.deepEqual(service.project(), { root, file: null })
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'theirs')
    assert.equal(service.project()?.file, 'CLAUDE.md')
    fs.mkdirSync(path.join(root, '.encode'))
    fs.writeFileSync(path.join(root, '.encode', 'ENCODE.md'), 'ours')
    assert.equal(service.project()?.file, '.encode/ENCODE.md')
    assert.equal(service.createProject(), '.encode/ENCODE.md', 'one is there already')
    assert.equal(fs.existsSync(path.join(root, 'ENCODE.md')), false)

    const bare = temp()
    const fresh = new InstructionsService(temp(), () => bare)
    assert.equal(fresh.createProject(), 'ENCODE.md')
    assert.match(fs.readFileSync(path.join(bare, 'ENCODE.md'), 'utf8'), /Instructions for this project/)
  })
})
