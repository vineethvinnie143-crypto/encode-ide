import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ServerSpec } from './catalog'
import { LANGUAGE_SERVERS } from './catalog'
import { discover } from './discover'
import { installedDir, installedRuntime, installedRuntimeLabel, installServer, planInstall, removeRuntime, type InstallContext, type InstallPlan } from './install'
import { makeTar, makeZip } from './test-archives'

let dir: string
let tools: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-runtimes-'))
  tools = path.join(dir, 'tools')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type Route = { status?: number; body?: Buffer | string; headers?: Record<string, string> }

function fakeFetch(routes: Record<string, Route>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    assert.equal(init?.redirect, 'manual')
    const route = routes[url]
    if (!route) return new Response('not here', { status: 404 })
    const headers = { ...(route.headers ?? {}), ...(route.body !== undefined ? { 'content-length': String(Buffer.byteLength(route.body)) } : {}) }
    return new Response(init?.method === 'HEAD' || route.body === undefined ? null : typeof route.body === 'string' ? route.body : new Uint8Array(route.body), { status: route.status ?? 200, headers })
  }) as typeof fetch
}

type Run = NonNullable<InstallContext['run']>

function context(fetchImpl: typeof fetch, extra: Partial<InstallContext> = {}): InstallContext {
  return {
    toolsDir: tools,
    cacheDir: path.join(dir, 'cache'),
    root: path.join(dir, 'project'),
    platform: 'win32',
    arch: 'x64',
    node: { file: 'C:\\eNCode\\eNCode.exe', env: { ELECTRON_RUN_AS_NODE: '1' } },
    which: () => null,
    // Windows spells it Path.
    env: { Path: 'C:\\Windows\\System32' },
    fetch: fetchImpl,
    ...extra,
  }
}

const hex = (algorithm: 'sha256' | 'sha512', data: Buffer) => createHash(algorithm).update(data).digest('hex')
const server = (id: string) => LANGUAGE_SERVERS.find((spec) => spec.id === id)!
const planned = (plan: InstallPlan | { unavailable: string }): InstallPlan => {
  assert.ok(!('unavailable' in plan), 'unavailable' in plan ? plan.unavailable : '')
  return plan
}

describe('C#: the .NET SDK', () => {
  const sdk = makeZip([
    { name: 'dotnet.exe', data: 'MZ dotnet' },
    { name: 'sdk/10.0.402/dotnet.dll', data: 'sdk' },
    { name: 'shared/Microsoft.NETCore.App/10.0.13/System.Runtime.dll', data: 'runtime' },
  ])
  const zipUrl = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip'
  const releases = (hash: string, url = zipUrl) =>
    JSON.stringify({
      'channel-version': '10.0',
      'latest-release': '10.0.13',
      'latest-sdk': '10.0.402',
      releases: [
        {
          'release-version': '10.0.13',
          sdk: {
            version: '10.0.402',
            files: [
              { name: 'dotnet-sdk-win-x64.exe', rid: 'win-x64', url: 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.exe', hash: 'a'.repeat(128) },
              { name: 'dotnet-sdk-win-x64.zip', rid: 'win-x64', url, hash },
            ],
          },
        },
      ],
    })
  const routes = (hash = hex('sha512', sdk), url?: string): Record<string, Route> => ({
    'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json': { body: releases(hash, url) },
    [zipUrl]: { body: sdk },
  })
  // `dotnet tool install csharp-ls --version 0.28.0 --tool-path <dir>` leaves csharp-ls.exe in <dir>.
  const toolInstall = (runs: Parameters<Run>[]): Run => async (program, args, options) => {
    runs.push([program, args, options])
    if (args[0] === 'tool') fs.writeFileSync(path.join(args[args.indexOf('--tool-path') + 1]!, 'csharp-ls.exe'), 'MZ csharp-ls')
    return { code: 0, output: '' }
  }

  it('fetches the .NET SDK into its own folder when the computer has none, installs csharp-ls with it, and starts the server with it', async () => {
    const csharp = server('csharp')
    const runs: Parameters<Run>[] = []
    const asked: string[] = []
    const ctx = context(fakeFetch(routes(), asked), { run: toolInstall(runs) })
    const plan = planned(await planInstall(csharp, ctx))
    assert.equal(plan.bytes, sdk.length)
    assert.match(plan.steps[0]!, /^Downloads the \.NET SDK 10\.0\.402 \(\d+ KB\) from Microsoft \(builds\.dotnet\.microsoft\.com\) and checks it against the SHA-512 Microsoft publishes for it\.$/)
    assert.equal(plan.steps[1], `Runs dotnet tool install csharp-ls --version 0.28.0 --tool-path ${path.join(tools, 'csharp', '0.28.0')}, with that copy.`)
    assert.match(plan.steps[2]!, /Nothing is installed for the whole computer, no administrator is asked for, and the PATH stays as it is: this copy of the \.NET SDK is for the language server alone\. To build C# programs yourself, install the \.NET SDK from https:\/\/dotnet\.microsoft\.com\/download\.$/)

    const installed = await installServer(csharp, ctx)
    const home = path.join(tools, 'runtimes', 'dotnet', '10.0.402')
    assert.equal(fs.readFileSync(path.join(home, 'dotnet.exe'), 'utf8'), 'MZ dotnet')
    const [program, args, options] = runs.at(-1)!
    assert.equal(program, path.join(home, 'dotnet.exe'))
    assert.deepEqual(args.slice(0, 5), ['tool', 'install', 'csharp-ls', '--version', '0.28.0'])
    assert.equal(options.env.DOTNET_ROOT, home)
    assert.equal(options.env.Path, `${home};C:\\Windows\\System32`)
    assert.equal(options.env.PATH, undefined, 'one PATH key, as Windows spells it')
    assert.equal(options.env.DOTNET_CLI_TELEMETRY_OPTOUT, '1')
    // Its caches go in a folder of their own that is removed afterwards, not the person's home folder.
    assert.ok(options.env.DOTNET_CLI_HOME!.startsWith(`${options.cwd}-work`))
    assert.ok(options.env.NUGET_PACKAGES!.startsWith(`${options.cwd}-work`))
    assert.equal(fs.existsSync(`${options.cwd}-work`), false)
    assert.deepEqual(installedDir(csharp, tools)?.runtime, { id: 'dotnet', version: '10.0.402' })
    assert.equal(installedRuntimeLabel(csharp, tools), '.NET SDK 10.0.402')

    const launch = discover(csharp, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: tools, context: ctx } })
    assert.ok('file' in launch)
    assert.equal(launch.file, path.join(installed, 'csharp-ls.exe'))
    assert.equal(launch.env?.DOTNET_ROOT, home)
    assert.equal(launch.env?.DOTNET_ROLL_FORWARD, 'Major')
    assert.equal(launch.env?.Path, `${home};C:\\Windows\\System32`)

    // The SDK is asked about once and downloaded once; a second plan uses the copy in place.
    assert.equal(asked.filter((line) => line === `GET ${zipUrl}`).length, 1)
    const again = planned(await planInstall(csharp, ctx))
    assert.equal(again.steps[0], `Runs dotnet tool install csharp-ls --version 0.28.0 --tool-path ${path.join(tools, 'csharp', '0.28.0')}, with eNCode's own copy of the .NET SDK (10.0.402).`)
    assert.equal(again.bytes, undefined)

    // Without its SDK, the server says how to get it back rather than failing to start.
    removeRuntime('dotnet', tools)
    const gone = discover(csharp, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: tools, context: ctx } })
    assert.match((gone as { missing: string }).missing, /installed with eNCode's own copy of the \.NET SDK, which is no longer there\. Install it again from Settings > Language servers\./)
  })

  it('uses the .NET SDK on the computer when it is 10 or newer, and fetches its own when it is older', async () => {
    const csharp = server('csharp')
    const system = 'C:\\Program Files\\dotnet\\dotnet.exe'
    const sdks = (output: string): Run => async (program, args, options) => {
      assert.deepEqual([program, args], [system, ['--list-sdks']])
      // Asked in eNCode's own folder, never the project, whose global.json could pick another SDK.
      assert.equal(options.cwd, tools)
      return { code: 0, output }
    }
    const which = (name: string) => (name === 'dotnet' ? system : null)
    const newer = planned(await planInstall(csharp, context(fakeFetch(routes()), { which, run: sdks('8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n10.0.100 [C:\\Program Files\\dotnet\\sdk]\r\n') })))
    assert.equal(newer.steps[0], `Runs dotnet tool install csharp-ls --version 0.28.0 --tool-path ${path.join(tools, 'csharp', '0.28.0')}, with the .NET SDK from ${system}.`)
    const older = planned(await planInstall(csharp, context(fakeFetch(routes()), { which, run: sdks('8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n') })))
    assert.match(older.steps[0]!, /^Downloads the \.NET SDK 10\.0\.402/)
    // A dotnet with no SDK at all (only a runtime) lists none.
    const none = planned(await planInstall(csharp, context(fakeFetch(routes()), { which, run: sdks('') })))
    assert.match(none.steps[0]!, /^Downloads the \.NET SDK 10\.0\.402/)
  })

  it('says where to get the .NET SDK where eNCode cannot fetch it, or cannot reach Microsoft', async () => {
    const csharp = server('csharp')
    const linux = await planInstall(csharp, context(fakeFetch(routes()), { platform: 'linux', env: { PATH: '/usr/bin' } }))
    assert.deepEqual(linux, { unavailable: "Installing C#'s language server needs the .NET SDK 10 or newer, and it is not on this computer. eNCode cannot fetch it for this computer (linux, x64). Get it from https://dotnet.microsoft.com/download, then try again." })
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
    }) as typeof fetch
    const unreachable = await planInstall(csharp, context(offline))
    assert.match((unreachable as { unavailable: string }).unavailable, /needs the \.NET SDK 10 or newer, and it is not on this computer\. eNCode could not find one to fetch: eNCode could not reach builds\.dotnet\.microsoft\.com \(ENOTFOUND\)\. Check the connection, or a proxy it needs, and try again\. Get it from https:\/\/dotnet\.microsoft\.com\/download, then try again\./)
  })

  it('refuses an SDK that does not match the SHA-512 Microsoft publishes, or one from elsewhere, and leaves nothing', async () => {
    const csharp = server('csharp')
    const runs: Parameters<Run>[] = []
    await assert.rejects(installServer(csharp, context(fakeFetch(routes('b'.repeat(128))), { run: toolInstall(runs) })), /dotnet-sdk-10\.0\.402-win-x64\.zip does not match its checksum, so it was not installed\./)
    assert.deepEqual(fs.readdirSync(path.join(tools, 'runtimes', 'dotnet')), [])
    assert.equal(runs.length, 0)
    const elsewhere = await planInstall(csharp, context(fakeFetch(routes(hex('sha512', sdk), 'https://example.com/dotnet-sdk.zip'))))
    assert.match((elsewhere as { unavailable: string }).unavailable, /names a \.NET SDK 10\.0\.402 download eNCode does not take/)
  })
})

describe('Java: Temurin for the Java server', () => {
  const jdtls = makeTar([{ name: 'plugins/org.eclipse.equinox.launcher_1.0.jar', data: 'jar' }, { name: 'config_win/config.ini', data: 'x' }], true)
  const jre = makeZip([
    { name: 'jdk-25.0.4.1+1-jre/bin/java.exe', data: 'MZ java' },
    { name: 'jdk-25.0.4.1+1-jre/lib/modules', data: 'modules' },
  ])
  const link = 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip'
  const routes: Record<string, Route> = {
    'https://download.eclipse.org/jdtls/x/jdtls.tar.gz': { body: jdtls },
    'https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse': {
      body: JSON.stringify([{ binary: { image_type: 'jre', os: 'windows', architecture: 'x64', package: { name: 'OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip', link, checksum: hex('sha256', jre), size: jre.length } }, release_name: 'jdk-25.0.4.1+1', version: { major: 25, semver: '25.0.4+101.0.LTS' } }]),
    },
    [link]: { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/jre' } },
    'https://release-assets.githubusercontent.com/github-production-release-asset/jre': { body: jre },
  }
  const java = server('java')
  const pinned: ServerSpec = { ...java, installer: { ...(java.installer as Extract<NonNullable<ServerSpec['installer']>, { kind: 'download' }>), release: { version: '9.9', base: 'https://download.eclipse.org/jdtls/x/', sha256: { 'jdtls.tar.gz': hex('sha256', jdtls) } }, assets: { 'win32-x64': { name: 'jdtls.tar.gz', archive: 'tar', bin: 'plugins' } } } }
  // Java 8 on the PATH: too old for the Java server.
  const old = { which: (name: string) => (name === 'java' ? 'C:\\java8\\bin\\java.exe' : null), run: (async () => ({ code: 0, output: 'java version "1.8.0_421"\nJava(TM) SE Runtime Environment' })) as Run }

  it('fetches Java when the computer has none new enough, starts the server on it, and fetches only Java when the server is already there', async () => {
    const ctx = context(fakeFetch(routes), old)
    const plan = planned(await planInstall(pinned, ctx))
    assert.equal(plan.bytes, jdtls.length + jre.length)
    assert.match(plan.steps[1]!, /^Downloads Java 25\.0\.4\.1\+1 \(\d+ KB\) from Eclipse Adoptium \(Temurin, adoptium\.net\) and checks it against the sha256 Eclipse Adoptium publishes for it\. The server runs on it\.$/)
    assert.match(plan.steps[2]!, /To build Java programs yourself, install a JDK such as Eclipse Temurin from https:\/\/adoptium\.net\/\.$/)
    const installed = await installServer(pinned, ctx)
    const home = path.join(tools, 'runtimes', 'java', '25.0.4.1+1')
    assert.equal(fs.readFileSync(path.join(home, 'bin', 'java.exe'), 'utf8'), 'MZ java')
    const launch = discover(pinned, dir, { platform: 'win32', which: old.which, isFile: () => false, tools: { dir: tools, context: ctx } })
    assert.ok('file' in launch)
    assert.equal(launch.file, path.join(home, 'bin', 'java.exe'))
    assert.ok(launch.args.includes(path.join(installed, 'plugins', 'org.eclipse.equinox.launcher_1.0.jar')))
    assert.equal(installedRuntimeLabel(pinned, tools), 'Java 25.0.4.1+1')

    // Java gone, the server still there: Install fetches Java alone.
    removeRuntime('java', tools)
    const missing = discover(pinned, dir, { platform: 'win32', which: () => null, isFile: () => false, tools: { dir: tools, context: context(fakeFetch({})) } })
    assert.match((missing as { missing: string }).missing, /needs Java 21 or newer.*Choose Install in Settings > Language servers to have eNCode fetch it/)
    const asked: string[] = []
    const again = planned(await planInstall(pinned, context(fakeFetch(routes, asked), old)))
    assert.equal(again.steps[0], "Java's language server 9.9 is already in eNCode's folder, so it is not downloaded again.")
    assert.equal(again.bytes, jre.length)
    assert.equal(await installServer(pinned, context(fakeFetch(routes, asked), old)), installed)
    assert.equal(asked.some((line) => line.endsWith('jdtls.tar.gz')), false)
    assert.ok(installedRuntime('java', tools))
  })

  it('runs on a Java 21 or newer the computer has, and says where to get one when it can find none', async () => {
    const java21: Partial<InstallContext> = { which: (name) => (name === 'java' ? 'C:\\jdk21\\bin\\java.exe' : null), run: async () => ({ code: 0, output: 'openjdk version "21.0.4" 2024-07-16 LTS' }) }
    const plan = planned(await planInstall(pinned, context(fakeFetch(routes), java21)))
    assert.equal(plan.steps[1], 'It runs on the Java on this computer (C:\\jdk21\\bin\\java.exe).')
    assert.equal(plan.bytes, jdtls.length)
    const nowhere = planned(await planInstall(pinned, context(fakeFetch({ 'https://download.eclipse.org/jdtls/x/jdtls.tar.gz': { body: jdtls } }))))
    assert.match(nowhere.steps[1]!, /^It needs Java 21 or newer to run, and it is not on this computer\. eNCode could not find one to fetch: .*Get it from https:\/\/adoptium\.net\/\.$/)
  })
})

describe('Rust: rust-analyzer without rustup', () => {
  const program = zlib.gzipSync(Buffer.from('ELF rust-analyzer'))
  const asset = 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-19/rust-analyzer-x86_64-unknown-linux-gnu.gz'
  const routes: Record<string, Route> = {
    'https://api.github.com/repos/rust-lang/rust-analyzer/releases/latest': { body: JSON.stringify({ tag_name: '2026-10-19', assets: [{ name: 'rust-analyzer-x86_64-unknown-linux-gnu.gz', size: program.length, browser_download_url: asset, digest: `sha256:${hex('sha256', program)}` }] }) },
    [asset]: { body: program },
  }

  it("takes the server's own build where rustup is not, and starts it", async () => {
    const rust = server('rust')
    const ctx = context(fakeFetch(routes), { platform: 'linux', env: { PATH: '/usr/bin' } })
    const plan = planned(await planInstall(rust, ctx))
    assert.deepEqual(plan.steps.slice(0, 1), ["Rust (rustup) is not on this computer (rustup was not found on the PATH), so eNCode takes the server's own build."])
    assert.match(plan.steps[1]!, /^Downloads rust-analyzer-x86_64-unknown-linux-gnu\.gz \(the newest release, version 2026-10-19, .*\) from github\.com\/rust-lang\/rust-analyzer/)
    assert.equal(plan.steps[2], 'It needs cargo to read a whole Cargo project, which comes with Rust (https://rustup.rs).')
    const installed = await installServer(rust, ctx)
    assert.equal(fs.readFileSync(path.join(installed, 'rust-analyzer'), 'utf8'), 'ELF rust-analyzer')
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(installed, 'rust-analyzer')).mode & 0o111, 0o111)
    const launch = discover(rust, dir, { platform: 'linux', which: () => null, isFile: () => false, tools: { dir: tools, context: ctx } })
    assert.deepEqual(launch, { file: path.join(installed, 'rust-analyzer'), args: [], found: "eNCode's tools folder, 2026-10-19", command: 'rust-analyzer' })
  })

  it('still adds the component through rustup where rustup is', async () => {
    const plan = planned(await planInstall(server('rust'), context(fakeFetch(routes), { which: (name) => (name === 'rustup' ? 'C:\\Users\\a\\.cargo\\bin\\rustup.exe' : null) })))
    assert.equal(plan.steps[0], 'Runs rustup component add rust-analyzer, with Rust (rustup) from C:\\Users\\a\\.cargo\\bin\\rustup.exe.')
  })
})

describe('Go: the toolchain from the Go module proxy', () => {
  const zipUrl = 'https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go1.27.3.windows-amd64.zip'
  const stored = 'https://storage.googleapis.com/proxy-golang-org-prod/373c7bff73643bc9-golang.org:toolchain-v0.0.1-go1.27.3.windows-amd64.zip?Expires=1'
  const fake = makeZip([{ name: 'golang.org/toolchain@v0.0.1-go1.27.3.windows-amd64/bin/go.exe', data: 'MZ go' }])

  it('plans the pinned Go, and refuses a download that does not match it or comes from elsewhere', async () => {
    const go = server('go')
    const plan = planned(await planInstall(go, context(fakeFetch({}))))
    assert.equal(plan.bytes, 76_890_515)
    assert.equal(plan.steps[0], 'Downloads Go 1.27.3 (73.3 MB) from the Go module proxy (proxy.golang.org, where the go command gets its toolchains) and checks it against the sha256 eNCode was built with.')
    assert.equal(plan.steps[1], 'Runs go install golang.org/x/tools/gopls@v0.24.0, with that copy.')
    const runs: Parameters<Run>[] = []
    const run: Run = async (...call) => (runs.push(call), { code: 0, output: '' })
    await assert.rejects(installServer(go, context(fakeFetch({ [zipUrl]: { status: 302, headers: { location: stored } }, [stored]: { body: fake } }), { run })), /go1\.27\.3\.windows-amd64 does not match its checksum/)
    await assert.rejects(installServer(go, context(fakeFetch({ [zipUrl]: { status: 302, headers: { location: 'https://storage.googleapis.com/someone-else/go.zip' } } }), { run })), /does not download from storage\.googleapis\.com/)
    assert.deepEqual(fs.readdirSync(path.join(tools, 'runtimes', 'go')), [])
    assert.equal(runs.length, 0)
  })

  it('uses a Go 1.21 or newer the computer has, since it fetches what gopls asks for itself', async () => {
    const which = (name: string) => (name === 'go' ? 'C:\\Go\\bin\\go.exe' : null)
    const version = (output: string): Run => async (_program, args, options) => {
      assert.deepEqual(args, ['env', 'GOVERSION'])
      assert.equal(options.env.GOTOOLCHAIN, 'local')
      return { code: 0, output }
    }
    const newer = planned(await planInstall(server('go'), context(fakeFetch({}), { which, run: version('go1.22.5\n') })))
    assert.equal(newer.steps[0], 'Runs go install golang.org/x/tools/gopls@v0.24.0, with Go from C:\\Go\\bin\\go.exe.')
    const older = planned(await planInstall(server('go'), context(fakeFetch({}), { which, run: version('go1.20.14\n') })))
    assert.match(older.steps[0]!, /^Downloads Go 1\.27\.3/)
  })
})
