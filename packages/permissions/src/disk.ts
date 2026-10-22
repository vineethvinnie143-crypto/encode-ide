import type { CommandAssessment } from './command-policy'
import { isInside } from './paths'
import type { PathApi } from './shell-grammar'

/**
 * The half of a command verdict the text cannot settle. The shell policies
 * judge a line lexically; before it runs unasked, every path it may read is
 * resolved through links, every program it starts is looked up the way the
 * shell will look it up, and a git command's repository is located. The
 * filesystem is injected so the policy stays testable and free of Electron.
 */
export interface DiskProbe {
  /** Workspace root with links resolved. */
  rootReal: string
  /**
   * Resolves links (and on Windows 8.3 short names) on the longest existing
   * prefix of an absolute path and keeps the rest. Must walk `..` the way the
   * kernel does: from wherever the link before it points.
   */
  realPath(absolute: string): Promise<string>
  /** The files running `program` may start, by absolute path, in lookup order; empty when there are none. */
  locate(program: string): Promise<readonly string[]> | readonly string[]
  /** Whether anything exists at an absolute path. */
  exists(absolute: string): Promise<boolean>
}

function ask(reason: string): CommandAssessment {
  return { decision: 'ask', reason, paths: [], programs: [] }
}

function isGit(program: string): boolean {
  return /^git(\.exe)?$/i.test(program)
}

/**
 * The working tree root git would pick for `dirReal`: the nearest folder,
 * walking up, that holds a `.git` file or folder. Null when there is none.
 */
async function repositoryOf(dirReal: string, probe: DiskProbe, api: PathApi): Promise<string | null> {
  for (let dir = dirReal; ; ) {
    if (await probe.exists(api.join(dir, '.git'))) return dir
    const parent = api.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Finishes an "allow" verdict on the real filesystem. Asks when a path leads
 * outside the workspace through a link, when a program would start from a
 * file inside the workspace (a planted git.exe), or when a git command would
 * use a repository that starts above the workspace (a home folder kept in
 * git, whose history holds files the workspace does not). Any other verdict
 * is returned as it is. Errors from the probe ask too.
 */
export async function confirmOnDisk(
  verdict: CommandAssessment,
  root: string,
  probe: DiskProbe,
  api: PathApi,
): Promise<CommandAssessment> {
  if (verdict.decision !== 'allow') return verdict
  const show = (absolute: string) => api.relative(root, absolute) || '.'
  try {
    for (const target of verdict.paths) {
      if (!isInside(probe.rootReal, await probe.realPath(target), api)) {
        return ask(`reads ${show(target)}, which leads outside the workspace through a link`)
      }
    }
    for (const program of verdict.programs) {
      for (const file of await probe.locate(program)) {
        if (!api.isAbsolute(file) || isInside(probe.rootReal, await probe.realPath(file), api)) {
          return ask(`runs ${program} from inside the workspace (${file})`)
        }
      }
    }
    if (verdict.programs.some(isGit)) {
      for (const cwd of verdict.cwds ?? [root]) {
        const repository = await repositoryOf(await probe.realPath(cwd), probe, api)
        if (repository && !isInside(probe.rootReal, repository, api)) {
          return ask(`runs git in the repository at ${repository}, which starts above the workspace`)
        }
      }
    }
  } catch (error) {
    return ask(`could not be checked on disk (${error instanceof Error ? error.message : String(error)})`)
  }
  return verdict
}
