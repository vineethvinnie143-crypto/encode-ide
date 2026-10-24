/**
 * The folder channel between this PC and eNCode's program on another machine (ADR 0111): what the main process asks of
 * a folder there (its files, git, the terminal, the Review tab), and what that program asks back (the agent host's
 * models, for a commit message or a review, and its record of a request's changes).
 *
 * Calls name a service and one of its methods from a fixed list; anything else is refused. The other machine is
 * trusted with its own files, not with this PC: nothing it can ask here reaches this PC's files or programs.
 */
import type { CodeReviewInput, CodeReviewResult } from '@encode/core'
import type { ShellPromptInfo } from '../../shared/types'
import type { CommitDraftInput } from '../agent-host/commit-message'
import type { TurnSource } from '../services/turn-review'

export interface RemoteHello {
  home: string
  platform: NodeJS.Platform
  arch: string
  node: string
  /** The account eNCode's program runs as there. */
  user: string
  hostname: string
}

export interface RemoteFolderInfo {
  /** The folder as an absolute path on that machine. */
  root: string
  name: string
}

/** The services a call may name, and the methods of each it may call. */
export const FOLDER_METHODS = {
  workspace: ['open', 'close', 'list', 'listAll', 'read', 'readForEditor', 'write', 'createFile', 'createDir', 'rename', 'remove', 'search'],
  git: ['status'],
  shell: ['create', 'run', 'cancel', 'close', 'complete', 'disposeAll'],
  review: ['load', 'act', 'undo', 'commits', 'branches', 'commit', 'draft', 'askReviewer'],
} as const

export type FolderService = keyof typeof FOLDER_METHODS

/** Served by eNCode's program on the other machine. */
export type FolderServerApi = {
  requests: {
    hello: { params: undefined; result: RemoteHello }
    /** A folder typed by the person: `~` is that machine's home; answers with it as an absolute path, or refuses. */
    resolveFolder: { params: { path: string }; result: RemoteFolderInfo }
    call: { params: { service: FolderService; method: string; args: unknown[] }; result: unknown }
  }
  events: {
    changed: { paths: string[] }
    shellData: { id: string; text: string }
    shellPrompt: ShellPromptInfo
    shellExit: { id: string; code: number }
  }
}

/** Served by this PC for that program. */
export type FolderMainApi = {
  requests: {
    draftCommit: { params: CommitDraftInput; result: string }
    reviewCode: { params: CodeReviewInput; result: CodeReviewResult }
    turnChanges: { params: { sessionId: string; turn: Parameters<TurnSource['changes']>[1] }; result: Awaited<ReturnType<TurnSource['changes']>> }
    turnWrite: { params: { sessionId: string; write: Parameters<TurnSource['write']>[1] }; result: Awaited<ReturnType<TurnSource['write']>> }
  }
  events: {}
}

export const FOLDER_CALL_SCHEMA = {
  type: 'object',
  required: ['service', 'method', 'args'],
  additionalProperties: false,
  properties: {
    service: { type: 'string', enum: Object.keys(FOLDER_METHODS) },
    method: { type: 'string', minLength: 1, maxLength: 40 },
    args: { type: 'array', maxItems: 8 },
  },
} as const
