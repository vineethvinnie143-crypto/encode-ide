import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPolicy, gitDirectories, type PolicyIo } from './policy'
import { DEFAULT_SETTINGS, type SandboxSettings } from './settings'

/** A file system in a map: a folder maps to null, a file to its text. */
function fake(entries: Record<string, string | null>): PolicyIo {
  return {
    realpath: (file) => file,
    stat: (file) => (file in entries ? (entries[file] === null ? 'dir' : 'file') : undefined),
    readText: (file) => (typeof entries[file] === 'string' ? (entries[file] as string) : undefined),
  }
}

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...DEFAULT_SETTINGS, allowWrite: [], denyWrite: [], denyRead: [], allowRead: [], ...over })

const base = {
  platform: 'linux' as NodeJS.Platform,
  home: '/home/u',
  roots: ['/work/p'],
  temp: '/home/u/.encode/sandbox/tmp',
  env: {},
}

describe('the policy for a session', () => {
  it('lets commands write the project and the sandbox’s temp folder', () => {
    const policy = buildPolicy({ ...base, settings: settings({ caches: false }), io: fake({ '/work/p': null }) })
    assert.deepEqual(policy.writable, ['/work/p', '/home/u/.encode/sandbox/tmp'])
    assert.equal(policy.temp, '/home/u/.encode/sandbox/tmp')
    assert.equal(policy.env.TMPDIR, '/home/u/.encode/sandbox/tmp')
    assert.equal(policy.env.TEMP, '/home/u/.encode/sandbox/tmp')
  })

  it('keeps git’s hooks and configuration and eNCode’s settings read-only in every folder', () => {
    const policy = buildPolicy({ ...base, roots: ['/work/p', '/work/extra'], settings: settings({ caches: false }), io: fake({ '/work/p/.git': null, '/work/extra/.git': null }) })
    for (const root of ['/work/p', '/work/extra']) {
      for (const item of ['.git/hooks', '.git/config', '.encode', '.mcp.json']) assert.ok(policy.protected.includes(`${root}/${item}`), `${root}/${item}`)
    }
  })

  it('lets git work in a worktree or a submodule, where .git is a file pointing elsewhere', () => {
    const io = fake({
      '/work/p/.git': 'gitdir: /repo/.git/worktrees/p\n',
      '/repo/.git/worktrees/p/commondir': '../..\n',
    })
    assert.deepEqual(gitDirectories('/work/p', io, 'linux'), ['/repo/.git/worktrees/p', '/repo/.git'])
    const policy = buildPolicy({ ...base, settings: settings({ caches: false }), io })
    assert.ok(policy.writable.includes('/repo/.git/worktrees/p'))
    assert.ok(policy.writable.includes('/repo/.git'))
    assert.ok(policy.protected.includes('/repo/.git/hooks'))
    assert.ok(policy.protected.includes('/repo/.git/config'))
  })

  it('does not list a git directory twice when it is inside a root', () => {
    const policy = buildPolicy({ ...base, settings: settings({ caches: false }), io: fake({ '/work/p/.git': null }) })
    assert.equal(policy.writable.filter((folder) => folder.includes('.git')).length, 0)
  })

  it('adds the package caches that exist, on systems where they are shared', () => {
    const io = fake({ '/home/u/.npm': null, '/home/u/.cache': null, '/home/u/.cargo/registry': null })
    const on = buildPolicy({ ...base, settings: settings(), io })
    assert.ok(on.writable.includes('/home/u/.npm'))
    assert.ok(on.writable.includes('/home/u/.cargo/registry'))
    assert.ok(!on.writable.includes('/home/u/.gradle'), 'a cache that does not exist is not listed')
    const off = buildPolicy({ ...base, settings: settings({ caches: false }), io })
    assert.ok(!off.writable.includes('/home/u/.npm'))
  })

  it('hides credentials where the system can, and the person’s agent sockets', () => {
    const policy = buildPolicy({ ...base, settings: settings({ caches: false }), env: { XDG_RUNTIME_DIR: '/run/user/1000' }, io: fake({}) })
    for (const item of ['/home/u/.ssh', '/home/u/.aws', '/home/u/.gnupg', '/home/u/.config/gh', '/run/docker.sock', '/run/user/1000']) assert.ok(policy.unreadable.includes(item), item)
    for (const name of ['SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS']) assert.ok(policy.unset.includes(name), name)
  })

  it('lets the user take a credential folder off the hidden list, and add to it', () => {
    const policy = buildPolicy({ ...base, settings: settings({ caches: false, allowRead: ['~/.ssh'], denyRead: ['~/private', 'notes'] }), io: fake({}) })
    assert.ok(!policy.unreadable.includes('/home/u/.ssh'))
    assert.ok(policy.unreadable.includes('/home/u/private'))
    assert.ok(policy.unreadable.includes('/work/p/notes'))
  })

  it('resolves extra writable and protected paths against the project and home', () => {
    const policy = buildPolicy({ ...base, settings: settings({ caches: false, allowWrite: ['~/shared'], denyWrite: ['dist', '/etc/x'] }), io: fake({}) })
    assert.ok(policy.writable.includes('/home/u/shared'))
    assert.ok(policy.protected.includes('/work/p/dist'))
    assert.ok(policy.protected.includes('/etc/x'))
  })

  it('carries the network setting', () => {
    assert.equal(buildPolicy({ ...base, settings: settings({ network: false }), io: fake({}) }).network, false)
    assert.equal(buildPolicy({ ...base, settings: settings(), io: fake({}) }).network, true)
  })

  it('on Windows hides nothing, redirects the caches into a folder of the sandbox and keeps what the person set', () => {
    const policy = buildPolicy({
      platform: 'win32',
      home: 'C:\\Users\\u',
      roots: ['C:\\work\\p'],
      settings: settings(),
      temp: 'C:\\Users\\u\\AppData\\Local\\eNCode\\sandbox\\tmp',
      cacheRoot: 'C:\\Users\\u\\AppData\\Local\\eNCode\\sandbox\\cache',
      env: { npm_config_cache: 'D:\\mine' },
      io: fake({}),
    })
    assert.deepEqual(policy.unreadable, [])
    assert.deepEqual(policy.unset, [])
    assert.ok(policy.writable.includes('C:\\Users\\u\\AppData\\Local\\eNCode\\sandbox\\cache'))
    assert.equal(policy.env.npm_config_cache, undefined)
    assert.equal(policy.env.PIP_CACHE_DIR, 'C:\\Users\\u\\AppData\\Local\\eNCode\\sandbox\\cache\\pip')
    assert.ok(policy.protected.includes('C:\\work\\p\\.git\\hooks'))
  })

  it('treats paths that differ in case as one on Windows', () => {
    const policy = buildPolicy({ platform: 'win32', home: 'C:\\Users\\u', roots: ['C:\\Work\\P', 'c:\\work\\p'], settings: settings({ caches: false }), temp: 'C:\\t', env: {}, io: fake({}) })
    assert.equal(policy.writable.filter((folder) => folder.toLowerCase() === 'c:\\work\\p').length, 1)
  })
})
