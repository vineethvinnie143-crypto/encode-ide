/**
 * The DLLs a Windows program imports, read from its PE file, and the Python LLVM's lldb-dap needs on Windows (ADR 0144).
 * The PE files here are built byte by byte: the headers, one section, and the import and delay-load tables in it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { tempWorkspace } from '@encode/tools/testing'
import { lldbPython, RunProblem, withPathTail } from './debuggers'
import { dllImports } from './dll-imports'

interface Image {
  imports?: string[]
  delayed?: string[]
  /** A 32-bit image whose delay-load table holds whole addresses, as linkers before Visual C++ 7 wrote it. */
  old?: boolean
}

const SECTION_RVA = 0x1000
const SECTION_RAW = 0x400

/** A PE file with one section that holds the import tables and the names. */
function pe({ imports = [], delayed = [], old = false }: Image): Buffer {
  const wide = !old
  const optionalSize = wide ? 240 : 224
  const imageBase = wide ? 0x180000000 : 0x400000
  const file = Buffer.alloc(SECTION_RAW + 0x1000)
  file.write('MZ', 0, 'latin1')
  file.writeUInt32LE(0x40, 0x3c)
  file.write('PE\0\0', 0x40, 'latin1')
  file.writeUInt16LE(wide ? 0x8664 : 0x14c, 0x44)
  file.writeUInt16LE(1, 0x46)
  file.writeUInt16LE(optionalSize, 0x54)
  const optional = 0x58
  file.writeUInt16LE(wide ? 0x20b : 0x10b, optional)
  if (wide) file.writeBigUInt64LE(BigInt(imageBase), optional + 24)
  else file.writeUInt32LE(imageBase, optional + 28)
  file.writeUInt32LE(16, optional + (wide ? 108 : 92))
  const directories = optional + (wide ? 112 : 96)
  const section = optional + optionalSize
  file.write('.rdata', section, 'latin1')
  file.writeUInt32LE(0x1000, section + 8)
  file.writeUInt32LE(SECTION_RVA, section + 12)
  file.writeUInt32LE(0x1000, section + 16)
  file.writeUInt32LE(SECTION_RAW, section + 20)

  const at = (rva: number) => rva - SECTION_RVA + SECTION_RAW
  let names = SECTION_RVA + 0x800
  const name = (text: string) => {
    const rva = names
    file.write(`${text}\0`, at(rva), 'latin1')
    names += text.length + 1
    return rva
  }
  const importTable = SECTION_RVA
  imports.forEach((dll, i) => file.writeUInt32LE(name(dll), at(importTable + i * 20) + 12))
  const delayTable = SECTION_RVA + 0x400
  delayed.forEach((dll, i) => {
    const entry = at(delayTable + i * 32)
    const rva = name(dll)
    file.writeUInt32LE(old ? 0 : 1, entry)
    file.writeUInt32LE(old ? imageBase + rva : rva, entry + 4)
  })
  if (imports.length) file.writeUInt32LE(importTable, directories + 8)
  if (delayed.length) file.writeUInt32LE(delayTable, directories + 13 * 8)
  return file
}

async function write(dir: string, name: string, content: Buffer | string): Promise<string> {
  const file = path.join(dir, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

describe('the DLLs a Windows program imports', () => {
  it('reads the import table and the delay-load table of a 64-bit image', async () => {
    const dir = await tempWorkspace()
    const file = await write(dir, 'liblldb.dll', pe({ imports: ['KERNEL32.dll', 'python311.dll'], delayed: ['USER32.dll'] }))
    assert.deepEqual(dllImports(file), [
      { name: 'KERNEL32.dll', delayed: false },
      { name: 'python311.dll', delayed: false },
      { name: 'USER32.dll', delayed: true },
    ])
  })

  it('reads a 32-bit image, and a delay-load table that holds whole addresses', async () => {
    const dir = await tempWorkspace()
    const file = await write(dir, 'old.dll', pe({ imports: ['msvcrt.dll'], delayed: ['python39.dll'], old: true }))
    assert.deepEqual(dllImports(file), [
      { name: 'msvcrt.dll', delayed: false },
      { name: 'python39.dll', delayed: true },
    ])
  })

  it('gives nothing for a file that is not a PE file, is cut short, points outside itself, or is missing', async () => {
    const dir = await tempWorkspace()
    const whole = pe({ imports: ['python311.dll'] })
    const pointing = Buffer.from(whole)
    pointing.writeUInt32LE(0x7fff_fff0, 0x3c)
    const looping = Buffer.from(whole)
    // An import table whose address is in no section.
    looping.writeUInt32LE(0x9000_0000, 0x58 + 112 + 8)
    assert.deepEqual(dllImports(await write(dir, 'script.exe', '#!/bin/sh\necho hello\n')), [])
    assert.deepEqual(dllImports(await write(dir, 'short.dll', whole.subarray(0, 0x200))), [])
    assert.deepEqual(dllImports(await write(dir, 'pointing.dll', pointing)), [])
    assert.deepEqual(dllImports(await write(dir, 'nowhere.dll', looping)), [])
    assert.deepEqual(dllImports(path.join(dir, 'missing.dll')), [])
    assert.deepEqual(dllImports(dir), [])
  })
})

describe("lldb-dap's Python on Windows", () => {
  async function llvm(image: Image) {
    const root = await fs.realpath(await tempWorkspace())
    const lldbDap = await write(root, path.join('LLVM', 'bin', 'lldb-dap.exe'), pe({ imports: ['liblldb.dll', 'KERNEL32.dll'] }))
    await write(root, path.join('LLVM', 'bin', 'liblldb.dll'), pe(image))
    const local = path.join(root, 'AppData', 'Local')
    const env = { PATH: '', LOCALAPPDATA: local, ProgramFiles: path.join(root, 'Program Files') }
    return { root, lldbDap, local, env, context: { root, platform: 'win32' as const, env, ask: async () => null } }
  }

  it('needs nothing when lldb was built without Python', async () => {
    const { lldbDap, context } = await llvm({ imports: ['KERNEL32.dll'] })
    assert.equal(await lldbPython(lldbDap, context), null)
  })

  it('names the Python it was built with, and adds nothing when Windows finds its library next to lldb-dap', async () => {
    const { lldbDap, context } = await llvm({ imports: ['KERNEL32.dll', 'PYTHON311.DLL'] })
    await write(path.dirname(lldbDap), 'python311.dll', '')
    assert.deepEqual(await lldbPython(lldbDap, context), { dll: 'python311.dll', version: '3.11', add: null })
  })

  it("finds that Python where python.org's installer puts it, and puts its folder on the end of the PATH", async () => {
    const { lldbDap, local, context } = await llvm({ imports: ['python311.dll'] })
    await write(path.join(local, 'Programs', 'Python', 'Python312'), 'python312.dll', '')
    const python = path.join(local, 'Programs', 'Python', 'Python311')
    await write(python, 'python311.dll', '')
    const found = await lldbPython(lldbDap, context)
    assert.deepEqual(found, { dll: 'python311.dll', version: '3.11', add: python })
    assert.deepEqual(withPathTail({ Path: 'C:\\Windows\\System32', TEMP: 'C:\\Temp' }, found!.add!, 'win32'), { Path: `C:\\Windows\\System32;${python}`, TEMP: 'C:\\Temp' })
    assert.deepEqual(withPathTail({}, python, 'win32'), { PATH: python })
  })

  it('finds an installation for every user, in Program Files', async () => {
    const { lldbDap, env, context } = await llvm({ imports: ['python310.dll'] })
    const python = path.join(env.ProgramFiles, 'Python310')
    await write(python, 'python310.dll', '')
    assert.deepEqual(await lldbPython(lldbDap, context), { dll: 'python310.dll', version: '3.10', add: python })
  })

  it('says which Python to install before anything starts, when the one it needs is missing', async () => {
    const { lldbDap, context } = await llvm({ imports: ['python311.dll'] })
    await assert.rejects(lldbPython(lldbDap, context), (error: unknown) => {
      assert.ok(error instanceof RunProblem)
      assert.equal(error.message, "LLVM's lldb-dap needs Python 3.11 (python311.dll), which is not on this computer. Install Python 3.11 (winget install Python.Python.3.11), then start this again.")
      return true
    })
  })

  it('starts without it when lldb loads Python only once it runs some', async () => {
    const { lldbDap, context } = await llvm({ imports: ['KERNEL32.dll'], delayed: ['python311.dll'] })
    assert.equal(await lldbPython(lldbDap, context), null)
  })
})
