/**
 * What a Browser tab makes of what is typed in its address bar: an address with or without its scheme (a bare host
 * gets http on this computer and https elsewhere), and nothing else. Only http and https open.
 */
const LOCAL = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|[\w-]+\.localhost)(:\d+)?([/?#]|$)/i

export function addressOf(raw: string): string | null {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const candidate = hasScheme ? text : `${LOCAL.test(text) ? 'http' : 'https'}://${text}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    // A word with no dot is not a host, except this computer's own names.
    if (!hasScheme && !url.hostname.includes('.') && !LOCAL.test(text) && !url.port) return null
    return url.href
  } catch {
    return null
  }
}

/** The address as the bar shows it while the page is not being edited: without https:// and a lone trailing slash. */
export function shownAddress(url: string): string {
  if (!url || url === 'about:blank') return ''
  return url.replace(/^https:\/\//, '').replace(/^([^/?#]+)\/$/, '$1')
}
