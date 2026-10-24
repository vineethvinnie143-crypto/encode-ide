import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { configHosts, parseRemotePath, parseRemoteRoot, parseTarget, remoteRoot, sshArgs, targetLabel } from './target'

describe('a machine and a folder there, as the person types them', () => {
  it('reads a host, a user and a port, in the shapes ssh takes', () => {
    assert.deepEqual(parseTarget('devbox'), { host: 'devbox' })
    assert.deepEqual(parseTarget(' me@build.example.com:2222 '), { host: 'build.example.com', user: 'me', port: 2222 })
    assert.deepEqual(parseTarget('root@10.0.0.7'), { host: '10.0.0.7', user: 'root' })
    assert.deepEqual(parseTarget('me@[fe80::1]:22'), { host: 'fe80::1', user: 'me', port: 22 })
  })

  it('refuses what ssh would read as an option or split into two arguments', () => {
    for (const bad of ['-oProxyCommand=calc', 'me@-oProxyCommand=x', 'dev box', 'host\nother', 'host\u0000', '', 'me@host:99999', 'me@host:http', 'me@ho;st', '$(id)@host']) {
      assert.ok('error' in parseTarget(bad), bad)
    }
  })

  it('reads a folder as an absolute path or one under the home, and nothing that climbs out', () => {
    assert.equal(parseRemotePath('/srv/app/'), '/srv/app')
    assert.equal(parseRemotePath('~/work//site'), '~/work/site')
    assert.equal(parseRemotePath('~'), '~')
    assert.equal(parseRemotePath('/'), '/')
    for (const bad of ['', 'relative/path', '/srv/../etc', '~/a/../../b', '/a\u0007b', 'C:\\work']) assert.ok(typeof parseRemotePath(bad) !== 'string', bad)
  })

  it('names the folder in full and reads the name back', () => {
    const uri = remoteRoot({ host: 'fe80::1', user: 'me', port: 2222, path: '/home/me/app' })
    assert.equal(uri, 'ssh://me@[fe80::1]:2222/home/me/app')
    assert.deepEqual(parseRemoteRoot(uri), { host: 'fe80::1', user: 'me', port: 2222, path: '/home/me/app' })
    assert.equal(remoteRoot({ host: 'vm', path: '~/site' }), 'ssh://vm/~/site')
    assert.deepEqual(parseRemoteRoot('ssh://vm/~/site'), { host: 'vm', path: '~/site' })
    assert.equal(parseRemoteRoot('ssh://-oProxyCommand=x/srv'), null)
    assert.equal(parseRemoteRoot('C:\\work'), null)
    assert.equal(targetLabel({ host: 'vm', user: 'me' }), 'me@vm')
  })

  it('puts the machine after "--", with eNCode’s options before, so nothing typed becomes an option', () => {
    const args = sshArgs({ host: 'vm', user: 'me', port: 2222 }, 'sh -c true')
    assert.deepEqual(args.slice(-5), ['-p', '2222', '--', 'vm', 'sh -c true'])
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('ClearAllForwardings=yes'))
    assert.ok(args.indexOf('-l') < args.indexOf('--'))
  })

  it('suggests the plain host names of an ssh config', () => {
    const config = ['Host devbox build', '  HostName 10.0.0.7', 'Host *.internal !bad', 'host = staging # a comment', 'Match host x', 'Host -oProxyCommand=calc'].join('\n')
    assert.deepEqual(configHosts(config), ['devbox', 'build', 'staging'])
  })
})
