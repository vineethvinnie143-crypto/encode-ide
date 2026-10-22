/**
 * Windows: a write-restricted token. The command runs as the person, with its privileges removed and with every
 * write checked a second time against a list of restricting SIDs; only the folders that carry an entry for the
 * sandbox's own SID (put there by the helper, see build.ts) pass that second check, besides the few objects every
 * program needs (the NUL device, its own pipes). Reads and the network are not restricted. Nothing the command
 * starts can outlive it: the helper's job object kills the tree when the helper goes away.
 */
import { randomBytes, randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { EnginePolicy, EngineProbe, SandboxEngine, SpawnSpec } from '../engine'
import { mergeEnv } from '../env'
import { SandboxError } from '../errors'
import { ensureHelper, type BuildOptions, type HelperBuild } from './build'
import { foldersWithGrant, grantFolder, probeHelper, runArguments, runHelper, type RunFlags } from './client'

export interface WindowsEngineOptions {
  /** The sandbox's folder: helper builds under `helper`, the SID and the folders prepared in `state.json`. */
  dir: string
  build?: Partial<BuildOptions>
  /** The restricting SIDs besides the sandbox's own. */
  extraSids?: readonly string[]
  flags?: Omit<RunFlags, 'restrict'>
}

/** What the explore test found to keep Git Bash, PowerShell, node and cmd working (see explore.test.ts). */
export const DEFAULT_EXTRA_SIDS: readonly string[] = ['everyone']

interface State {
  version: 1
  sid: string
  /** Folders prepared, by lower-cased path, with the helper that did it. */
  folders: Record<string, { at: string; helper: string }>
}

function newSid(): string {
  const part = () => randomInt(1, 2 ** 31 - 1)
  return `S-1-5-21-${part()}-${part()}-${part()}-${randomInt(1000, 9999)}`
}

export function createWindowsEngine(options: WindowsEngineOptions): SandboxEngine & { readonly sid: () => Promise<string>; helperPath(): string | undefined } {
  const stateFile = path.join(options.dir, 'state.json')
  const extra = options.extraSids ?? DEFAULT_EXTRA_SIDS
  let state: Promise<State> | undefined
  let helper: Promise<HelperBuild> | undefined
  let exe: string | undefined
  let queue: Promise<unknown> = Promise.resolve()
  /** Known once the state is loaded, which prepare() and probe() wait for before wrap() is used. */
  let knownSid: string | undefined

  async function load(): Promise<State> {
    try {
      const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<State>
      if (parsed.version === 1 && typeof parsed.sid === 'string' && /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(parsed.sid)) return { version: 1, sid: parsed.sid, folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {} }
    } catch {
      // first use, or a file that cannot be trusted: start again
    }
    return { version: 1, sid: newSid(), folders: {} }
  }

  async function save(value: State): Promise<void> {
    await fs.mkdir(options.dir, { recursive: true })
    const temp = `${stateFile}.${process.pid}.${randomBytes(3).toString('hex')}`
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.rename(temp, stateFile)
  }

  const current = () =>
    (state ??= load().then((value) => {
      knownSid = value.sid
      return value
    }))

  function built(): Promise<HelperBuild> {
    helper ??= ensureHelper({ cacheDir: path.join(options.dir, 'helper'), ...options.build }).then((result) => {
      exe = result.exe
      return result
    })
    helper.catch(() => {
      helper = undefined
    })
    return helper
  }

  function flagsFor(sid: string): RunFlags {
    return { ...options.flags, restrict: [sid, ...extra] }
  }

  /** Runs `job` after the ones before it: two grants on one folder at once would only slow each other down. */
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job, job)
    queue = next.catch(() => undefined)
    return next
  }

  const key = (folder: string) => folder.toLowerCase()

  return {
    name: 'restricted-token',
    limits: { reads: false, network: false, protectedPaths: 'best-effort' },
    sid: async () => (await current()).sid,
    helperPath: () => exe,

    async probe(): Promise<EngineProbe> {
      let build: HelperBuild
      try {
        build = await built()
      } catch (error) {
        return { ok: false, reason: error instanceof SandboxError ? error.message : `The sandbox helper could not be prepared: ${error instanceof Error ? error.message : String(error)}` }
      }
      const value = await current()
      try {
        const answer = await probeHelper(build.exe, flagsFor(value.sid))
        if (!answer.ok) return { ok: false, reason: answer.error ?? answer.tokenError ?? 'A program could not be started under the restricted token.' }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      // The end-to-end test: a folder with the entry can be written by a sandboxed program, one without cannot.
      const probeDir = path.join(options.dir, 'probe')
      const inside = path.join(probeDir, `in-${randomBytes(3).toString('hex')}`)
      const outside = path.join(probeDir, `out-${randomBytes(3).toString('hex')}`)
      try {
        await fs.mkdir(inside, { recursive: true })
        await fs.mkdir(outside, { recursive: true })
        await grantFolder(build.exe, value.sid, inside, [])
        const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
        const script = `echo ok> "${path.join(inside, 'in.txt')}" & echo no> "${path.join(outside, 'out.txt')}"`
        await runHelper(build.exe, runArguments(flagsFor(value.sid), cmd, ['/d', '/c', script]), 20_000)
        const wrote = await fs.access(path.join(inside, 'in.txt')).then(() => true, () => false)
        const escaped = await fs.access(path.join(outside, 'out.txt')).then(() => true, () => false)
        if (!wrote) return { ok: false, reason: 'A sandboxed program could not write in a folder that was prepared for it.' }
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
        const build = await built()
        const value = await current()
        const todo: string[] = []
        const known = Object.keys(value.folders)
        const prepared = known.filter((folder) => value.folders[folder].helper === build.hash)
        const present = new Set((await foldersWithGrant(build.exe, value.sid, policy.writable.filter((folder) => prepared.includes(key(folder))))).map(key))
        for (const folder of policy.writable) if (!present.has(key(folder))) todo.push(folder)
        let changed = false
        for (const folder of todo) {
          onProgress?.(`Preparing ${folder} for the sandbox`)
          const protect = policy.protected.filter((item) => key(item).startsWith(`${key(folder)}\\`) || key(item).startsWith(`${key(folder)}/`))
          try {
            await grantFolder(build.exe, value.sid, folder, protect)
          } catch (error) {
            throw new SandboxError('failed', `${folder} could not be prepared for the sandbox: ${error instanceof Error ? error.message : String(error)}`)
          }
          value.folders[key(folder)] = { at: new Date().toISOString(), helper: build.hash }
          changed = true
        }
        if (changed) await save(value)
      })
    },

    wrap(spec: SpawnSpec, policy: EnginePolicy): SpawnSpec {
      if (!exe) throw new SandboxError('failed', 'The sandbox helper has not been built yet.')
      // The sid is known by now: prepare() runs before the first wrap().
      const sid = knownSid
      if (!sid) throw new SandboxError('failed', 'The sandbox has not been prepared yet.')
      return {
        file: exe,
        args: runArguments({ ...flagsFor(sid), cwd: spec.cwd }, spec.file, spec.args),
        env: mergeEnv(spec.env, policy.env, policy.unset, 'win32'),
        cwd: spec.cwd,
      }
    },
  }
}
