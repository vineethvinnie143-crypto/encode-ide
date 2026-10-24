import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { RemoteMachine } from './machine'
import { Places, type PlacesOptions } from './places'
import { targetLabel, type SshTarget } from './target'

/** A machine whose folders all exist, recording what is done to it. */
function fakeMachine(target: SshTarget, log: string[], options: { refuse?: boolean } = {}): RemoteMachine {
  let root: string | null = null
  return {
    target,
    label: targetLabel(target),
    open: async () => {
      log.push(`connect ${targetLabel(target)}`)
      return options.refuse ? { ok: false, kind: 'auth', message: 'no key' } : null
    },
    resolveFolder: async (typed: string) => {
      const abs = typed.startsWith('~/') ? `/home/me/${typed.slice(2)}` : typed
      return { root: abs, name: path.posix.basename(abs) }
    },
    workspace: {
      get current() {
        return root ? { root, name: path.posix.basename(root) } : null
      },
      open: async (abs: string) => {
        root = abs
        return { root: abs, name: path.posix.basename(abs) }
      },
      close: async () => {
        root = null
      },
    },
    shell: { disposeAll: () => undefined },
    close: () => log.push(`close ${targetLabel(target)}`),
  } as unknown as RemoteMachine
}

function places(platform: NodeJS.Platform, log: string[], extra: Partial<PlacesOptions> = {}) {
  let localRoot: string | null = null
  const local = {
    workspace: {
      get current() {
        return localRoot ? { root: localRoot, name: path.basename(localRoot) } : null
      },
      open: async (root: string) => {
        log.push(`local ${root}`)
        localRoot = root
        return { root, name: path.basename(root) }
      },
      close: async () => {
        localRoot = null
      },
    },
    shell: { disposeAll: () => undefined },
  } as unknown as PlacesOptions['local']
  return new Places({
    local,
    platform,
    localFolders: () => ['/home/me/local-project'],
    machine: (target) => fakeMachine(target, log),
    moved: async () => {
      log.push('agent moved')
    },
    ...extra,
  })
}

describe('where the open folder is', () => {
  it('opens a folder on a machine by its full name, and the agent moves there once', async () => {
    const log: string[] = []
    const where = places('win32', log)
    const opened = await where.open('ssh://me@vm/~/app')
    assert.deepEqual(opened, { root: '/home/me/app', name: 'app', remote: { label: 'me@vm', uri: 'ssh://me@vm/home/me/app' } })
    // Another folder on the same machine: no new connection, no move.
    await where.open('/srv/api')
    assert.equal(where.shown?.remote?.uri, 'ssh://me@vm/srv/api')
    assert.deepEqual(log, ['connect me@vm', 'agent moved'])
  })

  it('takes a Windows path for this PC while a machine’s folder is open, and closes that connection', async () => {
    const log: string[] = []
    const where = places('win32', log)
    await where.open('ssh://vm/srv/app')
    await where.open('C:\\work\\site')
    assert.equal(where.remote, null)
    assert.deepEqual(log, ['connect vm', 'agent moved', 'agent moved', 'close vm', 'local C:\\work\\site'])
  })

  it('on a PC with POSIX paths, takes its own known folders for this PC and the rest for the machine', async () => {
    const log: string[] = []
    const where = places('linux', log)
    await where.open('ssh://vm/srv/app')
    await where.open('/srv/other')
    assert.equal(where.shown?.remote?.label, 'vm')
    await where.open('/home/me/local-project')
    assert.equal(where.remote, null)
    // A folder the system's dialog chose is this PC's whatever its path.
    await where.open('ssh://vm/srv/app')
    await where.open('/srv/app', { local: true })
    assert.equal(where.remote, null)
  })

  it('moving from one machine to another closes the first after the agent has moved', async () => {
    const log: string[] = []
    const where = places('win32', log)
    await where.open('ssh://one/srv/a')
    await where.open('ssh://two/srv/b')
    assert.deepEqual(log, ['connect one', 'agent moved', 'connect two', 'agent moved', 'close one'])
  })

  it('stays where it was when the machine cannot be reached', async () => {
    const log: string[] = []
    const where = places('win32', log, { machine: (target) => fakeMachine(target, log, { refuse: true }) })
    await where.open('C:\\work\\site')
    await assert.rejects(where.open('ssh://vm/srv/app'), /no key/)
    assert.equal(where.remote, null)
    assert.equal(where.shown?.root, 'C:\\work\\site')
    assert.ok(!log.includes('agent moved'))
  })
})
