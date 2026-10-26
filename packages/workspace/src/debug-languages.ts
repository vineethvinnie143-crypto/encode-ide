/**
 * Runs of Python, Go, C, C++ and Rust programs, worked out (ADR 0144): which debugger starts, how, and what it is told
 * to launch or attach to. The debugger starts the program itself, with the environment it was started with, so a
 * run's variables are the debugger's. A program that must be built first (C, C++, Rust) is built as the run starts,
 * in its console (debug-builds.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DapPlan } from '@encode/debug'
import { cargoBuild, compileFile, compileRust, type BuildContext } from './debug-builds'
import { findCompiler, findDebugpy, findDelve, findGo, findLldbDap, findPython, findRust, lldbPython, rustFormatters, RunProblem, withPathTail, type FindContext } from './debuggers'

/** A run of a language's own debugger, as the folder's debugger starts it; the run's folder is given when it starts. */
export interface DapRun {
  kind: 'dap'
  name: string
  detail: string
  dap: Omit<DapPlan, 'runDir'>
}

/** What a language's run is given: where it runs, and its environment with the configuration's variables in it. */
export interface LanguageContext extends FindContext {
  cwd: string
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name)
const DETAIL_CHARS = 160
const clip = (text: string) => (text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text)

/** A file's path as the panel shows it: in the folder when it is the folder's. */
export function shown(file: string, root: string): string {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file
}

function buildContext(context: LanguageContext, prepare: { print: BuildContext['print']; signal: AbortSignal }): BuildContext {
  return { cwd: context.cwd, env: context.env, platform: context.platform, print: prepare.print, signal: prepare.signal }
}

// ---------------------------------------------------------------- Python

export interface PythonRun {
  name: string
  /** A script, or a module run as `python -m`. */
  program?: string
  module?: string
  /** Attach to a program that runs debugpy's server (`python -m debugpy --listen 5678 app.py`) on this machine. */
  attach?: { host: string; port: number }
  args: string[]
  python?: string
  justMyCode: boolean
}

export async function pythonRun(run: PythonRun, context: LanguageContext): Promise<DapRun> {
  const python = await findPython(context, run.python)
  const adapter = await findDebugpy(python, context)
  const common = { type: 'python', justMyCode: run.justMyCode, showReturnValue: true, redirectOutput: true, subProcess: false }
  if (run.attach) {
    return {
      kind: 'dap',
      name: run.name,
      detail: `debugpy at ${run.attach.host}:${run.attach.port}`,
      dap: { kind: 'dap', profile: 'debugpy', request: 'attach', adapter: { file: adapter.file, args: adapter.args, cwd: context.cwd, env: context.env, transport: 'stdio' }, arguments: { ...common, connect: run.attach } },
    }
  }
  const target = run.module !== undefined ? { module: run.module } : { program: run.program }
  return {
    kind: 'dap',
    name: run.name,
    detail: clip([`python ${run.module !== undefined ? `-m ${run.module}` : shown(run.program!, context.root)}`, ...run.args].join(' ')),
    dap: {
      kind: 'dap',
      profile: 'debugpy',
      request: 'launch',
      adapter: { file: adapter.file, args: adapter.args, cwd: context.cwd, env: context.env, transport: 'stdio' },
      // The program inherits the debugger's environment, which is the run's.
      arguments: { ...common, ...target, args: run.args, cwd: context.cwd, env: {}, python: python.file, console: 'internalConsole', stopOnEntry: false },
    },
  }
}

// ---------------------------------------------------------------- Go

export interface GoRun {
  name: string
  /** A package's folder, or one .go file. */
  program: string
  mode: 'debug' | 'test'
  args: string[]
  buildFlags: string[]
}

export async function goRun(run: GoRun, context: LanguageContext): Promise<DapRun> {
  const delve = findDelve(context)
  const go = await findGo(context, run.program, delve.ours)
  const env = { ...context.env, ...go.env }
  return {
    kind: 'dap',
    name: run.name,
    detail: clip([`dlv ${run.mode} ${shown(run.program, context.root) || '.'}`, ...run.args].join(' ')),
    dap: {
      kind: 'dap',
      profile: 'delve',
      request: 'launch',
      adapter: { file: delve.file, args: ['dap', '--client-addr={clientAddr}'], cwd: context.cwd, env, transport: 'dial' },
      arguments: {
        mode: run.mode,
        program: run.program,
        cwd: context.cwd,
        args: run.args,
        env: {},
        outputMode: 'remote',
        hideSystemGoroutines: true,
        stopOnEntry: false,
        ...(run.buildFlags.length ? { buildFlags: run.buildFlags.join(' ') } : {}),
      },
      // The program Delve builds goes in the run's folder, not the person's.
      prepare: async (prepare) => {
        prepare.print('info', `Building with ${go.label}…`)
        return { output: path.join(prepare.runDir, exe('program', context.platform)) }
      },
    },
  }
}

// ---------------------------------------------------------------- C, C++ and Rust

/** What an lldb run starts: a program that is there, or one built as the run starts. */
export type NativeProgram =
  | { kind: 'program'; file: string }
  | { kind: 'file'; file: string; language: 'c' | 'cpp' }
  | { kind: 'rustc'; file: string }
  | { kind: 'cargo'; manifest: string; file?: string; bin?: string; example?: string; package?: string }

export interface NativeRun {
  name: string
  program: NativeProgram
  args: string[]
  /** A Rust program: its formatters are loaded, and its panics are its exceptions. */
  rust: boolean
}

export async function nativeRun(run: NativeRun, context: LanguageContext): Promise<DapRun> {
  const lldb = findLldbDap(context)
  const python = context.platform === 'win32' ? await lldbPython(lldb, context) : null
  const program = run.program
  let detail: string
  let build: ((prepare: { runDir: string; print: BuildContext['print']; signal: AbortSignal }) => Promise<string>) | null = null
  switch (program.kind) {
    case 'program':
      if (!fs.existsSync(program.file)) throw new RunProblem(`${shown(program.file, context.root)} does not exist: build it first.`)
      detail = shown(program.file, context.root)
      break
    case 'file': {
      const compiler = findCompiler(program.language, context)
      detail = `${path.basename(compiler).replace(/\.exe$/i, '')} -g ${shown(program.file, context.root)}`
      build = (prepare) => compileFile(compiler, program.file, prepare.runDir, buildContext(context, prepare))
      break
    }
    case 'rustc': {
      const rustc = findRust('rustc', context)
      detail = `rustc -g ${shown(program.file, context.root)}`
      build = (prepare) => compileRust(rustc, program.file, prepare.runDir, buildContext(context, prepare))
      break
    }
    case 'cargo': {
      const cargo = findRust('cargo', context)
      const which = program.bin !== undefined ? ` --bin ${program.bin}` : program.example !== undefined ? ` --example ${program.example}` : program.file ? `, ${shown(program.file, context.root)}` : ''
      detail = `cargo build${which}`
      build = async (prepare) => (await cargoBuild(cargo, program, buildContext(context, prepare))).program
      break
    }
  }
  const initCommands = run.rust ? await rustFormatters(findRust('rustc', context), context).catch(() => []) : []
  return {
    kind: 'dap',
    name: run.name,
    detail: clip([detail, ...run.args].join(' ')),
    dap: {
      kind: 'dap',
      profile: 'lldb',
      request: 'launch',
      ...(run.rust ? { rust: true } : {}),
      adapter: { file: lldb, args: [], cwd: context.cwd, env: python?.add ? withPathTail(context.env, python.add, context.platform) : context.env, transport: 'stdio' },
      // The program inherits lldb-dap's environment, which is the run's: `env` adds to it.
      arguments: { ...(program.kind === 'program' ? { program: program.file } : {}), args: run.args, cwd: context.cwd, env: [], stopOnEntry: false, ...(initCommands.length ? { initCommands } : {}) },
      ...(build ? { prepare: async (prepare) => ({ program: await build(prepare) }) } : {}),
    },
  }
}

/** The nearest Cargo.toml from a file's folder up to the root, or null. */
export function cargoManifest(from: string, root: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'Cargo.toml')
    if (fs.existsSync(manifest)) return manifest
    const back = path.relative(root, dir)
    if (!back || back.startsWith('..') || path.isAbsolute(back) || path.dirname(dir) === dir) return null
  }
}
