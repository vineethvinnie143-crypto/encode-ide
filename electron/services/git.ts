import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitChange, GitStatus } from '../../shared/types'
import type { WorkspaceService } from './workspace'

const execFileAsync = promisify(execFile)

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

export class GitService {
  constructor(private readonly workspace: WorkspaceService) {}

  async status(): Promise<GitStatus> {
    const root = this.workspace.current?.root
    if (!root) return { isRepo: false, changes: [] }

    try {
      const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '-b'], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
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
      changes.push({ path: file, status: STATUS_LABEL[statusChar] ?? 'modified' })
    }

    return { isRepo: true, branch, ahead, behind, changes }
  }
}
