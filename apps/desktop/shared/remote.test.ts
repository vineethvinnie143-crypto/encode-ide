import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isRemoteRoot, remoteHost, remoteParts } from './remote'

describe('names of folders on other machines', () => {
  it('splits a name into the machine and the folder there', () => {
    assert.deepEqual(remoteParts('ssh://me@vm:2222/home/me/app'), { machine: 'me@vm:2222', folder: '/home/me/app' })
    assert.deepEqual(remoteParts('ssh://vm/~/app'), { machine: 'vm', folder: '~/app' })
    assert.equal(remoteParts('ssh://vm'), null)
    assert.equal(remoteParts('C:\\Users\\me\\app'), null)
    assert.equal(isRemoteRoot('/home/me/app'), false)
  })

  it('gives the host for a short label', () => {
    assert.equal(remoteHost('me@vm:2222'), 'vm')
    assert.equal(remoteHost('vm'), 'vm')
    assert.equal(remoteHost('me@[fe80::1]:22'), 'fe80::1')
  })
})
