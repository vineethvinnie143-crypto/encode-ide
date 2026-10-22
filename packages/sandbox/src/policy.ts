/**
 * From the session's folders and the settings to the policy an engine enforces. Pure: every look at the file system
 * goes through `io`, so the rules are tested without one.
 */
import path from 'node:path'
import type { EnginePolicy } from './engine'
import { expandPath, type SandboxSettings } from './settings'

export interface PolicyIo {
  /** The real path (links resolved), or the path itself when it cannot be resolved. */
  realpath(file: string): string
  stat(file: string): 'dir' | 'file' | undefined
  readText(file: string): string | undefined
}

export interface PolicyInput {
  platform: NodeJS.Platform
  home: string
  /** The session's folder first, then any extra folders the person allowed edits in. */
  roots: readonly string[]
  settings: SandboxSettings
  /** The sandbox's temp folder. */
  temp: string
  /** Windows: where the redirected package caches live (a folder the sandbox may write). */
  cacheRoot?: string
  env: Readonly<Record<string, string | undefined>>
  io: PolicyIo
}

/** Inside a writable folder and still read-only: what would run outside the sandbox later, or change what may run. */
export const PROTECTED_IN_PROJECT: readonly string[] = ['.git/hooks', '.git/config', '.encode', '.mcp.json']

/** Package caches in the home folder that commands may write (posix systems; they are shared with the person's own tools). */
export const CACHE_DIRS: readonly string[] = [
  '.npm',
  '.cache',
  '.local/share/pnpm',
  '.pnpm-store',
  '.yarn',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg',
  '.gradle',
  '.m2/repository',
  '.nuget/packages',
  '.node-gyp',
  'Library/Caches',
]

/** Folders of credentials: unreadable where the system can hide them, since a command that reads them could send them anywhere. */
export const SECRET_DIRS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.netrc', '.git-credentials', '.config/gh']

/** Variables that carry a way to the person's agents, keyrings and sockets. */
export const UNSET_VARIABLES: readonly string[] = ['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO']

/** Sockets that give the rights of the person's whole account. */
export const SOCKET_FILES: readonly string[] = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock', '/run/containerd/containerd.sock']

function pathApiOf(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? (path.win32 as typeof path.posix) : path.posix
}

function unique(items: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = platform === 'win32' ? item.toLowerCase() : item
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** The git directories of a working tree: `.git` itself, or where its `gitdir:` file points (worktrees, submodules). */
export function gitDirectories(root: string, io: PolicyIo, platform: NodeJS.Platform): string[] {
  const api = pathApiOf(platform)
  const dotGit = api.join(root, '.git')
  const kind = io.stat(dotGit)
  if (kind === 'dir') return [dotGit]
  if (kind !== 'file') return []
  const text = io.readText(dotGit)
  const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null
  if (!match) return []
  const gitDir = io.realpath(api.resolve(root, match[1]))
  const dirs = [gitDir]
  const common = io.readText(api.join(gitDir, 'commondir'))
  if (common?.trim()) dirs.push(io.realpath(api.resolve(gitDir, common.trim())))
  return dirs
}

export function buildPolicy(input: PolicyInput): EnginePolicy {
  const { platform, home, settings, io } = input
  const api = pathApiOf(platform)
  const roots = unique(
    input.roots.map((root) => io.realpath(root)),
    platform,
  )
  const primary = roots[0] ?? home

  const writable: string[] = [...roots]
  const protectedPaths: string[] = []
  for (const root of roots) {
    const gitDirs = gitDirectories(root, io, platform)
    for (const dir of gitDirs) {
      if (!roots.some((other) => isUnder(other, dir, api, platform))) writable.push(dir)
      // `commondir` and `gitdir` say where git finds the shared hooks and configuration: pointing them elsewhere is as good as editing those.
      protectedPaths.push(api.join(dir, 'hooks'), api.join(dir, 'config'), api.join(dir, 'config.worktree'), api.join(dir, 'commondir'), api.join(dir, 'gitdir'))
    }
    // In a worktree or a submodule `.git` is a file that says which git directory the folder belongs to.
    if (io.stat(api.join(root, '.git')) === 'file') protectedPaths.push(api.join(root, '.git'))
    for (const entry of PROTECTED_IN_PROJECT) protectedPaths.push(api.join(root, ...entry.split('/')))
  }
  writable.push(input.temp)

  const env: Record<string, string> = { TMPDIR: input.temp, TEMP: input.temp, TMP: input.temp }
  if (platform === 'win32') {
    if (settings.caches && input.cacheRoot) {
      writable.push(input.cacheRoot)
      const at = (name: string) => api.join(input.cacheRoot!, name)
      const redirects: Record<string, string> = {
        npm_config_cache: at('npm'),
        npm_config_store_dir: at('pnpm-store'),
        YARN_CACHE_FOLDER: at('yarn'),
        PIP_CACHE_DIR: at('pip'),
        UV_CACHE_DIR: at('uv'),
        GOCACHE: at('go-build'),
        COREPACK_HOME: at('corepack'),
        NUGET_PACKAGES: at('nuget'),
        GRADLE_USER_HOME: at('gradle'),
        npm_config_update_notifier: 'false',
      }
      // What the person set themselves stays: it is theirs to have made writable.
      for (const [name, value] of Object.entries(redirects)) if (input.env[name] === undefined) env[name] = value
    }
  } else if (settings.caches) {
    for (const entry of CACHE_DIRS) {
      const dir = api.join(home, ...entry.split('/'))
      if (io.stat(dir) === 'dir') writable.push(io.realpath(dir))
    }
  }
  for (const entry of settings.allowWrite) writable.push(io.realpath(expandPath(entry, primary, home, api)))

  for (const entry of settings.denyWrite) protectedPaths.push(expandPath(entry, primary, home, api))

  const unreadable: string[] = []
  if (platform !== 'win32') {
    const allowed = new Set(settings.allowRead.map((entry) => expandPath(entry, primary, home, api)))
    for (const entry of SECRET_DIRS) {
      const full = api.join(home, ...entry.split('/'))
      if (!allowed.has(full)) unreadable.push(full)
    }
    for (const socket of SOCKET_FILES) if (!allowed.has(socket)) unreadable.push(socket)
    const runtime = input.env.XDG_RUNTIME_DIR
    if (runtime && !allowed.has(runtime)) unreadable.push(runtime)
  }
  for (const entry of settings.denyRead) unreadable.push(expandPath(entry, primary, home, api))

  return {
    writable: unique(writable, platform),
    protected: unique(protectedPaths, platform),
    unreadable: unique(unreadable, platform),
    network: settings.network,
    temp: input.temp,
    env,
    unset: platform === 'win32' ? [] : [...UNSET_VARIABLES],
  }
}

function isUnder(parent: string, child: string, api: typeof path.posix, platform: NodeJS.Platform): boolean {
  const a = platform === 'win32' ? parent.toLowerCase() : parent
  const b = platform === 'win32' ? child.toLowerCase() : child
  const relative = api.relative(a, b)
  return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))
}
