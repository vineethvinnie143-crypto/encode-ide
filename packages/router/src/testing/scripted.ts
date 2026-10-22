import {
  TransportError,
  classifyHttpFailure,
  type ModelRequest,
  type ProviderAdapter,
  type ProviderType,
  type StreamInput,
  type TransportErrorDetails,
  type TransportErrorKind,
  type TransportEvent,
  type TransportTarget,
} from '@encode/providers'
import { sleep, type Clock } from '../clock'

/**
 * Fault injection for the router's tests: an adapter that plays a script per
 * call instead of speaking HTTP, and the faults real providers produce, as
 * script steps. Time inside a script runs on the test's clock.
 */

export type ScriptStep =
  | { event: TransportEvent }
  /** Simulated time passes before the next step. */
  | { wait: number }
  /** The call fails; a function gets the time of failure, for retry times. */
  | { fail: TransportError | ((now: number) => TransportError) }
  /** Nothing more arrives: until the call is aborted, or ever (an adapter that ignores its signal). */
  | { hang: 'until-abort' | 'forever' }
  /** The stream ends here, finished or not. */
  | { end: true }

export type Script = readonly ScriptStep[]

export interface AdapterCall {
  at: number
  key: string
  provider: string
  model: string
  target: TransportTarget
  request: ModelRequest
}

export type Scripter = (target: TransportTarget, call: { index: number; forModel: number; request: ModelRequest }) => Script

/**
 * A ProviderAdapter that plays scripts. Every call is recorded with its time;
 * adapters of several types can share one log and one per-model count.
 */
export class ScriptedAdapter implements ProviderAdapter {
  constructor(
    readonly type: ProviderType,
    private readonly clock: Clock,
    private readonly scripter: Scripter,
    readonly calls: AdapterCall[] = [],
    private readonly perModel = new Map<string, number>(),
  ) {}

  stream({ target, request, signal }: StreamInput): AsyncIterable<TransportEvent> {
    const forModel = this.perModel.get(target.key) ?? 0
    this.perModel.set(target.key, forModel + 1)
    const index = this.calls.length
    this.calls.push({ at: this.clock.now(), key: target.key, provider: target.provider, model: target.model, target, request })
    const script = this.scripter(target, { index, forModel, request })
    return play(script, this.clock, signal)
  }
}

async function* play(script: Script, clock: Clock, signal: AbortSignal): AsyncGenerator<TransportEvent> {
  for (const step of script) {
    if (signal.aborted) throw signal.reason
    if ('event' in step) {
      yield step.event
    } else if ('wait' in step) {
      await sleep(clock, step.wait, signal)
    } else if ('fail' in step) {
      throw typeof step.fail === 'function' ? step.fail(clock.now()) : step.fail
    } else if ('hang' in step) {
      if (step.hang === 'forever') await new Promise<never>(() => undefined)
      await new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    } else {
      return
    }
  }
}

const event = (value: TransportEvent): ScriptStep => ({ event: value })
const fail = (kind: TransportErrorKind, message: string, details: TransportErrorDetails | ((now: number) => TransportErrorDetails) = {}): ScriptStep => ({
  fail: (now) => new TransportError(kind, message, typeof details === 'function' ? details(now) : details),
})

/** Text in a few pieces, with a pause between them. */
function textSteps(text: string, gapMs: number): ScriptStep[] {
  const pieces = text.match(/[\s\S]{1,8}/g) ?? []
  return pieces.flatMap((piece, index) => (index && gapMs ? [{ wait: gapMs }, event({ type: 'text', text: piece })] : [event({ type: 'text', text: piece })]))
}

/** What OpenRouter wrote when an account's settings, or the app itself, shut a model out (as seen on 21 October 2026). */
export const OPENROUTER_REFUSALS = {
  policy:
    '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons): Free model training violation (guardrail): 1 endpoint excluded; configurable at https://openrouter.ai/workspaces/default/guardrails',
  appOnly: (model: string) => `${model} is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps`,
}

/** A failed response as the providers package classifies it, so tests see the kinds real calls get. */
function httpFailure(status: number, message: string): ScriptStep {
  return { fail: classifyHttpFailure(status, undefined, JSON.stringify({ error: { message, code: status } })) }
}

export const faults = {
  /** A clean reply. */
  reply(text: string, options: { firstTokenMs?: number; gapMs?: number; model?: string; cost?: number } = {}): Script {
    return [
      ...(options.model ? [event({ type: 'model', model: options.model })] : []),
      ...(options.firstTokenMs ? [{ wait: options.firstTokenMs }] : []),
      ...textSteps(text, options.gapMs ?? 0),
      event({ type: 'usage', usage: { inputTokens: 100, outputTokens: Math.max(1, Math.ceil(text.length / 4)), ...(options.cost !== undefined ? { cost: options.cost } : {}) } }),
      event({ type: 'finish', reason: 'stop' }),
    ]
  },
  /** A clean tool call, its JSON sent in pieces. `args` may be raw text to send malformed JSON. */
  toolCall(name: string, args: Record<string, unknown> | string, options: { id?: string; firstTokenMs?: number; cost?: number } = {}): Script {
    const json = typeof args === 'string' ? args : JSON.stringify(args)
    const pieces = json.match(/[\s\S]{1,10}/g) ?? ['']
    return [
      ...(options.firstTokenMs ? [{ wait: options.firstTokenMs }] : []),
      ...pieces.map((piece, index) =>
        event(index === 0 ? { type: 'tool-call', index: 0, id: options.id ?? 'call_1', name, arguments: piece } : { type: 'tool-call', index: 0, arguments: piece }),
      ),
      ...(options.cost !== undefined ? [event({ type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cost: options.cost } })] : []),
      event({ type: 'finish', reason: 'tool_use' }),
    ]
  },
  /** A tool call whose JSON stops in the middle of a string: no repair may complete it. */
  badToolJson(name = 'Write'): Script {
    return faults.toolCall(name, '{"path": "a.ts", "content": "half of the fi')
  },
  emptyReply(): Script {
    return [event({ type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } }), event({ type: 'finish', reason: 'stop' })]
  },
  /** A 429 for this model, with the time the provider named, if any. */
  rateLimited(retryAfterMs?: number): Script {
    return [fail('rate-limit', 'HTTP 429: rate limited upstream', (now) => (retryAfterMs === undefined ? {} : { retryAt: now + retryAfterMs }))]
  },
  /** OpenRouter's free per-minute cap: the whole account waits. */
  freeMinuteCap(retryAfterMs = 30_000): Script {
    return [fail('rate-limit', 'HTTP 429: Rate limit exceeded: free-models-per-min.', (now) => ({ status: 429, scope: 'account', retryAt: now + retryAfterMs }))]
  },
  /** A daily quota on the whole account, spent until `until`. */
  quotaExhausted(until?: number): Script {
    return [fail('quota', 'HTTP 429: Rate limit exceeded: free-models-per-day.', { status: 429, scope: 'account', ...(until !== undefined ? { retryAt: until } : {}) })]
  },
  serverError(status = 502): Script {
    return [fail('server', `HTTP ${status}: bad gateway`, { status })]
  },
  overloaded(): Script {
    return [fail('overloaded', 'HTTP 529: Overloaded', { status: 529 })]
  },
  networkError(): Script {
    return [fail('network', 'Could not reach the provider (ECONNRESET).')]
  },
  auth(code?: string): Script {
    return [fail('auth', 'HTTP 401: Invalid API key', { status: 401, ...(code ? { code } : {}) })]
  },
  payment(): Script {
    return [fail('payment', 'HTTP 402: Insufficient credits', { status: 402, scope: 'account' })]
  },
  contextOverflow(window?: number): Script {
    return [fail('context-overflow', `HTTP 400: maximum context length exceeded`, { status: 400, ...(window ? { window } : {}) })]
  },
  notFound(): Script {
    return [fail('not-found', 'HTTP 404: No endpoints found for this model.', { status: 404 })]
  },
  noTools(): Script {
    return [fail('unsupported', 'HTTP 404: No endpoints found that support tool use.', { status: 404, feature: 'tools' })]
  },
  invalidRequest(): Script {
    return [fail('invalid-request', 'HTTP 400: temperature is invalid', { status: 400 })]
  },
  contentFilter(): Script {
    return [fail('content-filter', 'HTTP 403: Input was flagged by moderation', { status: 403 })]
  },
  /** OpenRouter: the account's privacy or guardrail settings leave the model no endpoint. HTTP 404, which the providers package calls not-found. */
  policyBlocked(): Script {
    return [httpFailure(404, OPENROUTER_REFUSALS.policy)]
  },
  /** OpenRouter: the model answers only the apps on its list. HTTP 403, which the providers package calls a refused key. */
  appOnly(model = 'vendor/gated:free'): Script {
    return [httpFailure(403, OPENROUTER_REFUSALS.appOnly(model))]
  },
  /** A 403 that says nothing about why. */
  forbidden(message = 'Forbidden'): Script {
    return [httpFailure(403, message)]
  },
  /** Nothing at all for `ms`, then a reply. */
  slowFirstToken(ms: number, text = 'late but fine'): Script {
    return faults.reply(text, { firstTokenMs: ms })
  },
  /** Keepalives every `everyMs`, forever: the server is up, the model is not. */
  keepaliveOnly(everyMs = 10_000, count = 1_000): Script {
    return Array.from({ length: count }, () => [{ wait: everyMs }, event({ type: 'keepalive' })]).flat()
  },
  /** Keepalives for a while, then a reply: a gateway failing over on its side. */
  keepaliveThenReply(keepalives: number, everyMs: number, text = 'served after keepalives'): Script {
    return [...Array.from({ length: keepalives }, () => [{ wait: everyMs }, event({ type: 'keepalive' })]).flat(), ...faults.reply(text)]
  },
  /** Some text, then silence until the call is abandoned. */
  stallAfter(text = 'partial answer that will be discarded'): Script {
    return [...textSteps(text, 0), { hang: 'until-abort' }]
  },
  /** Some text, then the connection closes without a finish. */
  cutStream(text = 'partial answer, then the stream dies'): Script {
    return [...textSteps(text, 0), { end: true }]
  },
  /** Some text, then a provider error inside the stream. */
  midStreamError(text = 'partial answer, then an error'): Script {
    return [...textSteps(text, 0), { fail: new TransportError('server', 'The provider ended the reply with an error.') }]
  },
  /** An adapter that ignores its abort signal and never returns. */
  hangIgnoringAbort(): Script {
    return [{ hang: 'forever' }]
  },
  /** OpenRouter served one of the server-side fallbacks. */
  servedBy(model: string, text = 'answer from a fallback'): Script {
    return faults.reply(text, { model })
  },
}
