import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { app, dialog } from 'electron'

/** Minimal ZIP writer (store/deflate) so sessions can be exported without a library. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0 ^ -1
  for (let i = 0; i < buffer.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = zlib.deflateRawSync(entry.data)
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, deflated)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + deflated.length
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}

export interface ExportPayload {
  title: string
  transcript: string
  json: string
}

/** Writes a session export zip, prompting for a location unless one is supplied. */
export async function exportSessionZip(payload: ExportPayload, targetPath?: string): Promise<string | null> {
  let file = targetPath
  if (!file) {
    const safe = payload.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'session'
    const result = await dialog.showSaveDialog({
      title: 'Export session',
      defaultPath: path.join(app.getPath('downloads'), `${safe}.zip`),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return null
    file = result.filePath
  }
  const archive = zip([
    { name: 'transcript.md', data: Buffer.from(payload.transcript, 'utf8') },
    { name: 'session.json', data: Buffer.from(payload.json, 'utf8') },
  ])
  fs.writeFileSync(file, archive)
  return file
}
