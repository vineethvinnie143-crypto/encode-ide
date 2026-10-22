/**
 * Environment checks shared by the shell policies. Each agent command runs in
 * a fresh shell that inherits the environment the previous one exported, so a
 * command the user approved earlier can leave behind a variable that makes a
 * later, read-only looking command run other code or write files. Before a
 * line runs unasked, its environment is checked for such variables.
 */

export type Environment = Readonly<Record<string, string | undefined>>

/** The value of `name`; Windows matches variable names without regard to case (Path, PATH). */
export function envValue(env: Environment | undefined, name: string, windows: boolean): string | undefined {
  if (!env) return undefined
  if (!windows || Object.hasOwn(env, name)) return env[name]
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper)
  return key === undefined ? undefined : env[key]
}

/**
 * Variables that make the shell itself, or any program it starts, run other
 * code or write files, whatever the line says.
 */
const ALWAYS_RISKY = new Set([
  // bash reads these at startup or while it runs: startup files, options such as xtrace, field splitting.
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS', 'GLOBIGNORE', 'BASH_XTRACEFD', 'EXECIGNORE',
])
/** The dynamic loader's variables (LD_PRELOAD, LD_DEBUG_OUTPUT, DYLD_INSERT_LIBRARIES) and exported bash functions. */
const ALWAYS_RISKY_PREFIXES = ['LD_', 'DYLD_', 'BASH_FUNC_']

/** Variables that matter only to one program on the read-only lists. */
const PROGRAM_RISKS: ReadonlyArray<readonly [program: string, names: ReadonlySet<string>, prefixes: readonly string[]]> = [
  [
    'git',
    new Set([
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_EXEC_PATH', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG',
      'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]),
    // GIT_TRACE=/some/file makes git append to that file.
    ['GIT_TRACE'],
  ],
  ['rg', new Set(['RIPGREP_CONFIG_PATH']), []],
  ['grep', new Set(['GREP_OPTIONS']), []],
  ['egrep', new Set(['GREP_OPTIONS']), []],
  ['fgrep', new Set(['GREP_OPTIONS']), []],
  ['node', new Set(['NODE_OPTIONS']), []],
  ['tsc', new Set(['NODE_OPTIONS']), []],
  ['python', new Set(), ['PYTHON']],
  ['python3', new Set(), ['PYTHON']],
]

/** A program name as the risk table spells it: lower case and without .exe on Windows. */
function programKey(program: string, windows: boolean): string {
  return windows ? program.toLowerCase().replace(/\.(exe|com)$/, '') : program
}

/**
 * The first variable in `env` that could make this line run something it
 * does not say, given the programs it starts; null when there is none. Empty
 * variables count as unset, as they do for every variable listed.
 */
export function riskyVariable(env: Environment | undefined, programs: Iterable<string>, windows: boolean): string | null {
  if (!env) return null
  const names = Object.keys(env).filter((name) => env[name] !== undefined && env[name] !== '')
  const keys = new Set([...programs].map((program) => programKey(program, windows)))
  for (const name of names) {
    // Matching ignores case on every platform: a lower-case twin of a risky name is suspicious enough to ask.
    const upper = name.toUpperCase()
    if (ALWAYS_RISKY.has(upper) || ALWAYS_RISKY_PREFIXES.some((prefix) => upper.startsWith(prefix))) return name
    for (const [program, risky, prefixes] of PROGRAM_RISKS) {
      if (keys.has(program) && (risky.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix)))) return name
    }
  }
  return null
}

/**
 * git settings eNCode passes on the command line, which outranks every
 * config file, to each git the agent runs. A repository's own config, which
 * whoever wrote the folder controls, can otherwise start programs.
 */
export const GIT_SAFETY_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  // A repository's config must not start a program on `git status`.
  ['core.fsmonitor', 'false'],
  // A bare repository planted in the workspace (dir/HEAD, dir/config) is not picked up by `cd dir; git log -p`.
  ['safe.bareRepository', 'explicit'],
]

/**
 * `env` with eNCode's git settings appended after any the user already has
 * (as GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n), credential prompts off, and
 * GIT_OPTIONAL_LOCKS=0 so `git status` does not rewrite the index (which
 * would run the repository's post-index-change hook).
 */
export function withGitSafety(env: Readonly<Record<string, string>>, windows: boolean): Record<string, string> {
  const out = { ...env }
  const keyOf = (name: string) =>
    windows ? (Object.keys(out).find((key) => key.toUpperCase() === name) ?? name) : name
  const countKey = keyOf('GIT_CONFIG_COUNT')
  const count = Number(out[countKey] ?? 0)
  let index = Number.isInteger(count) && count >= 0 ? count : 0
  for (const [key, value] of GIT_SAFETY_CONFIG) {
    out[keyOf(`GIT_CONFIG_KEY_${index}`)] = key
    out[keyOf(`GIT_CONFIG_VALUE_${index}`)] = value
    index++
  }
  out[countKey] = String(index)
  out[keyOf('GIT_TERMINAL_PROMPT')] = '0'
  out[keyOf('GIT_OPTIONAL_LOCKS')] = '0'
  return out
}

/**
 * Why git may not run unasked with this environment, or null when eNCode's
 * git settings are in effect. git reads GIT_CONFIG_KEY_n for n below
 * GIT_CONFIG_COUNT and the last value of a key wins, so an earlier command
 * that lowered the count or added a key of its own would undo them. Any
 * command-line key other than eNCode's own therefore asks as well.
 */
export function gitSafetyProblem(env: Environment | undefined, windows: boolean): string | null {
  const missing = "eNCode's git safety settings are not in effect"
  const count = Number(envValue(env, 'GIT_CONFIG_COUNT', windows) ?? '')
  if (!Number.isInteger(count) || count < 1 || count > 1000) return missing
  const effective = new Map<string, string>()
  for (let index = 0; index < count; index++) {
    const key = envValue(env, `GIT_CONFIG_KEY_${index}`, windows)
    const value = envValue(env, `GIT_CONFIG_VALUE_${index}`, windows) ?? ''
    if (key === undefined) return missing
    // Section and variable names are case-insensitive in git (Core.FSMonitor).
    const wanted = GIT_SAFETY_CONFIG.find(([own]) => own.toLowerCase() === key.toLowerCase())
    if (!wanted) return `the environment sets the git setting ${key}, which can change what git runs`
    effective.set(wanted[0], value)
  }
  for (const [key, value] of GIT_SAFETY_CONFIG) {
    if (effective.get(key) !== value) return missing
  }
  return null
}
