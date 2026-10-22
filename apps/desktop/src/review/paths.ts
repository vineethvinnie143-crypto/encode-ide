/**
 * The review names files by their path in the repository. The editor, the agent's tools and the file tree name them
 * from the open folder, which can be a folder inside the repository (`ReviewRepo.folder` says where), and the agent's
 * tools mostly by absolute path. These turn one into the other.
 */
import type { ReviewRepo } from '@shared/types'

type Place = Pick<ReviewRepo, 'root' | 'folder'>

const isWindowsPath = (value: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(value)
const isAbsolute = (value: string) => value.startsWith('/') || isWindowsPath(value)
const slashes = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

/** The part of `target` below `base`, `/`-separated; null when it is not below it. Windows paths compare without case. */
function below(target: string, base: string): string | null {
  const full = slashes(target)
  const prefix = slashes(base)
  // A repository at the top of the file system.
  if (!prefix) return base.startsWith('/') && full.length > 1 && full.startsWith('/') ? full.slice(1) : null
  if (full.length <= prefix.length || full[prefix.length] !== '/') return null
  const head = full.slice(0, prefix.length)
  const same = isWindowsPath(base) ? head.toLowerCase() === prefix.toLowerCase() : head === prefix
  return same ? full.slice(prefix.length + 1) : null
}

/**
 * How the open folder names a file of the repository, or null when the file is outside that folder. The Turn view
 * names a file outside the workspace by its absolute path, which no folder-relative name reaches.
 */
export function inFolder(repoPath: string, folder: string): string | null {
  if (isAbsolute(repoPath)) return null
  if (!folder) return repoPath
  return repoPath.startsWith(folder) ? repoPath.slice(folder.length) : null
}

/**
 * How the repository names a file the agent's tools or the open folder name: an absolute path, or one relative to the
 * open folder. Null when the file is not in the repository. `workspaceRoot` covers a folder opened through a link,
 * whose absolute paths do not start with the repository's real one.
 */
export function inRepository(target: string, place: Place, workspaceRoot?: string | null): string | null {
  if (isAbsolute(target)) {
    const fromRoot = below(target, place.root)
    if (fromRoot) return fromRoot
    const fromFolder = workspaceRoot ? below(target, workspaceRoot) : null
    return fromFolder ? place.folder + fromFolder : null
  }
  const relative = slashes(target).replace(/^(\.\/)+/, '')
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) return null
  return place.folder + relative
}

/** How to name a file to the agent: from the open folder when it is inside it, otherwise by its absolute path. */
export function forAgent(repoPath: string, place: Place): string {
  if (isAbsolute(repoPath)) return repoPath
  const local = inFolder(repoPath, place.folder)
  if (local !== null) return local
  const separator = isWindowsPath(place.root) ? '\\' : '/'
  return `${place.root.replace(/[\\/]+$/, '')}${separator}${repoPath.split('/').join(separator)}`
}
