/**
 * The project's dependencies as they are installed (ADR 0091): which version of each it would load, and where that
 * code is, so the agent writes against the API it will run with, not the one it remembers. Read from the project's
 * own manifests and what is on disk: `node_modules`, a virtual environment's `site-packages`, Cargo's and Go's module
 * caches, and FiveM's resources. Nothing is fetched and nothing is run.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { findResources, importedResources } from '@encode/lsp'

export type Ecosystem = 'npm' | 'python' | 'cargo' | 'go' | 'fivem'

export interface InstalledPackage {
  ecosystem: Ecosystem
  name: string
  /** The version installed, or the one the lockfile names when it is not installed. */
  version?: string
  /** Where its code is, as a real path; absent when it is not installed. */
  dir?: string
  /** The same folder as the project reaches it (`node_modules/react`), when that is a link to `dir`. */
  link?: string
  /** Declared only for development (devDependencies, dev-dependencies). */
  dev?: boolean
}

export interface PackageEnv {
  home: string
  platform: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  /** The highest folder Node's lookup climbs to: the project's root when `root` is a worktree inside it. */
  top?: string
}

/** Manifests this deep in the folder count as the project's own (a monorepo's `packages/*`). */
const MANIFEST_DEPTH = 2
const MAX_MANIFESTS = 40
const MAX_MANIFEST_BYTES = 1_000_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'out', 'vendor', '.venv', 'venv', '__pycache__', '.encode'])
const VENVS = ['.venv', 'venv', 'env']

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const PYTHON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CRATE_NAME = /^[A-Za-z0-9_-]+$/
const GO_PATH = /^[a-z0-9.-]+(?:\/[\w.~-]+)+$/i
const RESOURCE_NAME = /^[A-Za-z0-9_.-]+$/

async function readText(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file)
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function realDir(dir: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(dir)
    return (await fs.stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

const inside = (dir: string, base: string) => {
  const relative = path.relative(base, dir)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The folders of the project that hold a manifest of `name`: the root first, then a monorepo's packages. */
async function manifestDirs(root: string, names: readonly string[]): Promise<string[]> {
  const found: string[] = []
  let level = [root]
  for (let depth = 0; depth <= MANIFEST_DEPTH && level.length && found.length < MAX_MANIFESTS; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      if (entries.some((entry) => entry.isFile() && names.includes(entry.name))) found.push(dir)
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) next.push(path.join(dir, entry.name))
    }
    level = next.slice(0, 400)
  }
  return found.slice(0, MAX_MANIFESTS)
}

// ---------------------------------------------------------------------------
// npm

/** Where Node would load `name` from, starting at `from` and going up, but never above `root`. */
export async function npmPackage(name: string, from: string, root: string): Promise<InstalledPackage | undefined> {
  if (!NPM_NAME.test(name)) return undefined
  for (let dir = from; inside(dir, root); dir = path.dirname(dir)) {
    const link = path.join(dir, 'node_modules', ...name.split('/'))
    const real = await realDir(link)
    if (real) {
      const manifest = await readJson(path.join(real, 'package.json'))
      if (manifest) return { ecosystem: 'npm', name, ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}), dir: real, ...(real !== link ? { link } : {}) }
    }
    if (dir === root || path.dirname(dir) === dir) break
  }
  return undefined
}

async function npmDependencies(root: string, top = root): Promise<InstalledPackage[]> {
  const out: InstalledPackage[] = []
  const seen = new Set<string>()
  for (const dir of await manifestDirs(root, ['package.json'])) {
    const manifest = await readJson(path.join(dir, 'package.json'))
    if (!manifest) continue
    for (const [field, dev] of [['dependencies', false], ['devDependencies', true]] as const) {
      const deps = manifest[field]
      if (!deps || typeof deps !== 'object') continue
      for (const [name, wanted] of Object.entries(deps as Record<string, unknown>)) {
        // The project's own packages, linked from the workspace, are its code, not a dependency.
        if (seen.has(name) || typeof wanted !== 'string' || wanted.startsWith('workspace:') || wanted.startsWith('file:') || wanted.startsWith('link:')) continue
        seen.add(name)
        const found = await npmPackage(name, dir, inside(root, top) ? top : root)
        out.push(found ? { ...found, ...(dev ? { dev } : {}) } : { ecosystem: 'npm', name, ...(dev ? { dev } : {}) })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Python

const normalizePython = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '_')

/** The `site-packages` folders of the virtual environments in the folder. */
async function sitePackages(root: string, platform: NodeJS.Platform): Promise<string[]> {
  const out: string[] = []
  for (const venv of VENVS) {
    const base = path.join(root, venv)
    if (!(await realDir(base))) continue
    const windows = await realDir(path.join(base, 'Lib', 'site-packages'))
    if (windows) out.push(windows)
    if (platform === 'win32') continue
    try {
      for (const entry of await fs.readdir(path.join(base, 'lib'))) {
        if (!/^python3(?:\.\d+)?$/.test(entry)) continue
        const site = await realDir(path.join(base, 'lib', entry, 'site-packages'))
        if (site) out.push(site)
      }
    } catch {
      // No lib folder.
    }
  }
  return out
}

async function pythonPackage(name: string, root: string, platform: NodeJS.Platform): Promise<InstalledPackage | undefined> {
  if (!PYTHON_NAME.test(name)) return undefined
  const wanted = normalizePython(name)
  for (const site of await sitePackages(root, platform)) {
    let entries: string[]
    try {
      entries = await fs.readdir(site)
    } catch {
      continue
    }
    for (const entry of entries) {
      const match = /^(.+)-([^-]+)\.dist-info$/.exec(entry)
      if (match) {
        if (normalizePython(match[1]!) !== wanted) continue
        const info = path.join(site, entry)
        const version = /^Version:\s*(.+)$/m.exec((await readText(path.join(info, 'METADATA'))) ?? '')?.[1]?.trim() ?? match[2]
        // The import name may differ from the distribution's (PyYAML is `yaml`).
        const top = ((await readText(path.join(info, 'top_level.txt'))) ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z_]\w*$/.test(line))
        for (const candidate of [...top, wanted, name]) {
          const dir = await realDir(path.join(site, candidate))
          if (dir && inside(dir, site)) return { ecosystem: 'python', name, ...(version ? { version } : {}), dir }
          const single = await readText(path.join(site, `${candidate}.py`))
          if (single !== undefined) return { ecosystem: 'python', name, ...(version ? { version } : {}), dir: site }
        }
        return { ecosystem: 'python', name, ...(version ? { version } : {}) }
      }
    }
    // A package installed without metadata, or the import name given.
    if (/^[A-Za-z_]\w*$/.test(name)) {
      const dir = await realDir(path.join(site, name))
      if (dir && inside(dir, site)) return { ecosystem: 'python', name, dir }
    }
  }
  return undefined
}

/** `requests>=2.31; python_version > "3.8"` → requests. */
function requirementName(spec: string): string | undefined {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)
  return match?.[1]
}

async function pythonDependencies(root: string, platform: NodeJS.Platform): Promise<InstalledPackage[]> {
  const names: { name: string; dev: boolean }[] = []
  const add = (name: string | undefined, dev = false) => {
    if (name && !names.some((entry) => normalizePython(entry.name) === normalizePython(name))) names.push({ name, dev })
  }
  for (const dir of await manifestDirs(root, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
    const pyproject = await readText(path.join(dir, 'pyproject.toml'))
    if (pyproject) {
      const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(pyproject)?.[1]
      for (const item of list?.matchAll(/["']([^"']+)["']/g) ?? []) add(requirementName(item[1]!))
      const poetry = /^\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\[)/m.exec(`${pyproject}\n[`)?.[1]
      for (const line of poetry?.split(/\r?\n/) ?? []) {
        const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line.trim())?.[1]
        if (name && name.toLowerCase() !== 'python') add(name)
      }
    }
    for (const [file, dev] of [['requirements.txt', false], ['requirements-dev.txt', true]] as const) {
      const text = await readText(path.join(dir, file))
      for (const line of text?.split(/\r?\n/) ?? []) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue
        add(requirementName(trimmed), dev)
      }
    }
  }
  const out: InstalledPackage[] = []
  for (const { name, dev } of names.slice(0, 200)) {
    const found = await pythonPackage(name, root, platform)
    out.push({ ...(found ?? { ecosystem: 'python', name }), ...(dev ? { dev } : {}) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Cargo

/** The versions Cargo.lock pins, by crate. */
async function cargoLock(root: string): Promise<Map<string, string[]>> {
  const versions = new Map<string, string[]>()
  const text = await readText(path.join(root, 'Cargo.lock'))
  for (const block of text?.split(/^\[\[package\]\]\s*$/m) ?? []) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    if (!name || !version) continue
    versions.set(name, [...(versions.get(name) ?? []), version])
  }
  return versions
}

async function cargoSource(name: string, version: string, env: PackageEnv): Promise<string | undefined> {
  const home = env.env?.CARGO_HOME || path.join(env.home, '.cargo')
  const registry = path.join(home, 'registry', 'src')
  let indexes: string[]
  try {
    indexes = await fs.readdir(registry)
  } catch {
    return undefined
  }
  for (const index of indexes) {
    const dir = await realDir(path.join(registry, index, `${name}-${version}`))
    if (dir) return dir
  }
  return undefined
}

async function cargoPackage(name: string, root: string, env: PackageEnv, lock?: Map<string, string[]>): Promise<InstalledPackage | undefined> {
  if (!CRATE_NAME.test(name)) return undefined
  const versions = (lock ?? (await cargoLock(root))).get(name) ?? (lock ?? (await cargoLock(root))).get(name.replace(/-/g, '_')) ?? []
  // The newest the lockfile names, when it names more than one.
  const version = [...versions].sort(compareVersions).pop()
  if (!version) return undefined
  const dir = await cargoSource(name, version, env)
  return { ecosystem: 'cargo', name, version, ...(dir ? { dir } : {}) }
}

async function cargoDependencies(root: string, env: PackageEnv): Promise<InstalledPackage[]> {
  const lock = await cargoLock(root)
  const out: InstalledPackage[] = []
  const seen = new Set<string>()
  for (const dir of await manifestDirs(root, ['Cargo.toml'])) {
    const text = await readText(path.join(dir, 'Cargo.toml'))
    if (!text) continue
    let section = ''
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      const header = /^\[([^\]]+)\]$/.exec(line)?.[1]
      if (header) {
        section = header
        // `[dependencies.serde]`
        const named = /^(?:dev-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(header)?.[1]
        if (named && !seen.has(named)) {
          seen.add(named)
          const found = await cargoPackage(named, root, env, lock)
          out.push({ ...(found ?? { ecosystem: 'cargo', name: named }), ...(header.startsWith('dev-') ? { dev: true } : {}) })
        }
        continue
      }
      if (section !== 'dependencies' && section !== 'dev-dependencies' && section !== 'workspace.dependencies') continue
      const name = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
      if (!name || seen.has(name)) continue
      seen.add(name)
      // `serde_json = { package = "serde-json", ... }` names another crate.
      const renamed = /package\s*=\s*"([A-Za-z0-9_-]+)"/.exec(line)?.[1]
      const found = await cargoPackage(renamed ?? name, root, env, lock)
      out.push({ ...(found ?? { ecosystem: 'cargo', name: renamed ?? name }), ...(section === 'dev-dependencies' ? { dev: true } : {}) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Go

/** The modules go.mod requires, with their versions. */
async function goRequires(root: string): Promise<Map<string, string>> {
  const requires = new Map<string, string>()
  const text = await readText(path.join(root, 'go.mod'))
  if (!text) return requires
  const add = (line: string) => {
    const match = /^([^\s]+)\s+(v[^\s]+)/.exec(line.replace(/\/\/.*$/, '').trim())
    if (match && GO_PATH.test(match[1]!)) requires.set(match[1]!, match[2]!)
  }
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) for (const line of block[1]!.split(/\r?\n/)) add(line)
  for (const line of text.matchAll(/^require\s+([^\s(][^\r\n]*)$/gm)) add(line[1]!)
  return requires
}

/** The module cache spells capitals as `!` and the letter. */
const escapeGo = (modulePath: string) => modulePath.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)

async function goModule(modulePath: string, version: string, env: PackageEnv): Promise<string | undefined> {
  const cache = env.env?.GOMODCACHE || path.join(env.env?.GOPATH?.split(path.delimiter)[0] || path.join(env.home, 'go'), 'pkg', 'mod')
  return realDir(path.join(cache, ...`${escapeGo(modulePath)}@${version}`.split('/')))
}

async function goPackage(name: string, root: string, env: PackageEnv): Promise<InstalledPackage | undefined> {
  if (!GO_PATH.test(name) || name.split('/').includes('..')) return undefined
  const requires = await goRequires(root)
  // A package of a module: the module that is the longest start of its path.
  const module = [...requires.keys()].filter((entry) => name === entry || name.startsWith(`${entry}/`)).sort((a, b) => b.length - a.length)[0]
  if (!module) return undefined
  const version = requires.get(module)!
  const base = await goModule(module, version, env)
  const dir = base && name !== module ? await realDir(path.join(base, ...name.slice(module.length + 1).split('/'))) : base
  return { ecosystem: 'go', name, version, ...(dir && base && inside(dir, base) ? { dir } : {}) }
}

async function goDependencies(root: string, env: PackageEnv): Promise<InstalledPackage[]> {
  const out: InstalledPackage[] = []
  for (const [module, version] of await goRequires(root)) {
    const dir = await goModule(module, version, env)
    out.push({ ecosystem: 'go', name: module, version, ...(dir ? { dir } : {}) })
  }
  return out
}

// ---------------------------------------------------------------------------
// FiveM

/** The resources the folder's resources import or depend on (ox_lib, qb-core), with the version their manifest gives. */
async function fivemDependencies(root: string): Promise<InstalledPackage[]> {
  const folder = findResources(root)
  if (!folder) return []
  const names = new Set(folder.imports)
  for (const dir of folder.resources.slice(0, 500)) {
    const manifest = (await readText(path.join(dir, 'fxmanifest.lua'))) ?? (await readText(path.join(dir, '__resource.lua')))
    if (!manifest) continue
    for (const block of manifest.matchAll(/\bdependenc(?:y|ies)\s*\{([^}]*)\}/g)) for (const item of block[1]!.matchAll(/['"]([A-Za-z0-9_.-]+)['"]/g)) names.add(item[1]!)
    for (const item of manifest.matchAll(/\bdependency\s*['"]([A-Za-z0-9_.-]+)['"]/g)) names.add(item[1]!)
  }
  // Builds of the server, not resources.
  for (const name of [...names]) if (/^\/?(?:server|onesync|gameBuild)/i.test(name)) names.delete(name)
  const byName = new Map(folder.resources.map((dir) => [path.basename(dir).toLowerCase(), dir]))
  for (const dir of importedResources(root, folder)) byName.set(path.basename(dir).toLowerCase(), dir)
  const out: InstalledPackage[] = []
  for (const name of [...names].slice(0, 60)) {
    const dir = byName.get(name.toLowerCase())
    const manifest = dir ? ((await readText(path.join(dir, 'fxmanifest.lua'))) ?? '') : ''
    const version = /^\s*version\s*['"]([^'"\r\n]{1,40})['"]/m.exec(manifest)?.[1]
    out.push({ ecosystem: 'fivem', name, ...(version ? { version } : {}), ...(dir ? { dir: (await realDir(dir)) ?? dir } : {}) })
  }
  return out
}

async function fivemPackage(name: string, root: string): Promise<InstalledPackage | undefined> {
  if (!RESOURCE_NAME.test(name)) return undefined
  return (await fivemDependencies(root)).find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.dir)
}

// ---------------------------------------------------------------------------

/** The project's direct dependencies in every ecosystem it uses, with what is installed. */
export async function projectPackages(root: string, env: PackageEnv): Promise<InstalledPackage[]> {
  const groups = await Promise.all([npmDependencies(root, env.top), pythonDependencies(root, env.platform), cargoDependencies(root, env), goDependencies(root, env), fivemDependencies(root)].map((work) => work.catch(() => [] as InstalledPackage[])))
  return groups.flat()
}

/** One package by name, as the project would load it: npm, then Python, Cargo, Go and FiveM's resources. */
export async function findPackage(root: string, from: string, name: string, env: PackageEnv): Promise<InstalledPackage | undefined> {
  const trimmed = name.trim()
  const tries = [
    () => npmPackage(trimmed, inside(from, root) ? from : root, root),
    () => pythonPackage(trimmed, root, env.platform),
    () => cargoPackage(trimmed, root, env),
    () => goPackage(trimmed, root, env),
    () => fivemPackage(trimmed, root),
  ]
  let declared: InstalledPackage | undefined
  for (const attempt of tries) {
    const found = await attempt().catch(() => undefined)
    if (found?.dir) return found
    declared ??= found
  }
  // Named in a manifest but not installed: say so, rather than that it is unknown.
  return declared ?? (await projectPackages(root, env).catch(() => [])).find((entry) => entry.name === trimmed)
}

/** `1.10.0` after `1.9.3`; pre-releases and odd strings compare as text after the numbers. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^v/, '').split(/[.+-]/)
  const x = parts(a)
  const y = parts(b)
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const p = x[index] ?? ''
    const q = y[index] ?? ''
    const n = Number(p)
    const m = Number(q)
    if (p !== '' && q !== '' && Number.isFinite(n) && Number.isFinite(m)) {
      if (n !== m) return n - m
    } else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** The dependencies in a line or two: `react 18.3.1, zustand 5.0.2, …`, the project's own first, development last. */
export function renderPackages(packages: readonly InstalledPackage[], maxChars: number): string {
  const labels: Record<Ecosystem, string> = { npm: 'npm', python: 'Python', cargo: 'Rust', go: 'Go', fivem: 'FiveM resources' }
  const lines: string[] = []
  let length = 0
  for (const ecosystem of Object.keys(labels) as Ecosystem[]) {
    // `@types/x` says the version of x's types, which the agent reads with x.
    const group = packages.filter((entry) => entry.ecosystem === ecosystem && !entry.name.startsWith('@types/')).sort((a, b) => Number(a.dev ?? false) - Number(b.dev ?? false))
    if (!group.length) continue
    const items = group.map((entry) => `${entry.name} ${entry.version ?? (ecosystem === 'fivem' ? '(no version)' : 'not installed')}`)
    let line = `${labels[ecosystem]}: `
    let shown = 0
    for (const item of items) {
      const next = `${shown ? ', ' : ''}${item}`
      if (length + line.length + next.length + 20 > maxChars) break
      line += next
      shown++
    }
    if (!shown) break
    if (shown < items.length) line += `, and ${items.length - shown} more`
    lines.push(line)
    length += line.length + 1
  }
  return lines.join('\n')
}
