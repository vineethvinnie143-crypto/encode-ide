/**
 * Runs git for eNCode's own requests (the Review tab and its Commit dialog), never for the agent: with the settings
 * that keep a repository's config from starting a program on a read (GIT_SAFETY_CONFIG), paths taken literally, no
 * prompts in a terminal, and without the variables that would point git at another repository than the folder's.
 */
import { spawn } from 'node:child_process'
import { GIT_SAFETY_CONFIG, withGitSafety } from '@encode/permissions'

/** Variables that would make git work on another repository, index or object store, or change how it writes a patch. */
const RELOCATING = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
]

/** Passed as `-c` on every command, which outranks every config file. */
const SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ...GIT_SAFETY_CONFIG,
  ['core.quotePath', 'false'],
  ['color.ui', 'false'],
  // `git log` would otherwise run gpg for every commit it shows.
  ['log.showSignature', 'false'],
]

const SETTING_ARGS = SETTINGS.flatMap(([key, value]) => ['-c', `${key}=${value}`])

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const MAX_STDERR = 64 * 1024

export type GitErrorCode = 'failed' | 'timeout' | 'too-large' | 'missing'

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: GitErrorCode,
    readonly stderr = '',
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface RunOptions {
  /** Written to git's standard input, which is then closed. Without it the input is closed at once. */
  input?: string | Buffer
  timeoutMs?: number
  /** Output beyond this many bytes ends the command with a `too-large` error. */
  maxBytes?: number
}

export interface GitRunnerOptions {
  /** git, by absolute path: a bare `git` could resolve to a git.exe in the working folder on Windows. */
  git: string
  /** The folder git runs in. */
  cwd: string
  /** The environment to start from, usually the program's own. */
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

/** The environment eNCode's own git commands run with. */
export function gitEnvironment(base: Readonly<Record<string, string | undefined>>, windows: boolean): Record<string, string> {
  const env: Record<string, string> = {}
  const drop = new Set(RELOCATING)
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue
    if (drop.has(windows ? key.toUpperCase() : key)) continue
    env[key] = value
  }
  const out = withGitSafety(env, windows)
  const set = (name: string, value: string) => {
    const existing = windows ? Object.keys(out).find((key) => key.toUpperCase() === name) : undefined
    out[existing ?? name] = value
  }
  // A path given to a command is that path, not a pattern: a file named `*.ts` stays one file.
  set('GIT_LITERAL_PATHSPECS', '1')
  // Nothing here waits for an editor; a command that would open one fails instead of hanging.
  set('GIT_EDITOR', ':')
  set('GIT_MERGE_AUTOEDIT', 'no')
  return out
}

export class GitRunner {
  readonly cwd: string
  private readonly git: string
  private readonly env: Record<string, string>

  constructor(options: GitRunnerOptions) {
    this.git = options.git
    this.cwd = options.cwd
    this.env = gitEnvironment(options.env, (options.platform ?? process.platform) === 'win32')
  }

  /** Runs git; a non-zero exit is a result, not an error. */
  run(args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    return new Promise<GitResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.git, [...SETTING_ARGS, ...args], { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new GitError(`git could not be started: ${error instanceof Error ? error.message : String(error)}`, 'missing'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let stderr = ''
      let settled = false
      const finish = (outcome: GitResult | GitError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (outcome instanceof GitError) reject(outcome)
        else resolve(outcome)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new GitError(`git ${args[0] ?? ''} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, 'timeout', stderr))
      }, timeoutMs)
      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          child.kill()
          finish(new GitError(`git ${args[0] ?? ''} printed more than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'too-large', stderr))
          return
        }
        chunks.push(chunk)
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(new GitError(error.code === 'ENOENT' ? 'git was not found.' : `git could not be started: ${error.message}`, 'missing'))
      })
      child.on('close', (code) => finish({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }))
      // A command that reads nothing may already have exited; its closed input is not an error.
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(options.input ?? undefined)
    })
  }

  /** Runs git and returns what it printed; an exit with an error becomes a GitError with git's own words. */
  async ok(args: readonly string[], options?: RunOptions): Promise<Buffer> {
    const result = await this.run(args, options)
    if (result.code !== 0) throw failure(args, result)
    return result.stdout
  }

  /** The output as text, without the final line break. */
  async text(args: readonly string[], options?: RunOptions): Promise<string> {
    return (await this.ok(args, options)).toString('utf8').replace(/\r?\n$/, '')
  }
}

/** git's own message for a failed command, cut to what a person reads. */
export function failure(args: readonly string[], result: GitResult): GitError {
  const said = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^hint: /.test(line))
    .join('\n')
    .trim()
  const message = said ? said.slice(0, 2_000) : `git ${args[0] ?? ''} failed (exit code ${result.code}).`
  return new GitError(message, 'failed', result.stderr, result.code)
}
