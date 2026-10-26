/**
 * Building a program to debug it (ADR 0144): a Rust program with cargo, or one C, C++ or Rust file with its compiler,
 * with debug information and without optimization. A build runs as part of its run, before the debugger starts:
 * what it prints shows in the run's console, stopping the run stops the build, and a single file's program is made
 * in the run's own folder, which goes when the run ends. Nothing is written into the person's folder but what cargo
 * itself writes there (target/).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { killTree } from '@encode/tools'
import { RunProblem } from './debuggers'

export interface BuildContext {
  cwd: string
  env: Record<string, string>
  platform: NodeJS.Platform
  print(category: 'stdout' | 'stderr' | 'info', text: string): void
  signal: AbortSignal
  /** For tests. */
  spawn?: typeof spawn
}

/** cargo metadata of a large workspace is a few megabytes. */
const MAX_METADATA = 32 * 1024 * 1024

/**
 * Runs one build step to its end. Its error output is printed as it comes; its output too, unless `onLine` takes
 * each line (cargo's messages). Rejects with why when it fails or is stopped.
 */
export function runStep(file: string, args: string[], context: BuildContext, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (context.signal.aborted) return reject(new RunProblem('The run was stopped.'))
    const child = (context.spawn ?? spawn)(file, args, {
      cwd: context.cwd,
      env: context.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so that stopping it stops what it started (rustc under cargo).
      detached: context.platform !== 'win32',
      windowsHide: true,
      shell: false,
    })
    const name = path.basename(file).replace(/\.exe$/i, '')
    const stop = () => void killTree(child, context.platform)
    context.signal.addEventListener('abort', stop, { once: true })
    let partial = ''
    let taken = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!onLine) return context.print('stdout', chunk.toString('utf8'))
      taken += chunk.length
      if (taken > MAX_METADATA) return stop()
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => context.print('stderr', chunk.toString('utf8')))
    child.once('error', (error) => {
      context.signal.removeEventListener('abort', stop)
      reject(new RunProblem(`${name} could not be started: ${error.message}`))
    })
    child.once('close', (code) => {
      context.signal.removeEventListener('abort', stop)
      if (partial && onLine) onLine(partial)
      if (context.signal.aborted) return reject(new RunProblem('The run was stopped.'))
      if (taken > MAX_METADATA) return reject(new RunProblem(`${name} printed more than eNCode reads.`))
      if (code === 0) return resolve()
      reject(new RunProblem(`The build failed: ${name} exited with code ${code ?? 'none'}. What it printed is above.`))
    })
  })
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name)

/** One C or C++ file, built with debug information into the run's folder; resolves with the program. */
export async function compileFile(compiler: string, file: string, runDir: string, context: BuildContext): Promise<string> {
  const program = path.join(runDir, exe('program', context.platform))
  context.print('info', `Building ${path.basename(file)} with ${path.basename(compiler).replace(/\.exe$/i, '')}…`)
  await runStep(compiler, ['-g', '-O0', '-o', program, file], context)
  return program
}

/** One Rust file without a Cargo project, built with rustc into the run's folder. */
export async function compileRust(rustc: string, file: string, runDir: string, context: BuildContext): Promise<string> {
  const program = path.join(runDir, exe('program', context.platform))
  context.print('info', `Building ${path.basename(file)} with rustc…`)
  await runStep(rustc, ['-g', '-C', 'opt-level=0', '--edition', '2021', '--crate-type', 'bin', '-o', program, file], context)
  return program
}

interface CargoTarget {
  package: string
  name: string
  kind: 'bin' | 'example'
  src: string
}

/** What a Cargo build is asked for: a program by name, or the one whose source is a file. */
export interface CargoAsk {
  manifest: string
  bin?: string
  example?: string
  package?: string
  /** The file open in the editor. */
  file?: string
}

const sameFile = (a: string, b: string, platform: NodeJS.Platform) => (platform === 'win32' ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase() : path.posix.normalize(a) === path.posix.normalize(b))

/** The programs (bins and examples) of a Cargo project and its workspace, as `cargo metadata` lists them. */
async function cargoTargets(cargo: string, manifest: string, context: BuildContext): Promise<{ targets: CargoTarget[]; packages: { name: string; dir: string }[] }> {
  let text = ''
  await runStep(cargo, ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest], context, (line) => {
    text += `${line}\n`
  })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RunProblem('cargo metadata gave an answer eNCode could not read.')
  }
  const packages = (raw as { packages?: unknown }).packages
  if (!Array.isArray(packages)) throw new RunProblem('cargo metadata gave an answer eNCode could not read.')
  const targets: CargoTarget[] = []
  const dirs: { name: string; dir: string }[] = []
  for (const pkg of packages as Record<string, unknown>[]) {
    if (typeof pkg.name !== 'string' || typeof pkg.manifest_path !== 'string' || !Array.isArray(pkg.targets)) continue
    dirs.push({ name: pkg.name, dir: path.dirname(pkg.manifest_path) })
    for (const target of pkg.targets as Record<string, unknown>[]) {
      const kinds = Array.isArray(target.kind) ? target.kind : []
      const kind = kinds.includes('bin') ? 'bin' : kinds.includes('example') ? 'example' : null
      if (kind && typeof target.name === 'string' && typeof target.src_path === 'string') targets.push({ package: pkg.name, name: target.name, kind, src: target.src_path })
    }
  }
  return { targets, packages: dirs }
}

/** The one program a Cargo build is for, or why it is not clear which. */
function chooseTarget(found: Awaited<ReturnType<typeof cargoTargets>>, ask: CargoAsk, platform: NodeJS.Platform): CargoTarget {
  const inPackage = (target: CargoTarget) => !ask.package || target.package === ask.package
  if (ask.bin !== undefined || ask.example !== undefined) {
    const kind = ask.bin !== undefined ? 'bin' : 'example'
    const name = ask.bin ?? ask.example
    const target = found.targets.find((item) => item.kind === kind && item.name === name && inPackage(item))
    if (!target) throw new RunProblem(`The Cargo project has no ${kind === 'bin' ? 'program' : 'example'} named "${name}".`)
    return target
  }
  if (ask.file) {
    const own = found.targets.find((item) => sameFile(item.src, ask.file!, platform) && inPackage(item))
    if (own) return own
  }
  // The package the file is in, else the one the manifest is for.
  const where = ask.file ?? path.dirname(ask.manifest)
  const pkg = ask.package ?? found.packages.filter((item) => !path.relative(item.dir, where).startsWith('..') && !path.isAbsolute(path.relative(item.dir, where))).sort((a, b) => b.dir.length - a.dir.length)[0]?.name
  const bins = found.targets.filter((item) => item.kind === 'bin' && (!pkg || item.package === pkg))
  if (bins.length === 1) return bins[0]!
  if (!bins.length) throw new RunProblem(`${pkg ? `The package ${pkg}` : 'The Cargo project'} has no program to run (it is a library). Open the main file of a program, or of an example, and start this again.`)
  throw new RunProblem(`${pkg ? `The package ${pkg}` : 'The Cargo project'} has several programs (${bins.map((item) => item.name).slice(0, 8).join(', ')}): open the main file of the one to debug, or name it in .encode/debug.json ("bin").`)
}

/** A Cargo project's program, built in debug: cargo says where the program it made is. */
export async function cargoBuild(cargo: string, ask: CargoAsk, context: BuildContext): Promise<{ program: string; name: string }> {
  const target = chooseTarget(await cargoTargets(cargo, ask.manifest, context), ask, context.platform)
  context.print('info', `Building ${target.name} with cargo…`)
  let program: string | null = null
  await runStep(cargo, ['build', '--message-format=json-render-diagnostics', '--manifest-path', ask.manifest, '--package', target.package, target.kind === 'bin' ? '--bin' : '--example', target.name], context, (line) => {
    if (!line.startsWith('{')) {
      if (line.trim()) context.print('stdout', `${line}\n`)
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const built = message.target as { name?: unknown; kind?: unknown } | undefined
    if (message.reason === 'compiler-artifact' && typeof message.executable === 'string' && built?.name === target.name && Array.isArray(built.kind) && built.kind.includes(target.kind)) program = message.executable
  })
  if (!program) throw new RunProblem(`cargo built ${target.name} but did not say where the program is.`)
  return { program, name: target.name }
}
