import fs from 'node:fs'
import path from 'node:path'

/**
 * How eNCode finds the programs it starts. A bare name is looked up only in
 * absolute PATH entries and always started by its absolute path: on Windows,
 * libuv looks in the child's working directory before PATH, and an empty or
 * relative PATH entry means a working directory too, so a git.exe or
 * node.exe inside a project could otherwise run in place of the real one.
 */

type Env = Record<string, string | undefined>

/** The key under which `env` holds `name`; Windows treats names case-insensitively (Path, PATH). */
export function envKey(env: Env, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || Object.hasOwn(env, name)) return name
  const upper = name.toUpperCase()
  return Object.keys(env).find((key) => key.toUpperCase() === upper) ?? name
}

export function envValue(env: Env, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return env[envKey(env, name, platform)]
}

/** A directory PATH may name: absolute, and on Windows with a drive or UNC root (not `\dir` or `C:dir`). */
function isSearchable(dir: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir)
  return path.posix.isAbsolute(dir)
}

/** PATH directories in order, without empty, relative or drive-relative entries. */
export function searchDirectories(env: Env, platform: NodeJS.Platform = process.platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':'
  return (envValue(env, 'PATH', platform) ?? '')
    .split(delimiter)
    .map((entry) => (platform === 'win32' ? entry.trim().replace(/^"(.*)"$/, '$1') : entry))
    .filter((entry) => entry && isSearchable(entry, platform))
}

/**
 * File names to try for `name`. On Windows, like cmd.exe: a name that already
 * ends in a PATHEXT extension is tried as is, any other name with each one.
 */
export function candidateNames(name: string, env: Env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [name]
  const extensions = (envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'))
  if (extensions.includes(path.win32.extname(name).toLowerCase())) return [name]
  return extensions.map((extension) => name + extension)
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Absolute path of a bare program name (`git`, `node`) found on PATH, or null. */
export function searchPath(name: string, env: Env, platform: NodeJS.Platform = process.platform): string | null {
  const api = platform === 'win32' ? path.win32 : path.posix
  for (const dir of searchDirectories(env, platform)) {
    for (const candidate of candidateNames(name, env, platform)) {
      const file = api.join(dir, candidate)
      if (isFile(file)) return file
    }
  }
  return null
}

/** A program that ships with Windows, by absolute path. */
export function windowsSystemProgram(file: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.win32.join(root, 'System32', file)
}

/** Arguments cmd.exe hands to a batch file as typed: no spaces, quotes, % or other cmd syntax. */
const PLAIN_BATCH_ARGUMENT = /^[\w\-+=.,:/\\@~]+$/

export type BatchCommand = { ok: true; file: string; args: string[] } | { ok: false; reason: string }

/**
 * How to start a batch file (npm.cmd, yarn.cmd): only cmd.exe runs them, and
 * it re-parses the whole line, so only plain arguments are passed through.
 * Run with `windowsVerbatimArguments`, and with NoDefaultCurrentDirectoryInExePath
 * set so the script's own bare `node` is not looked up in the project.
 */
export function batchCommand(file: string, args: readonly string[], cmd = windowsSystemProgram('cmd.exe')): BatchCommand {
  if (/["%^&|<>!\r\n]/.test(file)) {
    return { ok: false, reason: `${path.win32.basename(file)} is in a folder whose name cmd.exe would reinterpret` }
  }
  const unsafe = args.find((arg) => !PLAIN_BATCH_ARGUMENT.test(arg))
  if (unsafe !== undefined) {
    return { ok: false, reason: `the argument ${JSON.stringify(unsafe)} would be reinterpreted by cmd.exe` }
  }
  return { ok: true, file: cmd, args: ['/d', '/v:off', '/s', '/c', `""${file}"${args.map((arg) => ` ${arg}`).join('')}"`] }
}
