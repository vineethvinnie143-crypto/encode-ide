import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GIT_SAFETY_CONFIG, withGitSafety } from '@encode/permissions'
import type { GitChange, GitStatus } from '../../shared/types'
import { isFile, searchPath } from './programs'
import type { WorkspaceService } from './workspace'

const execFileAsync = promisify(execFile)

/** git by absolute path; a bare `git` could resolve to a git.exe in the app's working directory on Windows. */
let gitPath: string | null = null

function locateGit(): string | null {
  if (!gitPath || !isFile(gitPath)) gitPath = searchPath('git', process.env)
  return gitPath
}

const STATUS_LABEL: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'updated',
  '?': 'untracked',
  '!': 'ignored',
}

/** The same settings as command-line config too: git before 2.31 knows only that. */
const SAFETY_ARGS = GIT_SAFETY_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`])

function definedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

export class GitService {
  constructor(private readonly workspace: WorkspaceService) {}

  async status(): Promise<GitStatus> {
    const root = this.workspace.current?.root
    const git = locateGit()
    if (!root || !git) return { isRepo: false, changes: [] }

    try {
      const { stdout } = await execFileAsync(git, [...SAFETY_ARGS, '-C', root, 'status', '--porcelain=v1', '-b'], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // The settings that stop the repository's config from starting programs, and no index rewrite (which would run its hooks).
        env: withGitSafety(definedEnv(), process.platform === 'win32'),
      })
      return this.parse(stdout)
    } catch {
      return { isRepo: false, changes: [] }
    }
  }

  private parse(output: string): GitStatus {
    const lines = output.split(/\r?\n/)
    const header = lines.find((l) => l.startsWith('## '))
    let branch: string | undefined
    let ahead = 0
    let behind = 0

    if (header) {
      const text = header.slice(3).trim()
      const branchPart = text.split('...')[0]
      branch = branchPart.startsWith('No commits yet on ') ? branchPart.replace('No commits yet on ', '') : branchPart
      const aheadMatch = /ahead (\d+)/.exec(text)
      const behindMatch = /behind (\d+)/.exec(text)
      if (aheadMatch) ahead = Number(aheadMatch[1])
      if (behindMatch) behind = Number(behindMatch[1])
    }

    const changes: GitChange[] = []
    for (const line of lines) {
      if (!line || line.startsWith('## ')) continue
      if (line.length < 4) continue
      const xy = line.slice(0, 2)
      let file = line.slice(3).trim()
      if (file.includes(' -> ')) file = file.split(' -> ').pop() as string
      file = file.replace(/^"|"$/g, '').replace(/\\/g, '/')
      const statusChar = xy.trim()[0] ?? 'M'
      const untracked = xy === '??'
      changes.push({
        path: file,
        status: STATUS_LABEL[statusChar] ?? 'modified',
        staged: !untracked && xy[0] !== ' ' && xy[0] !== '!',
        unstaged: untracked || (xy[1] !== ' ' && xy[1] !== '!'),
      })
    }

    return { isRepo: true, branch, ahead, behind, changes }
  }
}
