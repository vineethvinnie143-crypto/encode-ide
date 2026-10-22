import { useSyncExternalStore } from 'react'
import { commandRegistry } from './app'

/** Draws the caller again when a shortcut changes, so the shortcuts it shows are the ones bound. */
export function useShortcuts(): number {
  return useSyncExternalStore(commandRegistry.subscribe, () => commandRegistry.version)
}
