import path from 'node:path'
import { sha256 } from './blobs'
import { parseManifest, pathKeyOf } from './manifest'
import type { CheckpointFs, Hash } from './types'

/**
 * The store on disk, one folder per workspace under a base the host picks
 * (for example `~/.encode/checkpoints`):
 *
 *   <base>/<workspace id>/blobs/<aa>/<sha256>     file contents, gzip, shared by all sessions
 *   <base>/<workspace id>/sessions/<session>.jsonl  the manifest of one session
 *
 * The workspace id is a hash of the workspace's real path, so the store holds
 * no readable paths in its own names.
 */
export function checkpointDir(base: string, rootReal: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === 'win32'
  const api = windows ? path.win32 : path.posix
  return api.join(base, sha256(Buffer.from(pathKeyOf(windows)(rootReal), 'utf8')).slice(0, 24))
}

export interface PruneOptions {
  /** Sessions whose manifest has not changed for this long are forgotten. */
  maxAgeMs: number
  now?: number
  /**
   * Blobs younger than this are kept even when no manifest names them yet: a
   * snapshot writes its blob before its line, and another window may be
   * halfway through doing that.
   */
  graceMs?: number
  platform?: NodeJS.Platform
}

export interface PruneResult {
  sessions: number
  blobs: number
  bytes: number
}

/** Forgets old sessions, then deletes the blobs no remaining session refers to. */
export async function pruneStore(fs: CheckpointFs, dir: string, options: PruneOptions): Promise<PruneResult> {
  const api = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? 60 * 60 * 1000
  const result: PruneResult = { sessions: 0, blobs: 0, bytes: 0 }
  const referenced = new Set<Hash>()
  let complete = true

  const sessions = api.join(dir, 'sessions')
  for (const entry of await fs.list(sessions)) {
    if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue
    const file = api.join(sessions, entry.name)
    if (now - entry.mtimeMs > options.maxAgeMs) {
      await fs.remove(file)
      result.sessions++
      continue
    }
    try {
      const bytes = await fs.read(file)
      if (!bytes) continue
      for (const item of parseManifest(bytes.toString('utf8')).entries) {
        if (item.t === 'snap' && item.hash && item.stored) referenced.add(item.hash)
        else if (item.t === 'rewind') for (const f of item.files) if (f.before && f.stored) referenced.add(f.before)
      }
    } catch {
      complete = false
    }
  }
  // A manifest that could not be read may still need blobs that look unused: delete none.
  if (!complete) return result

  const blobs = api.join(dir, 'blobs')
  for (const group of await fs.list(blobs)) {
    if (group.isFile) continue
    const folder = api.join(blobs, group.name)
    for (const blob of await fs.list(folder)) {
      if (!blob.isFile || referenced.has(blob.name) || now - blob.mtimeMs < grace) continue
      await fs.remove(api.join(folder, blob.name))
      result.blobs++
      result.bytes += blob.size
    }
  }
  return result
}
