import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ServerSpec } from './catalog'
import { LANGUAGE_SERVERS } from './catalog'
import { discover } from './discover'
import { InstallFailed, installedDir, installServer, planInstall, removeInstall, type InstallContext, type NpmLock } from './install'
import { NPM_LOCKS } from './npm-locks'
import { makeTar, makeZip } from './test-archives'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-install-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type Route = { status?: number; body?: Buffer | string; headers?: Record<string, string> }

/** A fetch that answers from a table of URLs, and records what was asked. */
function fakeFetch(routes: Record<string, Route>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    assert.equal(init?.redirect, 'manual', 'redirects are followed by eNCode, host by host')
    const route = routes[url]
    if (!route) return new Response('not here', { status: 404 })
    return new Response(route.body === undefined ? null : typeof route.body === 'string' ? route.body : new Uint8Array(route.body), { status: route.status ?? 200, headers: route.headers ?? {} })
  }) as typeof fetch
}

function context(fetchImpl: typeof fetch, extra: Partial<InstallContext> = {}): InstallContext {
  return {
    toolsDir: path.join(dir, 'tools'),
    cacheDir: path.join(dir, 'cache'),
    root: path.join(dir, 'project'),
    platform: 'win32',
    arch: 'x64',
    node: { file: 'C:\\eNCode\\eNCode.exe', env: { ELECTRON_RUN_AS_NODE: '1' } },
    which: () => null,
    env: { PATH: '' },
    fetch: fetchImpl,
    ...extra,
  }
}

const sha512 = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

function npmSpec(lock: NpmLock): ServerSpec {
  return { id: 'fake', label: 'Fake', extensions: { '.fk': 'fake' }, candidates: [{ command: 'fake-ls', args: ['--stdio'] }], install: 'npm install -g fake-ls', installer: { kind: 'npm', lock, script: 'node_modules/fake-ls/bin/cli.js', args: ['--stdio'] } }
}

describe('installing from npm', () => {
  const server = makeTar([{ name: 'package/package.json', data: '{"name":"fake-ls"}' }, { name: 'package/bin/cli.js', data: 'console.log(1)', mode: 0o755 }], true)
  const helper = makeTar([{ name: 'package/index.js', data: 'module.exports = 2' }], true)
  const mac = makeTar([{ name: 'package/index.js', data: 'mac only' }], true)
  const lock: NpmLock = {
    packages: { 'fake-ls': '1.2.3' },
    files: [
      { path: 'node_modules/fake-ls', version: '1.2.3', url: 'https://registry.npmjs.org/fake-ls/-/fake-ls-1.2.3.tgz', integrity: sha512(server), size: server.length },
      { path: 'node_modules/fake-ls/node_modules/@scope/helper', version: '0.1.0', url: 'https://registry.npmjs.org/@scope/helper/-/helper-0.1.0.tgz', integrity: sha512(helper), size: helper.length },
      { path: 'node_modules/fsevents', version: '2.3.3', url: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz', integrity: sha512(mac), size: mac.length, optional: true, os: ['darwin'] },
    ],
  }
  const routes = {
    'https://registry.npmjs.org/fake-ls/-/fake-ls-1.2.3.tgz': { body: server },
    'https://registry.npmjs.org/@scope/helper/-/helper-0.1.0.tgz': { body: helper },
  }

  it('says what it will do, downloads every package checked against its pinned hash, and starts it on eNCode\'s Node.js', async () => {
    const spec = npmSpec(lock)
    const asked: string[] = []
    const plan = await planInstall(spec, context(fakeFetch(routes, asked)))
    assert.ok(!('unavailable' in plan))
    assert.equal(plan.version, '1.2.3')
    assert.equal(plan.bytes, server.length + helper.length)
    assert.match(plan.steps.join(' '), /fake-ls 1\.2\.3 from the npm registry: 2 packages/)
    assert.match(plan.steps.join(' '), /no install scripts/)
    assert.deepEqual(asked, [], 'planning downloads nothing')
    const progress: number[] = []
    const installed = await installServer(spec, context(fakeFetch(routes, asked), { onProgress: (done) => progress.push(done) }))
    assert.equal(installed, path.join(dir, 'tools', 'fake', '1.2.3'))
    assert.deepEqual(asked, Object.keys(routes), 'the macOS-only package is left out')
    assert.equal(progress.at(-1), server.length + helper.length)
    assert.equal(fs.readFileSync(path.join(installed, 'node_modules', 'fake-ls', 'node_modules', '@scope', 'helper', 'index.js'), 'utf8'), 'module.exports = 2')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tools', 'fake')), ['1.2.3'], 'nothing half-written is left behind')
    const plan2 = discover(spec, path.join(dir, 'project'), { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: path.join(dir, 'tools'), context: context(fakeFetch({})) } })
    assert.deepEqual(plan2, { file: 'C:\\eNCode\\eNCode.exe', args: [path.join(installed, 'node_modules', 'fake-ls', 'bin', 'cli.js'), '--stdio'], found: "eNCode's tools folder, 1.2.3", command: 'fake-ls', env: { ELECTRON_RUN_AS_NODE: '1' } })
    removeInstall(spec, path.join(dir, 'tools'))
    assert.equal(installedDir(spec, path.join(dir, 'tools')), null)
  })

  it('refuses a package that does not match its hash, and leaves nothing behind', async () => {
    const spec = npmSpec(lock)
    const swapped = { ...routes, 'https://registry.npmjs.org/@scope/helper/-/helper-0.1.0.tgz': { body: makeTar([{ name: 'package/index.js', data: 'evil' }], true) } }
    await assert.rejects(installServer(spec, context(fakeFetch(swapped))), (error: unknown) => error instanceof InstallFailed && /helper 0\.1\.0 does not match the hash/.test(error.message))
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tools', 'fake')), [])
    assert.equal(installedDir(spec, path.join(dir, 'tools')), null)
  })

  it('refuses a place no package goes, and a download from a host it does not use', async () => {
    const outside = npmSpec({ ...lock, files: [{ ...lock.files[0]!, path: 'node_modules/../../escape' }] })
    await assert.rejects(installServer(outside, context(fakeFetch(routes))), /is not a place a package goes/)
    const elsewhere = npmSpec({ ...lock, files: [{ ...lock.files[0]!, url: 'https://evil.example/fake-ls.tgz' }] })
    await assert.rejects(installServer(elsewhere, context(fakeFetch(routes))), /does not download from evil\.example/)
    const plain = npmSpec({ ...lock, files: [{ ...lock.files[0]!, url: 'http://registry.npmjs.org/fake-ls.tgz' }] })
    await assert.rejects(installServer(plain, context(fakeFetch(routes))), /does not download from http:/)
  })

  it('pins every package of the servers it installs from npm to a registry address and a sha512, with no install scripts', () => {
    for (const spec of LANGUAGE_SERVERS) {
      if (spec.installer?.kind !== 'npm') continue
      const lockOf = typeof spec.installer.lock === 'string' ? NPM_LOCKS[spec.installer.lock] : spec.installer.lock
      assert.ok(lockOf, `${spec.id} has a lock`)
      const top = spec.installer.script.split('/').slice(0, spec.installer.script.startsWith('node_modules/@') ? 3 : 2).join('/')
      assert.ok(lockOf.files.some((file) => file.path === top), `${spec.id}: ${top} is in its lock`)
      for (const file of lockOf.files) {
        assert.match(file.url, /^https:\/\/registry\.npmjs\.org\//, file.path)
        assert.match(file.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, file.path)
        assert.ok(file.size > 0, file.path)
      }
    }
  })
})

describe('installing a download', () => {
  const zip = makeZip([
    { name: 'tool_2.0.0/bin/tool.exe', data: 'MZ program', mode: 0o100755 },
    { name: 'tool_2.0.0/lib/headers.h', data: '#define X 1' },
  ])
  const release = (digest: string | null) =>
    JSON.stringify({
      tag_name: 'v2.0.0',
      assets: [
        { name: 'tool-windows-2.0.0.zip', size: zip.length, browser_download_url: 'https://github.com/owner/tool/releases/download/2.0.0/tool-windows-2.0.0.zip', ...(digest ? { digest } : {}) },
        { name: 'tool-linux-2.0.0.zip', size: 1, browser_download_url: 'https://github.com/owner/tool/releases/download/2.0.0/tool-linux-2.0.0.zip' },
      ],
    })
  const spec = (repo: string): ServerSpec => ({
    id: `tool-${repo}`,
    label: 'Tool',
    extensions: { '.tl': 'tool' },
    candidates: [{ command: 'tool', args: ['--serve'] }],
    install: 'get it from the website',
    installer: { kind: 'download', from: `github.com/owner/${repo}`, release: { github: `owner/${repo}` }, assets: { 'win32-x64': { name: 'tool-windows-{version}.zip', archive: 'zip', bin: 'bin/tool.exe' } }, args: ['--serve'] },
  })
  const routes = (repo: string, digest: string | null, asset: Route = { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset/1' } }) => ({
    [`https://api.github.com/repos/owner/${repo}/releases/latest`]: { body: release(digest) },
    'https://github.com/owner/tool/releases/download/2.0.0/tool-windows-2.0.0.zip': asset,
    'https://release-assets.githubusercontent.com/asset/1': { body: zip },
  })

  it('takes the newest GitHub release, checks the file against the sha256 GitHub publishes, and drops its top folder', async () => {
    const server = spec('a')
    const plan = await planInstall(server, context(fakeFetch(routes('a', `sha256:${sha256(zip)}`))))
    assert.ok(!('unavailable' in plan))
    assert.equal(plan.version, '2.0.0')
    assert.match(plan.steps[0]!, /tool-windows-2\.0\.0\.zip \(the newest release, version 2\.0\.0, .*\) from github\.com\/owner\/a and checks it against the checksum GitHub publishes/)
    const installed = await installServer(server, context(fakeFetch(routes('a', `sha256:${sha256(zip)}`))))
    assert.equal(fs.readFileSync(path.join(installed, 'bin', 'tool.exe'), 'utf8'), 'MZ program')
    assert.deepEqual(discover(server, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: path.join(dir, 'tools'), context: context(fakeFetch({})) } }), { file: path.join(installed, 'bin', 'tool.exe'), args: ['--serve'], found: "eNCode's tools folder, 2.0.0", command: 'tool' })
  })

  it('refuses a file GitHub publishes no checksum for, one that does not match, and a redirect to a host it does not use', async () => {
    const unchecked = await planInstall(spec('b'), context(fakeFetch(routes('b', null))))
    assert.match((unchecked as { unavailable: string }).unavailable, /publishes no checksum/)
    await assert.rejects(installServer(spec('c'), context(fakeFetch(routes('c', `sha256:${'0'.repeat(64)}`)))), /does not match its checksum/)
    await assert.rejects(installServer(spec('d'), context(fakeFetch(routes('d', `sha256:${sha256(zip)}`, { status: 302, headers: { location: 'https://evil.example/zip' } })))), /does not download from evil\.example/)
    for (const id of ['tool-c', 'tool-d']) assert.deepEqual(fs.readdirSync(path.join(dir, 'tools', id)), [])
  })

  it('says when there is no build for this computer', async () => {
    const plan = await planInstall(spec('e'), context(fakeFetch(routes('e', `sha256:${sha256(zip)}`)), { platform: 'linux', arch: 'riscv64' }))
    assert.match((plan as { unavailable: string }).unavailable, /no build of Tool's server for this computer \(linux, riscv64\)/)
  })

  it('checks a pinned download against the sha256 eNCode carries', async () => {
    const tar = makeTar([{ name: 'plugins/org.eclipse.equinox.launcher_1.0.jar', data: 'jar' }, { name: 'config_win/config.ini', data: 'x' }], true)
    const java = LANGUAGE_SERVERS.find((item) => item.id === 'java')!
    assert.equal(java.installer?.kind, 'download')
    const pinned: ServerSpec = { ...java, installer: { ...(java.installer as Extract<NonNullable<ServerSpec['installer']>, { kind: 'download' }>), release: { version: '9.9', base: 'https://download.eclipse.org/jdtls/x/', sha256: { 'jdtls.tar.gz': sha256(tar) } }, assets: { 'win32-x64': { name: 'jdtls.tar.gz', archive: 'tar', bin: 'plugins' } } } }
    const installed = await installServer(pinned, context(fakeFetch({ 'https://download.eclipse.org/jdtls/x/jdtls.tar.gz': { body: tar } })))
    const java21 = path.join(dir, 'jdk', 'bin', 'java.exe')
    fs.mkdirSync(path.dirname(java21), { recursive: true })
    fs.writeFileSync(java21, '')
    const launch = discover(pinned, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: path.join(dir, 'tools'), context: context(fakeFetch({}), { env: { JAVA_HOME: path.join(dir, 'jdk') } }) } })
    assert.ok('file' in launch)
    assert.equal(launch.file, java21)
    assert.ok(launch.args.includes(path.join(installed, 'plugins', 'org.eclipse.equinox.launcher_1.0.jar')))
    assert.ok(launch.args.includes(`-Dosgi.sharedConfiguration.area=${path.join(installed, 'config_win')}`))
    assert.equal(launch.args.at(-2), '-data')
    assert.ok(launch.args.at(-1)!.startsWith(path.join(dir, 'cache', 'jdtls')))
    const noJava = discover(pinned, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: path.join(dir, 'tools'), context: context(fakeFetch({})) } })
    assert.match((noJava as { missing: string }).missing, /needs Java 21 or newer/)
    await assert.rejects(installServer(pinned, context(fakeFetch({ 'https://download.eclipse.org/jdtls/x/jdtls.tar.gz': { body: makeTar([{ name: 'other', data: 'x' }], true) } }))), /does not match its checksum/)
  })
})

describe('installing with a toolchain', () => {
  const spec: ServerSpec = { id: 'go-ish', label: 'Go', extensions: { '.go': 'go' }, candidates: [{ command: 'gopls', args: [] }], install: 'go install gopls', installer: { kind: 'toolchain', program: 'go', args: ['install', 'golang.org/x/tools/gopls@v1'], env: { GOBIN: '{dir}' }, version: '1', needs: 'Go', bin: 'gopls' } }

  it('runs the toolchain with fixed arguments into a folder of its own, and keeps what it left there', async () => {
    const runs: { program: string; args: string[]; env: Record<string, string>; cwd: string }[] = []
    const installed = await installServer(
      spec,
      context(fakeFetch({}), {
        which: (name) => (name === 'go' ? 'C:\\Go\\bin\\go.exe' : null),
        run: async (program, args, options) => {
          runs.push({ program, args, env: options.env, cwd: options.cwd })
          fs.writeFileSync(path.join(options.env.GOBIN!, 'gopls.exe'), 'MZ')
          return { code: 0, output: '' }
        },
      }),
    )
    assert.equal(runs[0]!.program, 'C:\\Go\\bin\\go.exe')
    assert.deepEqual(runs[0]!.args, ['install', 'golang.org/x/tools/gopls@v1'])
    // It runs in its own empty folder, never the project, whose go.mod could pick another toolchain.
    assert.equal(runs[0]!.cwd, runs[0]!.env.GOBIN)
    assert.equal(fs.readFileSync(path.join(installed, 'gopls.exe'), 'utf8'), 'MZ')
  })

  it('says what is needed when the toolchain is not there, and what it said when it failed', async () => {
    const plan = await planInstall(spec, context(fakeFetch({})))
    assert.match((plan as { unavailable: string }).unavailable, /needs Go \(go was not found on the PATH\)/)
    await assert.rejects(
      installServer(spec, context(fakeFetch({}), { which: () => 'go', run: async () => ({ code: 1, output: 'downloading\nverifying: checksum mismatch\n' }) })),
      /go could not install it \(exit 1\): downloading verifying: checksum mismatch/,
    )
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tools', 'go-ish')), [])
  })
})

describe('installing without a network', () => {
  it('says which address could not be reached and why, and leaves nothing', async () => {
    const lock: NpmLock = { packages: { 'fake-ls': '1.0.0' }, files: [{ path: 'node_modules/fake-ls', version: '1.0.0', url: 'https://registry.npmjs.org/fake-ls/-/fake-ls-1.0.0.tgz', integrity: 'sha512-x', size: 1 }] }
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' }) })
    }) as typeof fetch
    await assert.rejects(
      installServer(npmSpec(lock), context(offline)),
      (error: unknown) => error instanceof InstallFailed && error.message === 'eNCode could not reach registry.npmjs.org (ENOTFOUND). Check the connection, or a proxy it needs, and try again.',
    )
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tools', 'fake')), [])
  })
})
