import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { batchCommand, candidateNames, envKey, envValue, searchDirectories, searchPath } from './programs'

let base = ''

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-programs-')))
})

after(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

/** Creates `dir/name` (and, on Windows, `dir/name.exe`) and returns `dir`. */
async function program(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), '')
  if (process.platform === 'win32') await fs.writeFile(path.join(dir, `${name}.exe`), '')
  return dir
}

describe('environment names', () => {
  it('finds Path as PATH on Windows only', () => {
    const env = { Path: 'C:\\bin', PathExt: '.EXE' }
    assert.equal(envKey(env, 'PATH', 'win32'), 'Path')
    assert.equal(envValue(env, 'PATH', 'win32'), 'C:\\bin')
    assert.equal(envValue(env, 'PATHEXT', 'win32'), '.EXE')
    assert.equal(envKey(env, 'PATH', 'linux'), 'PATH')
    assert.equal(envValue(env, 'PATH', 'linux'), undefined)
  })

  it('prefers an exact match and leaves unknown names alone', () => {
    assert.equal(envKey({ PATH: 'a', Path: 'b' }, 'PATH', 'win32'), 'PATH')
    assert.equal(envKey({}, 'GIT_CONFIG_COUNT', 'win32'), 'GIT_CONFIG_COUNT')
  })
})

describe('searchDirectories', () => {
  it('drops empty and relative PATH entries, which mean the working directory', () => {
    assert.deepEqual(searchDirectories({ PATH: '/usr/bin::bin:./tools:/opt/x/bin:' }, 'linux'), ['/usr/bin', '/opt/x/bin'])
  })

  it('on Windows keeps only drive and UNC roots, and unquotes entries', () => {
    const env = { Path: 'C:\\Windows\\System32;;bin;.\\tools;\\rooted;C:relative;"C:\\Program Files\\Git\\cmd";\\\\server\\share\\bin' }
    assert.deepEqual(searchDirectories(env, 'win32'), [
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
      '\\\\server\\share\\bin',
    ])
  })
})

describe('candidateNames', () => {
  it('adds PATHEXT extensions on Windows, like cmd.exe', () => {
    assert.deepEqual(candidateNames('git', { PATHEXT: '.COM;.EXE;.CMD' }, 'win32'), ['git.com', 'git.exe', 'git.cmd'])
    assert.deepEqual(candidateNames('git.exe', { PATHEXT: '.COM;.EXE' }, 'win32'), ['git.exe'])
    assert.deepEqual(candidateNames('python3.11', { PATHEXT: '.EXE' }, 'win32'), ['python3.11.exe'])
    assert.deepEqual(candidateNames('git', {}, 'linux'), ['git'])
  })
})

describe('searchPath', () => {
  it('finds a program in an absolute PATH entry', async () => {
    const dir = await program(path.join(base, 'tools'), 'encode-probe')
    const found = searchPath('encode-probe', { PATH: dir, PATHEXT: '.EXE' })
    assert.ok(found && path.isAbsolute(found) && path.dirname(found) === dir, String(found))
  })

  it('never finds one through a relative or empty entry', async () => {
    await program(path.join(base, 'relative-bin'), 'encode-planted')
    const previous = process.cwd()
    process.chdir(base)
    try {
      await fs.writeFile(path.join(base, 'encode-planted'), '')
      const delimiter = path.delimiter
      const env = { PATH: ['relative-bin', '', `.${path.sep}relative-bin`].join(delimiter), PATHEXT: '.EXE' }
      assert.equal(searchPath('encode-planted', env), null)
    } finally {
      process.chdir(previous)
    }
  })
})

describe('batchCommand', () => {
  const cmd = 'C:\\Windows\\System32\\cmd.exe'

  it('runs a batch file through cmd.exe with plain arguments', () => {
    const result = batchCommand('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'build', '--if-present', '@scope/pkg@1.2.3'], cmd)
    assert.deepEqual(result, {
      ok: true,
      file: cmd,
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" run build --if-present @scope/pkg@1.2.3"'],
    })
    assert.deepEqual(batchCommand('C:\\x\\y.cmd', [], cmd), { ok: true, file: cmd, args: ['/d', '/v:off', '/s', '/c', '""C:\\x\\y.cmd""'] })
  })

  it('refuses arguments cmd.exe would reinterpret', () => {
    for (const argument of ['a b', 'a&calc', '%PATH%', '"quoted"', 'a|b', 'a>b', 'a<b', 'a^b', '(x)', '!x!', 'a\nb', '']) {
      const result = batchCommand('C:\\x\\npm.cmd', ['test', argument], cmd)
      assert.equal(result.ok, false, JSON.stringify(argument))
    }
  })

  it('refuses batch files in folders cmd.exe would reinterpret', () => {
    assert.equal(batchCommand('C:\\a&b\\npm.cmd', [], cmd).ok, false)
    assert.equal(batchCommand('C:\\100%\\npm.cmd', [], cmd).ok, false)
  })
})
