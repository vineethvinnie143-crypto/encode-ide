/**
 * Seeded property testing and fuzzing for node:test, kept in-house and
 * deliberately small: a deterministic PRNG, a handful of generators, and
 * `check`, which runs a property over generated cases and reports the seed
 * and the failing input so any failure replays exactly.
 *
 * Cases grow from size 0 to `maxSize`, so the first failure found is usually
 * a small one, and a failure is then shrunk: every generator draws its
 * choices from one stream of numbers, so the case is made again from that
 * stream with draws taken out and made smaller (towards 0, which every
 * generator reads as its first or smallest choice), keeping each change that
 * still fails. No generator needs to know how to shrink.
 *
 * Fuzzing is the same properties run for longer: with ENCODE_FUZZ_MS set,
 * each `check` keeps making cases, sweep after sweep of sizes, until that
 * much time has passed (see scripts/fuzz.mjs).
 */

import { appendFileSync } from 'node:fs'

/** Uniform float in [0, 1). */
export type Random = () => number

/** mulberry32: tiny, fast and well distributed enough for test generation. */
export function prng(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Gen<T> = (random: Random, size: number) => T

function int(min: number, max: number): Gen<number> {
  return (random) => min + Math.floor(random() * (max - min + 1))
}

function oneOf<T>(...values: readonly T[]): Gen<T> {
  if (!values.length) throw new Error('oneOf needs at least one value')
  return (random) => values[Math.floor(random() * values.length)]
}

function pick<T>(...gens: ReadonlyArray<Gen<T>>): Gen<T> {
  if (!gens.length) throw new Error('pick needs at least one generator')
  return (random, size) => gens[Math.floor(random() * gens.length)](random, size)
}

/** Weighted choice between generators: `weighted([3, a], [1, b])`. */
function weighted<T>(...entries: ReadonlyArray<readonly [number, Gen<T>]>): Gen<T> {
  const total = entries.reduce((sum, [weight]) => sum + weight, 0)
  return (random, size) => {
    let roll = random() * total
    for (const [weight, generator] of entries) {
      roll -= weight
      if (roll < 0) return generator(random, size)
    }
    return entries[entries.length - 1][1](random, size)
  }
}

function array<T>(item: Gen<T>, minLength = 0, maxLength?: number): Gen<T[]> {
  return (random, size) => {
    const max = Math.max(minLength, maxLength ?? size)
    const length = minLength + Math.floor(random() * (max - minLength + 1))
    return Array.from({ length }, () => item(random, size))
  }
}

function string(alphabet: string, minLength = 0, maxLength?: number): Gen<string> {
  const chars = oneOf(...Array.from(alphabet))
  return (random, size) => array(chars, minLength, maxLength)(random, size).join('')
}

function map<T, U>(generator: Gen<T>, project: (value: T) => U): Gen<U> {
  return (random, size) => project(generator(random, size))
}

function tuple<T extends unknown[]>(...gens: { [K in keyof T]: Gen<T[K]> }): Gen<T> {
  return (random, size) => gens.map((generator) => generator(random, size)) as T
}

export const gen = { int, oneOf, pick, weighted, array, string, map, tuple }

export interface CheckOptions<T = unknown> {
  /** Cases to run. Default 200, or ENCODE_PROPERTY_RUNS. */
  runs?: number
  /** Fixed seed. Default ENCODE_PROPERTY_SEED, else a fresh random seed. */
  seed?: number
  /** Size reached by the last case. Default 30. */
  maxSize?: number
  /** Inputs that once failed, run first every time so the failure stays fixed. */
  examples?: readonly T[]
  /** Default true: make a failing case smaller before reporting it. */
  shrink?: boolean
}

function describe(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}… (${text.length} chars)` : text
}

/**
 * The numbers a case is made from: drawn from a PRNG and written down, or read back from a list written down before
 * (0 once the list runs out, the first choice of every generator).
 */
class Draws {
  readonly used: number[] = []
  private index = 0

  constructor(
    private readonly source: Random | null,
    private readonly list: readonly number[] = [],
  ) {}

  readonly random: Random = () => {
    const value = this.source ? this.source() : this.index < this.list.length ? this.list[this.index] : 0
    this.index++
    this.used.push(value)
    return value
  }
}

/** Runs the property on one input; the error it fails with, or null. */
async function attempt<T>(property: (value: T) => unknown, value: T): Promise<unknown> {
  try {
    if ((await property(value)) === false) return new Error('property returned false')
    return null
  } catch (error) {
    return error ?? new Error('property threw a nullish value')
  }
}

const SHRINK_TRIES = 3000
const SHRINK_MS = 20_000

/** A failing case made smaller: from its draws and size, as small a set of draws as still fails, in bounded time. */
async function shrink<T>(
  generator: Gen<T>,
  property: (value: T) => unknown,
  draws: readonly number[],
  size: number,
  failure: unknown,
): Promise<{ value: T; failure: unknown; steps: number } | null> {
  const deadline = Date.now() + SHRINK_MS
  let tries = 0
  let best: { draws: number[]; size: number; value: T; failure: unknown } | null = null
  let current = { draws: draws.slice(), size }
  let steps = 0

  /** Makes the case from these draws; when it still fails, keeps it as the new smallest. */
  const tryCase = async (list: readonly number[], at: number): Promise<boolean> => {
    if (tries >= SHRINK_TRIES || Date.now() > deadline) return false
    tries++
    const replay = new Draws(null, list)
    let value: T
    try {
      value = generator(replay.random, at)
    } catch {
      return false
    }
    const error = await attempt(property, value)
    if (error === null) return false
    // Only what the generator read counts, so draws past them fall away.
    current = { draws: replay.used.slice(0, Math.min(replay.used.length, list.length)), size: at }
    best = { ...current, value, failure: error }
    steps++
    return true
  }

  let improved = true
  while (improved && tries < SHRINK_TRIES && Date.now() <= deadline) {
    improved = false
    // A smaller size first: it shortens every array and string at once.
    for (const at of [0, current.size >> 1, current.size - 1]) {
      if (at >= 0 && at < current.size && (await tryCase(current.draws, at))) {
        improved = true
        break
      }
    }
    // Take out runs of draws, longest first: drops whole items from a list.
    for (const run of [8, 4, 2, 1]) {
      for (let index = 0; index + run <= current.draws.length; ) {
        const list = current.draws.slice(0, index).concat(current.draws.slice(index + run))
        if (await tryCase(list, current.size)) improved = true
        else index++
      }
    }
    // Make draws smaller: 0 is every generator's first choice, else the smallest that still fails, found by halving.
    for (let index = 0; index < current.draws.length; index++) {
      const value = current.draws[index]
      if (value === 0) continue
      const withDraw = (draw: number) => {
        const list = current.draws.slice()
        list[index] = draw
        return list
      }
      if (await tryCase(withDraw(0), current.size)) {
        improved = true
        continue
      }
      let low = 0
      let high = value
      for (let step = 0; step < 12 && high - low > 1e-9; step++) {
        const middle = (low + high) / 2
        if (index < current.draws.length && (await tryCase(withDraw(middle), current.size))) {
          high = middle
          improved = true
        } else low = middle
      }
    }
  }
  if (!best) return null
  const found = best as { value: T; failure: unknown }
  return { value: found.value, failure: found.failure ?? failure, steps }
}

/** Where `check` was called from, for the fuzzing report. */
function callSite(): string {
  const line = new Error().stack?.split('\n')[3] ?? ''
  const match = /\(?(.+?:\d+):\d+\)?$/.exec(line.trim())
  // Windows writes the path with backslashes: the report names it as the repository does.
  return (match ? match[1] : 'unknown').replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^.*?\b(packages|apps)\//, '$1/')
}

/** With ENCODE_FUZZ_REPORT set, one JSON line per `check`: where, how many cases, how long, the seed, and whether it failed. */
function report(entry: Record<string, unknown>): void {
  const file = process.env.ENCODE_FUZZ_REPORT
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    // A report that cannot be written does not fail the test.
  }
}

/**
 * Runs `property` over generated inputs. The property fails by throwing (for
 * example through node:assert) or by returning false.
 */
export async function check<T>(
  generator: Gen<T>,
  property: (value: T) => unknown,
  options: CheckOptions<T> = {},
): Promise<void> {
  const fuzzMs = Number(process.env.ENCODE_FUZZ_MS) || 0
  const runs = options.runs ?? (Number(process.env.ENCODE_PROPERTY_RUNS) || 200)
  const envSeed = process.env.ENCODE_PROPERTY_SEED
  const seed = options.seed ?? (envSeed ? Number(envSeed) >>> 0 : Math.floor(Math.random() * 2 ** 32))
  const maxSize = options.maxSize ?? 30
  const random = prng(seed)
  const site = fuzzMs ? callSite() : ''
  const started = Date.now()

  for (const [index, example] of (options.examples ?? []).entries()) {
    const failure = await attempt(property, example)
    if (failure !== null) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      throw new Error(`Property failed on example ${index + 1}, which failed before.\nInput: ${describe(example)}\n${reason}`, { cause: failure })
    }
  }

  let run = 0
  for (; run < runs || (fuzzMs > 0 && Date.now() - started < fuzzMs); run++) {
    const step = run % runs
    const size = runs === 1 ? maxSize : Math.round((step / (runs - 1)) * maxSize)
    const draws = new Draws(random)
    const value = generator(draws.random, size)
    const failure = await attempt(property, value)
    if (failure === null) continue
    const shrunk = options.shrink === false ? null : await shrink(generator, property, draws.used, size, failure)
    const final = shrunk?.failure ?? failure
    const reason = final instanceof Error ? final.message : String(final)
    if (site) report({ site, cases: run + 1, ms: Date.now() - started, seed, failed: true, input: describe(shrunk?.value ?? value) })
    throw new Error(
      `Property failed on case ${run + 1} (seed ${seed}; replay with ENCODE_PROPERTY_SEED=${seed}${fuzzMs ? ` ENCODE_FUZZ_MS=${fuzzMs}` : ''}).\n` +
        (shrunk ? `Input, made smaller in ${shrunk.steps} steps: ${describe(shrunk.value)}\nAs first found: ${describe(value)}\n` : `Input: ${describe(value)}\n`) +
        reason,
      { cause: final },
    )
  }
  if (site) report({ site, cases: run, ms: Date.now() - started, seed, failed: false })
}
