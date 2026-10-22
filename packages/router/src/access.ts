import { SERVER_TOOL_REFUSED_CODE } from '@encode/providers'

/**
 * Refusals that belong to one model on one account, not to the key or to the
 * provider. OpenRouter answers HTTP 404 when the account's privacy or
 * guardrail settings leave a model no endpoint (the free models that may log
 * prompts for training are the usual case), and HTTP 403 for a model it
 * limits to the coding agents and productivity apps on its list. Retrying
 * changes nothing, so such a model is set aside for a long time; and neither
 * says anything about the key or about the provider's other models, so
 * nothing else is blocked.
 *
 * The providers package classifies by status, a 404 as not-found and a 403 as
 * a refused key. That would block the whole provider for a day over one
 * gated model, so the router tells these apart by what the provider wrote.
 */

export type RefusalKind =
  /** The account's privacy or guardrail settings leave the model no endpoint. */
  | 'policy'
  /** The model answers only the coding apps the provider lists. */
  | 'app-only'
  /** Some other 403: refused for this model, and the provider said no more. */
  | 'forbidden'
  /** The model is called through an OpenRouter preset whose server tool the chat-completions API does not take. */
  | 'server-tool'

export interface Refusal {
  kind: RefusalKind
  /** How long the model stays out, counted from the refusal. */
  ms: number
}

export const REFUSAL_KINDS: ReadonlySet<string> = new Set<RefusalKind>(['policy', 'app-only', 'forbidden', 'server-tool'])

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Long enough not to fail the same request every turn, short enough that a fixed preset is picked up on its own. */
const SERVER_TOOL_MS = 15 * MINUTE

/**
 * "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy" (404), and the older
 * "No endpoints found matching your data policy". It has to talk about endpoints: a guardrail that stopped one request's
 * content says nothing about the model.
 */
const POLICY = /\bendpoints?\b[^.]{0,80}\b(?:data policy|guardrails?)\b/i
/** "x is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps" (403). */
const APP_ONLY = /\bonly available on agentic harnesses?\b|\bopenrouter\.ai\/apps\b/i
/** Where the provider says the setting can be changed. Only its own site is passed on. */
const SETTINGS_LINK = /https:\/\/openrouter\.ai\/[A-Za-z0-9._~/%?=&#-]*[A-Za-z0-9_/-]/

/** What the providers package makes of these answers; limits, bills and moderation keep their own handling. */
const CLASSIFIED_AS = new Set(['auth', 'not-found', 'invalid-request'])

/** The refusal an OpenRouter error is, or undefined when it is something else. */
export function refusalOf(providerType: string, error: { kind: string; status?: number; code?: string; message: string }): Refusal | undefined {
  // A 401 is OpenRouter refusing the key, whatever else the message says.
  if (providerType !== 'openrouter' || error.status === 401 || !CLASSIFIED_AS.has(error.kind)) return undefined
  if (error.code === SERVER_TOOL_REFUSED_CODE) return { kind: 'server-tool', ms: SERVER_TOOL_MS }
  if (APP_ONLY.test(error.message)) return { kind: 'app-only', ms: DAY }
  if (POLICY.test(error.message) && error.status !== 400) return { kind: 'policy', ms: DAY }
  if (error.status === 403 && error.kind === 'auth') return { kind: 'forbidden', ms: HOUR }
  return undefined
}

/** What to tell the user about a refused model; `text` is the provider's own wording. */
export function refusalMessage(kind: RefusalKind, model: string, text: string): string {
  switch (kind) {
    case 'policy': {
      const link = SETTINGS_LINK.exec(text)?.[0]
      return `Your OpenRouter privacy settings leave ${model} no endpoint (usually because a free model may log prompts for training). eNCode skips it for a day. To use it, allow it in your OpenRouter settings${link ? ` (${link})` : ''}, then check again.`
    }
    case 'app-only':
      return `OpenRouter limits ${model} to the coding apps on its list and refused eNCode (HTTP 403). eNCode skips it for a day.`
    case 'forbidden':
      return `OpenRouter refused ${model} (HTTP 403: ${text.replace(/^HTTP 403:?\s*/, '').slice(0, 160) || 'no reason given'}). eNCode skips it for an hour; the key and the other models are not affected.`
    case 'server-tool':
      // The providers package wrote this text itself: it names the tool and says what to change in the preset.
      return `${text.replace(/^HTTP 400:?\s*/, '').slice(0, 400)} eNCode skips ${model} for 15 minutes; the key and the other models are not affected.`
  }
}
