/**
 * A line the agent host printed, as the log keeps it. The host writes everything to stderr, its own name first; most
 * of it is routine (a model router note, a request that needed a second try), and a report that shows those as errors
 * hides the real ones. Anything not known to be routine stays an error.
 */
export type HostLogLevel = 'info' | 'warn' | 'error'

const OWN_PREFIX = /^\[agent-host\]\s*/
/** What the model router says of itself (runtime.ts: `router <level>: …`). */
const ROUTER = /^router (info|warn|error):/
/** One request that did not simply work (runtime.ts: `request <role>: <outcome>…`). */
const REQUEST = /^request [\w-]+: (\w+)/

export function hostLogLine(line: string): { level: HostLogLevel; text: string } {
  const body = line.replace(OWN_PREFIX, '')
  const text = `[agent-host] ${body}`
  const router = ROUTER.exec(body)
  if (router) return { level: router[1] as HostLogLevel, text }
  const request = REQUEST.exec(body)
  if (request) {
    // Done after a retry, or stopped by the person: routine. Anything else is a request that failed.
    const outcome = request[1]
    return { level: outcome === 'done' || outcome === 'aborted' ? 'info' : 'warn', text }
  }
  return { level: 'error', text }
}
