import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { lookupNames, nodeDiskProbe } from './probe'

describe('the file names a program may start from', () => {
  it('are the extensions Windows runs, and PowerShell scripts, which cmd.exe does not know', () => {
    const env = { PATHEXT: '.EXE;.CMD' }
    assert.deepEqual(lookupNames('git', env, 'win32'), ['git.exe', 'git.cmd', 'git.ps1'])
    assert.deepEqual(lookupNames('git.exe', env, 'win32'), ['git.exe'])
    assert.deepEqual(lookupNames('build.ps1', env, 'win32'), ['build.ps1'])
  })

  it('are only the name itself elsewhere', () => {
    assert.deepEqual(lookupNames('git', {}, 'linux'), ['git'])
    assert.deepEqual(lookupNames('git', {}, 'darwin'), ['git'])
  })
})

describe('the disk probe', () => {
  it('finds a program in each folder of PATH, in order, and a name with a folder in it as it is', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-probe-'))
    try {
      const first = path.join(base, 'first')
      const second = path.join(base, 'second')
      await fs.mkdir(first)
      await fs.mkdir(second)
      await fs.writeFile(path.join(first, 'tool'), '')
      await fs.writeFile(path.join(second, 'tool'), '')
      const probe = nodeDiskProbe(base, { env: { PATH: [first, second, 'relative'].join(path.delimiter) }, platform: process.platform === 'win32' ? 'win32' : 'linux' })
      if (process.platform !== 'win32') {
        assert.deepEqual(await probe.locate('tool'), [path.join(first, 'tool'), path.join(second, 'tool')])
        assert.deepEqual(await probe.locate('missing'), [])
        assert.deepEqual(await probe.locate('./tool'), ['./tool'])
      }
      assert.equal(await probe.exists(first), true)
      assert.equal(await probe.exists(path.join(base, 'nothing')), false)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
