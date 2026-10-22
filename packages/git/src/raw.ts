/**
 * `git diff --raw -z --no-abbrev`, read: for each changed path its modes and objects on both sides and how it
 * changed. On the working tree's side git names no object (all zeros) when the file has to be read from the disk.
 */

export interface RawEntry {
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
  /** A (added), C (copied), D (deleted), M (modified), R (renamed), T (type changed), U (unmerged), X (unknown). */
  status: string
  /** Similarity of a rename or copy, in percent. */
  score?: number
  path: string
  /** The path a rename or copy came from. */
  oldPath?: string
}

export function parseRaw(output: Buffer | string): RawEntry[] {
  const text = typeof output === 'string' ? output : output.toString('utf8')
  const tokens = text.split('\0')
  const entries: RawEntry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const head = tokens[index]
    if (!head.startsWith(':')) continue
    const [oldMode, newMode, oldOid, newOid, status] = head.slice(1).split(' ')
    if (!status) continue
    const letter = status[0]
    const score = status.length > 1 ? Number(status.slice(1)) : undefined
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index + 1]
      const path = tokens[index + 2]
      index += 2
      if (oldPath === undefined || path === undefined) break
      entries.push({ oldMode, newMode, oldOid, newOid, status: letter, ...(score !== undefined && Number.isFinite(score) ? { score } : {}), path, oldPath })
    } else {
      const path = tokens[index + 1]
      index += 1
      if (path === undefined) break
      entries.push({ oldMode, newMode, oldOid, newOid, status: letter, path })
    }
  }
  return entries
}
