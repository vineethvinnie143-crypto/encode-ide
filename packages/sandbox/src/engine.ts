/**
 * What an operating system's sandbox is asked to do and what it reports. The policy is the same on every system;
 * each engine says what it can enforce (`limits`) so that the person is told the truth about their machine.
 */

/** Structurally the same as the shell's SpawnSpec (@encode/tools), kept here so that this package depends on nothing. */
export interface SpawnSpec {
  /** Absolute path of the program. */
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export type EngineName = 'bubblewrap' | 'seatbelt' | 'integrity-level'

export interface EnginePolicy {
  /** Folders a command may write, as real paths: the project folders, the sandbox's temp folder and the caches. */
  writable: readonly string[]
  /** Paths inside the writable ones that stay read-only. Ones that do not exist are skipped. */
  protected: readonly string[]
  /** Paths a command may not read. Only where `limits.reads` says the engine can. */
  unreadable: readonly string[]
  /** Whether a command may use the network. Only where `limits.network` says the engine can block it. */
  network: boolean
  /** The sandbox's temp folder: TMPDIR for the commands, and where the shell keeps its scripts. */
  temp: string
  /** Variables added to the command's environment. */
  env: Readonly<Record<string, string>>
  /** Variables taken out of it. */
  unset: readonly string[]
}

export interface EngineLimits {
  /** Can paths be made unreadable? */
  reads: boolean
  /** Can the network be blocked? */
  network: boolean
  /** `exact`: a protected path that exists cannot be changed, deleted, renamed or replaced. `best-effort`: it cannot be written, but something may get around that. */
  protectedPaths: 'exact' | 'best-effort'
  /** Can a command be kept from ending, signalling or looking into the person's other programs? */
  processes: boolean
}

export interface EngineProbe {
  ok: boolean
  /** Why not, in words for the person. */
  reason?: string
}

export interface SandboxEngine {
  readonly name: EngineName
  readonly limits: EngineLimits
  /** Starts a trivial confined program and checks that a write inside is allowed and one outside is not. */
  probe(): Promise<EngineProbe>
  /** Makes the policy's folders ready (Windows: the integrity marks). Idempotent; may take a while the first time. */
  prepare(policy: EnginePolicy, onProgress?: (message: string) => void): Promise<void>
  /** Rewrites a spawn so that the program runs confined. */
  wrap(spec: SpawnSpec, policy: EnginePolicy): SpawnSpec
  /** Why this program cannot run inside the sandbox on this system (Windows: Git Bash), in words for the person, or nothing when it can. */
  unsupported?(file: string): string | undefined
  /** The folders `prepare` changed so that commands can be confined there (Windows: the integrity marks). */
  marked?(): Promise<string[]>
  /** Puts those folders back as they were, all of them or only these; returns the ones done. */
  release?(folders?: readonly string[]): Promise<string[]>
  /**
   * Gives the person's account what `prepare` needs in a folder the system refused it (Windows: Full control, after an
   * administrator's yes). Only for a folder `prepare` refused with `no-permission`.
   */
  grant?(folder: string): Promise<GrantOutcome>
}

/**
 * What fixing a folder's permissions came to. `cancelled`: the person said no to the system's prompt, so nothing changed.
 * `owner`: the account that said yes to the system's prompt had to take ownership of the folder on the way.
 */
export type GrantOutcome = { ok: true; owner: boolean } | { ok: false; cancelled: true } | { ok: false; cancelled?: false; reason: string }

export type SandboxState = 'active' | 'unavailable' | 'disabled'

/** What the person is shown. */
export interface SandboxStatus {
  state: SandboxState
  engine?: EngineName
  /** Why it is unavailable or disabled. */
  reason?: string
  limits?: EngineLimits
  /** Refuse to run commands when the sandbox is unavailable. */
  required: boolean
  /** May a command ask to run outside the sandbox (the person is asked each time). */
  allowUnsandboxed: boolean
}
