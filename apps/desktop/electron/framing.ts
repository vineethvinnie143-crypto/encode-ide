/**
 * A Browser tab shows its page in a frame of the window, and many sites forbid that: they answer with
 * an X-Frame-Options header, or a Content-Security-Policy whose frame-ancestors directive names no one
 * but themselves, and the frame stays blank white. `allowFraming` reads a response's headers the way
 * the tab needs: it drops those two rules and keeps every other header, directive and value as it was.
 *
 * This is a stopgap for the frame. The page cannot reach the app: it is another origin, in a sandbox
 * without top navigation, and it has no bridge. Framing it is as safe as opening it. A browser view of
 * its own, which needs none of this, is part of the UI work to come.
 */
export type ResponseHeaders = Record<string, string[]>

/**
 * A frame-ancestors directive and the separator before it. A policy header holds directives separated
 * by ';', and several policies separated by ','. The name has to start a directive: the same letters
 * inside a source or a value do not match.
 */
const FRAME_ANCESTORS = /(?:^|[;,])\s*frame-ancestors(?=[\s;,]|$)[^;,]*/gi
const LEADING_SEPARATOR = /^[\s;,]+/

/** A Content-Security-Policy value without its frame-ancestors directives; empty when nothing else is left. */
function withoutFrameAncestors(value: string): string {
  const rest = value.replace(FRAME_ANCESTORS, '').replace(LEADING_SEPARATOR, '').trim()
  return /^[\s;,]*$/.test(rest) ? '' : rest
}

/** The headers of a response without X-Frame-Options and without any frame-ancestors directive. */
export function allowFraming(headers: ResponseHeaders): ResponseHeaders {
  const result: ResponseHeaders = {}
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'x-frame-options') continue
    if (lower === 'content-security-policy') {
      const kept = values.map(withoutFrameAncestors).filter((value) => value !== '')
      if (kept.length) result[name] = kept
      continue
    }
    result[name] = values
  }
  return result
}
