/**
 * The DLLs a Windows program or library loads, read from its PE file: the import table and the delay-load table. Only
 * the headers and the tables are read, a few kilobytes of a file that may be a hundred megabytes (LLVM's liblldb.dll).
 * Used to tell which Python LLVM's lldb-dap needs before it is started (ADR 0144).
 */
import fs from 'node:fs'

const MAX_DESCRIPTORS = 4_096
const MAX_NAME = 256
const MAX_SECTIONS = 96

/** A DLL a program imports: its name as written (python311.dll, KERNEL32.dll), and whether it is loaded only when used. */
export interface DllImport {
  name: string
  /** In the delay-load table: Windows loads it the first time the program calls into it, so the program starts without it. */
  delayed: boolean
}

/** The DLLs `file` imports; [] when it is not a PE file or cannot be read. */
export function dllImports(file: string): DllImport[] {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return []
  }
  try {
    return readImports(fd, fs.fstatSync(fd).size)
  } catch {
    return []
  } finally {
    fs.closeSync(fd)
  }
}

function readImports(fd: number, size: number): DllImport[] {
  const read = (offset: number, length: number): Buffer => {
    if (offset < 0 || length < 0 || offset + length > size) throw new Error('outside the file')
    const buffer = Buffer.alloc(length)
    if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error('short read')
    return buffer
  }
  const dos = read(0, 64)
  if (dos.toString('latin1', 0, 2) !== 'MZ') return []
  const pe = dos.readUInt32LE(0x3c)
  const header = read(pe, 24)
  if (header.toString('latin1', 0, 4) !== 'PE\0\0') return []
  const sectionCount = Math.min(header.readUInt16LE(6), MAX_SECTIONS)
  const optionalSize = header.readUInt16LE(20)
  const optional = read(pe + 24, optionalSize)
  const magic = optional.readUInt16LE(0)
  if (magic !== 0x10b && magic !== 0x20b) return []
  const wide = magic === 0x20b
  const imageBase = wide ? Number(optional.readBigUInt64LE(24)) : optional.readUInt32LE(28)
  const directoryCount = optional.readUInt32LE(wide ? 108 : 92)
  const directory = (index: number): number => (index < directoryCount ? optional.readUInt32LE((wide ? 112 : 96) + index * 8) : 0)

  const sections = read(pe + 24 + optionalSize, sectionCount * 40)
  const offsetOf = (rva: number): number => {
    for (let i = 0; i < sectionCount; i++) {
      const virtualSize = sections.readUInt32LE(i * 40 + 8)
      const address = sections.readUInt32LE(i * 40 + 12)
      const rawSize = sections.readUInt32LE(i * 40 + 16)
      const raw = sections.readUInt32LE(i * 40 + 20)
      if (rva >= address && rva < address + Math.max(virtualSize, rawSize)) return rva - address + raw
    }
    throw new Error('not in a section')
  }
  const nameAt = (rva: number): string => {
    const offset = offsetOf(rva)
    const bytes = read(offset, Math.min(MAX_NAME, size - offset))
    const end = bytes.indexOf(0)
    return bytes.toString('latin1', 0, end < 0 ? bytes.length : end)
  }

  const names: DllImport[] = []
  const imports = directory(1)
  if (imports) {
    for (let i = 0; i < MAX_DESCRIPTORS; i++) {
      const entry = read(offsetOf(imports + i * 20), 20)
      if (entry.every((byte) => byte === 0)) break
      names.push({ name: nameAt(entry.readUInt32LE(12)), delayed: false })
    }
  }
  const delayed = directory(13)
  if (delayed) {
    for (let i = 0; i < MAX_DESCRIPTORS; i++) {
      const entry = read(offsetOf(delayed + i * 32), 32)
      if (entry.every((byte) => byte === 0)) break
      // Attribute bit 0 says the table holds addresses relative to the image; without it, old linkers wrote whole ones.
      const name = entry.readUInt32LE(4)
      names.push({ name: nameAt(entry.readUInt32LE(0) & 1 ? name : name - imageBase), delayed: true })
    }
  }
  return names.filter((item) => item.name.length > 0)
}
