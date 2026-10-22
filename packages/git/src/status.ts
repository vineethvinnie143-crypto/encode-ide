/**
 * `git status --porcelain=v2 --branch -z`, read: the branch and each changed path with its state in the index and in
 * the working tree, and the objects HEAD and the index hold for it. Paths are NUL-terminated, so none is quoted.
 */

export interface StatusBranch {
  /** The commit HEAD points at; null in a repository without commits. */
  oid: string | null
  /** The branch checked out; null when HEAD is detached. */
  head: string | null
  upstream?: string
  ahead?: number
  behind?: number
}

export interface StatusEntry {
  type: 'ordinary' | 'renamed' | 'unmerged' | 'untracked'
  /** The index against HEAD: `.` unchanged, or M T A D R C U. */
  x: string
  /** The working tree against the index. */
  y: string
  path: string
  /** For a rename or copy staged in the index: the path it came from. */
  origPath?: string
  submodule: boolean
  /** File modes in HEAD, the index and the working tree (`000000` where there is none). */
  modes?: { head: string; index: string; worktree: string }
  /** Objects in HEAD and the index (all zeros where there is none). For an unmerged path: our side (stage 2). */
  oids?: { head: string; index: string }
}

export interface Status {
  branch: StatusBranch
  entries: StatusEntry[]
}

/** Splits off `count` space-separated fields; the rest of the line (a path, which may hold spaces) comes last. */
function fields(line: string, count: number): string[] | null {
  const out: string[] = []
  let at = 0
  for (let index = 0; index < count; index++) {
    const space = line.indexOf(' ', at)
    if (space < 0) return null
    out.push(line.slice(at, space))
    at = space + 1
  }
  out.push(line.slice(at))
  return out
}

export function parseStatus(output: Buffer | string): Status {
  const text = typeof output === 'string' ? output : output.toString('utf8')
  const tokens = text.split('\0')
  const branch: StatusBranch = { oid: null, head: null }
  const entries: StatusEntry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = fields(token, 8)
      if (!parts) continue
      const [, xy, sub, mH, mI, mW, hH, hI, path] = parts
      entries.push({ type: 'ordinary', x: xy[0], y: xy[1], path, submodule: sub[0] === 'S', modes: { head: mH, index: mI, worktree: mW }, oids: { head: hH, index: hI } })
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next token
      const parts = fields(token, 9)
      if (!parts) continue
      const [, xy, sub, mH, mI, mW, hH, hI, , path] = parts
      const origPath = tokens[index + 1] ?? ''
      index++
      entries.push({ type: 'renamed', x: xy[0], y: xy[1], path, origPath, submodule: sub[0] === 'S', modes: { head: mH, index: mI, worktree: mW }, oids: { head: hH, index: hI } })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = fields(token, 10)
      if (!parts) continue
      const [, xy, sub, m1, m2, , mW, , h2, , path] = parts
      entries.push({ type: 'unmerged', x: xy[0], y: xy[1], path, submodule: sub[0] === 'S', modes: { head: m1, index: m2, worktree: mW }, oids: { head: h2, index: h2 } })
    } else if (kind === '?') {
      entries.push({ type: 'untracked', x: '?', y: '?', path: token.slice(2), submodule: false })
    }
    // `!` (ignored) is never asked for.
  }
  return { branch, entries }
}

/** Whether an object name is the null object: no file on that side. */
export function isNullOid(oid: string | undefined): boolean {
  return !oid || /^0+$/.test(oid)
}
