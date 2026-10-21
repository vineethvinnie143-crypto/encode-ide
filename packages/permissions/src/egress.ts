/**
 * Where web_fetch may connect: public unicast addresses only. Private,
 * loopback, link-local (cloud metadata), carrier-grade NAT, multicast,
 * documentation and other special-purpose ranges are refused, including IPv4
 * addresses wrapped in IPv6 forms (mapped, NAT64, 6to4). Anything that does
 * not parse as a canonical address is refused too.
 */

type Range = readonly [base: number, bits: number]

const IPV4_SPECIAL: readonly Range[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"; 0.0.0.0 reaches the local machine
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local, cloud metadata services
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 documentation
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relays
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 documentation
  [0xcb007100, 24], // 203.0.113.0/24 documentation
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved, broadcast
]

const DOTTED_QUAD = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/

/** A canonical dotted-quad IPv4 address as an unsigned 32-bit number, or null. */
export function parseIPv4(text: string): number | null {
  const match = DOTTED_QUAD.exec(text)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** An IPv6 address (optionally with a zone or an IPv4 tail) as eight 16-bit groups, or null. */
export function parseIPv6(text: string): number[] | null {
  let rest = text.replace(/%[\w.-]+$/, '')
  if (!rest.includes(':')) return null
  const groups: number[] = []
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(rest)
  let embedded: number | null = null
  if (tail) {
    embedded = parseIPv4(tail[1])
    if (embedded === null) return null
    rest = rest.slice(0, tail.index + 1) + '0:0'
  }
  const halves = rest.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }
  const head = parse(halves[0])
  const end = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !end) return null
  if (halves.length === 2) {
    const missing = 8 - head.length - end.length
    if (missing < 1) return null
    groups.push(...head, ...new Array<number>(missing).fill(0), ...end)
  } else {
    if (head.length !== 8) return null
    groups.push(...head)
  }
  if (embedded !== null) {
    groups[6] = embedded >>> 16
    groups[7] = embedded & 0xffff
  }
  return groups
}

export function isPublicIPv4(address: number): boolean {
  return !IPV4_SPECIAL.some(([base, bits]) => address >>> (32 - bits) === base >>> (32 - bits))
}

function isPublicIPv6(g: number[]): boolean {
  const ipv4At = (high: number, low: number) => ((g[high] << 16) | g[low]) >>> 0
  const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0)

  // ::ffff:0:0/96 (mapped) carries an IPv4 address; ::/96 (unspecified, loopback, deprecated compatible) is never public.
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicIPv4(ipv4At(6, 7))
  if (zeros(0, 6)) return false
  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 carry an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicIPv4(ipv4At(6, 7))
  if (g[0] === 0x2002) return isPublicIPv4(ipv4At(1, 2))
  // Global unicast is 2000::/3; ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8) and the rest are outside it.
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2001) {
    if (g[1] === 0) return false // 2001::/32 Teredo
    if (g[1] === 0x0db8) return false // 2001:db8::/32 documentation
    if (g[1] === 0x0002 && g[2] === 0) return false // 2001:2::/48 benchmarking
    if ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020) return false // ORCHID
  }
  if (g[0] === 0x3fff && g[1] < 0x1000) return false // 3fff::/20 documentation
  return true
}

/** True for a public unicast IPv4 or IPv6 address; false for special-purpose ranges and anything unparseable. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4 !== null) return isPublicIPv4(v4)
  const v6 = parseIPv6(address)
  return v6 !== null && isPublicIPv6(v6)
}

export type UrlCheck = { ok: true; url: URL; host: string } | { ok: false; reason: string }

/** The host part of a URL hostname, without IPv6 brackets. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Validates a URL web_fetch was asked for: http or https, no credentials, and
 * no literal address outside `allowAddress`. Host names are checked again on
 * every connection, after DNS.
 */
export function checkFetchUrl(raw: string, allowAddress: (address: string) => boolean = isPublicAddress): UrlCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'it is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs are fetched' }
  if (url.username || url.password) return { ok: false, reason: 'URLs with a user name or password are not fetched' }
  const host = bareHost(url.hostname)
  if (!host) return { ok: false, reason: 'it has no host' }
  const literal = parseIPv4(host) !== null || parseIPv6(host) !== null
  if (literal && !allowAddress(host)) return { ok: false, reason: `${host} is a private or special-purpose network address` }
  return { ok: true, url, host: host.toLowerCase() }
}
