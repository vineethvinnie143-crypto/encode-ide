import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { EnginePolicy, SandboxEngine } from './engine'
import { bwrapArguments, createLinuxEngine, findBwrap } from './linux'

const policy = (over: Partial<EnginePolicy> = {}): EnginePolicy => ({
  writable: ['/work/project', '/work/temp'],
  protected: ['/work/project/.git/hooks'],
  unreadable: [],
  network: true,
  temp: '/work/temp',
  env: { TMPDIR: '/work/temp' },
  unset: [],
  ...over,
})

describe('the bubblewrap arguments', () => {
  it('mounts everything read-only, the writable folders over it, then the protected paths', () => {
    const args = bwrapArguments(policy(), '/work/project')
    const text = args.join(' ')
    assert.match(text, /--ro-bind \/ \//)
    assert.ok(text.indexOf('--ro-bind / /') < text.indexOf('--bind-try /work/project /work/project'))
    assert.ok(text.indexOf('--bind-try /work/project /work/project') < text.indexOf('--ro-bind-try /work/project/.git/hooks /work/project/.git/hooks'))
    assert.ok(text.indexOf('--tmpfs /tmp') < text.indexOf('--bind-try /work/project /work/project'))
    assert.match(text, /--chdir \/work\/project$/)
  })

  it('ends processes with the command and cuts them off from the others', () => {
    const args = bwrapArguments(policy(), '/work/project')
    for (const flag of ['--die-with-parent', '--unshare-pid', '--unshare-ipc']) assert.ok(args.includes(flag), flag)
    assert.ok(!args.includes('--new-session'), 'the shell already starts a session of its own, and setsid fails for a group leader')
  })

  it('leaves the network alone unless the policy blocks it', () => {
    assert.ok(!bwrapArguments(policy(), '/').includes('--unshare-net'))
    assert.ok(bwrapArguments(policy({ network: false }), '/').includes('--unshare-net'))
  })

  it('hides folders with an empty one and files with an empty file, and skips what is not there', () => {
    const stat = (file: string) => (file === '/home/u/.ssh' ? 'dir' : file === '/home/u/.netrc' ? 'file' : undefined)
    const args = bwrapArguments(policy({ unreadable: ['/home/u/.ssh', '/home/u/.netrc', '/home/u/.nothing'] }), '/', stat)
    assert.deepEqual(args.slice(args.indexOf('/home/u/.ssh') - 1, args.indexOf('/home/u/.ssh') + 1), ['--tmpfs', '/home/u/.ssh'])
    assert.ok(args.join(' ').includes('--ro-bind /dev/null /home/u/.netrc'))
    assert.ok(!args.includes('/home/u/.nothing'))
  })

  it('takes variables out of the command', () => {
    assert.ok(bwrapArguments(policy({ unset: ['SSH_AUTH_SOCK'] }), '/').join(' ').includes('--unsetenv SSH_AUTH_SOCK'))
  })
})

describe('wrapping a spawn', () => {
  it('runs the program through bwrap with the policy’s variables and without the removed ones', () => {
    const engine = createLinuxEngine({ bwrap: '/usr/bin/bwrap', stat: () => undefined })
    const wrapped = engine.wrap(
      { file: '/bin/bash', args: ['--noprofile', '/tmp/x.sh'], env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/s' }, cwd: '/work/project' },
      policy({ unset: ['SSH_AUTH_SOCK'] }),
    )
    assert.equal(wrapped.file, '/usr/bin/bwrap')
    assert.deepEqual(wrapped.args.slice(-3), ['/bin/bash', '--noprofile', '/tmp/x.sh'])
    assert.equal(wrapped.args[wrapped.args.length - 4], '--')
    assert.equal(wrapped.env.TMPDIR, '/work/temp')
    assert.equal(wrapped.env.SSH_AUTH_SOCK, undefined)
    assert.equal(wrapped.cwd, '/work/project')
  })

  it('says so when there is no bwrap', async () => {
    const engine = createLinuxEngine({ bwrap: undefined, env: { PATH: '/nonexistent' } })
    if (findBwrap({ PATH: '/nonexistent' })) return // a machine with bwrap in a usual folder
    const probe = await engine.probe()
    assert.equal(probe.ok, false)
    assert.match(probe.reason ?? '', /not installed/)
  })
})

const bwrapPath = process.platform === 'linux' ? findBwrap() : undefined
const real = createLinuxEngine(bwrapPath ? { bwrap: bwrapPath } : {})
let works = false

describe('a real bubblewrap', { skip: !bwrapPath }, () => {
  let base: string
  let project: string
  let temp: string
  let outside: string
  let home: string

  before(async () => {
    works = (await real.probe()).ok
    // Not under /tmp: the sandbox mounts its own /tmp, which would hide the folders these tests make.
    const here = path.dirname(fileURLToPath(import.meta.url))
    base = fs.realpathSync(fs.mkdtempSync(path.join(here, 'work-')))
    project = path.join(base, 'project')
    temp = path.join(base, 'temp')
    outside = path.join(base, 'outside')
    home = path.join(base, 'home')
    for (const dir of [project, temp, outside, path.join(project, '.git', 'hooks'), path.join(home, '.ssh')]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(project, '.git', 'config'), '[core]\n')
    fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'secret')
    fs.writeFileSync(path.join(home, '.netrc'), 'machine x password y')
  })
  after(() => fs.rmSync(base, { recursive: true, force: true }))

  const base_policy = (over: Partial<EnginePolicy> = {}): EnginePolicy => ({
    writable: [project, temp],
    protected: [path.join(project, '.git', 'hooks'), path.join(project, '.git', 'config')],
    unreadable: [path.join(home, '.ssh'), path.join(home, '.netrc')],
    network: true,
    temp,
    env: { TMPDIR: temp },
    unset: ['SSH_AUTH_SOCK'],
    ...over,
  })

  async function run(engine: SandboxEngine, script: string, over: Partial<EnginePolicy> = {}, env: Record<string, string> = {}) {
    const wrapped = engine.wrap({ file: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin', ...env }, cwd: project }, base_policy(over))
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(wrapped.file, wrapped.args, { env: wrapped.env, cwd: wrapped.cwd, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ code: error ? (((error as { code?: unknown }).code as number | null) ?? null) : 0, out: `${stdout}${stderr}` })
      })
    })
  }

  it('passes its own test', async (t) => {
    if (!works) return t.skip('this machine does not allow user namespaces')
    assert.equal((await real.probe()).ok, true)
  })

  it('lets a command write in the project and its temp folder and nowhere else', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const result = await run(real, `echo a > new.txt && echo b > "$TMPDIR/t.txt" && ! { echo c > ${outside}/x; } 2>/dev/null && ! { echo d > "$HOME_X/escape"; } 2>/dev/null`, {}, { HOME_X: home })
    assert.equal(result.code, 0, result.out)
    assert.ok(fs.existsSync(path.join(project, 'new.txt')))
    assert.ok(fs.existsSync(path.join(temp, 't.txt')))
    assert.ok(!fs.existsSync(path.join(outside, 'x')))
    assert.ok(!fs.existsSync(path.join(home, 'escape')))
  })

  it('edits and removes files that were already there', async (t) => {
    if (!works) return t.skip('no user namespaces')
    fs.writeFileSync(path.join(project, 'old.txt'), 'old\n')
    const result = await run(real, 'echo more >> old.txt && mv old.txt moved.txt && rm moved.txt')
    assert.equal(result.code, 0, result.out)
    assert.ok(!fs.existsSync(path.join(project, 'moved.txt')))
  })

  it('keeps git’s hooks and configuration read-only, though they are inside the project', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const hook = await run(real, `! { echo '#!/bin/sh' > .git/hooks/pre-commit; } 2>/dev/null`)
    assert.equal(hook.code, 0, hook.out)
    assert.ok(!fs.existsSync(path.join(project, '.git', 'hooks', 'pre-commit')))
    const config = await run(real, `! { echo '[alias]' >> .git/config; } 2>/dev/null`)
    assert.equal(config.code, 0, config.out)
    assert.equal(fs.readFileSync(path.join(project, '.git', 'config'), 'utf8'), '[core]\n')
    const removed = await run(real, `! rm -rf .git/hooks 2>/dev/null && ! mv .git/hooks .git/h2 2>/dev/null`)
    assert.equal(removed.code, 0, removed.out)
    assert.ok(fs.existsSync(path.join(project, '.git', 'hooks')))
    const other = await run(real, 'echo x > .git/index.lock && rm .git/index.lock')
    assert.equal(other.code, 0, other.out)
  })

  it('hides credentials from the command', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const result = await run(real, `ls ${home}/.ssh | wc -l; cat ${home}/.netrc 2>&1 | grep -c password; true`)
    assert.equal(result.code, 0, result.out)
    assert.deepEqual(result.out.trim().split(/\s+/), ['0', '0'])
    assert.equal(fs.readFileSync(path.join(home, '.netrc'), 'utf8'), 'machine x password y')
  })

  it('gives the command a private /tmp and the session’s TMPDIR', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const name = `leak-${process.pid}`
    const result = await run(real, `echo x > /tmp/${name} && test "$TMPDIR" = ${temp}`)
    assert.equal(result.code, 0, result.out)
    assert.ok(!fs.existsSync(path.join('/tmp', name)), 'a file in /tmp must not reach the real /tmp')
  })

  it('removes the variables the policy lists', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const result = await run(real, 'echo "[${SSH_AUTH_SOCK-unset}]"', {}, { SSH_AUTH_SOCK: '/run/agent' })
    assert.match(result.out, /\[unset\]/)
  })

  it('ends what a command started when the command ends', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const marker = path.join(project, 'late.txt')
    const result = await run(real, `(sleep 1; echo late > ${marker}) >/dev/null 2>&1 & exit 0`)
    assert.equal(result.code, 0, result.out)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.ok(!fs.existsSync(marker), 'a process left behind must not outlive the command')
  })

  it('does not let a command see or signal the person’s other processes', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const result = await run(real, 'ls /proc | grep -c "^[0-9]"')
    assert.equal(result.code, 0, result.out)
    assert.ok(Number(result.out.trim()) < 10, `only the sandbox's own processes are visible, saw ${result.out.trim()}`)
  })

  it('blocks the network when the policy says so and not otherwise', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined)
      socket.end('hi')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    try {
      const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))"`
      const open = await run(real, probe, {}, { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` })
      assert.equal(open.code, 0, open.out)
      const closed = await run(real, probe, { network: false }, { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` })
      assert.equal(closed.code, 7, closed.out)
    } finally {
      server.close()
    }
  })

  it('runs git in the project', async (t) => {
    if (!works) return t.skip('no user namespaces')
    const repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    const result = await run(real, `cd ${repo} && git init -q . && echo a > a && git add a && git -c user.email=a@b -c user.name=n commit -qm one && git log --oneline | wc -l`, { writable: [project, temp, repo] })
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /1/)
  })
})
