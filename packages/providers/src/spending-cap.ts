/**
 * A hard stop on what a run spends (ADR 0137, 0138): every model call goes through one cap, which adds up what each
 * call cost: what the provider billed, or, where it did not say, the model's listed prices over the call's tokens.
 * Before a call, the cap adds the dearest call so far to what was spent; when that reaches the limit, the call is
 * refused and the cap's signal aborts, so whatever runs on it stops. The benchmark keeps one for every run of a bench,
 * the command line one for its request.
 *
 * A provider reports what a call cost only when its reply finishes, but it bills what it did before that too: an
 * attempt the router gave up on midway, a call its caller stopped (a Reviewer that ran out of time). Those are counted
 * as well, from what they streamed, by the model's listed prices and on the high side.
 */
import type { ClientEvent, CompletionOutcome, CompletionRequest, ModelBudget, ModelClient, Usage } from './contract'

export interface SpendingCap {
  /** US dollars. */
  readonly limit: number
  /** What every call has cost so far. */
  spent(): number
  /** Why the cap stopped; undefined while it has not. */
  stopped(): string | undefined
  /** Stops without a call refused: what is left would not pay for what comes next. */
  stop(reason: string): void
  /** Aborted once the cap stops. */
  readonly signal: AbortSignal
  /** `inner`, each of its calls counted against the cap. */
  wrap(inner: ModelClient): ModelClient
}

/** What a call cost by the model's listed prices (dollars per million tokens); undefined when nothing is listed. */
export function listedCost(usage: Usage, budget: Pick<ModelBudget, 'price' | 'cache'>): number | undefined {
  const price = budget.price
  if (!price || !(price.input > 0 || price.output > 0)) return undefined
  const read = usage.cacheReadTokens
  const written = usage.cacheWriteTokens
  const plain = Math.max(0, usage.inputTokens - read - written)
  const input = plain + read * (budget.cache?.read ?? 1) + written * (budget.cache?.write ?? 1)
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000
}

/** What a call streamed, attempt by attempt. */
export interface StreamTally {
  /** What each attempt wrote, in characters, that failed after it began writing. */
  readonly discarded: number[]
  /** What the attempt under way has written. */
  current: number
}

/** The request, with what it streams counted on the way to its own listener. */
export function tallyStream(request: CompletionRequest): { request: CompletionRequest; tally: StreamTally } {
  const tally: StreamTally = { discarded: [], current: 0 }
  const forward = request.onEvent
  const onEvent = (event: ClientEvent) => {
    if (event.type === 'text' || event.type === 'thinking') tally.current += event.text.length
    else if (event.type === 'tool-call') tally.current += event.arguments.length + (event.name?.length ?? 0)
    else if (event.type === 'discard') {
      if (tally.current > 0) tally.discarded.push(tally.current)
      tally.current = 0
    } else if (event.type === 'attempt') tally.current = 0
    forward?.(event)
  }
  return { request: { ...request, onEvent }, tally }
}

/** Characters a token stands for, on the low side, so that what was written is not counted short. */
const CHARS_PER_TOKEN = 3.5

/**
 * What a call cost that no provider reported, guessed on the high side: each attempt that failed after it began
 * writing read the whole prompt at the full input price and wrote what it streamed; with `stopped`, so did the attempt
 * under way, whatever it wrote. 0 when there is nothing of the kind; undefined when the model has no listed price.
 */
export function unreportedCost(request: Pick<CompletionRequest, 'requirements'>, tally: StreamTally, stopped: boolean, budget: Pick<ModelBudget, 'price'>): number | undefined {
  const written = [...tally.discarded, ...(stopped ? [tally.current] : [])]
  if (!written.length) return 0
  const price = budget.price
  if (!price || !(price.input > 0 || price.output > 0)) return undefined
  const output = written.reduce((all, chars) => all + Math.ceil(chars / CHARS_PER_TOKEN), 0)
  const prompt = request.requirements?.promptTokens
  return (written.length * (Number.isFinite(prompt) ? prompt : 0) * price.input + output * price.output) / 1_000_000
}

const dollars = (value: number) => `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`

export function spendingCap(limit: number): SpendingCap {
  if (!(limit > 0) || !Number.isFinite(limit)) throw new Error('A spending cap is a number of dollars above 0.')
  const controller = new AbortController()
  let spent = 0
  let dearest = 0
  let reason: string | undefined
  const stop = (why: string) => {
    reason ??= why
    if (!controller.signal.aborted) controller.abort(new Error(reason))
  }
  const add = (cost: number) => {
    spent += cost
    dearest = Math.max(dearest, cost)
  }
  const count = async (inner: ModelClient, request: CompletionRequest, outcome: CompletionOutcome | null, tally: StreamTally) => {
    const budget = await inner.budget(request.role).catch(() => ({}) as Partial<ModelBudget>)
    // What was billed and not reported has no price to keep to only where the model has none: it is left out then.
    const lost = unreportedCost(request, tally, outcome === null, budget) ?? 0
    if (outcome?.kind !== 'done') {
      if (lost > 0) add(lost)
      return
    }
    const { usage } = outcome
    const cost = usage.cost ?? listedCost(usage, budget)
    if (cost === undefined) {
      // Free of charge says so: OpenRouter bills a free model at 0. Nothing said, and no price, cannot be kept to a cap.
      stop(`a call to ${outcome.message.origin?.model ?? 'the model'} said nothing of what it cost, and the model has no listed price`)
      return
    }
    add(cost + lost)
  }
  return {
    limit,
    spent: () => spent,
    stopped: () => reason,
    stop,
    signal: controller.signal,
    wrap(inner) {
      return {
        budget: (role, query) => inner.budget(role, query),
        async complete(request) {
          if (!reason && spent + dearest >= limit) stop(`it reached its spending cap (${dollars(spent)} of ${dollars(limit)} spent; the next call could cost ${dollars(dearest)})`)
          if (reason) throw new Error(`Stopped: ${reason}.`)
          // A call stopped before it began reached no model (ADR 0139).
          const unsent = request.signal.aborted
          const { request: watched, tally } = tallyStream(request)
          let outcome: CompletionOutcome
          try {
            outcome = await inner.complete(watched)
          } catch (error) {
            if (!unsent) await count(inner, request, null, tally)
            throw error
          }
          await count(inner, request, outcome, tally)
          return outcome
        },
      }
    },
  }
}
