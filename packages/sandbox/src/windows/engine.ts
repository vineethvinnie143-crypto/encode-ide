/**
 * Windows: the low integrity level. A command runs as the person, without privileges, at an integrity level below the
 * one the person's own programs run at. The system refuses a program at that level the writing, deleting, renaming
 * and permission changes on anything labeled higher, which is everything that was not marked on purpose: the person's
 * documents, the registry, the Startup folder, scheduled tasks, the program files. The folders a command may change
 * (the project, the sandbox's temp and cache folders) are marked low once, by the helper (see build.ts), and what a
 * command must not change inside them (git's hooks and configuration, the project's own settings) is marked medium
 * again and kept from being renamed away while the command runs. Reads and the network are not restricted, nor
 * is the ending of the person's other programs. Nothing the command starts can outlive it: the helper's job object
 * kills the tree when the helper goes away.
 *
 * Git Bash cannot run in it (see `unsupported`), so the shell that is confined is PowerShell.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { EnginePolicy, EngineProbe, SandboxEngine, SpawnSpec } from '../engine'
import { mergeEnv } from '../env'
import { SandboxError } from '../errors'
import { ensureHelper, type BuildOptions, type HelperBuild } from './build'
import { defaultClient, runArguments, type HelperClient, type LabelResult } from './client'

export interface WindowsEngineOptions {
  /** The sandbox's folder: the helper is built under `helper`, the folders marked so far are listed in `state.json`. */
  dir: string
  build?: Partial<BuildOptions>
  client?: Partial<HelperClient>
  env?: Readonly<Record<string, string | undefined>>
  home?: string
  /** The program's own folder, which must stay out of reach. Default: where the running program is. */
  appDir?: string
  warn?(message: string): void
}

/**
 * Programs of the MSYS runtime (Git Bash). They make objects in a namespace that every MSYS program of the person
 * shares, and a program at the low integrity level is refused that namespace as soon as one of the person's own
 * (an open Git Bash window, the terminal of an editor) is running (explore.test.ts: "NtCreateDirectoryObject").
 */
const MSYS_SHELLS = new Set(['bash.exe', 'sh.exe', 'zsh.exe', 'dash.exe'])

interface State {
  version: 2
  /** Folders marked, by lower-cased path, with the protected paths inside them that were marked medium again. */
  folders: Record<string, { path: string; at: string; helper: string; protect: string[] }>
}

const MAX_PROTECT_KEPT = 64

/** A folder's name for comparing: absolute, without a trailing separator, in one case. "C:" alone is the drive, not the folder last used on it. */
const key = (folder: string) => (/^[a-z]:[\\/]*$/i.test(folder) ? folder.slice(0, 2) : path.win32.resolve(folder).replace(/[\\/]+$/, '')).toLowerCase()

const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}\\`)

/**
 * Why a folder must not be marked, or nothing when it may be. Marking a folder lets every command change everything
 * in it, so the person's home, the places where programs keep their settings and what runs at sign-in (all inside
 * it), a whole drive, the system's folders, and the sandbox's own helper and the program itself are out.
 */
export function tooBroad(folder: string, input: { env: Readonly<Record<string, string | undefined>>; home: string; keep: readonly string[] }): string | undefined {
  const target = key(folder)
  if (/^[a-z]:$/.test(target) || /^\\\\[^\\]+(\\[^\\]+)?$/.test(target)) return 'a whole drive or share'
  if (within(target, key(input.home))) return "the person's home folder, or a folder that holds it"
  for (const name of ['APPDATA', 'LOCALAPPDATA']) {
    const value = input.env[name]
    if (value && within(target, key(value))) return 'the folder where programs keep their settings'
  }
  for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const value = input.env[name]
    if (value && within(key(value), target)) return "Windows' own folders"
  }
  for (const keep of input.keep) if (within(target, key(keep))) return "the sandbox's own program, which commands must not be able to change"
  return undefined
}

export interface WindowsEngine extends SandboxEngine {
  helperPath(): string | undefined
  /** Takes the marks off every folder this engine marked (or only these), so that they are as they were. Returns the folders. */
  release(folders?: readonly string[]): Promise<string[]>
}

export function createWindowsEngine(options: WindowsEngineOptions): WindowsEngine {
  const stateFile = path.join(options.dir, 'state.json')
  const client: HelperClient = { ...defaultClient, ...options.client }
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const helperDir = path.join(options.dir, 'helper')
  const keep = [helperDir, options.appDir ?? path.dirname(process.execPath)]
  let state: Promise<State> | undefined
  let helper: Promise<HelperBuild> | undefined
  let exe: string | undefined
  let queue: Promise<unknown> = Promise.resolve()
  /** Folders known to be marked in this run, so that a command does not start a helper to find out. */
  const marked = new Set<string>()

  async function load(): Promise<State> {
    try {
      const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<State>
      if (parsed.version === 2 && parsed.folders && typeof parsed.folders === 'object') {
        const folders: State['folders'] = {}
        for (const [name, entry] of Object.entries(parsed.folders)) {
          if (entry && typeof entry.path === 'string' && typeof entry.at === 'string' && typeof entry.helper === 'string') {
            const protect = Array.isArray(entry.protect) ? entry.protect.filter((item): item is string => typeof item === 'string').slice(0, MAX_PROTECT_KEPT) : []
            folders[name] = { path: entry.path, at: entry.at, helper: entry.helper, protect }
          }
        }
        return { version: 2, folders }
      }
    } catch {
      // first use, or a file that cannot be trusted: start again
    }
    return { version: 2, folders: {} }
  }

  async function save(value: State): Promise<void> {
    await fs.mkdir(options.dir, { recursive: true })
    const temp = `${stateFile}.${process.pid}.${randomBytes(3).toString('hex')}`
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.rename(temp, stateFile)
  }

  const current = () => (state ??= load())

  function built(): Promise<HelperBuild> {
    helper ??= ensureHelper({ cacheDir: helperDir, ...options.build }).then((result) => {
      exe = result.exe
      return result
    })
    helper.catch(() => {
      helper = undefined
    })
    return helper
  }

  /** Runs `job` after the ones before it: two walks over one folder at once would only slow each other down. */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job, job)
    queue = next.catch(() => undefined)
    return next
  }

  async function probeProgram(build: HelperBuild): Promise<EngineProbe> {
    let answer: Awaited<ReturnType<HelperClient['probe']>>
    try {
      answer = await client.probe(build.exe)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (!answer.ok) return { ok: false, reason: answer.error ?? answer.tokenError ?? 'A program could not be started at the low integrity level.' }
    return { ok: true }
  }

  return {
    name: 'integrity-level',
    limits: { reads: false, network: false, protectedPaths: 'exact', processes: false },
    helperPath: () => exe,

    async probe(): Promise<EngineProbe> {
      marked.clear()
      let build: HelperBuild
      try {
        build = await built()
      } catch (error) {
        return { ok: false, reason: error instanceof SandboxError ? error.message : `The sandbox helper could not be prepared: ${error instanceof Error ? error.message : String(error)}` }
      }
      const started = await probeProgram(build)
      if (!started.ok) return started
      // The end-to-end test: a folder that was marked can be written by a sandboxed program, one that was not cannot.
      const probeDir = path.join(options.dir, `probe-${randomBytes(3).toString('hex')}`)
      const inside = path.join(probeDir, 'in')
      const outside = path.join(probeDir, 'out')
      try {
        await fs.mkdir(inside, { recursive: true })
        await fs.mkdir(outside, { recursive: true })
        await client.label(build.exe, [inside], [])
        const cmd = path.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe')
        const ran = await client.run(build.exe, runArguments({ cwd: inside }, cmd, ['/d', '/c', 'echo ok> in.txt & echo no> ..\\out\\out.txt']), 20_000)
        const wrote = await fs.access(path.join(inside, 'in.txt')).then(() => true, () => false)
        const escaped = await fs.access(path.join(outside, 'out.txt')).then(() => true, () => false)
        if (!wrote) return { ok: false, reason: `A sandboxed program could not write in a folder that was prepared for it. ${ran.stderr.trim().split(/\r?\n/)[0] ?? ''}`.trim() }
        if (escaped) return { ok: false, reason: 'A sandboxed program wrote in a folder that was not prepared for it, so the sandbox does not hold on this machine.' }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: `The sandbox test failed: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },

    prepare(policy: EnginePolicy, onProgress?: (message: string) => void): Promise<void> {
      return serial(async () => {
        for (const folder of policy.writable) {
          const why = tooBroad(folder, { env, home, keep })
          if (why) throw new SandboxError('failed', `${folder} cannot be prepared for the sandbox: it is ${why}, and every command could change everything in it. Open a folder inside it instead, run the command outside the sandbox (you are asked), or turn the sandbox off in the settings.`)
        }
        const build = await built()
        const value = await current()
        let changed = false
        for (const folder of policy.writable) {
          const name = key(folder)
          if (marked.has(name)) continue
          onProgress?.(`Preparing ${folder} for the sandbox`)
          const protect = policy.protected.filter((item) => within(name, key(item)) && key(item) !== name)
          let result: LabelResult
          try {
            result = await client.label(build.exe, [folder], protect, {
              ifMissing: true,
              onProgress: (done) => onProgress?.(`Preparing ${folder} for the sandbox (${done.toLocaleString('en-US')} items so far)`),
            })
          } catch (error) {
            throw new SandboxError('failed', `${folder} could not be prepared for the sandbox: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (result.failed > 0) {
            const first = result.failures[0] ? ` (the first: ${result.failures[0]})` : ''
            options.warn?.(`${result.failed} item${result.failed === 1 ? '' : 's'} in ${folder} could not be marked for the sandbox${first}; commands cannot change them.`)
          }
          marked.add(name)
          const known = value.folders[name]
          const kept = [...new Set([...(known?.protect ?? []), ...protect])].slice(-MAX_PROTECT_KEPT)
          if (!known || known.helper !== build.hash || kept.length !== known.protect.length) {
            value.folders[name] = { path: folder, at: known?.at ?? new Date().toISOString(), helper: build.hash, protect: kept }
            changed = true
          }
        }
        if (changed) await save(value)
      })
    },

    unsupported(file: string): string | undefined {
      return MSYS_SHELLS.has(path.win32.basename(file).toLowerCase())
        ? 'Git Bash cannot run inside the Windows sandbox: its runtime shares objects with every other Git Bash and git program that is running, and a confined program is refused them. PowerShell can.'
        : undefined
    },

    wrap(spec: SpawnSpec, policy: EnginePolicy): SpawnSpec {
      if (!exe) throw new SandboxError('failed', 'The sandbox helper has not been built yet.')
      return {
        file: exe,
        args: runArguments({ cwd: spec.cwd, protect: policy.protected }, spec.file, spec.args),
        env: mergeEnv(spec.env, policy.env, policy.unset, 'win32'),
        cwd: spec.cwd,
      }
    },

    release(folders?: readonly string[]): Promise<string[]> {
      return serial(async () => {
        const build = await built()
        const value = await current()
        const wanted = folders ? new Set(folders.map(key)) : undefined
        const done: string[] = []
        for (const [name, entry] of Object.entries(value.folders)) {
          if (wanted && !wanted.has(name)) continue
          try {
            await client.unlabel(build.exe, [entry.path], entry.protect)
          } catch (error) {
            throw new SandboxError('failed', `The marks on ${entry.path} could not be taken away: ${error instanceof Error ? error.message : String(error)}`)
          }
          delete value.folders[name]
          marked.delete(name)
          done.push(entry.path)
        }
        await save(value)
        return done
      })
    },
  }
}
