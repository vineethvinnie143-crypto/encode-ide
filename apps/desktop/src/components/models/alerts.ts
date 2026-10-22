import type { ModelAlert } from '@shared/types'
import type { SettingsTab } from '../../stores/ui'

export interface AlertToast {
  kind: 'info' | 'error'
  text: string
  /** The Settings tab that helps, when one does. */
  tab?: SettingsTab
}

/** A notice from the model router as the toast says it: problems with a key or with payment are errors that point to the fix. */
export function toastOf(alert: ModelAlert): AlertToast {
  switch (alert.kind) {
    case 'key-refused':
    case 'sign-in':
      return { kind: 'error', text: alert.message, tab: 'models' }
    case 'payment':
    case 'billed':
      return { kind: 'error', text: alert.message, tab: 'roles' }
    default:
      return { kind: 'info', text: alert.message }
  }
}

/** The same alert is not shown twice in a short while: a provider that keeps refusing would otherwise fill the corner of the window. */
export function alertGate(windowMs = 60_000, now: () => number = Date.now): (alert: ModelAlert) => boolean {
  const seen = new Map<string, number>()
  return (alert) => {
    const at = now()
    for (const [key, when] of seen) if (at - when >= windowMs) seen.delete(key)
    const key = `${alert.kind}|${alert.profileId ?? ''}|${alert.message}`
    if (seen.has(key)) return false
    seen.set(key, at)
    return true
  }
}
