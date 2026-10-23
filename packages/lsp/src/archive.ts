/**
 * Unpacking the archives language servers come in (zip, tar, tar.gz), for one job: putting a download that already
 * matched its checksum under one folder. Every entry's path is checked before anything is written: no absolute path,
 * drive letter, `..`, name Windows keeps for devices, link or device file, and no more than so many files and bytes.
 * An archive that breaks a rule is refused whole, never unpacked in part.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export interface ArchiveFile {
  /** Relative, with `/` between parts. */
  path: string
  data: Buffer
  executable: boolean
}

export interface ArchiveLimits {
  maxFiles: number
  /** Unpacked, all files together. */
  maxBytes: number
  /** Leading folders taken off every path (npm's `package/`). */
  strip?: number
}

export class ArchiveRefused extends Error {}

/** Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i

/**
 * The entry's path, relative and with `/` between parts, or null when it must not be written: absolute, a drive, a
 * `..`, a part Windows would read as something else (a device, a stream after `:`, a trailing dot or space), or a
 * control character. An empty string is the archive's own top folder.
 */
export function safeEntryPath(name: string, strip = 0): string | null {
  if (!name || /[\u0000-\u001f]/.test(name)) return null
  const slashed = name.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return null
  const parts = slashed.split('/').filter((part) => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..' || part.includes(':') || RESERVED.test(part) || /[. ]$/.test(part) || /[<>"|?*]/.test(part)) return null
  }
  return parts.slice(strip).join('/')
}

function refuse(reason: string): never {
  throw new ArchiveRefused(reason)
}

class Budget {
  private files = 0
  private bytes = 0
  constructor(private readonly limits: ArchiveLimits) {}
  take(size: number): void {
    if (++this.files > this.limits.maxFiles) refuse(`it holds more than ${this.limits.maxFiles} files`)
    this.bytes += size
    const limit = this.limits.maxBytes
    if (this.bytes > limit) refuse(`it unpacks to more than ${limit >= 1048576 ? `${Math.round(limit / 1048576)} MB` : `${limit} bytes`}`)
  }
  get left(): number {
    return this.limits.maxBytes - this.bytes
  }
}

// ---------------------------------------------------------------------------------------------------------------- zip

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** The files in a zip archive. Only stored and deflated entries without encryption; no Zip64. */
export function readZip(archive: Buffer, limits: ArchiveLimits): ArchiveFile[] {
  let end = -1
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (archive.readUInt32LE(at) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) refuse('it is not a zip archive')
  const count = archive.readUInt16LE(end + 10)
  const size = archive.readUInt32LE(end + 12)
  const offset = archive.readUInt32LE(end + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) refuse('it is a Zip64 archive')
  if (offset + size > end) refuse('its directory is out of place')
  const budget = new Budget(limits)
  const files: ArchiveFile[] = []
  let at = offset
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || archive.readUInt32LE(at) !== CENTRAL) refuse('its directory is broken')
    const madeBy = archive.readUInt16LE(at + 4) >> 8
    const flags = archive.readUInt16LE(at + 8)
    const method = archive.readUInt16LE(at + 10)
    const crc = archive.readUInt32LE(at + 16)
    const packed = archive.readUInt32LE(at + 20)
    const unpacked = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const external = archive.readUInt32LE(at + 38)
    const local = archive.readUInt32LE(at + 42)
    const raw = archive.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1')
    at += 46 + nameLength + extraLength + commentLength
    // Made on a Unix system: the upper half of the external attributes is the file's mode.
    const mode = madeBy === 3 ? external >>> 16 : 0
    const kind = mode & 0o170000
    if (kind === 0o120000) refuse(`${raw} is a link`)
    if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) refuse(`${raw} is not a file or a folder`)
    const name = safeEntryPath(raw, limits.strip)
    if (name === null) refuse(`it would write outside its folder (${JSON.stringify(raw)})`)
    if (raw.endsWith('/') || kind === 0o040000) continue
    if (flags & 0x1) refuse(`${raw} is encrypted`)
    if (method !== 0 && method !== 8) refuse(`${raw} is packed in a way eNCode does not read`)
    if (!name) continue
    budget.take(unpacked)
    if (local + 30 > archive.length || archive.readUInt32LE(local) !== LOCAL) refuse(`${raw} is out of place`)
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
    if (start + packed > archive.length) refuse(`${raw} is cut short`)
    const body = archive.subarray(start, start + packed)
    let data: Buffer
    try {
      data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, unpacked) })
    } catch {
      refuse(`${raw} does not unpack`)
    }
    if (data.length !== unpacked || zlib.crc32(data) !== crc) refuse(`${raw} does not match its checksum`)
    files.push({ path: name, data, executable: (mode & 0o111) !== 0 })
  }
  return files
}

// ---------------------------------------------------------------------------------------------------------------- tar

function octal(block: Buffer, from: number, length: number): number {
  // Large sizes are written in base 256, the first byte's top bit set.
  if (block[from]! & 0x80) {
    let value = 0
    for (let index = from + 1; index < from + length; index++) value = value * 256 + block[index]!
    return value
  }
  const text = block.subarray(from, from + length).toString('latin1').replace(/\0.*$/s, '').trim()
  if (!/^[0-7]*$/.test(text)) refuse('a header is broken')
  return text ? parseInt(text, 8) : 0
}

function cString(block: Buffer, from: number, length: number): string {
  const slice = block.subarray(from, from + length)
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero < 0 ? slice.length : zero).toString('utf8')
}

/** The files in a tar archive (POSIX, GNU long names, pax paths and sizes). Gzipped when it starts as gzip does. */
export function readTar(archive: Buffer, limits: ArchiveLimits): ArchiveFile[] {
  let tar = archive
  if (archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      tar = zlib.gunzipSync(archive, { maxOutputLength: limits.maxBytes + limits.maxFiles * 1536 + 1024 })
    } catch {
      refuse('it does not unpack, or unpacks to too much')
    }
  }
  const budget = new Budget(limits)
  const files: ArchiveFile[] = []
  let longName: string | null = null
  let paxPath: string | null = null
  let paxSize: number | null = null
  let at = 0
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512)
    if (block.every((byte) => byte === 0)) break
    let sum = 0
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : block[index]!
    if (sum !== octal(block, 148, 8)) refuse('a header does not match its checksum')
    const type = String.fromCharCode(block[156]!)
    const size = paxSize ?? octal(block, 124, 12)
    const body = at + 512
    const next = body + Math.ceil(size / 512) * 512
    if (body + size > tar.length) refuse('it is cut short')
    const data = tar.subarray(body, body + size)
    at = next
    if (type === 'L') {
      longName = cString(data, 0, data.length)
      continue
    }
    if (type === 'x' || type === 'g') {
      if (type === 'x') {
        for (const record of pax(data)) {
          if (record.key === 'path') paxPath = record.value
          if (record.key === 'size') {
            if (!/^[0-9]{1,15}$/.test(record.value)) refuse('a pax header is broken')
            paxSize = Number(record.value)
          }
        }
      }
      continue
    }
    const prefix = block.subarray(257, 262).toString('latin1') === 'ustar' ? cString(block, 345, 155) : ''
    const raw = paxPath ?? longName ?? (prefix ? `${prefix}/${cString(block, 0, 100)}` : cString(block, 0, 100))
    longName = null
    paxPath = null
    paxSize = null
    if (type === '1' || type === '2' || type === 'K') refuse(`${raw} is a link`)
    if (type !== '0' && type !== '\0' && type !== '7' && type !== '5') refuse(`${raw} is not a file or a folder`)
    const name = safeEntryPath(raw, limits.strip)
    if (name === null) refuse(`it would write outside its folder (${JSON.stringify(raw)})`)
    if (type === '5' || !name) continue
    budget.take(size)
    files.push({ path: name, data: Buffer.from(data), executable: (octal(block, 100, 8) & 0o111) !== 0 })
  }
  return files
}

function pax(data: Buffer): { key: string; value: string }[] {
  const records: { key: string; value: string }[] = []
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const length = Number(data.subarray(at, space).toString('latin1'))
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) refuse('a pax header is broken')
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.push({ key: record.slice(0, equals), value: record.slice(equals + 1) })
    at += length
  }
  return records
}

// ------------------------------------------------------------------------------------------------------------ writing

/**
 * Writes the files under `dir`, which must not exist yet. Two entries with the same path, or one that is both a file
 * and a folder, refuse the archive. Executable files keep their mode on systems that have one.
 */
export function writeFiles(files: readonly ArchiveFile[], dir: string): void {
  const root = path.resolve(dir)
  const seen = new Set<string>()
  for (const file of files) {
    const key = file.path.toLowerCase()
    if (seen.has(key)) refuse(`${file.path} is in it twice`)
    seen.add(key)
  }
  fs.mkdirSync(root, { recursive: false })
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'))
    if (!target.startsWith(root + path.sep)) refuse(`it would write outside its folder (${file.path})`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.data, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 })
  }
}
