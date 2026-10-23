/**
 * Finding a language server on this machine: in the project's `node_modules/.bin`, then on the PATH, then in eNCode's
 * tools folder. On Windows an npm install leaves a `.cmd` shim, which Node cannot start without a shell; the shim is
 * read for the script it runs, and that script is started with Node directly, so no command line is ever handed to
 * cmd.exe.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ServerSpec } from './catalog'
import { installedLaunch, type LaunchContext } from './install'

export interface LaunchPlan {
  /** Absolute. */
  file: string
  args: string[]
  /** For people: where it was found. */
  found: string
  /** The candidate's name. */
  command: string
  /** Added to the environment it starts with (eNCode's own Node.js runs as Node through this). */
  env?: Record<string, string>
}

export interface DiscoverOptions {
  platform?: NodeJS.Platform
  /** A program on the PATH by absolute path, or null. */
  which(name: string): string | null
  /** Default: the disk. */
  isFile?(file: string): boolean
  readText?(file: string): string | null
  /** Look in the project's `node_modules/.bin` too: only for a folder the person trusts, since the project put it there. */
  projectBins?: boolean
  /** eNCode's tools folder, where it installs servers, looked in last. */
  tools?: { dir: string; context: LaunchContext }
}

function diskIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function diskRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * The script an npm or pnpm `.cmd` shim runs, absolute, or null when the shim does not read as one. npm writes
 * `"%dp0%\node_modules\pkg\cli.js" %*`, pnpm `"%~dp0\..\pkg\cli.js" %*`.
 */
export function shimScript(shim: string, text: string): string | null {
  const dir = path.win32.dirname(shim)
  const found = [...text.matchAll(/"%~?dp0%?\\([^"%]+?\.(?:c|m)?js)"/gi)].map((match) => match[1])
  const script = found.at(-1)
  if (!script) return null
  const resolved = path.win32.resolve(dir, script)
  // The script must stay where the shim's package is: a shim that points elsewhere is not one npm wrote.
  const base = path.win32.resolve(dir, '..')
  const prefix = (base.endsWith('\\') ? base : `${base}\\`).toLowerCase()
  return resolved.toLowerCase().startsWith(prefix) ? resolved : null
}

/** How to start a server, or what is missing. */
export function discover(spec: ServerSpec, root: string, options: DiscoverOptions): LaunchPlan | { missing: string } {
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? diskIsFile
  const read = options.readText ?? diskRead
  const windows = platform === 'win32'
  const api = windows ? path.win32 : path.posix
  for (const candidate of spec.candidates) {
    const places: { file: string; found: string }[] = []
    if (options.projectBins) {
      const bin = api.join(root, 'node_modules', '.bin')
      for (const name of windows ? [`${candidate.command}.exe`, `${candidate.command}.cmd`] : [candidate.command]) places.push({ file: api.join(bin, name), found: 'the project' })
    }
    const onPath = options.which(candidate.command)
    if (onPath) places.push({ file: onPath, found: 'the PATH' })
    for (const place of places) {
      if (!isFile(place.file)) continue
      const extension = api.extname(place.file).toLowerCase()
      if (windows && (extension === '.cmd' || extension === '.bat')) {
        const text = read(place.file)
        const script = text ? shimScript(place.file, text) : null
        if (!script || !isFile(script)) continue
        const bundled = api.join(api.dirname(place.file), 'node.exe')
        const node = isFile(bundled) ? bundled : options.which('node')
        if (!node) return { missing: `${candidate.command} needs Node.js, which is not on the PATH. Install Node.js from nodejs.org.` }
        return { file: node, args: [script, ...candidate.args], found: place.found, command: candidate.command }
      }
      if (windows && extension && extension !== '.exe' && extension !== '.com') continue
      return { file: place.file, args: [...candidate.args], found: place.found, command: candidate.command }
    }
  }
  if (options.tools) {
    const installed = installedLaunch(spec, options.tools.dir, options.tools.context)
    if (installed) return installed
  }
  const names = spec.candidates.map((candidate) => candidate.command).join(' or ')
  return { missing: `No language server for ${spec.label} is installed (${names}). To get one: ${spec.installer ? 'install it from Settings > Language servers, or ' : ''}${spec.install}.` }
}
