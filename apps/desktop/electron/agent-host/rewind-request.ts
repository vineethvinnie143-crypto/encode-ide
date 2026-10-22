import type { RewindRequest } from '../../shared/types'

/**
 * What the renderer is allowed to ask a rewind to do: which kind, for which request, from which plan, and two yes-or-no
 * choices. Anything else it sends is dropped; the host checks the same shape again.
 */
export function rewindRequestOf(value: unknown): RewindRequest {
  const given = typeof value === 'object' && value !== null ? (value as { kind?: unknown; turn?: unknown; fingerprint?: unknown; force?: unknown; conversation?: unknown }) : {}
  if (given.kind !== 'rewind' && given.kind !== 'redo') throw new Error('That is not a rewind.')
  if (typeof given.turn !== 'string' || !given.turn || typeof given.fingerprint !== 'string' || !given.fingerprint) throw new Error('That is not a rewind.')
  return {
    kind: given.kind,
    turn: given.turn,
    fingerprint: given.fingerprint,
    ...(given.force === true ? { force: true } : {}),
    ...(given.conversation === true ? { conversation: true } : {}),
  }
}
