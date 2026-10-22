/**
 * Reading many objects with one git: `cat-file --batch-check` for their sizes, then `--batch` for those small enough
 * to show. Each object comes back as bytes; nothing is written to the disk.
 */
import type { GitRunner } from './runner'

export interface ObjectInfo {
  type: string
  size: number
}

/** Sizes and types of objects; a missing object is left out. */
export async function objectInfo(runner: GitRunner, oids: readonly string[]): Promise<Map<string, ObjectInfo>> {
  const out = new Map<string, ObjectInfo>()
  const unique = [...new Set(oids)]
  if (!unique.length) return out
  const text = (await runner.ok(['cat-file', '--batch-check'], { input: unique.join('\n') + '\n' })).toString('utf8')
  for (const line of text.split('\n')) {
    const [oid, type, size] = line.trim().split(' ')
    if (!oid || !type || type === 'missing' || size === undefined) continue
    out.set(oid, { type, size: Number(size) })
  }
  return out
}

/** The bytes of objects; ones that are missing are left out. */
export async function readObjects(runner: GitRunner, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const unique = [...new Set(oids)]
  if (!unique.length) return out
  const data = await runner.ok(['cat-file', '--batch'], { input: unique.join('\n') + '\n' })
  let at = 0
  while (at < data.length) {
    const newline = data.indexOf(0x0a, at)
    if (newline < 0) break
    const header = data.subarray(at, newline).toString('utf8').split(' ')
    at = newline + 1
    if (header[1] === 'missing' || header.length < 3) continue
    const size = Number(header[2])
    if (!Number.isFinite(size) || at + size > data.length) break
    out.set(header[0], data.subarray(at, at + size))
    // Each object's bytes are followed by a line break.
    at += size + 1
  }
  return out
}
