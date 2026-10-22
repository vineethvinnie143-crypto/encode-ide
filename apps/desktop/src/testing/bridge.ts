/**
 * A stand-in for the preload bridge and the browser globals the stores touch, so renderer stores load in plain Node
 * for unit tests. Import it before any store. Every bridge call answers a resolved undefined (an `on…` call answers
 * an unsubscribe) unless a test gives the call an answer.
 */
type Answer = (...args: unknown[]) => unknown

const answers = new Map<string, Answer>()

/** Every bridge call made, as "review.load" and its arguments. */
export const calls: { path: string; args: unknown[] }[] = []

/** What the bridge call at `path` ("review.load") answers from now on. */
export function answer(path: string, fn: Answer): void {
  answers.set(path, fn)
}

function node(path: string): unknown {
  return new Proxy(() => undefined, {
    // Not a promise: `then` is absent, so awaiting the bridge itself does not hang.
    get: (_target, key) => (typeof key === 'string' && key !== 'then' ? node(path ? `${path}.${key}` : key) : undefined),
    apply: (_target, _this, args: unknown[]) => {
      calls.push({ path, args })
      const fn = answers.get(path)
      if (fn) return fn(...args)
      return /(^|\.)on[A-Z]/.test(path) ? () => undefined : Promise.resolve(undefined)
    },
  })
}

const stored = new Map<string, string>()
const globals = globalThis as Record<string, unknown>
globals.localStorage ??= {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, String(value)),
  removeItem: (key: string) => void stored.delete(key),
  clear: () => stored.clear(),
}
globals.window ??= { eNCode: node(''), addEventListener: () => undefined, removeEventListener: () => undefined }
