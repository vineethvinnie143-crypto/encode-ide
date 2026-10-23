import { connectHighlighting, type HighlightConnection, type HighlightService } from '@encode/editor'

let connection: HighlightConnection | null = null
let started = false

/**
 * The one highlighting worker every editor shares, started on first use. A worker that fails is not started again:
 * the editors tokenize on the page's own thread from then on, as they do where no worker can start.
 */
export function sharedHighlighting(): HighlightService | null {
  if (started) return connection?.alive ? connection : null
  started = true
  try {
    connection = connectHighlighting(new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module', name: 'highlighting' }))
  } catch (error) {
    console.warn('The highlighting worker did not start; editors colour text on the page thread.', error)
    connection = null
  }
  return connection
}
