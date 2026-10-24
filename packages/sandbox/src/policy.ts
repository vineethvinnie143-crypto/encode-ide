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
  /** The names of the folders in a folder (not following links); none when it cannot be read. */
  folders?(dir: string): string[]
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
  /**
   * Folders of eNCode's own that commands must not read (its profile): unreadable where the system can hide reads.
   * Writable folders inside one (the sandbox's temp folder) stay usable.
   */
  hidden?: readonly string[]
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

/** More submodules than this in one repository are not looked for, so a crafted tree cannot make every command slow. */
const MAX_SUBMODULES = 64
const MAX_SUBMODULE_DEPTH = 8

/**
 * The git directories of a repository's submodules, nested ones included: `<git dir>/modules/<name>`, where a name may
 * have several parts (`modules/libs/a`). A folder there is one when it holds a HEAD file; others are walked into.
 */
export function submoduleGitDirectories(gitDir: string, io: PolicyIo, platform: NodeJS.Platform): string[] {
  if (!io.folders) return []
  const api = pathApiOf(platform)
  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_SUBMODULE_DEPTH) return
    for (const name of io.folders!(dir)) {
      if (found.length >= MAX_SUBMODULES) return
      const child = api.join(dir, name)
      if (io.stat(api.join(child, 'HEAD')) === 'file') {
        found.push(child)
        visit(api.join(child, 'modules'), depth + 1)
      } else visit(child, depth + 1)
    }
  }
  visit(api.join(gitDir, 'modules'), 0)
  return found
}

/**
 * The folders the repository's configuration says git runs hooks from (`core.hooksPath`), resolved as git does: from
 * the working tree, or from home for `~/`. Husky's `.husky/_` runs the scripts in the folder above it, so that folder
 * is named too.
 */
export function configuredHooks(gitDir: string, root: string, home: string, io: PolicyIo, platform: NodeJS.Platform): string[] {
  const api = pathApiOf(platform)
  const text = io.readText(api.join(gitDir, 'config'))
  if (!text) return []
  let section = ''
  let value: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line)
    if (header) {
      section = header[1].toLowerCase()
      continue
    }
    const entry = section === 'core' ? /^\s*hookspath\s*=\s*(.*?)\s*(?:[#;].*)?$/i.exec(line) : null
    if (entry) value = entry[1].replace(/^"(.*)"$/, '$1')
  }
  if (!value) return []
  const folder = /^~[\\/]/.test(value) ? api.join(home, value.slice(2)) : api.resolve(root, value)
  return api.basename(folder) === '_' ? [folder, api.dirname(folder)] : [folder]
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
      // A submodule's git directory sits in `modules/`: git runs its hooks and reads its configuration the same way.
      for (const module of submoduleGitDirectories(dir, io, platform)) protectedPaths.push(api.join(module, 'hooks'), api.join(module, 'config'), api.join(module, 'config.worktree'))
      // Hooks the configuration places elsewhere (`core.hooksPath`), often in the project itself.
      protectedPaths.push(...configuredHooks(dir, root, home, io, platform))
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
    // eNCode's own folder is no setting's to open.
    for (const folder of input.hidden ?? []) unreadable.push(io.realpath(folder))
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
