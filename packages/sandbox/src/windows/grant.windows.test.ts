/**
 * Fix this folder on a real Windows (skipped elsewhere), ADR 0118: a folder where this account has only Modify, as in a
 * tester's `D:\TEST SERVEr`, is refused by the sandbox; Fix this folder asks for an administrator (the CI runner says
 * yes without a prompt), gives the account Full control, and the sandbox then marks it and confines a command there.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { SandboxError } from '../errors'
import { Sandbox } from '../sandbox'
import { DEFAULT_SETTINGS } from '../settings'
import { createWindowsEngine } from './engine'
import { currentSid } from './grant'

const windows = process.platform === 'win32'
const settings = { ...DEFAULT_SETTINGS, caches: false, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] }

function exec(file: string, args: readonly string[], timeoutMs = 120_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

describe('Fix this folder, on Windows', { skip: !windows }, () => {
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const icacls = path.join(system, 'System32', 'icacls.exe')
  const cmd = path.join(system, 'System32', 'cmd.exe')
  let base = ''
  let folder = ''
  let sid = ''
  let sandbox: Sandbox

  before(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'encode-grant-it-')))
    // A name that would break any quoting: the folder only ever travels as base64.
    folder = path.join(base, "TEST SERVEr's files & 100% $x")
    fs.mkdirSync(path.join(folder, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'resources', 'fxmanifest.lua'), "fx_version 'cerulean'\n")
    sid = await currentSid()
    const dir = path.join(base, 'sandbox')
    sandbox = new Sandbox({ platform: 'win32', dir, engine: createWindowsEngine({ dir, grant: { timeoutMs: 120_000 } }), env: process.env })
    const status = await sandbox.start()
    assert.equal(status.state, 'active', status.reason ?? 'the sandbox is not active')
    // As a folder an administrator made: this account may change files there (Modify), not the folder's security.
    const owner = await exec(icacls, [folder, '/setowner', '*S-1-5-18'])
    console.log(`[grant] owner set to SYSTEM: ${owner.code === 0 ? 'yes' : `no (${owner.out})`}`)
    const narrowed = await exec(icacls, [folder, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', `*${sid}:(OI)(CI)M`])
    assert.equal(narrowed.code, 0, narrowed.out)
    // The runner's programs run as an administrator, which a Full control entry for Administrators would let mark the
    // folder anyway; eNCode on a person's computer runs without it.
    const admins = await exec(icacls, [folder, '/remove:g', '*S-1-5-32-544'])
    assert.equal(admins.code, 0, admins.out)
    console.log(`[grant] before: ${(await exec(icacls, [folder])).out.replace(/\s+/g, ' ')}`)
  })

  after(async () => {
    if (!base) return
    await sandbox?.releaseMarks().catch((error: Error) => console.log(`[grant] release: ${error.message}`))
    await exec(path.join(system, 'System32', 'takeown.exe'), ['/F', base, '/R', '/D', 'Y'])
    await exec(icacls, [base, '/reset', '/T', '/C', '/Q'])
    fs.rmSync(base, { recursive: true, force: true })
  })

  const session = () => sandbox.session({ roots: () => [folder], settings: () => settings })
  const write = async (name: string) => {
    const spec = await session().wrapSpawn({ file: cmd, args: ['/d', '/c', `echo ok> ${name}`], env: { ...(process.env as Record<string, string>) }, cwd: folder })
    return exec(spec.file, spec.args)
  }

  it('is refused the folder first, as on the tester’s computer', { timeout: 120_000 }, async () => {
    await assert.rejects(write('before.txt'), (error: unknown) => error instanceof SandboxError && error.code === 'no-permission')
    assert.deepEqual(sandbox.blocked(), [folder])
  })

  it('gives the account Full control after the administrator’s yes, marks the folder, and confines a command there', { timeout: 240_000 }, async () => {
    const started = Date.now()
    const outcome = await sandbox.fixFolder(folder, settings)
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.cancelled ? 'cancelled' : outcome.reason)
    console.log(`[grant] fixed in ${Date.now() - started}ms, ownership taken: ${outcome.owner}`)
    assert.deepEqual(sandbox.blocked(), [])
    const after = (await exec(icacls, [folder])).out
    console.log(`[grant] after: ${after.replace(/\s+/g, ' ')}`)
    const name = (process.env.USERNAME ?? '').toLowerCase()
    assert.ok(
      after
        .toLowerCase()
        .split(/\r?\n/)
        .some((line) => line.includes(`\\${name}:(oi)(ci)(f)`) || line.includes(`${sid.toLowerCase()}:(oi)(ci)(f)`)),
      after,
    )
    const wrote = await write('after.txt')
    assert.equal(wrote.code, 0, wrote.out)
    assert.equal(fs.readFileSync(path.join(folder, 'after.txt'), 'utf8').trim(), 'ok')
    const spec = await session().wrapSpawn({ file: cmd, args: ['/d', '/c', `echo no> ${path.join(base, 'outside.txt')}`], env: { ...(process.env as Record<string, string>) }, cwd: folder })
    await exec(spec.file, spec.args)
    assert.equal(fs.existsSync(path.join(base, 'outside.txt')), false, 'the folder around it is still out of reach')
  })
})
