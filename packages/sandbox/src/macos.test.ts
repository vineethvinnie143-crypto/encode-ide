import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EnginePolicy } from './engine'
import { createMacEngine, seatbeltProfile } from './macos'

const policy = (over: Partial<EnginePolicy> = {}): EnginePolicy => ({
  writable: ['/Users/u/project', '/Users/u/.encode/sandbox/tmp'],
  protected: ['/Users/u/project/.git/hooks', '/Users/u/project/.mcp.json'],
  unreadable: ['/Users/u/.ssh', '/Users/u/.netrc'],
  network: true,
  temp: '/Users/u/.encode/sandbox/tmp',
  env: { TMPDIR: '/Users/u/.encode/sandbox/tmp' },
  unset: ['SSH_AUTH_SOCK'],
  ...over,
})

const isDir = (file: string) => !file.endsWith('.json') && !file.endsWith('.netrc')

describe('the Seatbelt profile', () => {
  const text = seatbeltProfile(policy(), isDir)
  const at = (needle: string) => {
    const index = text.indexOf(needle)
    assert.ok(index >= 0, `${needle} is in the profile`)
    return index
  }

  it('allows everything but writing, then allows writing in the policy’s folders', () => {
    assert.match(text, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n/)
    assert.ok(at('(deny file-write*)') < at('(allow file-write*'))
    assert.ok(text.includes('(subpath "/Users/u/project")'))
    assert.ok(text.includes('(subpath "/Users/u/.encode/sandbox/tmp")'))
    assert.ok(text.includes('(literal "/dev/null")'))
  })

  it('denies the protected paths after the folders that hold them, folders by subpath and files by literal', () => {
    const allow = at('(allow file-write*')
    const deny = text.indexOf('(deny file-write*\n')
    assert.ok(deny > allow)
    assert.ok(text.slice(deny).includes('(subpath "/Users/u/project/.git/hooks")'))
    assert.ok(text.slice(deny).includes('(literal "/Users/u/project/.mcp.json")'))
  })

  it('does not let the folders that hold a protected path be moved aside', () => {
    const unlink = text.slice(at('(deny file-write-unlink'))
    assert.ok(unlink.includes('(literal "/Users/u/project/.git")'))
    assert.ok(!unlink.includes('(literal "/Users/u/project")'), 'the project folder itself is not held')
  })

  it('denies reading what is unreadable', () => {
    const read = text.slice(at('(deny file-read*'))
    assert.ok(read.includes('(subpath "/Users/u/.ssh")'))
    assert.ok(read.includes('(literal "/Users/u/.netrc")'))
  })

  it('reads a writable folder inside a hidden one again, after the denial: the temp folder in eNCode’s profile', () => {
    const profile = '/Users/u/Library/Application Support/eNCode'
    const temp = `${profile}/sandbox/tmp`
    const own = seatbeltProfile(policy({ writable: ['/Users/u/project', temp], unreadable: [profile], temp }), isDir)
    const denied = own.indexOf(`(deny file-read*\n  (subpath "${profile}")`)
    const reopened = own.indexOf(`(allow file-read*\n  (subpath "${temp}")`)
    assert.ok(denied >= 0 && reopened > denied, own)
    assert.ok(!own.includes('(allow file-read*\n  (subpath "/Users/u/project")'), 'a folder outside the hidden ones needs no allowance')
    assert.ok(!text.includes('(allow file-read*'), 'nothing is read again when no writable folder lies in a hidden one')
  })

  it('denies the network only when the policy blocks it', () => {
    assert.ok(!text.includes('network'))
    assert.ok(seatbeltProfile(policy({ network: false }), isDir).includes('(deny network*)'))
  })

  it('escapes quotes and backslashes in a path, and refuses one with a line break', () => {
    const odd = seatbeltProfile(policy({ writable: ['/Users/u/we"ird\\dir'], protected: [], unreadable: [] }), isDir)
    assert.ok(odd.includes('(subpath "/Users/u/we\\"ird\\\\dir")'))
    assert.throws(() => seatbeltProfile(policy({ writable: ['/Users/u/a\nb'] }), isDir), /control character/)
  })
})

describe('wrapping a spawn', () => {
  it('runs the program through sandbox-exec with the profile and the policy’s variables', () => {
    const wrapped = createMacEngine({ sandboxExec: '/usr/bin/sandbox-exec' }).wrap(
      { file: '/bin/bash', args: ['--noprofile', '/tmp/x.sh'], env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/s' }, cwd: '/Users/u/project' },
      policy(),
    )
    assert.equal(wrapped.file, '/usr/bin/sandbox-exec')
    assert.equal(wrapped.args[0], '-p')
    assert.match(wrapped.args[1], /^\(version 1\)/)
    assert.deepEqual(wrapped.args.slice(2), ['/bin/bash', '--noprofile', '/tmp/x.sh'])
    assert.equal(wrapped.env.TMPDIR, '/Users/u/.encode/sandbox/tmp')
    assert.equal(wrapped.env.SSH_AUTH_SOCK, undefined)
  })

  it('reports itself unavailable where there is no sandbox-exec', async () => {
    const probe = await createMacEngine({ sandboxExec: '/nonexistent/sandbox-exec' }).probe()
    assert.equal(probe.ok, false)
    assert.match(probe.reason ?? '', /not found/)
  })
})
