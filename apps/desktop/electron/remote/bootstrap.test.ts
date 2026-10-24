import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { installCommand, nodePlatform, shellQuoted, startCommand } from './bootstrap'

/** The other machine, played by this one: the command goes to a login shell, as `ssh` hands it to one. */
const shells = ['bash', 'dash', 'sh'].filter((shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0)
const posix = process.platform !== 'win32' && shells.length > 0

/** A stand-in for eNCode's program: it says it runs, then echoes every line of its standard input. */
const ECHO = `process.stdout.write('ready ' + process.env.ENCODE_SERVER_NONCE + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf('\\n')) >= 0) { process.stdout.write('echo ' + buffer.slice(0, at) + '\\n'); buffer = buffer.slice(at + 1); } });
process.stdin.resume();
`

function run(shell: string, command: string, home: string) {
  const child = spawn(shell, ['-c', command], { env: { PATH: process.env.PATH ?? '', HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  const waiters: Array<{ pattern: RegExp; resolve: () => void }> = []
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
    for (const waiter of [...waiters]) if (waiter.pattern.test(out)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  })
  let err = ''
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
  const until = (pattern: RegExp) =>
    new Promise<void>((resolve, reject) => {
      if (pattern.test(out)) return resolve()
      const timer = setTimeout(() => reject(new Error(`Waited for ${pattern} and got:\n${out}\n${err}`)), 10_000)
      waiters.push({ pattern, resolve: () => (clearTimeout(timer), resolve()) })
    })
  const ended = new Promise<number | null>((resolve) => child.on('close', resolve))
  return { child, until, ended, output: () => out }
}

describe('starting eNCode on the other machine', { skip: !posix && 'needs a POSIX shell' }, () => {
  it('is one line for the login shell, whatever shell that is', () => {
    const command = startCommand({ version: '0.1.0-abc', sha256: 'a'.repeat(64), nonce: 'n1' })
    assert.ok(command.startsWith("sh -c '") && command.endsWith("'"))
    assert.equal(command.slice(7, -1).includes("'"), false)
    assert.equal(command.includes('!'), false)
    assert.equal(command.includes('\n'), false)
    assert.throws(() => shellQuoted("it's"), /single quote/)
    assert.throws(() => startCommand({ version: '0.1.0; rm -rf ~', sha256: 'a', nonce: 'n' }), /Not a safe argument/)
  })

  for (const shell of shells) {
    it(`sends the program when the machine lacks it, then hands it the connection (${shell})`, async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'encode-remote-'))
      try {
        const program = Buffer.from(ECHO)
        const sha256 = createHash('sha256').update(program).digest('hex')
        const nonce = `n${Date.now()}`
        const first = run(shell, startCommand({ version: 'test-1', sha256, nonce }), home)
        await first.until(new RegExp(`ENCODE-UPLOAD ${nonce}\\n`))
        // The upload and the first message in one write: what follows the program is the program's.
        first.child.stdin.write(Buffer.concat([Buffer.from(`${program.length}\n`), program, Buffer.from('hello\n')]))
        await first.until(new RegExp(`ENCODE-START ${nonce}\\nready ${nonce}\\necho hello\\n`))
        first.child.stdin.end()
        await first.ended
        assert.equal(readFileSync(path.join(home, '.encode-server', 'test-1', 'encode-server.cjs'), 'utf8'), ECHO)

        // The next time it is there and starts at once.
        const second = run(shell, startCommand({ version: 'test-1', sha256, nonce: `${nonce}b` }), home)
        await second.until(new RegExp(`ENCODE-START ${nonce}b\\nready ${nonce}b\\n`))
        assert.ok(!second.output().includes('UPLOAD'))
        second.child.stdin.end('again\n')
        await second.until(/echo again\n/)
        await second.ended
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  it('keeps nothing that does not match its checksum', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'encode-remote-'))
    try {
      const nonce = 'bad1'
      const started = run(shells[0]!, startCommand({ version: 'test-2', sha256: 'b'.repeat(64), nonce }), home)
      await started.until(/ENCODE-UPLOAD bad1\n/)
      started.child.stdin.write('5\nhello')
      await started.until(/ENCODE-FAILED bad1 checksum\n/)
      await started.ended
      assert.equal(existsSync(path.join(home, '.encode-server', 'test-2', 'encode-server.cjs')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('says when there is no Node.js, or only an old one, with the machine it is', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'encode-remote-'))
    try {
      const missing = run(shells[0]!, startCommand({ version: 'v', sha256: 'c'.repeat(64), nonce: 'm1', nodes: [] }), home)
      await missing.until(/ENCODE-NODE-MISSING m1 \S+-\S+\n/)
      assert.equal(await missing.ended, 0)
      const platform = missing.output().match(/ENCODE-NODE-MISSING m1 (\S+)/)![1]!
      assert.equal(nodePlatform(platform), process.platform === 'linux' || process.platform === 'darwin' ? `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}` : null)

      const old = path.join(home, 'old-node')
      writeFileSync(old, '#!/bin/sh\necho 18.19.0\n', { mode: 0o755 })
      const oldRun = run(shells[0]!, startCommand({ version: 'v', sha256: 'c'.repeat(64), nonce: 'm2', nodes: [`"${old}"`] }), home)
      await oldRun.until(/ENCODE-NODE-OLD m2 \S+ 18\n/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('installs Node.js only when the download matches the pinned checksum', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'encode-remote-'))
    const server = createServer((_request, response) => response.end('not node'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dist`
      const install = run(shells[0]!, installCommand({ platform: 'linux-x64', nonce: 'i1', base }), home)
      await install.until(/ENCODE-FAILED i1 (checksum|no-downloader)\n/)
      assert.equal(existsSync(path.join(home, '.encode-server', 'node')), false)
      mkdirSync(path.join(home, '.encode-server'), { recursive: true })
      assert.throws(() => installCommand({ platform: 'freebsd-x64', nonce: 'i2' }), /no Node.js build/)
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
