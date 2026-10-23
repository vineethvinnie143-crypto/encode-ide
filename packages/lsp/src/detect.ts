/**
 * Which languages a folder uses, by the files in it: how many files each server would cover, and the files that mark
 * a project of its kind (`go.mod`, `fxmanifest.lua`). Read quickly and bounded: folders of packages, builds and
 * caches are not entered, and the walk stops after so many entries or so long, saying it stopped.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { LANGUAGE_SERVERS, type ServerSpec } from './catalog'

export interface LanguageUse {
  /** The server's id. */
  id: string
  files: number
  /** The marker files found, by name, a few at most. */
  markers: string[]
}

export interface FolderLanguages {
  /** Most files first; servers no file needs are left out. */
  used: LanguageUse[]
  /** The walk stopped before it saw everything. */
  partial: boolean
}

/** Folders never entered: packages, builds, caches, version control, virtual environments. */
const SKIPPED = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'coverage',
  'bin',
  'obj',
  '.idea',
  '.gradle',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'cache',
])

export interface DetectOptions {
  catalog?: readonly ServerSpec[]
  maxEntries?: number
  maxDepth?: number
  maxMs?: number
  signal?: AbortSignal
}

function markerMatches(marker: string, name: string): boolean {
  return marker.startsWith('*') ? name.endsWith(marker.slice(1)) : name === marker
}

export async function detectLanguages(root: string, options: DetectOptions = {}): Promise<FolderLanguages> {
  const catalog = options.catalog ?? LANGUAGE_SERVERS
  const maxEntries = options.maxEntries ?? 20_000
  const maxDepth = options.maxDepth ?? 8
  const deadline = Date.now() + (options.maxMs ?? 1_500)
  const byExtension = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const spec of catalog) {
    for (const extension of Object.keys(spec.extensions)) if (!byExtension.has(extension)) byExtension.set(extension, spec.id)
    for (const name of Object.keys(spec.fileNames ?? {})) if (!byName.has(name)) byName.set(name, spec.id)
  }
  const counts = new Map<string, LanguageUse>()
  const use = (id: string): LanguageUse => {
    let found = counts.get(id)
    if (!found) counts.set(id, (found = { id, files: 0, markers: [] }))
    return found
  }
  let entries = 0
  let partial = false
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length && !partial; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (options.signal?.aborted || Date.now() > deadline || entries > maxEntries) {
        partial = true
        break
      }
      let items: import('node:fs').Dirent[]
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const item of items) {
        entries++
        const name = item.name.toLowerCase()
        if (item.isDirectory()) {
          if (!SKIPPED.has(name) && !(name.startsWith('.') && name !== '.github')) next.push(path.join(dir, item.name))
          continue
        }
        if (!item.isFile()) continue
        const id = byName.get(name) ?? byExtension.get(path.extname(name))
        if (id) use(id).files++
        for (const spec of catalog) {
          if (!spec.markers?.some((marker) => markerMatches(marker, name))) continue
          const found = use(spec.id)
          if (found.markers.length < 5 && !found.markers.includes(item.name)) found.markers.push(item.name)
        }
      }
    }
    if (depth === maxDepth && next.length) partial = true
    level = next
  }
  const used = [...counts.values()].filter((item) => item.files > 0).sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
  return { used, partial }
}
