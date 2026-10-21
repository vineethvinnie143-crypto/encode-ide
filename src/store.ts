import { useSyncExternalStore } from 'react'

/**
 * Minimal external store used by every eNCode store module. It mirrors the small
 * slice of the zustand API the app uses — `useX(selector)`, `useX.getState()`,
 * `useX.setState()`, `useX.subscribe()` — and binds to React through
 * `useSyncExternalStore`, so no state library is required.
 */

export type SetState<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void
export type GetState<T> = () => T

export interface StoreApi<T> {
  getState: GetState<T>
  setState: SetState<T>
  subscribe(listener: () => void): () => void
}

export interface BoundStore<T> extends StoreApi<T> {
  (): T
  <S>(selector: (state: T) => S): S
}

export function useStore<T extends object, S>(store: StoreApi<T>, selector: (state: T) => S): S {
  const snapshot = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

export function create<T extends object>(initializer: (set: SetState<T>, get: GetState<T>) => T): BoundStore<T> {
  let state: T
  const listeners = new Set<() => void>()

  const setState: SetState<T> = (partial) => {
    const patch = typeof partial === 'function' ? (partial as (current: T) => Partial<T>)(state) : partial
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const getState: GetState<T> = () => state
  state = initializer(setState, getState)

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const useBound = (selector?: (current: T) => unknown) =>
    useStore({ getState, setState, subscribe }, selector ?? ((current: T) => current))

  return Object.assign(useBound, { getState, setState, subscribe }) as BoundStore<T>
}
