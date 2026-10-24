/** A sandbox that cannot be used, or a step of it that failed. The message is written to be shown to the person. */
export class SandboxError extends Error {
  constructor(
    /** `no-permission`: the operating system does not let this account prepare `folder` (Windows: change its security settings). */
    readonly code: 'unavailable' | 'failed' | 'no-permission',
    message: string,
    readonly folder?: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}
