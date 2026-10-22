/** A sandbox that cannot be used, or a step of it that failed. The message is written to be shown to the person. */
export class SandboxError extends Error {
  constructor(
    readonly code: 'unavailable' | 'failed',
    message: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}
