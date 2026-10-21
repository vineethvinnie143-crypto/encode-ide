/**
 * Project memory: instructions the user keeps in files for the agent.
 *
 * Per directory the first of ENCODE.md, .encode/ENCODE.md, AGENTS.md and
 * CLAUDE.md is read (so a repository that already has one for another tool
 * works as it is), then ENCODE.local.md, the user's private additions. The
 * user's own ~/.encode/ENCODE.md comes first. From the workspace root the
 * search climbs to the repository root, and files are ordered outermost
 * first, so the most specific instructions come last.
 *
 * A line may import another file with `@path`. The imported text follows the
 * file's own, and an import is followed only when it stays inside the
 * workspace (or, for the user's file, their .encode folder): a file in a
 * repository must not be able to pull in files the agent would have to ask
 * about.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isInsideReal, realPathOf, sha256, truncateMiddle } from '@encode/tools'
import { reminder } from './prompt'

export type MemoryScope = 'user' | 'project' | 'local'

export interface MemoryFile {
  /** Absolute path. */
  path: string
  scope: MemoryScope
  /** The file's text with its imports appended, cut to the size limits. */
  content: string
}

export interface MemoryOptions {
  /** The workspace root, as a real path. */
  root: string
  home: string
  /** Where the user's own memory lives. Default `<home>/.encode`. */
  userDir?: string
}

const NAMES = ['ENCODE.md', path.join('.encode', 'ENCODE.md'), 'AGENTS.md', 'CLAUDE.md']
const LOCAL = 'ENCODE.local.md'
export const MAX_FILE_CHARS = 40_000
export const MAX_TOTAL_CHARS = 100_000
const MAX_IMPORT_DEPTH = 4
const MAX_CLIMB = 8
const IMPORT = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])?[\w.\-/\\]+\.(?:md|mdc|txt))(?=$|[\s,.;:)\]])/gm

async function readText(file: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > 2_000_000) return undefined
    return (await fs.readFile(file, 'utf8')).replace(/^﻿/, '')
  } catch {
    return undefined
  }
}

/** The text of `content` outside fenced code blocks. */
function outsideFences(content: string): string {
  let inside = false
  return content
    .split('\n')
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inside = !inside
        return false
      }
      return !inside
    })
    .join('\n')
}

async function withImports(file: string, content: string, allowed: string, home: string, seen: Set<string>, depth: number): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return content
  const imports: string[] = []
  for (const match of outsideFences(content).matchAll(IMPORT)) {
    const raw = match[1]
    const target = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : path.resolve(path.dirname(file), raw)
    if (!imports.includes(target)) imports.push(target)
  }
  let out = content
  for (const target of imports) {
    const real = await realPathOf(target)
    if (seen.has(real)) continue
    if (!(await isInsideReal(allowed, real))) {
      out += `\n\n(Import of ${target} skipped: it is outside ${allowed}.)`
      continue
    }
    const text = await readText(real)
    if (text === undefined) continue
    seen.add(real)
    const nested = await withImports(real, text, allowed, home, seen, depth + 1)
    out += `\n\nImported from ${target}:\n\n${nested.trim()}`
  }
  return out
}

async function load(file: string, scope: MemoryScope, allowed: string, home: string): Promise<MemoryFile | undefined> {
  const text = await readText(file)
  if (text === undefined || !text.trim()) return undefined
  const real = await realPathOf(file)
  const content = await withImports(file, text, allowed, home, new Set([real]), 0)
  return { path: file, scope, content: truncateMiddle(content.trim(), MAX_FILE_CHARS) }
}

async function firstOf(dir: string, names: readonly string[], scope: MemoryScope, allowed: string, home: string): Promise<MemoryFile | undefined> {
  for (const name of names) {
    const found = await load(path.join(dir, name), scope, allowed, home)
    if (found) return found
  }
  return undefined
}

/** The directories to read, outermost first: the repository root down to the workspace root. */
async function projectDirectories(root: string): Promise<string[]> {
  const dirs: string[] = []
  let dir = root
  let repository = false
  for (let level = 0; level <= MAX_CLIMB; level++) {
    dirs.push(dir)
    try {
      await fs.stat(path.join(dir, '.git'))
      repository = true
      break
    } catch {
      /* not the repository root */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Without a repository, only the workspace itself counts: its parents belong to other things.
  return (repository ? dirs : [root]).reverse()
}

export async function loadMemory(options: MemoryOptions): Promise<MemoryFile[]> {
  const files: MemoryFile[] = []
  const userDir = options.userDir ?? path.join(options.home, '.encode')
  const user = await load(path.join(userDir, 'ENCODE.md'), 'user', userDir, options.home)
  if (user) files.push(user)

  const dirs = await projectDirectories(options.root)
  for (const dir of dirs) {
    const project = await firstOf(dir, NAMES, 'project', options.root, options.home)
    if (project) files.push(project)
    const local = await load(path.join(dir, LOCAL), 'local', options.root, options.home)
    if (local) files.push(local)
  }

  // Total limit: the most specific files, which come last, are the ones to keep.
  let total = 0
  const kept: MemoryFile[] = []
  for (const file of files.reverse()) {
    if (total + file.content.length > MAX_TOTAL_CHARS) continue
    total += file.content.length
    kept.push(file)
  }
  return kept.reverse()
}

/** Changes whenever what the agent would be told changes. */
export function memoryFingerprint(files: readonly MemoryFile[]): string {
  return sha256(files.map((file) => `${file.path}\n${file.content}`).join('\n\n'))
}

const SCOPE_LABEL: Record<MemoryScope, string> = {
  user: "the user's own instructions, for every project",
  project: "the project's instructions, kept with its code",
  local: "the user's private instructions for this project, not kept with the code",
}

/** The reminder that hands the files to the model, or undefined when there are none. */
export function renderMemory(files: readonly MemoryFile[], changed = false): string | undefined {
  if (!files.length) return undefined
  const intro = changed
    ? 'The project\'s instruction files changed since you last read them. This is their current content; it replaces what you were told before.'
    : 'Instructions for this project follow. Follow them; where one conflicts with what the user asks in the conversation, the user\'s request wins.'
  const body = files.map((file) => `Contents of ${file.path} (${SCOPE_LABEL[file.scope]}):\n\n${file.content}`)
  return reminder([intro, ...body].join('\n\n'))
}
