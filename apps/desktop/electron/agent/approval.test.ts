import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import type { ApprovalPolicy } from '../../shared/types'
import { ShellSession } from '../services/shell'
import { decideApproval, type ApprovalContext } from './approval'

const SECRET = 'TOP-SECRET-OUTSIDE-THE-WORKSPACE'

let base = ''
let ws = ''
let outside = ''
let context: ApprovalContext

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const key = path.relative(dir, full)
      if (entry.isSymbolicLink()) out[key] = `link:${await fs.readlink(full)}`
      else if (entry.isDirectory()) {
        out[key] = 'dir'
        await walk(full)
      } else out[key] = await fs.readFile(full, 'utf8')
    }
  }
  await walk(dir)
  return out
}

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-approval-')))
  ws = path.join(base, 'ws')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(ws, 'sub'), { recursive: true })
  await fs.mkdir(path.join(ws, '.git'), { recursive: true })
  await fs.mkdir(path.join(ws, 'bin'), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\nbeta\n')
  await fs.writeFile(path.join(ws, 'sub', 'b.txt'), 'bravo\n')
  await fs.writeFile(path.join(ws, '.git', 'config'), '[core]\n')
  await fs.writeFile(path.join(outside, 'secret.txt'), `${SECRET}\n`)
  // A planted "grep" inside the workspace, for the PATH check.
  await fs.writeFile(path.join(ws, 'bin', 'grep'), '')
  await fs.writeFile(path.join(ws, 'bin', 'grep.exe'), '')
  await fs.symlink(outside, path.join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  context = {
    mode: 'code',
    policy: 'auto-review',
    root: ws,
    rootReal: await fs.realpath(ws),
    env: { PATH: '' },
    home: os.homedir(),
    approvedHosts: new Set(),
  }
})

after(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

function decide(tool: string, input: Record<string, unknown>, policy: ApprovalPolicy = 'auto-review') {
  return decideApproval(tool, input, { ...context, policy })
}

describe('decideApproval', () => {
  it('Workspace Write runs edits and asks before every command', async () => {
    assert.equal((await decide('write', { path: 'a.txt' }, 'workspace-write')).ask, false)
    assert.equal((await decide('edit', { path: 'src/x.ts' }, 'workspace-write')).ask, false)
    const command = await decide('pwsh', { command: 'ls' }, 'workspace-write')
    assert.equal(command.ask, true)
    assert.match(command.reason ?? '', /every command/)
  })

  it('asks before writes into protected folders, except under Full access', async () => {
    for (const target of ['.git/config', '.git/hooks/pre-commit', '.GIT/config', '.eNCode/skills/x.md', 'sub/.git/HEAD']) {
      for (const policy of ['workspace-write', 'auto-review'] as const) {
        const decision = await decide('write', { path: target }, policy)
        assert.equal(decision.ask, true, `${policy} ${target}`)
        assert.match(decision.reason ?? '', /protected/)
      }
      assert.equal((await decide('replace_in_file', { path: target }, 'full-access')).ask, false)
    }
  })

  it('asks once per site before a web fetch, in every mode and policy but Full access', async () => {
    const fetch = { url: 'https://Docs.Example.com/guide?q=1' }
    for (const policy of ['read-only', 'workspace-write', 'auto-review'] as const) {
      for (const mode of ['code', 'ask', 'plan'] as const) {
        const decision = await decideApproval('web_fetch', fetch, { ...context, policy, mode })
        assert.equal(decision.ask, true, `${policy} ${mode}`)
        assert.match(decision.reason ?? '', /docs\.example\.com until the session ends/)
      }
    }
    assert.equal((await decide('web_fetch', fetch, 'full-access')).ask, false)
    const approved = { ...context, approvedHosts: new Set(['docs.example.com']) }
    assert.equal((await decideApproval('web_fetch', { url: 'https://docs.example.com/other' }, approved)).ask, false)
    assert.equal((await decideApproval('web_fetch', { url: 'https://example.com/' }, approved)).ask, true)
    // URLs the tool refuses anyway (private addresses, other schemes) need no approval.
    assert.equal((await decide('web_fetch', { url: 'http://127.0.0.1/' })).ask, false)
    assert.equal((await decide('web_fetch', { url: 'file:///etc/passwd' })).ask, false)
  })

  it('never asks in Read Only, Full access, or Ask and Plan modes', async () => {
    for (const policy of ['read-only', 'full-access'] as const) {
      assert.equal((await decide('pwsh', { command: 'rm -rf .' }, policy)).ask, false)
    }
    for (const mode of ['ask', 'plan'] as const) {
      assert.equal((await decideApproval('pwsh', { command: 'rm -rf .' }, { ...context, mode })).ask, false)
    }
  })

  it('Auto review runs read-only commands and asks for the rest', async () => {
    assert.equal((await decide('pwsh', { command: 'cat a.txt | wc -l' })).ask, false)
    assert.equal((await decide('run_command', { command: 'ls sub', cwd: 'sub' })).ask, false)
    const removal = await decide('pwsh', { command: 'ls; rm a.txt' })
    assert.equal(removal.ask, true)
    assert.match(removal.reason ?? '', /rm changes files/)
  })

  it('Auto review sees through links that lead outside the workspace', async () => {
    for (const command of ['cat link/secret.txt', 'ls link', 'cd link && ls', 'wc -l link/secret.txt']) {
      const decision = await decide('pwsh', { command })
      assert.equal(decision.ask, true, command)
      assert.match(decision.reason ?? '', /outside the workspace/, command)
    }
    assert.equal((await decide('pwsh', { command: 'ls', cwd: 'link' })).ask, true)
    assert.equal((await decide('pwsh', { command: 'ls', cwd: '../outside' })).ask, true)
  })

  it('Auto review asks when a program would run from inside the workspace', async () => {
    const env = { PATH: path.join(ws, 'bin'), PATHEXT: '.EXE' }
    const decision = await decideApproval('pwsh', { command: 'grep alpha a.txt' }, { ...context, env })
    assert.equal(decision.ask, true)
    assert.match(decision.reason ?? '', /inside the workspace/)
  })

  it('anything Auto review runs leaves files alone and reads nothing outside', async () => {
    const command = gen.oneOf(
      'ls', 'cat', 'head', 'tail', 'wc', 'cd', 'echo', 'pwd', 'dir', 'type', 'rm', 'del', 'touch', 'mkdir', 'cp', 'mv',
    )
    const target = gen.oneOf(
      'a.txt', 'sub', 'sub/b.txt', 'link', 'link/secret.txt', '..', '../outside/secret.txt', 'new.txt', '.git/config',
      '-la', '-n', '1', '-r', '"sub/b.txt"', "'a.txt'",
    )
    const segment = gen.map(
      gen.tuple(command, gen.array(target, 0, 3), gen.weighted([6, gen.oneOf('')], [1, gen.oneOf(' > new.txt', ' >> a.txt')])),
      ([name, args, redirect]) => [name, ...args].join(' ') + redirect,
    )
    const separator = gen.oneOf(' ; ', ' && ', ' || ', ' | ')
    const lines = gen.map(gen.array(gen.tuple(segment, separator), 1, 4), (parts) => parts.flat().slice(0, -1).join(''))
    const before = { ws: await snapshot(ws), outside: await snapshot(outside) }
    let ran = 0
    await check(
      lines,
      async (line) => {
        if ((await decide('pwsh', { command: line })).ask) return
        ran++
        let output = ''
        const session = new ShellSession('property', ws, { PATH: '' }, {
          data: (text) => {
            output += text
          },
          prompt: () => {},
          exit: () => {},
        })
        await session.run(line)
        assert.ok(!output.includes(SECRET), `leaked the outside file: ${output}`)
        assert.deepEqual(await snapshot(ws), before.ws, 'changed the workspace')
        assert.deepEqual(await snapshot(outside), before.outside, 'changed files outside')
      },
      { runs: 1000 },
    )
    assert.ok(ran > 50, `only ${ran} generated lines were allowed; the generator needs tuning`)
  })
})
