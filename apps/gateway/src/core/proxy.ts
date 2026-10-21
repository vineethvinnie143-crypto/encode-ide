import { GatewayHeaders, SSE_KEEPALIVE, SSE_MODEL_COMMENT, type VirtualModelId } from '@encode/gateway-protocol'
import type { GatewayConfig } from './config'
import type { Admission, AttemptOutcome } from './control'
import { GatewayError } from './errors'
import { estimateInputTokens } from './estimate'
import { assertFreeOnly, sanitizeChatRequest, type SanitizedChat } from './firewall'
import { BASE_HEADERS, json, readJson } from './http'
import { describeModel, pickCandidates, type CandidateNeeds, type PoolDocument } from './pool'
import type { ConfigStore, ControlPort, Logger, UserQuotaPort } from './ports'
import { CompletionAssembler, eventError, readDataLine, sseError, StreamTail, type Usage } from './sse'
import type { AccessClaims, TokenService } from './tokens'
import { attemptUpstream, type Committed } from './upstream'

/**
 * POST /v1/chat/completions: admission, failover across free models, and the
 * relay back to the client.
 *
 * A request passes the kill switch, the access token, the cost firewall and
 * the account's quota before anything is sent upstream. Then each attempt
 * takes a slot from the global pacer and tries up to three `:free` models in
 * one OpenRouter call. Until a model produces its first real content, any
 * failure moves on to other models without the client seeing it; a
 * streaming client receives `: keepalive` comments meanwhile.
 */

export interface ChatDeps {
  config: GatewayConfig
  upstreamFetch: typeof fetch
  users: UserQuotaPort
  control: ControlPort
  store: ConfigStore
  tokens: TokenService
  log: Logger
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  newId: () => string
  /** The last fair-share multiplier the control plane reported; per-account limits use it before the first admission. */
  fairShare: { scale: number; at: number }
}

export interface RequestContext {
  requestId: string
  waitUntil(promise: Promise<unknown>): void
}

const FAIR_SHARE_TTL_MS = 60_000
const encoder = new TextEncoder()
const KEEPALIVE = encoder.encode(SSE_KEEPALIVE)
const MAX_JSON_BYTES = 8 * 1024 * 1024

type Ending = 'ok' | 'failed' | 'client_closed'

export async function handleChat(request: Request, claims: AccessClaims, deps: ChatDeps, ctx: RequestContext): Promise<Response> {
  const { config } = deps
  const { value } = await readJson(request, config.request.maxBodyBytes)
  const chat = sanitizeChatRequest(value, config.request)
  const pool = await deps.store.pool()
  const estimate = estimateInputTokens(chat.fields)
  const needs: CandidateNeeds = { tools: chat.needsTools, images: chat.needsImages, contextTokens: estimate + chat.fields.max_tokens }
  if (!pool || pickCandidates(pool, chat.virtualModel, needs, new Set(), {}, 0, 1).length === 0) {
    const reason = chat.needsImages
      ? 'No free model that reads images is available right now.'
      : 'No free model can take a request of this size right now.'
    throw new GatewayError('upstream_unavailable', reason, 60_000)
  }

  const scale = deps.now() - deps.fairShare.at < FAIR_SHARE_TTL_MS ? deps.fairShare.scale : 1
  const leaseId = deps.newId()
  const lease = await deps.users.acquire(claims.sub, { leaseId, sessionId: claims.sid, estimatedInputTokens: estimate, scale })
  const logId = await deps.tokens.logId(claims.sub)
  if (lease.newlyFlagged) {
    const reason = lease.ok ? lease.flagged : 'machine_speed'
    ctx.waitUntil(deps.control.flagged(logId, reason ?? 'machine_speed').catch((error) => deps.log.error('flag_report_failed', error)))
  }
  if (!lease.ok) {
    deps.log.event('chat_refused', { rid: ctx.requestId, uid: logId, code: lease.code })
    throw new GatewayError(lease.code, lease.message, lease.retryAfterMs)
  }

  const quotaHeaders = {
    [GatewayHeaders.quotaRemaining]: String(lease.remaining),
    [GatewayHeaders.quotaReset]: String(lease.resetAt),
  }
  const run = new ChatRun(deps, ctx, chat, pool, needs, estimate, claims, leaseId, lease.firstToday, logId, request.signal)
  // The first upstream slot is taken before answering, so an exhausted or busy free tier is a plain HTTP error even for a stream.
  await run.admitFirst()
  return chat.stream ? run.stream(quotaHeaders) : run.complete(quotaHeaders)
}

class ChatRun {
  private readonly started: number
  private readonly tried = new Set<string>()
  private readonly abort = new AbortController()
  private attempts = 0
  private admitted = false
  private rejections = 0
  private sent = false
  private failure: GatewayError | null = null
  private settled = false
  /** The models offered on the attempt that committed, so a failed non-streamed answer moves past all of them. */
  private committedCandidates: string[] = []
  /** The first attempt's slot, taken before the response started. */
  private preadmitted: Admission | null = null

  constructor(
    private readonly deps: ChatDeps,
    private readonly ctx: RequestContext,
    private readonly chat: SanitizedChat,
    private readonly pool: PoolDocument,
    private readonly needs: CandidateNeeds,
    private readonly estimate: number,
    private readonly claims: AccessClaims,
    private readonly leaseId: string,
    private readonly firstToday: boolean,
    private readonly logId: string,
    clientSignal: AbortSignal | undefined,
  ) {
    this.started = deps.now()
    if (clientSignal) {
      if (clientSignal.aborted) this.abort.abort()
      else clientSignal.addEventListener('abort', () => this.abort.abort(), { once: true })
    }
  }

  private get config(): GatewayConfig {
    return this.deps.config
  }

  private upstreamHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.openRouterKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-title': this.config.appTitle,
    }
    if (this.config.appUrl) headers['http-referer'] = this.config.appUrl
    return headers
  }

  private async report(model: string, outcome: AttemptOutcome, extra: { ttftMs?: number; usage?: Usage; retryAfterMs?: number } = {}): Promise<void> {
    try {
      await this.deps.control.report({
        model,
        outcome,
        ...(extra.ttftMs !== undefined ? { ttftMs: extra.ttftMs } : {}),
        ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
        ...(extra.usage ? { inputTokens: extra.usage.inputTokens, outputTokens: extra.usage.outputTokens } : {}),
      })
    } catch (error) {
      this.deps.log.error('control_report_failed', error, { rid: this.ctx.requestId })
    }
  }

  /** Takes the first upstream slot. On refusal it settles the request (refunded: nothing was sent) and throws. */
  async admitFirst(): Promise<void> {
    let admission: Admission
    try {
      admission = await this.deps.control.admit({ firstAttempt: true, newActiveUser: this.firstToday })
    } catch (error) {
      this.deps.log.error('control_admit_failed', error, { rid: this.ctx.requestId })
      this.failure = new GatewayError('internal_error', 'The gateway hit an internal error. Retry in a moment.', 5_000)
      await this.settle('failed')
      throw this.failure
    }
    this.admitted = true
    if (!admission.ok) {
      this.failure = new GatewayError(admission.code, admission.message, admission.retryAfterMs)
      await this.settle('failed')
      throw this.failure
    }
    this.deps.fairShare = { scale: admission.scale, at: this.deps.now() }
    this.preadmitted = admission
  }

  /**
   * Tries models until one commits to an answer. Returns null when none did,
   * with `failure` saying why (unless the client left).
   */
  private async connect(): Promise<Committed | null> {
    const { upstream } = this.config
    const preDeadline = this.started + upstream.preStreamBudgetMs
    const vm: VirtualModelId = this.chat.virtualModel
    while (this.attempts < upstream.maxAttempts && !this.abort.signal.aborted) {
      const left = preDeadline - this.deps.now()
      if (left < 1_000) {
        this.failure ??= new GatewayError('upstream_timeout', 'No free model answered in time. Retry in a moment.', 10_000)
        break
      }

      const admission = this.preadmitted ?? (await this.deps.control.admit({ firstAttempt: !this.admitted, newActiveUser: this.firstToday && !this.admitted }))
      this.preadmitted = null
      this.admitted = true
      if (!admission.ok) {
        this.failure = new GatewayError(admission.code, admission.message, admission.retryAfterMs)
        break
      }
      this.deps.fairShare = { scale: admission.scale, at: this.deps.now() }
      const cancel = () => this.ctx.waitUntil(this.deps.control.cancel(admission.slot).catch(() => undefined))
      if (admission.waitMs >= left) {
        cancel()
        this.failure = new GatewayError('free_tier_busy', 'The free tier is busy. Try again in a few seconds.', admission.waitMs)
        break
      }
      if (admission.waitMs > 0) {
        await this.deps.sleep(admission.waitMs, this.abort.signal)
        if (this.abort.signal.aborted) {
          cancel()
          break
        }
      }

      const candidates = pickCandidates(this.pool, vm, this.needs, this.tried, admission.coolingUntil, this.deps.now(), upstream.fallbackModels)
      if (!candidates.length) {
        cancel()
        this.failure ??= new GatewayError('upstream_unavailable', 'No free model is available right now. Retry in a minute.', 60_000)
        break
      }
      const body: Record<string, unknown> = {
        model: candidates[0],
        models: candidates,
        ...this.chat.fields,
        stream: true,
        stream_options: { include_usage: true },
        user: this.logId,
      }
      assertFreeOnly(body, upstream.fallbackModels)

      this.attempts += 1
      this.sent = true
      const thinking = candidates.some((id) => describeModel(this.pool, id)?.reasoning)
      const budget = Math.min(thinking ? upstream.reasoningFirstEventTimeoutMs : upstream.firstEventTimeoutMs, preDeadline - this.deps.now())
      const result = await attemptUpstream({
        fetch: this.deps.upstreamFetch,
        url: `${this.config.openRouterBaseUrl}/chat/completions`,
        headers: this.upstreamHeaders(),
        body,
        firstEventTimeoutMs: budget,
        signal: this.abort.signal,
        now: this.deps.now,
      })
      if (result.kind === 'committed') {
        this.committedCandidates = candidates
        return result
      }

      if (result.outcome === 'client_closed') return null
      await this.report(candidates[0], result.outcome, { retryAfterMs: result.retryAfterMs })
      switch (result.outcome) {
        case 'account_limited':
          // Every free model shares the account's per-minute limit; the next admission waits it out.
          this.failure = new GatewayError('free_tier_busy', 'The free tier is busy. Try again in a few seconds.', result.retryAfterMs)
          continue
        case 'daily_exhausted':
          this.failure = new GatewayError(
            'free_tier_exhausted',
            "Today's shared free requests are used up. The free tier is back at midnight UTC.",
            result.retryAfterMs,
          )
          return null
        case 'payment_required':
        case 'unauthorized':
          this.failure = new GatewayError('upstream_unavailable', 'The free tier is unavailable for a few minutes.', 15 * 60_000)
          return null
        case 'rejected':
          for (const id of candidates) this.tried.add(id)
          this.rejections += 1
          this.failure = new GatewayError('invalid_request', result.detail ?? 'The model rejected the request.')
          if (this.rejections >= 2) return null
          continue
        default:
          for (const id of candidates) this.tried.add(id)
          this.failure =
            result.outcome === 'timeout'
              ? new GatewayError('upstream_timeout', 'No free model answered in time. Retry in a moment.', 10_000)
              : new GatewayError('upstream_unavailable', 'The free models are failing right now. Retry in a minute.', 30_000)
      }
    }
    // A client that left before the first attempt hands its slot back.
    const unused = this.preadmitted
    this.preadmitted = null
    if (unused?.ok) this.ctx.waitUntil(this.deps.control.cancel(unused.slot).catch(() => undefined))
    return null
  }

  /** Releases the lease, reports the answering model and logs the request, exactly once. */
  private async settle(ending: Ending, served?: { model: string; outcome: AttemptOutcome; ttftMs?: number; usage?: Usage; bytes?: number }) {
    if (this.settled) return
    this.settled = true
    if (served) await this.report(served.model, served.outcome, { ttftMs: served.ttftMs, usage: served.usage })
    // Nothing sent costs nothing; an upstream failure is not the account's fault. A rejected request or a client that left is.
    const refund = ending === 'failed' ? !this.sent || this.failure?.code !== 'invalid_request' : ending === 'client_closed' && !this.sent
    const outputTokens = served?.usage?.outputTokens ?? Math.ceil((served?.bytes ?? 0) / 40)
    try {
      await this.deps.users.release(this.claims.sub, {
        leaseId: this.leaseId,
        ...(served?.usage ? { inputTokens: served.usage.inputTokens } : {}),
        outputTokens,
        refund,
      })
    } catch (error) {
      this.deps.log.error('quota_release_failed', error, { rid: this.ctx.requestId })
    }
    this.deps.log.event('chat', {
      rid: this.ctx.requestId,
      uid: this.logId,
      vm: this.chat.virtualModel,
      stream: this.chat.stream,
      ending,
      code: ending === 'failed' ? (this.failure?.code ?? 'upstream_unavailable') : null,
      model: served?.model ?? null,
      attempts: this.attempts,
      ttft_ms: served?.ttftMs ?? null,
      ms: this.deps.now() - this.started,
      in: served?.usage?.inputTokens ?? this.estimate,
      out: outputTokens,
      refund,
    })
  }

  private finalFailure(): GatewayError {
    return this.failure ?? new GatewayError('upstream_unavailable', 'No free model is available right now. Retry in a minute.', 60_000)
  }

  stream(quotaHeaders: Record<string, string>): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    this.ctx.waitUntil(this.pump(writable.getWriter()))
    return new Response(readable, {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
        ...quotaHeaders,
      },
    })
  }

  private async pump(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    let gone = false
    const write = async (chunk: Uint8Array): Promise<boolean> => {
      if (gone) return false
      try {
        await writer.write(chunk)
        return true
      } catch {
        gone = true
        this.abort.abort()
        return false
      }
    }
    const close = async () => {
      try {
        await writer.close()
      } catch {
        /* the client is already gone */
      }
    }

    void write(KEEPALIVE)
    const keepalive = setInterval(() => void write(KEEPALIVE), this.config.upstream.keepaliveMs)
    let committed: Committed | null = null
    try {
      committed = await this.connect()
    } catch (error) {
      this.deps.log.error('chat_connect_failed', error, { rid: this.ctx.requestId })
      this.failure = new GatewayError('internal_error', 'The gateway hit an internal error. Retry in a moment.', 5_000)
    } finally {
      clearInterval(keepalive)
    }

    if (!committed) {
      if (gone || this.abort.signal.aborted) {
        await close()
        await this.settle('client_closed')
        return
      }
      const failure = this.finalFailure()
      await write(sseError(failure.code, failure.message, failure.retryAfterMs))
      await close()
      await this.settle('failed')
      return
    }

    const { upstream } = this.config
    const active = committed
    const tail = new StreamTail()
    let bytes = 0
    let lastByte = this.deps.now()
    const stop: { reason: 'idle' | 'deadline' | 'error' | null } = { reason: null }
    const watchdog = setInterval(() => {
      if (this.deps.now() - lastByte > upstream.idleTimeoutMs) stop.reason = 'idle'
      else if (this.deps.now() - this.started > upstream.maxDurationMs) stop.reason = 'deadline'
      if (stop.reason) active.abort()
    }, Math.min(5_000, Math.max(250, Math.floor(upstream.idleTimeoutMs / 4))))
    // A client that leaves stops the upstream at once, not at the next chunk.
    const onClientGone = () => active.abort()
    this.abort.signal.addEventListener('abort', onClientGone, { once: true })

    try {
      await write(encoder.encode(`${SSE_MODEL_COMMENT}${active.model}\n\n`))
      for (const chunk of active.head) {
        tail.push(chunk)
        bytes += chunk.byteLength
        if (!(await write(chunk))) break
      }
      while (!gone && !this.abort.signal.aborted) {
        const { done, value } = await active.reader.read()
        if (done) break
        lastByte = this.deps.now()
        tail.push(value)
        bytes += value.byteLength
        if (!(await write(value))) break
      }
    } catch {
      stop.reason ??= 'error'
    } finally {
      clearInterval(watchdog)
      this.abort.signal.removeEventListener('abort', onClientGone)
    }
    gone ||= this.abort.signal.aborted
    if (gone) active.abort()

    const summary = tail.summary()
    const served = { model: active.model, ttftMs: active.ttftMs, usage: summary.usage, bytes }
    if (gone) {
      await close()
      await this.settle('client_closed', { ...served, outcome: 'client_closed' })
      return
    }
    // An upstream that stops without its end marker or a finish reason was cut off, even when the connection closed cleanly.
    const cut = !summary.done && !summary.finishReason
    if (stop.reason || summary.error || cut) {
      const timedOut = stop.reason === 'idle' || stop.reason === 'deadline'
      this.failure = timedOut
        ? new GatewayError('upstream_timeout', 'The model stopped responding. Retry the request.', 1_000)
        : summary.error
          ? new GatewayError('upstream_error', 'The model failed mid-answer. Retry the request.', 1_000)
          : new GatewayError('upstream_error', 'The model connection dropped. Retry the request.', 1_000)
      // Every failed stream ends with a gateway error chunk, after any upstream error relayed before it.
      await write(sseError(this.failure.code, this.failure.message, this.failure.retryAfterMs))
      await close()
      await this.settle('failed', { ...served, outcome: timedOut ? 'timeout' : 'error' })
      return
    }
    await close()
    await this.settle('ok', { ...served, outcome: 'ok' })
  }

  /** Reads a committed stream to its end for a client that did not ask to stream. */
  private async drain(committed: Committed, assembler: CompletionAssembler): Promise<{ ok: boolean; outcome: AttemptOutcome; usage?: Usage; bytes: number }> {
    const { upstream } = this.config
    let bytes = committed.head.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    let usage: Usage | undefined
    let lastByte = this.deps.now()
    const stop: { timedOut: boolean } = { timedOut: false }
    const watchdog = setInterval(() => {
      if (this.deps.now() - lastByte > upstream.idleTimeoutMs || this.deps.now() - this.started > upstream.maxDurationMs) {
        stop.timedOut = true
        committed.abort()
      }
    }, Math.min(5_000, Math.max(250, Math.floor(upstream.idleTimeoutMs / 4))))
    // A client that leaves stops the upstream too; nobody is waiting for the answer.
    const onClientGone = () => committed.abort()
    this.abort.signal.addEventListener('abort', onClientGone, { once: true })
    const take = (event: Record<string, unknown>): boolean => {
      if (eventError(event)) return false
      assembler.push(event)
      const reported = event.usage as Record<string, unknown> | undefined
      if (reported && typeof reported === 'object') {
        usage = { inputTokens: Number(reported.prompt_tokens) || 0, outputTokens: Number(reported.completion_tokens) || 0 }
      }
      return true
    }
    try {
      for (const event of committed.events) {
        if (!take(event)) {
          committed.abort()
          return { ok: false, outcome: 'error', usage, bytes }
        }
      }
      if (committed.done) {
        committed.abort()
        return { ok: true, outcome: 'ok', usage, bytes }
      }
      for (;;) {
        const { done, value } = await committed.reader.read()
        const lines = done ? committed.decoder.end() : committed.decoder.push(value)
        if (!done) {
          lastByte = this.deps.now()
          bytes += value.byteLength
          if (bytes > MAX_JSON_BYTES) {
            committed.abort()
            return { ok: false, outcome: 'error', usage, bytes }
          }
        }
        for (const line of lines) {
          const data = readDataLine(line)
          if (data.kind === 'done') {
            committed.abort()
            return { ok: true, outcome: 'ok', usage, bytes }
          }
          if (data.kind === 'json' && !take(data.value)) {
            committed.abort()
            return { ok: false, outcome: 'error', usage, bytes }
          }
        }
        if (done) {
          // A cancelled read also ends as done: tell a watchdog or a departed client from a stream that finished.
          if (this.abort.signal.aborted) return { ok: false, outcome: 'client_closed', usage, bytes }
          if (stop.timedOut) return { ok: false, outcome: 'timeout', usage, bytes }
          return assembler.finished ? { ok: true, outcome: 'ok', usage, bytes } : { ok: false, outcome: 'error', usage, bytes }
        }
      }
    } catch {
      if (this.abort.signal.aborted) return { ok: false, outcome: 'client_closed', usage, bytes }
      return { ok: false, outcome: stop.timedOut ? 'timeout' : 'error', usage, bytes }
    } finally {
      clearInterval(watchdog)
      this.abort.signal.removeEventListener('abort', onClientGone)
    }
  }

  async complete(quotaHeaders: Record<string, string>): Promise<Response> {
    try {
      for (;;) {
        const committed = await this.connect()
        if (!committed) break
        const assembler = new CompletionAssembler()
        const drained = await this.drain(committed, assembler)
        const served = { model: assembler.servedBy || committed.model, ttftMs: committed.ttftMs, usage: drained.usage, bytes: drained.bytes }
        if (drained.ok) {
          await this.settle('ok', { ...served, outcome: 'ok' })
          return json(assembler.result(), 200, { ...quotaHeaders, [GatewayHeaders.model]: served.model })
        }
        if (drained.outcome === 'client_closed') {
          await this.settle('client_closed', { ...served, outcome: 'client_closed' })
          throw new GatewayError('upstream_error', 'The request was cancelled.')
        }
        // Nothing reached the client, so a model failing mid-answer is just another failover.
        for (const id of [...this.committedCandidates, committed.model]) this.tried.add(id)
        await this.report(served.model, drained.outcome, { ttftMs: committed.ttftMs })
        this.failure = new GatewayError('upstream_unavailable', 'The free models are failing right now. Retry in a minute.', 30_000)
      }
    } catch (error) {
      if (error instanceof GatewayError && this.settled) throw error
      if (!(error instanceof GatewayError)) {
        this.deps.log.error('chat_connect_failed', error, { rid: this.ctx.requestId })
        this.failure = new GatewayError('internal_error', 'The gateway hit an internal error. Retry in a moment.', 5_000)
      } else {
        this.failure = error
      }
    }
    if (this.abort.signal.aborted && !this.failure) {
      await this.settle('client_closed')
      throw new GatewayError('upstream_error', 'The request was cancelled.')
    }
    await this.settle('failed')
    throw this.finalFailure()
  }
}

