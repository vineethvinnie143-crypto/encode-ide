import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DesktopError } from '../contract'
import { compilerErrors, ensureHelper, findCompiler, helperHash, HELPER_EXE, type Compiler, type CompilerRun, type RunCompiler } from './build'
import { HELPER_FILES, HELPER_MANIFEST } from './sources'

const FILES = [
  { name: 'B.cs', text: 'class B {}' },
  { name: 'A.cs', text: 'class A {}' },
]
const COMPILER: Compiler = { csc: 'C:\\Windows\\csc.exe', references: ['C:\\wpf\\UIAutomationClient.dll'] }

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encode-build-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A compiler that writes an "executable" where it was told to, and remembers how it was called. */
function fakeCompiler(result: Partial<CompilerRun> = {}) {
  const calls: { file: string; args: string[] }[] = []
  const run: RunCompiler = async (file, args) => {
    calls.push({ file, args })
    const out = args.find((arg) => arg.startsWith('/out:'))!.slice(5)
    if ((result.code ?? 0) === 0) await fs.writeFile(out, `program built from ${args.filter((arg) => arg.endsWith('.cs')).length} files`)
    return { code: 0, stdout: '', stderr: '', ...result }
  }
  return { run, calls }
}

describe('the name of a build', () => {
  it('is the same for the same source in any order, and changes with any file or the manifest', () => {
    const base = helperHash(FILES, 'm')
    assert.equal(base, helperHash([...FILES].reverse(), 'm'))
    assert.match(base, /^[0-9a-f]{16}$/)
    assert.notEqual(base, helperHash([FILES[0], { name: 'A.cs', text: 'class A { }' }], 'm'))
    assert.notEqual(base, helperHash([FILES[0], { name: 'C.cs', text: 'class A {}' }], 'm'))
    assert.notEqual(base, helperHash(FILES, 'm2'))
  })

  it('belongs to the sources that are in the repository', async () => {
    // A .cs file left out of sources.ts would not be in the build, and the helper would not compile on a user's machine.
    const onDisk = (await fs.readdir(path.join(process.cwd(), 'packages', 'tools', 'src', 'computer', 'windows', 'helper'))).filter((name) => name.endsWith('.cs')).sort()
    assert.deepEqual(HELPER_FILES.map((file) => file.name).sort(), onDisk)
    for (const file of HELPER_FILES) assert.ok(file.text.length > 100, `${file.name} is embedded`)
    assert.match(HELPER_MANIFEST, /<assembly/)
  })
})

describe('building the helper', () => {
  it('compiles the sources once and reuses the result', async () => {
    const { run, calls } = fakeCompiler()
    const cacheDir = path.join(dir, 'cache')
    const first = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    assert.equal(first.built, true)
    assert.equal(first.exe, path.join(cacheDir, first.hash, HELPER_EXE))
    assert.equal(await fs.readFile(first.exe, 'utf8'), 'program built from 2 files')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, COMPILER.csc)
    for (const flag of ['/nologo', '/noconfig', '/target:exe', '/optimize+', '/r:System.Drawing.dll', `/r:${COMPILER.references[0]}`]) assert.ok(calls[0].args.includes(flag), flag)
    assert.ok(calls[0].args.some((arg) => arg.startsWith('/win32manifest:')))

    const second = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    assert.equal(second.built, false)
    assert.equal(second.exe, first.exe)
    assert.equal(calls.length, 1, 'a good copy is not built again')
    assert.deepEqual((await fs.readdir(cacheDir)).sort(), [first.hash], 'no work folder is left behind')
  })

  it('builds again when the copy is not the one that was written', async () => {
    const { run, calls } = fakeCompiler()
    const cacheDir = path.join(dir, 'cache')
    const first = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    await fs.writeFile(first.exe, 'something else')
    const again = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    assert.equal(again.built, true)
    assert.equal(calls.length, 2)
    assert.equal(await fs.readFile(again.exe, 'utf8'), 'program built from 2 files')

    await fs.rm(`${again.exe}.sha256`)
    assert.equal((await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })).built, true, 'a copy without its record is not trusted')
  })

  it('builds a new copy for changed sources and leaves the old one for a while', async () => {
    const { run } = fakeCompiler()
    const cacheDir = path.join(dir, 'cache')
    const a = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    const b = await ensureHelper({ cacheDir, files: [{ name: 'A.cs', text: 'class A { int x; }' }], manifest: 'm', compiler: COMPILER, run })
    assert.notEqual(a.hash, b.hash)
    assert.deepEqual((await fs.readdir(cacheDir)).sort(), [a.hash, b.hash].sort())
  })

  it('lets concurrent callers share one build', async () => {
    const { run, calls } = fakeCompiler()
    const cacheDir = path.join(dir, 'cache')
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })))
    assert.equal(calls.length, 1)
    assert.equal(a.exe, b.exe)
    assert.equal(b.exe, c.exe)
  })

  it('says what the compiler complained about, without the folder it worked in', async () => {
    const cacheDir = path.join(dir, 'cache')
    const run: RunCompiler = async (_file, args) => {
      const source = args.find((arg) => arg.endsWith('.cs'))!
      return { code: 1, stdout: `${source}(12,5): error CS1002: ; expected\n${source}(30,1): error CS0103: The name 'x' does not exist\nwarning CS0168: unused`, stderr: '' }
    }
    await assert.rejects(ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run }), (error: unknown) => {
      assert.ok(error instanceof DesktopError)
      assert.equal(error.code, 'unavailable')
      assert.match(error.message, /could not be built/)
      assert.match(error.message, /CS1002/)
      assert.match(error.message, /CS0103/)
      assert.doesNotMatch(error.message, /encode-build-/, 'the temporary folder is not in the message')
      return true
    })
    assert.deepEqual(await fs.readdir(cacheDir), [], 'a failed build leaves nothing behind')
  })

  it('says so when the compiler produced nothing, or could not run', async () => {
    const cacheDir = path.join(dir, 'cache')
    const silent: RunCompiler = async () => ({ code: 0, stdout: '', stderr: '' })
    await assert.rejects(ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run: silent }), /could not be built/)
    const broken: RunCompiler = async () => ({ code: null, stdout: '', stderr: '\nspawn csc.exe ENOENT' })
    await assert.rejects(ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run: broken }), /ENOENT/)
  })

  it('uses the copy another window of eNCode finished first', async () => {
    const cacheDir = path.join(dir, 'cache')
    const hash = helperHash(FILES, 'm')
    const run: RunCompiler = async (_file, args) => {
      const out = args.find((arg) => arg.startsWith('/out:'))!.slice(5)
      await fs.writeFile(out, 'ours')
      // The other window gets there while this compiler runs.
      const theirs = path.join(cacheDir, hash)
      await fs.mkdir(theirs, { recursive: true })
      await fs.writeFile(path.join(theirs, HELPER_EXE), 'theirs')
      const { createHash } = await import('node:crypto')
      await fs.writeFile(path.join(theirs, `${HELPER_EXE}.sha256`), `${createHash('sha256').update('theirs').digest('hex')}\n`)
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    assert.equal(result.built, false)
    assert.equal(await fs.readFile(result.exe, 'utf8'), 'theirs')
    assert.deepEqual(await fs.readdir(cacheDir), [hash])
  })

  it('removes builds nobody has used for two weeks, and nothing else', async () => {
    const { run } = fakeCompiler()
    const cacheDir = path.join(dir, 'cache')
    await fs.mkdir(path.join(cacheDir, 'oldbuild'), { recursive: true })
    await fs.mkdir(path.join(cacheDir, 'newbuild'), { recursive: true })
    await fs.mkdir(path.join(cacheDir, 'abc.build-1-ff'), { recursive: true })
    const old = new Date(Date.now() - 20 * 24 * 3_600_000)
    await fs.utimes(path.join(cacheDir, 'oldbuild'), old, old)
    await fs.utimes(path.join(cacheDir, 'abc.build-1-ff'), old, old)
    const built = await ensureHelper({ cacheDir, files: FILES, manifest: 'm', compiler: COMPILER, run })
    // Pruning runs after the build returns; give it a moment.
    for (let n = 0; n < 50 && (await fs.readdir(cacheDir)).includes('oldbuild'); n++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual((await fs.readdir(cacheDir)).sort(), ['abc.build-1-ff', built.hash, 'newbuild'].sort(), 'another window\'s unfinished build is left alone')
  })
})

describe('finding the compiler', () => {
  async function framework(root: string, kind: string, parts: string[]) {
    const folder = path.join(root, 'Microsoft.NET', kind, 'v4.0.30319')
    await fs.mkdir(path.join(folder, 'WPF'), { recursive: true })
    for (const part of parts) await fs.writeFile(path.join(folder, part), '')
    return folder
  }

  it('takes the 64-bit .NET Framework 4 compiler with the UI Automation assemblies beside it', async () => {
    const folder = await framework(dir, 'Framework64', ['csc.exe', 'WPF/WindowsBase.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll'])
    const compiler = await findCompiler(dir)
    assert.equal(compiler.csc, path.join(folder, 'csc.exe'))
    assert.deepEqual(compiler.references.map((file) => path.basename(file)), ['WindowsBase.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll'])
  })

  it('falls back to the 32-bit folder, and says what to repair when there is none', async () => {
    await framework(dir, 'Framework64', ['csc.exe'])
    await assert.rejects(findCompiler(dir), /Windows Features/, 'a compiler without its UI Automation parts is no use')
    await framework(dir, 'Framework', ['csc.exe', 'WPF/WindowsBase.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll'])
    assert.match((await findCompiler(dir)).csc, /Framework[\\/]v4/)
    await assert.rejects(findCompiler(path.join(dir, 'nowhere')), (error: unknown) => error instanceof DesktopError && error.code === 'unavailable')
  })
})

describe('compiler messages', () => {
  it('keeps the errors, drops the folder and the noise, and stops at six', () => {
    const output = ['Microsoft (R) Visual C# Compiler', ...Array.from({ length: 9 }, (_, n) => `/tmp/work/src/A.cs(${n},1): error CS1000: problem ${n}`), 'warning CS0168: nothing'].join('\n')
    const text = compilerErrors(output, '/tmp/work')
    assert.equal(text.split('\n').length, 6)
    assert.doesNotMatch(text, /\/tmp\/work/)
    assert.match(text, /^src\/A\.cs\(0,1\): error CS1000/)
  })
})
