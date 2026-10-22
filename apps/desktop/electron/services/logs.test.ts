import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LOG_FILE, LogService } from './logs'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-logs-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const clock = () => {
  let at = Date.UTC(2026, 9, 22, 6, 30, 0)
  return () => (at += 1000)
}

describe('log service', () => {
  it('keeps each line with its level and time, in memory and in the file', () => {
    const logs = new LogService(dir, { now: clock() })
    logs.write('info', 'started')
    logs.write('error', 'it broke')
    logs.flush()
    assert.deepEqual(
      logs.recent().map((line) => [line.level, line.text]),
      [
        ['info', 'started'],
        ['error', 'it broke'],
      ],
    )
    assert.equal(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8'), '2026-10-22T06:30:01.000Z INFO  started\n2026-10-22T06:30:02.000Z ERROR it broke\n')
  })

  it('writes a line for every line of a message, skips empty ones, and cuts a very long one', () => {
    const logs = new LogService(dir, { maxLineLength: 10 })
    logs.write('error', 'Error: no\r\n   at a\n\n   at b')
    logs.write('info', '0123456789ABCDEF')
    assert.deepEqual(
      logs.recent().map((line) => line.text),
      ['Error: no', '   at a', '   at b', '0123456789 [cut: 6 more characters]'],
    )
  })

  it('removes secrets before anything is kept or written', () => {
    const logs = new LogService(dir, { redact: (text) => text.replace(/hunter22/g, '[redacted]') })
    logs.write('info', 'password hunter22 for the proxy')
    logs.flush()
    assert.equal(logs.recent()[0].text, 'password [redacted] for the proxy')
    assert.ok(!fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').includes('hunter22'))
  })

  it('keeps the last lines in memory and moves a full file aside, losing nothing in the tail', () => {
    const logs = new LogService(dir, { keepLines: 3, maxFileBytes: 200 })
    for (let i = 1; i <= 12; i++) {
      logs.write('info', `line number ${i}`)
      logs.flush()
    }
    assert.deepEqual(
      logs.recent().map((line) => line.text),
      ['line number 10', 'line number 11', 'line number 12'],
    )
    assert.ok(fs.existsSync(path.join(dir, `${LOG_FILE}.1`)), 'the older file is beside the current one')
    assert.ok(fs.statSync(path.join(dir, LOG_FILE)).size <= 200 + 60)
    const tail = logs.tail(5).map((line) => line.slice(line.indexOf('line')))
    assert.deepEqual(tail, ['line number 8', 'line number 9', 'line number 10', 'line number 11', 'line number 12'])
  })

  it('picks up the file an earlier run left, so a report shows what led up to a restart', () => {
    const first = new LogService(dir, { now: clock() })
    first.write('error', 'the last thing before the crash')
    first.flush()
    const second = new LogService(dir, { now: clock() })
    second.write('info', 'started again')
    assert.deepEqual(
      second.tail().map((line) => line.slice(line.indexOf(' ', 25) + 1).trim()),
      ['the last thing before the crash', 'started again'],
    )
  })

  it('writes later, after a short wait, without being asked', async () => {
    const logs = new LogService(dir, { flushAfterMs: 5 })
    logs.write('info', 'soon')
    assert.equal(fs.existsSync(path.join(dir, LOG_FILE)), false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.match(fs.readFileSync(path.join(dir, LOG_FILE), 'utf8'), /soon/)
  })

  it('takes over the console, passes everything on, and gives it back', () => {
    const printed: unknown[][] = []
    const target = { log: (...a: unknown[]) => void printed.push(['log', ...a]), info: (...a: unknown[]) => void printed.push(['info', ...a]), warn: (...a: unknown[]) => void printed.push(['warn', ...a]), error: (...a: unknown[]) => void printed.push(['error', ...a]) }
    const originalError = target.error
    const logs = new LogService(dir)
    const restore = logs.captureConsole(target as unknown as Console)
    target.log('plain')
    target.warn('a %s of %d', 'list', 3)
    target.error('failed:', { code: 7 })
    assert.deepEqual(printed, [['log', 'plain'], ['warn', 'a %s of %d', 'list', 3], ['error', 'failed:', { code: 7 }]])
    assert.deepEqual(
      logs.recent().map((line) => [line.level, line.text]),
      [
        ['info', 'plain'],
        ['warn', 'a list of 3'],
        ['error', 'failed: { code: 7 }'],
      ],
    )
    restore()
    assert.equal(target.error, originalError)
  })

  it('never throws, even when it has nowhere to write', () => {
    const blocked = path.join(dir, 'a-file')
    fs.writeFileSync(blocked, 'not a folder')
    const logs = new LogService(path.join(blocked, 'logs'))
    logs.write('error', 'still here')
    logs.flush()
    assert.equal(logs.recent()[0].text, 'still here')
    assert.deepEqual(logs.tail(), [`${new Date(logs.recent()[0].at).toISOString()} ERROR still here`])
  })
})
