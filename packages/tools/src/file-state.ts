/**
 * What the agent has read, so it never overwrites a file it has not seen or
 * one that changed since it looked. Keys are case-insensitive on Windows.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './text'
import type { FileState, FileStateTracker } from './types'

export function createFileStateTracker(platform: NodeJS.Platform = process.platform): FileStateTracker {
  const states = new Map<string, { path: string; state: FileState }>()
  const key = (file: string) => {
    const normalized = (platform === 'win32' ? path.win32 : path.posix).normalize(file)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return {
    get: (file) => states.get(key(file))?.state,
    set: (file, state) => void states.set(key(file), { path: file, state }),
    delete: (file) => void states.delete(key(file)),
    entries: () => [...states.values()].map(({ path: file, state }) => [file, state]),
  }
}

export function stateOf(bytes: Uint8Array, stats: { mtimeMs: number; size: number }, partial: boolean, now = Date.now()): FileState {
  return { hash: sha256(bytes), mtimeMs: stats.mtimeMs, size: stats.size, partial, readAt: now }
}

export type Staleness =
  | { kind: 'unread' }
  | { kind: 'changed' }
  | { kind: 'fresh' }

/**
 * Whether a file on disk is still what the agent read. Size and modification
 * time settle most cases; when they moved, the content decides, so a touch
 * or a save without changes does not force a re-read.
 */
export async function staleness(tracker: FileStateTracker, file: string, bytes: Uint8Array): Promise<Staleness> {
  const state = tracker.get(file)
  if (!state) return { kind: 'unread' }
  let stats: { mtimeMs: number; size: number }
  try {
    stats = await fs.stat(file)
  } catch {
    return { kind: 'changed' }
  }
  if (stats.mtimeMs === state.mtimeMs && stats.size === state.size && bytes.length === state.size) return { kind: 'fresh' }
  return sha256(bytes) === state.hash ? { kind: 'fresh' } : { kind: 'changed' }
}
