import path from 'node:path'

/**
 * Finding and starting the program of a stdio server.
 *
 * Programs come from absolute PATH entries only (never the working
 * directory, never an empty or relative PATH entry: a repository must not be
 * able to put its own `npx` ahead of the real one), and a command written
 * with a path is taken from where that path says. On Windows the program may
 * be a `.cmd` or `.bat` shim, such as npx; Node refuses to start those
 * directly, so they run through cmd.exe, and then every argument is checked:
 * cmd.exe reads `%`, `^`, `&`, `|`, `<`, `>`, `!` and quotes even where
 * they look harmless, and there is no way to pass them through safely.
 */

export interface ProgramHost {
  env: Record<string, string | undefined>
  /** Where a relative command is taken from: the workspace root. */
  cwd: string
  platform: NodeJS.Platform
  /** True when a file (not a folder) exists at the path. */
  isFile(file: string): Promise<boolean>
}

export interface SpawnTarget {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat']
const SAFE_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\~-]+$/
const CMD_UNSAFE = /["%^&|<>!\r\n\u0000]/

function lookup(env: Record<string, string | undefined>, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** The absolute path of the program a command names, or null. */
export async function resolveProgram(command: string, host: ProgramHost): Promise<string | null> {
  const windows = host.platform === 'win32'
  const api = windows ? path.win32 : path.posix
  if (!command || command.includes('\u0000')) return null

  const withExtensions = (base: string): string[] => {
    if (!windows) return [base]
    const ext = api.extname(base).toLowerCase()
    return WINDOWS_EXTENSIONS.includes(ext) ? [base] : WINDOWS_EXTENSIONS.map((extension) => base + extension)
  }

  const hasSeparator = command.includes('/') || (windows && command.includes('\\'))
  if (hasSeparator || api.isAbsolute(command)) {
    for (const candidate of withExtensions(api.resolve(host.cwd, command))) if (await host.isFile(candidate)) return candidate
    return null
  }
  const entries = (lookup(host.env, 'PATH', windows) ?? '').split(windows ? ';' : ':')
  for (const entry of entries) {
    const folder = windows ? entry.replace(/^"(.*)"$/, '$1') : entry
    if (!folder || !api.isAbsolute(folder)) continue
    for (const candidate of withExtensions(api.join(folder, command))) if (await host.isFile(candidate)) return candidate
  }
  return null
}

function quoteForCmd(argument: string): string | null {
  if (argument === '') return '""'
  if (SAFE_ARGUMENT.test(argument)) return argument
  if (CMD_UNSAFE.test(argument)) return null
  return `"${argument.replace(/(\\+)$/, '$1$1')}"`
}

/** How to start `file` with `args`; a string says why it cannot be done safely. */
export function spawnTarget(file: string, args: string[], host: Pick<ProgramHost, 'env' | 'platform'>): SpawnTarget | string {
  if (host.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  if (CMD_UNSAFE.test(file)) return `${file} cannot be started through cmd.exe because its path contains characters cmd.exe treats as commands.`
  const quoted: string[] = []
  for (const argument of args) {
    const safe = quoteForCmd(argument)
    if (safe === null) {
      return `The argument ${JSON.stringify(argument.length > 40 ? `${argument.slice(0, 40)}...` : argument)} cannot be passed to ${path.win32.basename(file)} safely (cmd.exe would read it as a command). Start the server with an .exe or with node directly.`
    }
    quoted.push(safe)
  }
  const root = lookup(host.env, 'SystemRoot', true) ?? lookup(host.env, 'windir', true) ?? 'C:\\Windows'
  const cmd = path.win32.join(root, 'System32', 'cmd.exe')
  return { file: cmd, args: ['/d', '/s', '/c', `"${[`"${file}"`, ...quoted].join(' ')}"`], windowsVerbatimArguments: true }
}

/**
 * The environment a stdio server starts with: a short list of what any
 * program needs to find its way (and proxy settings), plus what the
 * configuration names. The user's other variables, API keys among them, stay
 * behind unless the configuration passes them on.
 */
const POSIX_BASE = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR']
const WINDOWS_BASE = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'COMSPEC',
  'WINDIR',
]
const NETWORK_BASE = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
]

export function serverEnvironment(
  source: Record<string, string | undefined>,
  configured: Record<string, string>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const windows = platform === 'win32'
  // Windows names are compared without case; elsewhere they are exact.
  const fold = (name: string) => (windows ? name.toLowerCase() : name)
  const allowed = new Set([...(windows ? WINDOWS_BASE : POSIX_BASE), ...NETWORK_BASE].map(fold))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (allowed.has(fold(name)) || (!windows && name.startsWith('LC_'))) env[name] = value
  }
  for (const [name, value] of Object.entries(configured)) {
    if (windows) for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing]
    env[name] = value
  }
  return env
}
