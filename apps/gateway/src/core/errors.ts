import { GATEWAY_ERRORS, type GatewayErrorBody, type GatewayErrorCode } from '@encode/gateway-protocol'

/**
 * An error the gateway answers with on purpose. Its message is shown to the
 * user, so it never carries upstream text, prompts or secrets.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode
  /** Milliseconds until a retry can succeed, when known. */
  readonly retryAfterMs?: number

  constructor(code: GatewayErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs))
  }

  get status(): number {
    return GATEWAY_ERRORS[this.code].status
  }

  toBody(): GatewayErrorBody {
    return errorBody(this.code, this.message, this.retryAfterMs)
  }
}

/** Whole seconds for `retry_after` and the Retry-After header; at least 1 when a wait is due at all. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

export function errorBody(code: GatewayErrorCode, message: string, retryAfterMs?: number): GatewayErrorBody {
  return {
    error: {
      message,
      type: GATEWAY_ERRORS[code].type,
      code,
      ...(retryAfterMs !== undefined ? { retry_after: retryAfterSeconds(retryAfterMs) } : {}),
    },
  }
}
