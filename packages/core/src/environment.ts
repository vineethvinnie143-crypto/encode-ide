/**
 * What the agent is told about where it is: the workspace, the platform, the
 * shell, the git branch and the date. Gathered once per session (and again
 * after a compaction, which forgets the first message that carried it).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { messageText, type Message } from '@encode/providers'
import type { AgentShell } from '@encode/tools'
import { WORKSPACE_LINE, type EnvironmentInfo } from './prompt'

const MAX_ENTRIES = 200
const MAX_CLIMB = 8
/** Folders that are noise in a listing of the workspace. */
const HIDDEN = new Set(['.git', 'node_modules'])

/** The local date as YYYY-MM-DD. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function readHead(gitDir: string): Promise<{ branch?: string }> {
  try {
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? { branch: ref[1] } : {}
  } catch {
    return {}
  }
}

/** The repository the workspace is in, if any, and its branch (read from .git/HEAD; no git process). */
export async function gitInfo(root: string): Promise<{ branch?: string } | undefined> {
  let dir = root
  for (let depth = 0; depth <= MAX_CLIMB; depth++) {
    const dotGit = path.join(dir, '.git')
    try {
      const stats = await fs.stat(dotGit)
      if (stats.isDirectory()) return await readHead(dotGit)
      // A worktree or submodule: .git is a file naming the real directory.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))
      if (pointer) return await readHead(path.resolve(dir, pointer[1].trim()))
      return {}
    } catch {
      /* not here: look further up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export async function topLevelEntries(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => !HIDDEN.has(entry.name))
      .map((entry) => ({ name: entry.name + (entry.isDirectory() ? '/' : ''), dir: entry.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export async function gatherEnvironment(root: string, shell: AgentShell, platform: NodeJS.Platform = process.platform): Promise<EnvironmentInfo> {
  const [git, topLevel] = await Promise.all([gitInfo(root), topLevelEntries(root)])
  return {
    root,
    platform,
    arch: os.arch(),
    shell: `${shell.dialect === 'bash' ? 'bash' : 'PowerShell'} (${shell.program}); commands are written for ${shell.dialect === 'bash' ? 'bash' : 'PowerShell'}`,
    cwd: shell.state().cwd,
    date: localDate(),
    ...(git ? { git } : {}),
    topLevel,
  }
}

/** The workspace root the model was last told about, read from its conversation; undefined when it was never told. */
export function toldWorkspaceRoot(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const lines = messageText(messages[i]).split('\n')
    for (let j = lines.length - 1; j >= 0; j--) if (lines[j].startsWith(WORKSPACE_LINE)) return lines[j].slice(WORKSPACE_LINE.length).trim()
  }
  return undefined
}
