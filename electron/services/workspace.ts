import { shell } from 'electron'
import fssync from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileEntry, OpenWorkspace, ReadFileResult, SearchOptions, SearchResult } from '../../shared/types'
import { matchesAny, parseGlobList } from './glob'

/** Hidden from the explorer and excluded from walking/search. */
const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.cache',
  '.gradle',
  '.svelte-kit',
  'vendor',
  'coverage',
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.wasm', '.class', '.jar', '.pyc', '.o', '.obj', '.lib', '.a', '.bin',
  '.db', '.sqlite', '.sqlite3', '.pack', '.idx', '.lockb',
])

const MAX_READ_BYTES = 12 * 1024 * 1024
const WATCH_IGNORE = /(^|[\\/])(\.git|node_modules)([\\/]|$)/

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192)
  return sample.includes(0)
}

function decodeUtf8(buf: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return ''
  }
}

function validName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name cannot be empty')
  if (/[\\/:*?"<>|]/.test(trimmed)) throw new Error('Name contains invalid characters')
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name')
  return trimmed
}

export class WorkspaceService {
  private root: string | null = null
  private rootReal: string | null = null
  private watcher: fssync.FSWatcher | null = null
  private changeHandler: ((paths: string[]) => void) | null = null
  private pending = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  get current(): OpenWorkspace | null {
    if (!this.root) return null
    return { root: this.root, name: path.basename(this.root) }
  }

  get rootPath(): string | null {
    return this.root
  }

  setChangeHandler(handler: ((paths: string[]) => void) | null): void {
    this.changeHandler = handler
  }

  async open(rootPath: string): Promise<OpenWorkspace> {
    const abs = path.resolve(rootPath)
    const stat = await fs.stat(abs)
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${abs}`)
    this.stopWatch()
    this.root = abs
    this.rootReal = await fs.realpath(abs)
    this.startWatch()
    return this.current as OpenWorkspace
  }

  async close(): Promise<void> {
    this.stopWatch()
    this.root = null
    this.rootReal = null
  }

  resolve(rel = ''): string {
    if (!this.root) throw new Error('No folder is open')
    const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    const abs = path.resolve(this.root, cleaned)
    const relative = path.relative(this.root, abs)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path "${rel}" is outside the workspace`)
    }
    return abs
  }

  /** Resolve symlinks on the nearest existing ancestor and ensure it stays inside the root. */
  private async assertReal(abs: string): Promise<void> {
    if (!this.rootReal) throw new Error('No folder is open')
    let probe = abs
    for (let i = 0; i < 64; i++) {
      try {
        const real = await fs.realpath(probe)
        const relative = path.relative(this.rootReal, real)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Path escapes the workspace through a symlink')
        }
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        const parent = path.dirname(probe)
        if (parent === probe) return
        probe = parent
      }
    }
  }

  toRelative(abs: string): string {
    if (!this.root) return abs
    return path.relative(this.root, abs).replace(/\\/g, '/')
  }

  async list(rel = ''): Promise<FileEntry[]> {
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    const dirents = await fs.readdir(abs, { withFileTypes: true })
    const entries: FileEntry[] = []

    for (const dirent of dirents) {
      if (dirent.name === '.git') continue
      const childAbs = path.join(abs, dirent.name)
      let isDir = dirent.isDirectory()
      let size: number | undefined
      if (dirent.isSymbolicLink()) {
        try {
          const stat = await fs.stat(childAbs)
          isDir = stat.isDirectory()
        } catch {
          continue
        }
      } else if (!dirent.isDirectory()) {
        try {
          size = (await fs.stat(childAbs)).size
        } catch {
          size = undefined
        }
      }
      entries.push({ name: dirent.name, path: this.toRelative(childAbs), isDir, size })
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
    return entries
  }

  async listAll(): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = []
    const limit = 6000
    const stack: string[] = ['']

    while (stack.length && files.length < limit) {
      const relDir = stack.pop() as string
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(this.resolve(relDir), { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        if (dirent.name === '.git') continue
        const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          if (!IGNORED_NAMES.has(dirent.name)) stack.push(relPath)
        } else if (dirent.isFile()) {
          files.push(relPath)
        }
      }
    }

    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    return { files, truncated: files.length >= limit }
  }

  async read(rel: string): Promise<ReadFileResult> {
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) throw new Error('Path is a directory')
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File is too large to open (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    }
    const buf = await fs.readFile(abs)
    const binary = isBinaryBuffer(buf)
    const content = binary ? '' : decodeUtf8(buf)
    return {
      path: this.toRelative(abs),
      content,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      binary: binary || (buf.length > 0 && content === ''),
    }
  }

  async write(rel: string, content: string): Promise<{ size: number }> {
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    return { size: Buffer.byteLength(content, 'utf8') }
  }

  async createFile(parentRel: string, name: string): Promise<FileEntry> {
    const safe = validName(name)
    const rel = parentRel ? `${parentRel}/${safe}` : safe
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    try {
      await fs.stat(abs)
      throw new Error(`"${safe}" already exists`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, '', 'utf8')
    return { name: safe, path: rel, isDir: false, size: 0 }
  }

  async createDir(parentRel: string, name: string): Promise<FileEntry> {
    const safe = validName(name)
    const rel = parentRel ? `${parentRel}/${safe}` : safe
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    await fs.mkdir(abs, { recursive: false })
    return { name: safe, path: rel, isDir: true }
  }

  async rename(rel: string, newName: string): Promise<FileEntry> {
    const safe = validName(newName)
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    if (abs === this.root) throw new Error('Cannot rename the workspace root')
    const target = path.join(path.dirname(abs), safe)
    try {
      await fs.stat(target)
      throw new Error(`"${safe}" already exists`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await fs.rename(abs, target)
    const isDir = (await fs.stat(target)).isDirectory()
    return { name: safe, path: this.toRelative(target), isDir }
  }

  async remove(rel: string): Promise<void> {
    const abs = this.resolve(rel)
    await this.assertReal(abs)
    if (abs === this.root) throw new Error('Cannot delete the workspace root')
    await shell.trashItem(abs)
  }

  async reveal(rel: string): Promise<void> {
    const abs = this.resolve(rel)
    shell.showItemInFolder(abs)
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const query = options.query
    if (!query) return { matches: [], truncated: false, filesSearched: 0 }

    const caseSensitive = Boolean(options.caseSensitive)
    const maxResults = Math.min(2000, Math.max(1, options.maxResults ?? 200))
    const includeRe = parseGlobList(options.include)

    let regex: RegExp
    if (options.regex) {
      regex = new RegExp(query, caseSensitive ? '' : 'i')
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      regex = new RegExp(options.wholeWord ? `\\b${escaped}\\b` : escaped, caseSensitive ? '' : 'i')
    }

    const matches: SearchResult['matches'] = []
    let filesSearched = 0
    let truncated = false
    const stack: string[] = ['']

    outer: while (stack.length) {
      const relDir = stack.pop() as string
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(this.resolve(relDir), { withFileTypes: true })
      } catch {
        continue
      }

      for (const dirent of dirents) {
        if (dirent.name === '.git') continue
        const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name

        if (dirent.isDirectory()) {
          if (!IGNORED_NAMES.has(dirent.name)) stack.push(relPath)
          continue
        }
        if (!dirent.isFile()) continue
        if (!matchesAny(relPath, includeRe)) continue
        if (BINARY_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue

        const abs = this.resolve(relPath)
        let stat: Stats
        try {
          stat = await fs.stat(abs)
        } catch {
          continue
        }
        if (stat.size > 2 * 1024 * 1024) continue

        let text: string
        try {
          text = await fs.readFile(abs, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue
        filesSearched++

        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const index = line.search(regex)
          if (index >= 0) {
            matches.push({
              path: relPath,
              line: i + 1,
              column: index + 1,
              lineText: line.trim().slice(0, 300),
            })
            if (matches.length >= maxResults) {
              truncated = true
              break outer
            }
          }
        }

        if (filesSearched >= 4000) {
          truncated = true
          break outer
        }
      }
    }

    return { matches, truncated, filesSearched }
  }

  private startWatch(): void {
    if (!this.root) return
    try {
      this.watcher = fssync.watch(this.root, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? '').replace(/\\/g, '/')
        if (!rel || WATCH_IGNORE.test(rel)) return
        this.pending.add(rel)
        if (this.flushTimer) clearTimeout(this.flushTimer)
        this.flushTimer = setTimeout(() => {
          const paths = [...this.pending]
          this.pending.clear()
          this.changeHandler?.(paths)
        }, 180)
      })
      this.watcher.on('error', () => this.stopWatch())
    } catch {
      this.watcher = null
    }
  }

  private stopWatch(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending.clear()
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* already closed */
      }
      this.watcher = null
    }
  }
}
