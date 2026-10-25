/**
 * A hard stop on what a run spends (ADR 0137, 0138): every model call goes through one cap, which adds up what each
 * call cost: what the provider billed, or, where it did not say, the model's listed prices over the call's tokens.
 * Before a call, the cap adds the dearest call so far to what was spent; when that reaches the limit, the call is
 * refused and the cap's signal aborts, so whatever runs on it stops. The benchmark keeps one for every run of a bench,
 * the command line one for its request.
 */
import type { CompletionOutcome, CompletionRequest, ModelBudget, ModelClient, Usage } from './contract'

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
  const count = async (inner: ModelClient, request: CompletionRequest, outcome: CompletionOutcome) => {
    if (outcome.kind !== 'done') return
    const { usage } = outcome
    const cost = usage.cost ?? listedCost(usage, await inner.budget(request.role).catch(() => ({})))
    if (cost === undefined) {
      // Free of charge says so: OpenRouter bills a free model at 0. Nothing said, and no price, cannot be kept to a cap.
      stop(`a call to ${outcome.message.origin?.model ?? 'the model'} said nothing of what it cost, and the model has no listed price`)
      return
    }
    spent += cost
    dearest = Math.max(dearest, cost)
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
          const outcome = await inner.complete(request)
          await count(inner, request, outcome)
          return outcome
        },
      }
    },
  }
}
