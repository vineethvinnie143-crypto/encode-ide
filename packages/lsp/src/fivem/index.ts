/**
 * FiveM's Lua for lua-language-server (ADR 0084). In a folder of FiveM resources (a `fxmanifest.lua` in it, or in a
 * folder it is in), the Lua server is told:
 *
 * - CfxLua's syntax: backtick hashes, `?.`, `local a, b in t`, set constructors, C comments and compound assignment,
 *   through eNCode's plugin (`lua/plugin.lua`) and the server's own `nonstandardSymbol`;
 * - the runtime's globals (`lua/runtime.lua`): threads, events, exports, state bags, vectors, json, msgpack;
 * - the natives, once the person installs them: written from Cfx.re's own typings (`natives.ts`);
 * - the resources the manifests import from (`@ox_lib/init.lua`), when they are outside the folder, as libraries.
 *
 * The plugin and the definitions are eNCode's, written to eNCode's cache folder and checked each time; the plugin is
 * trusted by naming only that file in the server's list of trusted plugins, so a plugin a project names still asks
 * first (and eNCode's client says no).
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LibrarySpec, PrepareContext, Prepared } from '../catalog'
import { installedDir } from '../install'
import { NPM_LOCKS } from '../npm-locks'
import { CFX_PLUGIN, CFX_RUNTIME } from './lua-files'
import { nativesIndex, nativesLibrary, type NativeDoc } from './natives'

export const MANIFESTS = ['fxmanifest.lua', '__resource.lua']

/** CfxLua's additions the server reads itself; the rest are the plugin's. */
export const CFX_SYMBOLS = ['/**/', '`', '+=', '-=', '*=', '/=', '<<=', '>>=', '&=', '|=', '^=']

/** Folders never looked in for resources: a resource's assets, and what tools keep. */
const SKIP = new Set(['node_modules', '.git', 'stream', 'dist', 'build', '.vs', '.vscode', '.idea', 'cache'])
const MAX_ENTRIES = 5_000
const MAX_DEPTH = 4
/** How far up a folder may be inside a resource, or beside the resources it imports from. */
const MAX_PARENTS = 4
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_IMPORTS = 64

export interface FiveMFolder {
  /** Resource folders, absolute: the folder's own (found by a bounded walk), or the one it is inside. */
  resources: string[]
  /** Resources the manifests take files from (`'@ox_lib/init.lua'`), by name. */
  imports: string[]
}

function hasManifest(dir: string): string | null {
  for (const name of MANIFESTS) {
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return path.join(dir, name)
    } catch {
      // Not this one.
    }
  }
  return null
}

function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** `'@ox_lib/init.lua'` and `"@es_extended/imports.lua"` in a manifest: the resources named. */
export function manifestImports(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/['"]@([A-Za-z0-9_.-]+)\/[^'"\r\n]+['"]/g)) {
    if (match[1] !== '.' && match[1] !== '..') names.add(match[1]!)
    if (names.size >= MAX_IMPORTS) break
  }
  return [...names]
}

/** The resources of a folder, or null when it holds none and is inside none. */
export function findResources(root: string): FiveMFolder | null {
  const resources: string[] = []
  let seen = 0
  let level = [root]
  for (let depth = 0; depth <= MAX_DEPTH && level.length && seen < MAX_ENTRIES; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (hasManifest(dir)) {
        // A resource's own folders hold its scripts, not more resources.
        resources.push(dir)
        continue
      }
      for (const name of readDirs(dir)) {
        if (SKIP.has(name.toLowerCase()) || name.startsWith('.')) continue
        if (++seen > MAX_ENTRIES) break
        next.push(path.join(dir, name))
      }
    }
    level = next
  }
  if (!resources.length) {
    let dir = root
    for (let up = 0; up < MAX_PARENTS; up++) {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
      if (hasManifest(dir)) {
        resources.push(dir)
        break
      }
    }
  }
  if (!resources.length) return null
  const imports = new Set<string>()
  for (const dir of resources) {
    const manifest = hasManifest(dir)
    if (!manifest) continue
    try {
      if (fs.statSync(manifest).size > MAX_MANIFEST_BYTES) continue
      for (const name of manifestImports(fs.readFileSync(manifest, 'utf8'))) imports.add(name)
    } catch {
      // Unreadable: nothing imported.
    }
  }
  return { resources, imports: [...imports].slice(0, MAX_IMPORTS) }
}

/**
 * Where the resources a folder imports from are, when they are outside it: beside it, or in a `[category]` folder
 * beside it or a folder above, as a server keeps them (`resources/[ox]/ox_lib`).
 */
export function importedResources(root: string, folder: FiveMFolder): string[] {
  const inside = new Set(folder.resources.map((dir) => path.basename(dir).toLowerCase()))
  const wanted = folder.imports.filter((name) => !inside.has(name.toLowerCase()))
  if (!wanted.length) return []
  const found = new Map<string, string>()
  let dir = root
  for (let up = 0; up < MAX_PARENTS && found.size < wanted.length; up++) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    // The folder itself, and its `[category]` folders two deep.
    const places = [dir]
    for (const name of readDirs(dir)) {
      if (!/^\[.*\]$/.test(name)) continue
      const category = path.join(dir, name)
      places.push(category)
      for (const inner of readDirs(category)) if (/^\[.*\]$/.test(inner)) places.push(path.join(category, inner))
    }
    for (const place of places) {
      for (const name of wanted) {
        if (found.has(name)) continue
        const candidate = path.join(place, name)
        if (hasManifest(candidate) && !isInside(candidate, root)) found.set(name, candidate)
      }
    }
  }
  return wanted.map((name) => found.get(name)).filter((dir): dir is string => Boolean(dir))
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** A path as lua-language-server writes it after its own normalizing, so the list of trusted plugins matches. */
export function serverPath(file: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? file.replace(/[\\/]+/g, '\\') : file.replace(/\/+/g, '/')
}

function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temp, text)
  try {
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function sameText(file: string, text: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

export interface CfxSupport {
  plugin: string
  /** The folder of the runtime's definitions. */
  runtime: string
  /** The server's log folder, which holds its list of trusted plugins. */
  log: string
}

/**
 * Writes the plugin and the runtime's definitions to eNCode's cache folder, in a folder named by their hash, and
 * checks them each time: a file that changed there is written again.
 */
export function writeCfxSupport(cacheDir: string, platform: NodeJS.Platform): CfxSupport {
  const base = path.join(cacheDir, 'lua')
  const hash = createHash('sha256').update(CFX_PLUGIN).update('\0').update(CFX_RUNTIME).digest('hex').slice(0, 12)
  const dir = path.join(base, `cfx-${hash}`)
  const plugin = path.join(dir, 'plugin.lua')
  const runtime = path.join(dir, 'runtime')
  const definitions = path.join(runtime, 'cfx-runtime.lua')
  fs.mkdirSync(runtime, { recursive: true })
  if (!sameText(plugin, CFX_PLUGIN)) writeAtomic(plugin, CFX_PLUGIN)
  if (!sameText(definitions, CFX_RUNTIME)) writeAtomic(definitions, CFX_RUNTIME)
  // Only eNCode's file: the server adds to this list only when its client says yes, which eNCode's never does.
  const log = path.join(base, 'log')
  fs.mkdirSync(log, { recursive: true })
  const trusted = `${serverPath(plugin, platform)}\n`
  if (!sameText(path.join(log, 'trusted'), trusted)) writeAtomic(path.join(log, 'trusted'), trusted)
  // What an older eNCode wrote goes; one a running server still reads goes next time.
  for (const entry of readDirs(base)) {
    if (!entry.startsWith('cfx-') || entry === `cfx-${hash}`) continue
    try {
      fs.rmSync(path.join(base, entry), { recursive: true, force: true })
    } catch {
      // In use.
    }
  }
  return { plugin, runtime, log }
}

/** What lua-language-server is told in a folder of FiveM resources, or null elsewhere. */
export function prepareLua(context: PrepareContext): Prepared | null {
  const folder = findResources(context.root)
  if (!folder) return null
  const library: string[] = []
  const runtime: Record<string, unknown> = { version: 'Lua 5.4', nonstandardSymbol: [...CFX_SYMBOLS] }
  const args: string[] = []
  if (context.tools) {
    const support = writeCfxSupport(context.tools.cacheDir, context.platform)
    runtime.plugin = support.plugin
    library.push(support.runtime)
    args.push(`--logpath=${support.log}`)
    const natives = installedDir(FIVEM_NATIVES, context.tools.dir)
    if (natives) library.push(path.join(natives.dir, 'library'))
  }
  library.push(...importedResources(context.root, folder))
  return { settings: { Lua: { runtime, workspace: { library, checkThirdParty: false } } }, args }
}

/** Writes the natives' definitions from Cfx.re's typings, unpacked under `dir/node_modules`, then drops the typings. */
function buildNatives(dir: string): void {
  const read = (name: string, file: string) => fs.readFileSync(path.join(dir, 'node_modules', '@citizenfx', name, file), 'utf8')
  const version = NPM_LOCKS.fivem?.packages['@citizenfx/client'] ?? ''
  const files = nativesLibrary(read('client', 'natives_universal.d.ts'), read('server', 'natives_server.d.ts'), `@citizenfx/client and @citizenfx/server ${version}`.trim())
  if (!files.length) throw new Error('the typings declare no natives')
  const out = path.join(dir, 'library')
  fs.mkdirSync(out)
  for (const file of files) fs.writeFileSync(path.join(out, file.name), file.text, { flag: 'wx' })
  // The same natives for the agent's lookups (CodeMap, ADR 0091).
  fs.writeFileSync(path.join(dir, NATIVES_INDEX), JSON.stringify(nativesIndex(read('client', 'natives_universal.d.ts'), read('server', 'natives_server.d.ts'))), { flag: 'wx' })
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })
}

/** The natives for the agent's lookups, beside the library. */
const NATIVES_INDEX = 'natives.json'
const MAX_INDEX_BYTES = 64_000_000
let nativesCache: { file: string; mtimeMs: number; natives: NativeDoc[] } | undefined

/**
 * FiveM's natives as eNCode installed them, for the agent's lookups; undefined when they are not installed, or were
 * installed by an eNCode that wrote no index (installing them again writes it). Read once, and again when it changes.
 */
export function installedNatives(toolsDir: string): NativeDoc[] | undefined {
  const installed = installedDir(FIVEM_NATIVES, toolsDir)
  if (!installed) return undefined
  const file = path.join(installed.dir, NATIVES_INDEX)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return undefined
    if (nativesCache?.file === file && nativesCache.mtimeMs === stat.mtimeMs) return nativesCache.natives
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return undefined
    const natives = parsed.filter((entry): entry is NativeDoc => Boolean(entry) && typeof entry.name === 'string' && Array.isArray(entry.params) && Array.isArray(entry.returns) && Array.isArray(entry.doc))
    nativesCache = { file, mtimeMs: stat.mtimeMs, natives }
    return natives
  } catch {
    return undefined
  }
}

export const FIVEM_NATIVES: LibrarySpec = {
  id: 'fivem-natives',
  label: 'FiveM natives',
  what: "FiveM's natives for Lua",
  server: 'lua',
  install: "install them from Settings > Language servers (eNCode writes them from Cfx.re's @citizenfx packages)",
  markers: MANIFESTS,
  installer: { kind: 'library', lock: 'fivem', build: buildNatives, produces: "Lua definitions of FiveM's natives" },
}
