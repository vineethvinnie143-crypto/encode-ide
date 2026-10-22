import os from 'node:os'
import type { AboutInfo } from '../shared/types'

/** What a build says about itself; written in by scripts/main-build.mjs. */
export interface BuildStamp {
  version: string
  /** 40 hex characters, or empty for a build made outside a checkout. */
  commit: string
  /** The build was made from a working tree with changes in it. */
  dirty: boolean
  builtAt: string
  /** "tester" for the builds that are handed out, "dev" for the rest. */
  channel: string
}

declare const __ENCODE_BUILD__: BuildStamp | undefined

const UNSTAMPED: BuildStamp = { version: '0.0.0', commit: '', dirty: false, builtAt: '', channel: 'dev' }

/** The sources run unbuilt in unit tests, so the stamp may be missing. */
export const BUILD: BuildStamp = typeof __ENCODE_BUILD__ === 'undefined' ? UNSTAMPED : __ENCODE_BUILD__

/** "Windows 11 (10.0.26100)": Windows 10 and 11 both report 10.0, and the build number tells them apart. */
export function describeOs(platform: NodeJS.Platform, release: string): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2])
    const name = Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows 10'
    return `${name} (${release})`
  }
  const name = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
  return `${name} ${release}`
}

export interface AboutEnvironment {
  isPackaged: boolean
  versions: NodeJS.ProcessVersions
  platform: NodeJS.Platform
  arch: string
  release: string
}

export function aboutInfo(env: AboutEnvironment, build: BuildStamp = BUILD): AboutInfo {
  return {
    name: 'eNCode',
    version: build.version,
    commit: build.commit,
    dirty: build.dirty,
    builtAt: build.builtAt,
    channel: build.channel,
    packaged: env.isPackaged,
    platform: env.platform,
    arch: env.arch,
    os: describeOs(env.platform, env.release),
    electron: env.versions.electron ?? '',
    chrome: env.versions.chrome ?? '',
    node: env.versions.node,
  }
}

/** The environment of the running process. */
export function currentEnvironment(isPackaged: boolean): AboutEnvironment {
  return { isPackaged, versions: process.versions, platform: process.platform, arch: process.arch, release: os.release() }
}
