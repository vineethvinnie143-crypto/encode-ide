/**
 * The toolchains some language servers need, which eNCode fetches into its own folder when the computer has none
 * (ADR 0114): the .NET SDK for C#'s server, Go for gopls, and a Java runtime for Eclipse's Java server. The person
 * says yes first; nothing is installed for the whole computer, no administrator is asked for, and the PATH is not
 * changed. The copy is for the language server alone: people who build in that language install it themselves, and a
 * new enough one on the computer is always used first.
 *
 * Each comes from its makers, checked against a hash: Go's toolchain from the Go module proxy, at a version and sha256
 * pinned here; the .NET SDK at the newest release of its line, against the SHA-512 Microsoft publishes in its release
 * list; Temurin's Java runtime at the newest release of its line, against the sha256 Eclipse Adoptium publishes.
 */
import path from 'node:path'

export type RuntimeId = 'dotnet' | 'go' | 'java'

export interface RuntimeDownload {
  version: string
  /** The file's name, for people. */
  name: string
  url: string
  algorithm: 'sha256' | 'sha512'
  /** Hex, lower case. */
  digest: string
  /** In bytes, when known before downloading. */
  size?: number
  archive: 'zip' | 'tar'
  /** Leading folders taken off every path. */
  strip?: number
  /** Where it comes from and what it is checked against, for people. */
  from: string
  check: string
}

export interface Runtime {
  id: RuntimeId
  /** For people: "the .NET SDK". */
  label: string
  /** The oldest version the servers that use it take, for people: "10". */
  minimum: string
  /** Where people get the whole toolchain for themselves, and what it is called there: "a JDK such as Eclipse Temurin". */
  site: string
  whole: string
  /** Its program, as found on the PATH. */
  program: string
  /** Its program inside the folder it is unpacked in. */
  bin(platform: NodeJS.Platform): string
  /** The folder its environment names (JAVA_HOME, GOROOT, DOTNET_ROOT), from the folder it is unpacked in. */
  home(dir: string, platform: NodeJS.Platform): string
  /** How a copy on this computer says its version, and whether it is new enough. */
  check: { args: string[]; env?: Record<string, string>; enough(output: string): boolean }
  limits: { maxDownload: number; maxBytes: number; maxFiles: number }
  /** The build for this computer (`win32-x64`), or null when its makers publish none that eNCode can unpack. */
  resolve(key: string, getJson: (url: string) => Promise<unknown>): Promise<RuntimeDownload | null>
  /** What a program that uses eNCode's copy starts with, besides the PATH: its home, and no telemetry. */
  environment(home: string): Record<string, string>
  /**
   * What an installer that runs with eNCode's copy starts with besides: its caches in `work`, a folder removed once
   * the install is done, so that nothing is left in the person's home folder.
   */
  installEnvironment(work: string): Record<string, string>
}

const MB = 1024 * 1024

/** The first whole number in a version (`10.0.402`, `go1.27.3`), and the second for Java's old `1.8`. */
function major(version: string): number {
  const match = /(\d+)(?:\.(\d+))?/.exec(version)
  if (!match) return 0
  const first = Number(match[1])
  return first === 1 && match[2] !== undefined ? Number(match[2]) : first
}

/** Whether the first version in `version` (`go1.24.7`, `10.0.402`) is `minimum` or newer. */
export function versionAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = (/\d+(?:\.\d+)*/.exec(version)?.[0] ?? '').split('.').map(Number)
  for (let index = 0; index < minimum.length; index++) {
    const part = parts[index] ?? 0
    if (part !== minimum[index]) return part > minimum[index]!
  }
  return true
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

// ------------------------------------------------------------------------------------------------------------ .NET SDK

/** The line C#'s server is built for: csharp-ls 0.28 runs on .NET 10 and newer. */
const DOTNET_CHANNEL = '10.0'
const DOTNET_RIDS: Record<string, string> = { 'win32-x64': 'win-x64', 'win32-arm64': 'win-arm64' }

export const DOTNET: Runtime = {
  id: 'dotnet',
  label: 'the .NET SDK',
  minimum: '10',
  site: 'https://dotnet.microsoft.com/download',
  whole: 'the .NET SDK',
  program: 'dotnet',
  bin: (platform) => (platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
  home: (dir) => dir,
  // `dotnet --list-sdks` prints one line per SDK: "10.0.402 [C:\Program Files\dotnet\sdk]".
  check: { args: ['--list-sdks'], env: { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }, enough: (output) => output.split(/\r?\n/).some((line) => /^\d+\.\d+\.\d+/.test(line.trim()) && major(line) >= 10) },
  limits: { maxDownload: 600 * MB, maxBytes: 2048 * MB, maxFiles: 60_000 },
  // Microsoft ships the SDK as a zip for Windows only; elsewhere it is a tarball of a gigabyte unpacked, which
  // eNCode does not hold in memory, so there the person installs it.
  async resolve(key, getJson) {
    const rid = DOTNET_RIDS[key]
    if (!rid) return null
    const list = record(await getJson(`https://builds.dotnet.microsoft.com/dotnet/release-metadata/${DOTNET_CHANNEL}/releases.json`))
    const latest = text(list?.['latest-sdk'])
    if (!list || !latest || !Array.isArray(list.releases)) throw new Error("Microsoft's list of .NET releases could not be read.")
    for (const item of list.releases) {
      const release = record(item)
      const sdks = [release?.sdk, ...(Array.isArray(release?.sdks) ? release.sdks : [])].map(record)
      const sdk = sdks.find((entry) => entry && entry.version === latest)
      if (!sdk || !Array.isArray(sdk.files)) continue
      const file = sdk.files.map(record).find((entry) => entry && entry.rid === rid && text(entry.name)?.endsWith('.zip'))
      const url = text(file?.url)
      const hash = text(file?.hash)
      if (!url || !hash) break
      if (!url.startsWith('https://builds.dotnet.microsoft.com/dotnet/') || !/^[0-9a-f]{128}$/i.test(hash)) throw new Error(`Microsoft's list names a .NET SDK ${latest} download eNCode does not take.`)
      return { version: latest, name: path.posix.basename(new URL(url).pathname), url, algorithm: 'sha512', digest: hash.toLowerCase(), archive: 'zip', from: 'Microsoft (builds.dotnet.microsoft.com)', check: 'the SHA-512 Microsoft publishes for it' }
    }
    throw new Error(`Microsoft's list of .NET releases has no SDK ${latest} for ${rid}.`)
  },
  environment: (home) => ({ DOTNET_ROOT: home, DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false' }),
  installEnvironment: (work) => ({ DOTNET_CLI_HOME: path.join(work, 'home'), NUGET_PACKAGES: path.join(work, 'nuget') }),
}

// ---------------------------------------------------------------------------------------------------------------- Go

/** The Go gopls 0.24 asks for (1.27.0) or newer, as the go command itself fetches toolchains, pinned. */
const GO_VERSION = '1.27.3'
const GO_BUILDS: Record<string, { target: string; sha256: string; size: number }> = {
  'win32-x64': { target: 'windows-amd64', sha256: 'ed8a27b55d5b20235641122b320ded78ea8e9c815eb82b880ca41a67e83e3805', size: 76_890_515 },
  'win32-arm64': { target: 'windows-arm64', sha256: 'fa16225abc45f4d4750acf1d4ba3b26e52cbd3cf3ac7d77875e9dd17e7bf794b', size: 72_993_281 },
  'linux-x64': { target: 'linux-amd64', sha256: 'af4c06478303fdd1bfb335fab86c7ccb9b12e529044a946a16a1c4bcc779f8d7', size: 75_781_305 },
  'linux-arm64': { target: 'linux-arm64', sha256: '0ec0774cad42ecf4df82691146ee0b10c303ea594f163acb1737baedd5cc2835', size: 72_231_413 },
  'darwin-x64': { target: 'darwin-amd64', sha256: 'dc58868b55f2797ea997f3835e242c7c5da22df94f13fb06a79da1bab1cfed08', size: 77_099_468 },
  'darwin-arm64': { target: 'darwin-arm64', sha256: '8a730f886ae5c136fc467bface49a78f332fd5aeae5ad383c1f4f858bc9dd566', size: 73_595_702 },
}

export const GO: Runtime = {
  id: 'go',
  label: 'Go',
  // From Go 1.21 on, the go command fetches the toolchain a module asks for, so an older one installs gopls too.
  minimum: '1.21',
  site: 'https://go.dev/dl/',
  whole: 'Go',
  program: 'go',
  bin: (platform) => (platform === 'win32' ? 'bin/go.exe' : 'bin/go'),
  home: (dir) => dir,
  check: { args: ['env', 'GOVERSION'], env: { GOTOOLCHAIN: 'local' }, enough: (output) => versionAtLeast(output.trim().replace(/^go/, ''), [1, 21]) },
  limits: { maxDownload: 200 * MB, maxBytes: 1024 * MB, maxFiles: 40_000 },
  async resolve(key) {
    const build = GO_BUILDS[key]
    if (!build) return null
    const module = `v0.0.1-go${GO_VERSION}.${build.target}`
    return {
      version: GO_VERSION,
      name: `go${GO_VERSION}.${build.target}`,
      url: `https://proxy.golang.org/golang.org/toolchain/@v/${module}.zip`,
      algorithm: 'sha256',
      digest: build.sha256,
      size: build.size,
      archive: 'zip',
      // `golang.org/toolchain@v0.0.1-go1.27.3.windows-amd64/bin/go.exe`
      strip: 2,
      from: 'the Go module proxy (proxy.golang.org, where the go command gets its toolchains)',
      check: 'the sha256 eNCode was built with',
    }
  },
  environment: (home) => ({ GOROOT: home, GOTELEMETRY: 'off' }),
  installEnvironment: (work) => ({ GOTOOLCHAIN: 'local', GOPATH: path.join(work, 'gopath'), GOMODCACHE: path.join(work, 'mod'), GOCACHE: path.join(work, 'build'), GOFLAGS: '-modcacherw' }),
}

// -------------------------------------------------------------------------------------------------------------- Java

/** Eclipse's Java server runs on Java 21 or newer; the newest long-term release is the one fetched. */
const JAVA_LINE = 25
const ADOPTIUM_OS: Record<string, string> = { win32: 'windows', linux: 'linux', darwin: 'mac' }
const ADOPTIUM_ARCH: Record<string, string> = { x64: 'x64', arm64: 'aarch64' }

export const JAVA: Runtime = {
  id: 'java',
  label: 'Java',
  minimum: '21',
  site: 'https://adoptium.net/',
  whole: 'a JDK such as Eclipse Temurin',
  program: 'java',
  bin: (platform) => (platform === 'win32' ? 'bin/java.exe' : platform === 'darwin' ? 'Contents/Home/bin/java' : 'bin/java'),
  home: (dir, platform) => (platform === 'darwin' ? path.join(dir, 'Contents', 'Home') : dir),
  // `java -version` writes `openjdk version "21.0.4" 2024-07-16` (or `java version "1.8.0_421"`) to stderr.
  check: { args: ['-version'], enough: (output) => major(/version "([^"]+)"/.exec(output)?.[1] ?? '') >= 21 },
  limits: { maxDownload: 200 * MB, maxBytes: 600 * MB, maxFiles: 40_000 },
  async resolve(key, getJson) {
    const [platform, arch] = key.split('-')
    const os = ADOPTIUM_OS[platform ?? '']
    const cpu = ADOPTIUM_ARCH[arch ?? '']
    if (!os || !cpu) return null
    const list = await getJson(`https://api.adoptium.net/v3/assets/latest/${JAVA_LINE}/hotspot?architecture=${cpu}&image_type=jre&os=${os}&vendor=eclipse`)
    const first = record(Array.isArray(list) ? list[0] : null)
    const pack = record(record(first?.binary)?.package)
    const name = text(pack?.name)
    const url = text(pack?.link)
    const checksum = text(pack?.checksum)
    const release = text(first?.release_name)
    if (!first || !name || !url || !checksum || !release) throw new Error("Eclipse Adoptium's list of Java releases could not be read.")
    if (!url.startsWith('https://github.com/adoptium/') || !/^[0-9a-f]{64}$/i.test(checksum) || !/\.(zip|tar\.gz)$/.test(name)) throw new Error(`Eclipse Adoptium names a Java download eNCode does not take (${name}).`)
    return {
      version: release.replace(/^jdk-?/, ''),
      name,
      url,
      algorithm: 'sha256',
      digest: checksum.toLowerCase(),
      ...(typeof pack?.size === 'number' ? { size: pack.size } : {}),
      archive: name.endsWith('.zip') ? 'zip' : 'tar',
      // `jdk-25.0.4.1+1-jre/bin/java.exe`
      strip: 1,
      from: 'Eclipse Adoptium (Temurin, adoptium.net)',
      check: 'the sha256 Eclipse Adoptium publishes for it',
    }
  },
  environment: (home) => ({ JAVA_HOME: home }),
  installEnvironment: () => ({}),
}

export const RUNTIMES: Readonly<Record<RuntimeId, Runtime>> = { dotnet: DOTNET, go: GO, java: JAVA }
