/** Tar and zip archives made in memory, for the tests of the archive reader and the installer. */
import zlib from 'node:zlib'

export interface TarEntry {
  name: string
  data?: Buffer | string
  type?: string
  mode?: number
  link?: string
  prefix?: string
}

export function header(name: string, size: number, type: string, mode: number, link = '', prefix = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(mode.toString(8).padStart(7, '0'), 100, 'latin1')
  block.write('0000000', 108, 'latin1')
  block.write('0000000', 116, 'latin1')
  block.write(size.toString(8).padStart(11, '0'), 124, 'latin1')
  block.write('00000000000', 136, 'latin1')
  block.write(type, 156, 'latin1')
  block.write(link, 157, 100, 'utf8')
  block.write('ustar', 257, 'latin1')
  block.write('00', 263, 'latin1')
  block.write(prefix, 345, 155, 'utf8')
  block.fill(32, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

export function pad(data: Buffer): Buffer {
  const rest = data.length % 512
  return rest ? Buffer.concat([data, Buffer.alloc(512 - rest)]) : data
}

export function makeTar(entries: TarEntry[], gzip = false): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    parts.push(header(entry.name, data.length, entry.type ?? '0', entry.mode ?? 0o644, entry.link, entry.prefix), pad(data))
  }
  parts.push(Buffer.alloc(1024))
  const tar = Buffer.concat(parts)
  return gzip ? zlib.gzipSync(tar) : tar
}

export function longName(name: string): Buffer[] {
  const data = Buffer.from(`${name}\0`)
  return [header('././@LongLink', data.length, 'L', 0o644), pad(data)]
}

export function paxPath(name: string): Buffer[] {
  let record = ''
  for (let length = name.length + 8; ; length++) {
    record = `${length} path=${name}\n`
    if (Buffer.byteLength(record) === length) break
  }
  const data = Buffer.from(record)
  return [header('PaxHeader', data.length, 'x', 0o644), pad(data)]
}

export interface ZipEntry {
  name: string
  data?: Buffer | string
  method?: 0 | 8
  mode?: number
  flags?: number
  crc?: number
}

export function makeZip(entries: ZipEntry[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const method = entry.method ?? 8
    const packed = method === 8 ? zlib.deflateRawSync(data) : data
    const name = Buffer.from(entry.name)
    const crc = entry.crc ?? zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += 30 + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
