/**
 * What the renderer may ask the Review tab's service for, checked before git sees any of it: scopes, actions and
 * options of known shapes, names that cannot be read as git options, and sizes that stay small. Anything else is
 * refused with a TypeError.
 */
import type { ReviewAction, ReviewCommitRequest, ReviewOptions, ReviewScope } from '../../shared/types'

const ACTIONS = new Set(['stage-hunk', 'unstage-hunk', 'revert-hunk', 'stage-file', 'unstage-file', 'revert-file', 'stage-all', 'unstage-all', 'revert-all'])
const HUNK_ID = /^[0-9a-f]{16}$/
const FINGERPRINT = /^[0-9a-f]{40}$/
const COMMIT = /^[0-9a-f]{4,64}$/i
/** A session's or a request's id as eNCode makes them. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
/** A branch's short name as git allows one (no space, ~ ^ : ? * [ \\, "..", "//" or "@{"), and never one that reads as an option. */
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\p{Cc}]{1,200}$/u

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Not a ${what}.`)
  return value as Record<string, unknown>
}

export function reviewScopeOf(value: unknown): ReviewScope {
  const given = record(value, 'review scope')
  switch (given.kind) {
    case 'unstaged':
    case 'staged':
      return { kind: given.kind }
    case 'branch': {
      if (given.base === undefined || given.base === null) return { kind: 'branch' }
      if (typeof given.base !== 'string' || !REF.test(given.base) || given.base.endsWith('.lock')) throw new TypeError('Not a branch name.')
      return { kind: 'branch', base: given.base }
    }
    case 'commit':
      if (typeof given.commit !== 'string' || !COMMIT.test(given.commit)) throw new TypeError('Not a commit.')
      return { kind: 'commit', commit: given.commit.toLowerCase() }
    case 'turn': {
      if (typeof given.session !== 'string' || !ID.test(given.session)) throw new TypeError('Not a session.')
      if (given.turn === undefined || given.turn === null) return { kind: 'turn', session: given.session }
      if (typeof given.turn !== 'string' || !ID.test(given.turn)) throw new TypeError('Not a request.')
      return { kind: 'turn', session: given.session, turn: given.turn }
    }
    default:
      throw new TypeError('Not a review scope.')
  }
}

export function reviewOptionsOf(value: unknown): ReviewOptions {
  if (value === undefined || value === null) return { context: 3, ignoreWhitespace: false }
  const given = record(value, 'set of review options')
  const context = given.context === Infinity ? Infinity : typeof given.context === 'number' && Number.isInteger(given.context) && given.context >= 0 && given.context <= 1000 ? given.context : 3
  return { context, ignoreWhitespace: given.ignoreWhitespace === true }
}

function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new TypeError('Not a file path.')
  return value
}

export function reviewActionOf(value: unknown): ReviewAction {
  const given = record(value, 'review action')
  if (typeof given.type !== 'string' || !ACTIONS.has(given.type)) throw new TypeError('Not a review action.')
  const type = given.type as ReviewAction['type']
  if (type === 'stage-all' || type === 'unstage-all' || type === 'revert-all') return { type }
  const path = filePath(given.path)
  const fingerprint = typeof given.fingerprint === 'string' && FINGERPRINT.test(given.fingerprint) ? given.fingerprint : undefined
  if (type === 'stage-hunk' || type === 'unstage-hunk' || type === 'revert-hunk') {
    if (typeof given.hunk !== 'string' || !HUNK_ID.test(given.hunk)) throw new TypeError('Not a hunk.')
    if (!fingerprint) throw new TypeError('A hunk action needs the file as it was shown.')
    return { type, path, hunk: given.hunk, fingerprint }
  }
  return { type, path, ...(fingerprint ? { fingerprint } : {}) }
}

export function commitRequestOf(value: unknown): ReviewCommitRequest {
  const given = record(value, 'commit request')
  if (typeof given.message !== 'string' || given.message.length > 64 * 1024) throw new TypeError('Not a commit message.')
  return { message: given.message, all: given.all === true, amend: given.amend === true, push: given.push === true }
}
