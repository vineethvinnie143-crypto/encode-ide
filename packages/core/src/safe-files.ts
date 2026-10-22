/**
 * Reading files that a repository can fill: agent definitions, skills, instruction files. A repository is
 * somebody else's text, so a file there may be a link to a secret elsewhere on the disk, a named pipe that blocks
 * whoever opens it, or far larger than anything meant to be read. These helpers read a small regular file or
 * nothing, and never open anything that could block.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SmallFileOptions {
  maxBytes: number
  /** Whether a symbolic link to a regular file counts. The user's own folders may use links; a repository's must not. */
  followLinks: boolean
}

/** The text of a regular file of at most `maxBytes`, or null for anything else: a link (unless followed), a pipe, a device, a folder, a big or unreadable file. */
export function readSmallFile(file: string, options: SmallFileOptions): string | null {
  let fd: number | undefined
  try {
    if (!options.followLinks) {
      const link = fs.lstatSync(file)
      if (link.isSymbolicLink() || !link.isFile()) return null
    }
    const { constants } = fs
    // O_NONBLOCK keeps a pipe from holding the open; O_NOFOLLOW closes the gap between the check above and the open.
    fd = fs.openSync(file, constants.O_RDONLY | (options.followLinks ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > options.maxBytes) return null
    return fs.readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Whether `target` lies inside `root` once links are resolved; false when either cannot be resolved. */
export function insideRealSync(root: string, target: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  } catch {
    return false
  }
}

/**
 * Whether a folder a repository fills, `<project>/.encode/<kind>`, stays inside the project once links are resolved.
 * Either `.encode` or the folder itself may be a link that leads anywhere.
 */
export function staysInProject(folder: string): boolean {
  return insideRealSync(path.resolve(folder, '..', '..'), folder)
}

/** Whether `target` is a folder, or a link to one. */
export function isFolderSync(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}
