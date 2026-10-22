/**
 * The wire between the main process and the agent host (a utility process).
 * The host serves the session API of @encode/core and three requests of its
 * own; the main process answers one, for keys. Everything crosses as
 * structured-clonable data, and secrets cross only when asked for.
 */
import type { HostEvents, HostRequests, ProfileConfig } from '@encode/core'
import type { ApprovalPolicy } from '../../shared/types'

/** What the host needs to know about the user's settings, and nothing else of them. */
export interface HostConfig {
  policy: ApprovalPolicy
  maxSteps: number
  maxGoalRounds: number
  /** The model in use; null when none is set up. */
  profile: ProfileConfig | null
}

export interface HostInit {
  /** Where the session logs live. */
  dir: string
  /** The user's home, for ~/.encode (instructions, skills, agents). */
  home: string
  /** The folder open now. */
  workspace: string | null
  config: HostConfig
  /** A sessions file of an earlier build, imported once if it is there. */
  legacySessionsFile?: string
}

export type DesktopHostRequests = HostRequests & {
  init: { params: HostInit; result: void }
  configure: { params: HostConfig; result: void }
  /** Closes the sessions and their commands, and flushes the logs; the process exits afterwards. */
  shutdown: { params: undefined; result: void }
}

/** What the host serves. */
export type DesktopHostApi = { requests: DesktopHostRequests; events: HostEvents }

/** What the main process serves to the host. */
export type MainApi = {
  requests: {
    /**
     * The key stored for a model profile, for a call to `baseUrl`; empty when there is none, or when the
     * profile's key was entered for another server (a key is bound to its server).
     */
    key: { params: { profileId: string; baseUrl: string }; result: string }
  }
  events: {}
}
