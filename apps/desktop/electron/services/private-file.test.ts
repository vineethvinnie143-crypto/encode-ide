import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { secureExisting, writePrivateFile } from './private-file'

let dir = ''
const posixOnly = { skip: process.platform === 'win32' }
const temps = () => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-private-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writePrivateFile', () => {
  it('creates and replaces a file, leaving no temp files', () => {
    const file = path.join(dir, 'state.json')
    writePrivateFile(file, 'first')
    writePrivateFile(file, 'second')
    assert.equal(fs.readFileSync(file, 'utf8'), 'second')
    assert.deepEqual(temps(), [])
  })

  it('makes the file readable by its owner only, even when replacing a looser one', posixOnly, () => {
    const file = path.join(dir, 'state.json')
    fs.writeFileSync(file, 'old', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    writePrivateFile(file, 'new')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it('fails without leaving its temp file when the target cannot be replaced', () => {
    const target = path.join(dir, 'taken')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'inside'), 'x')
    assert.throws(() => writePrivateFile(target, 'data'))
    assert.deepEqual(temps(), [])
  })
})

describe('secureExisting', () => {
  it('removes temp copies a crash left behind, and nothing else', () => {
    const file = path.join(dir, 'eNCode-settings.json')
    const leftovers = ['eNCode-settings.json.tmp', '.eNCode-settings.json.4242.a1b2c3d4e5f6.tmp']
    const kept = ['eNCode-settings.json', 'eNCode-sessions.json.tmp', 'notes.tmp', 'eNCode-settings.json.bak']
    for (const name of [...leftovers, ...kept]) fs.writeFileSync(path.join(dir, name), 'x')
    fs.mkdirSync(path.join(dir, '.eNCode-settings.json.dir.tmp'))
    secureExisting(file)
    assert.deepEqual(fs.readdirSync(dir).sort(), [...kept, '.eNCode-settings.json.dir.tmp'].sort())
  })

  it('tightens a file an earlier build wrote with the default mode', posixOnly, () => {
    const file = path.join(dir, 'eNCode-sessions.json')
    fs.writeFileSync(file, '{}', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    secureExisting(file)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    secureExisting(path.join(dir, 'missing.json'))
  })
})
