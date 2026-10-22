import fs from 'node:fs/promises'
import path from 'node:path'
import { nodeTrustFs, type TrustFs } from '@encode/config'

/** What the workspace services read and write: settings files, the trust file, and the git exclude file. */
export interface WorkspaceFs extends TrustFs {
  /** Whether the path is a directory; false when it does not exist. */
  isDirectory(target: string): Promise<boolean>
  /** Appends text to a file, creating it and its folders when they are missing. */
  append(file: string, text: string): Promise<void>
}

export const nodeWorkspaceFs: WorkspaceFs = {
  ...nodeTrustFs,
  async isDirectory(target) {
    try {
      return (await fs.stat(target)).isDirectory()
    } catch {
      return false
    }
  },
  async append(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, text, 'utf8')
  },
}
