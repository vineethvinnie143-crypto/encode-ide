import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { NpmLock, ServerSpec } from '@encode/lsp'
import { makeTar } from '@encode/lsp/test-archives'
import { tempWorkspace } from '@encode/tools/testing'
import { ServerInstalls } from './installs'
import { Workspaces } from './scope'

/** Servers eNCode installs when asked: one install at a time per server, its progress, and the folders told after. */

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

/** A folder on the PATH with a program of this name in it, as a toolchain would have. */
async function onPath(program: string): Promise<Record<string, string>> {
  const bin = await tempWorkspace({ [exe(program)]: 'program' })
  return { PATH: bin, PATHEXT: '.EXE' }
}

const toolchain: ServerSpec = {
  id: 'go-ish',
  label: 'Go',
  extensions: { '.go': 'go' },
  candidates: [{ command: 'gopls', args: [] }],
  install: 'go install golang.org/x/tools/gopls@latest',
  installer: { kind: 'toolchain', program: 'go', args: ['install', 'golang.org/x/tools/gopls@v1'], env: { GOBIN: '{dir}' }, version: '1', needs: 'Go', bin: 'gopls' },
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function installs(run: ConstructorParameters<typeof ServerInstalls>[0]['run']) {
  const tools = await tempWorkspace()
  const rediscovered: [string, boolean][] = []
  let changes = 0
  const subject = new ServerInstalls({
    tools: { dir: tools, cacheDir: path.join(tools, '.cache'), node: { file: process.execPath } },
    platform: process.platform,
    catalog: [toolchain],
    env: await onPath('go'),
    rediscover: async (id, how) => {
      rediscovered.push([id, Boolean(how.stop)])
    },
    onChange: () => changes++,
    run,
  })
  return { subject, tools, rediscovered, changes: () => changes }
}

describe('installing language servers', () => {
  it('runs one install per server however often it is asked, shows it running, and has the folders look again after', async () => {
    const gate = deferred()
    let runs = 0
    const s = await installs(async (_program, _args, options) => {
      runs++
      await gate.promise
      fs.writeFileSync(path.join(options.env.GOBIN!, exe('gopls')), 'program')
      return { code: 0, output: '' }
    })
    const plan = await s.subject.plan('go-ish', s.tools)
    assert.ok('steps' in plan, JSON.stringify(plan))
    const first = s.subject.install('go-ish', s.tools)
    const second = s.subject.install('go-ish', s.tools)
    assert.equal(first, second, 'the second ask waits for the same install')
    assert.deepEqual(s.subject.state('go-ish'), { done: 0, total: 0 })
    gate.resolve()
    const result = await first
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(runs, 1)
    assert.equal(s.subject.state('go-ish'), undefined)
    assert.deepEqual(s.rediscovered, [['go-ish', false]])
    assert.ok(s.changes() >= 2, 'the screen heard it start and end')
    assert.ok(fs.existsSync(path.join(result.dir, exe('gopls'))))

    // Removing it stops the server in every folder first, then has them look for another.
    assert.deepEqual(await s.subject.remove('go-ish'), { ok: true, dir: '' })
    assert.deepEqual(s.rediscovered.slice(1), [
      ['go-ish', true],
      ['go-ish', false],
    ])
    assert.equal(fs.existsSync(result.dir), false)
  })

  it('keeps why an install failed until the next try, and a stopped install is no failure', async () => {
    let fail = true
    const s = await installs(async (_program, _args, options) => {
      if (fail) return { code: 1, output: 'verifying: checksum mismatch' }
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()))
      return { code: null, output: '' }
    })
    const failed = await s.subject.install('go-ish', s.tools)
    assert.equal(failed.ok, false)
    const state = s.subject.state('go-ish')
    assert.ok(state && 'error' in state && /checksum mismatch/.test(state.error), JSON.stringify(state))
    assert.deepEqual(await s.subject.remove('unknown'), { ok: false, reason: 'eNCode does not know that language server.' })

    fail = false
    const running = s.subject.install('go-ish', s.tools)
    assert.deepEqual(s.subject.state('go-ish'), { done: 0, total: 0 }, 'a new try clears the old failure')
    assert.deepEqual(await s.subject.remove('go-ish'), { ok: false, reason: 'It is being installed.' })
    s.subject.cancel('go-ish')
    assert.deepEqual(await running, { ok: false, reason: 'The install was stopped.' })
    assert.equal(s.subject.state('go-ish'), undefined)
    assert.deepEqual(fs.readdirSync(path.join(s.tools, 'go-ish')), [], 'nothing is left behind')
    assert.deepEqual(s.rediscovered, [])
  })

  it('says what it does not know or cannot do', async () => {
    const s = await installs(undefined)
    assert.deepEqual(await s.subject.plan('nope', s.tools), { unavailable: 'eNCode does not know that language server.' })
    assert.deepEqual(await s.subject.install('nope', s.tools), { ok: false, reason: 'eNCode does not know that language server.' })
  })
})

describe('a folder\'s report with installs', () => {
  it('names the servers eNCode can install, installs one from npm, and the folder finds it at once', async () => {
    const root = await tempWorkspace({ 'src/a.fk': '', 'src/b.fk': '', 'fake.json': '{}' })
    const home = await tempWorkspace()
    const tools = await tempWorkspace()
    const tarball = makeTar([{ name: 'package/package.json', data: '{"name":"fake-ls"}' }, { name: 'package/bin/cli.js', data: 'process.exit(0)' }], true)
    const lock: NpmLock = {
      packages: { 'fake-ls': '1.2.3' },
      files: [{ path: 'node_modules/fake-ls', version: '1.2.3', url: 'https://registry.npmjs.org/fake-ls/-/fake-ls-1.2.3.tgz', integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`, size: tarball.length }],
    }
    const spec: ServerSpec = {
      id: 'fake',
      label: 'Fake',
      extensions: { '.fk': 'fake' },
      markers: ['fake.json'],
      candidates: [{ command: 'fake-ls', args: ['--stdio'] }],
      install: 'npm install -g fake-ls',
      installer: { kind: 'npm', lock, script: 'node_modules/fake-ls/bin/cli.js', args: ['--stdio'] },
    }
    const asked: string[] = []
    const changes: string[] = []
    const workspaces = new Workspaces({
      home,
      env: {},
      languageServers: {
        enabled: () => true,
        env: { PATH: home },
        catalog: [spec],
        tools: {
          dir: tools,
          cacheDir: path.join(tools, '.cache'),
          node: { file: process.execPath },
          fetch: (async (input: string | URL | Request) => {
            asked.push(String(input))
            return new Response(new Uint8Array(tarball), { status: 200 })
          }) as typeof fetch,
        },
        onChange: (folder) => changes.push(folder),
      },
    })
    try {
      await workspaces.act(root, { type: 'trust' })
      const before = await workspaces.languageServersReport(root)
      assert.equal(before.state, 'on')
      assert.deepEqual(
        { state: before.servers[0]!.state, installer: before.servers[0]!.installer, used: before.servers[0]!.used, installed: before.servers[0]!.installed },
        { state: 'missing', installer: 'npm', used: { files: 2, markers: ['fake.json'] }, installed: undefined },
      )
      const plan = await workspaces.planServerInstall(root, 'fake')
      assert.ok('steps' in plan && plan.version === '1.2.3', JSON.stringify(plan))
      const result = await workspaces.installServer(root, 'fake')
      assert.ok(result.ok, JSON.stringify(result))
      assert.deepEqual(asked, ['https://registry.npmjs.org/fake-ls/-/fake-ls-1.2.3.tgz'])
      assert.ok(changes.length > 0, 'the folder heard of it')
      const after = await workspaces.languageServersReport(root)
      assert.equal(after.servers[0]!.installed, '1.2.3')
      assert.notEqual(after.servers[0]!.state, 'missing', 'found in eNCode\'s tools folder without waiting')
      assert.deepEqual(await workspaces.removeServer('fake'), { ok: true, dir: '' })
      assert.equal((await workspaces.languageServersReport(root)).servers[0]!.state, 'missing')
    } finally {
      await workspaces.close()
    }
  })

  it('installs nothing in a program without a tools folder', async () => {
    const workspaces = new Workspaces({ home: await tempWorkspace(), env: {}, languageServers: { enabled: () => true } })
    try {
      assert.deepEqual(await workspaces.planServerInstall(await tempWorkspace(), 'typescript'), { unavailable: 'This program does not install language servers.' })
      assert.deepEqual(await workspaces.installServer(await tempWorkspace(), 'typescript'), { ok: false, reason: 'This program does not install language servers.' })
    } finally {
      await workspaces.close()
    }
  })
})
