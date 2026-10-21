/**
 * Seeded property testing for node:test, kept in-house and deliberately
 * small: a deterministic PRNG, a handful of generators, and `check`, which
 * runs a property over generated cases and reports the seed and the failing
 * input so any failure replays exactly.
 *
 * Cases grow from size 0 to `maxSize`, so the first failure found is usually
 * a small one; there is no shrinking.
 */

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

export interface CheckOptions {
  /** Cases to run. Default 200, or ENCODE_PROPERTY_RUNS. */
  runs?: number
  /** Fixed seed. Default ENCODE_PROPERTY_SEED, else a fresh random seed. */
  seed?: number
  /** Size reached by the last case. Default 30. */
  maxSize?: number
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
 * Runs `property` over generated inputs. The property fails by throwing (for
 * example through node:assert) or by returning false.
 */
export async function check<T>(
  generator: Gen<T>,
  property: (value: T) => unknown,
  options: CheckOptions = {},
): Promise<void> {
  const runs = options.runs ?? (Number(process.env.ENCODE_PROPERTY_RUNS) || 200)
  const envSeed = process.env.ENCODE_PROPERTY_SEED
  const seed = options.seed ?? (envSeed ? Number(envSeed) >>> 0 : Math.floor(Math.random() * 2 ** 32))
  const maxSize = options.maxSize ?? 30
  const random = prng(seed)

  for (let run = 0; run < runs; run++) {
    const size = runs === 1 ? maxSize : Math.round((run / (runs - 1)) * maxSize)
    const value = generator(random, size)
    let failure: unknown = null
    try {
      if ((await property(value)) === false) failure = new Error('property returned false')
    } catch (error) {
      failure = error ?? new Error('property threw a nullish value')
    }
    if (failure !== null) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      throw new Error(
        `Property failed on case ${run + 1} of ${runs} (seed ${seed}; replay with ENCODE_PROPERTY_SEED=${seed}).\n` +
          `Input: ${describe(value)}\n${reason}`,
        { cause: failure },
      )
    }
  }
}
