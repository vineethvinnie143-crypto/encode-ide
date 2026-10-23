/**
 * File paths and the `file:` URIs language servers name documents by. On Windows a drive path becomes
 * `file:///C:/dir/a%20b.ts` and a share `file://server/share/a.ts`; reading back accepts the spellings servers use
 * (`c%3A`, a lower-case drive, an empty or `localhost` host) and gives the path with an upper-case drive. Every
 * character outside the unreserved set is percent-encoded, so `#`, `?` and `%` in a name survive the round trip.
 */
import path from 'node:path'

const UNRESERVED = /[A-Za-z0-9\-._~]/

function encodeSegment(segment: string): string {
  let out = ''
  for (const char of segment) {
    if (UNRESERVED.test(char)) {
      out += char
      continue
    }
    for (const byte of Buffer.from(char, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The `file:` URI of an absolute path. Throws for a relative one. */
export function pathToUri(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const normal = path.win32.normalize(file)
    const unc = /^\\\\([^\\]+)\\(.*)$/.exec(normal)
    if (unc && !/^[?.]$/.test(unc[1])) {
      return `file://${unc[1].toLowerCase()}/${unc[2].split('\\').filter(Boolean).map(encodeSegment).join('/')}`
    }
    const drive = /^([A-Za-z]):\\?(.*)$/.exec(normal)
    if (!drive) throw new Error(`Not an absolute path: ${file}`)
    const rest = drive[2].split('\\').filter(Boolean).map(encodeSegment).join('/')
    return `file:///${drive[1].toUpperCase()}:/${rest}`
  }
  if (!path.posix.isAbsolute(file)) throw new Error(`Not an absolute path: ${file}`)
  const normal = path.posix.normalize(file)
  return `file://${normal.split('/').map(encodeSegment).join('/')}`
}

/** The path a `file:` URI names, or null for another scheme or one that does not read. */
export function uriToPath(uri: string, platform: NodeJS.Platform = process.platform): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri)
  if (!match) return null
  let host: string
  let rest: string
  try {
    host = decodeURIComponent(match[1])
    rest = decodeURIComponent((match[2] ?? '/').replace(/[?#].*$/, ''))
  } catch {
    return null
  }
  if (rest.includes('\0')) return null
  if (platform === 'win32') {
    if (host && host.toLowerCase() !== 'localhost') return path.win32.normalize(`\\\\${host}${rest.replace(/\//g, '\\')}`)
    const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(rest)
    if (!drive) return null
    return path.win32.normalize(`${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`)
  }
  if (host && host.toLowerCase() !== 'localhost') return null
  return path.posix.normalize(rest)
}

/** A key for a document that is the same however a server spells its URI: the path, without case on Windows and macOS. */
export function documentKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  const normal = api.normalize(file)
  return platform === 'win32' || platform === 'darwin' ? normal.toLowerCase() : normal
}
