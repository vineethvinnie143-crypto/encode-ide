import type { UpdateStatus } from './types'

/** How far a download is, 0 to 100; null when nothing is downloading. */
export function updatePercent(status: UpdateStatus): number | null {
  if (status.state !== 'downloading') return null
  return status.next.size > 0 ? Math.min(100, Math.floor((status.received / status.next.size) * 100)) : 0
}

/** One plain line for where the updater is, as Settings, About and a diagnostics report say it. */
export function updateLine(status: UpdateStatus): string {
  switch (status.state) {
    case 'off':
      return status.reason
    case 'idle':
      return status.checkedAt === null ? 'Not looked yet.' : 'Up to date.'
    case 'checking':
      return 'Looking for a newer build…'
    case 'downloading':
      return `Downloading build ${status.next.build}… ${updatePercent(status)}%`
    case 'ready':
      return status.waiting ? `Build ${status.next.build} is ready. eNCode restarts into it when the agents finish.` : `Build ${status.next.build} is ready.`
    case 'manual':
      return `Build ${status.next.build} is out. ${status.reason}`
    case 'installing':
      return `Restarting into build ${status.next.build}…`
    case 'error':
      return status.message
  }
}

/** "5 minutes ago", for when the updater last heard from the release. */
export function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - checkedAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
