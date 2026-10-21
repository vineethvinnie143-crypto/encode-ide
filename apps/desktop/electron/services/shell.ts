import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  SHELL_BUILTINS,
  commandName,
  isBuiltin,
  parseLine,
  resolveShellPath as resolveWithHost,
  type ShellSegment,
} from '@encode/permissions'
import type { ShellCreateOptions, ShellInfo, ShellPromptInfo } from '../../shared/types'

const RESET = '\x1b[0m'
const RED = '\x1b[31m'
const BLUE = '\x1b[34m'
const GRAY = '\x1b[90m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

export interface ShellSink {
  data(text: string): void
  prompt(info: ShellPromptInfo): void
  exit(code: number): void
}

function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/**
 * git settings for commands the agent runs. They are passed as command-line
 * config, which outranks repository config.
 */
const AGENT_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // A repository's config must not start a program on `git status`.
  ['core.fsmonitor', 'false'],
  // A bare repository planted in the workspace (dir/HEAD, dir/config) is not picked up by `cd dir; git log -p`.
  ['safe.bareRepository', 'explicit'],
]

/**
 * Environment for commands the agent runs: the user's environment, plus the
 * git settings above, and no credential prompt nobody could answer.
 */
export function agentEnvironment(): Record<string, string> {
  const env = currentEnv()
  const count = Number(env.GIT_CONFIG_COUNT ?? 0)
  let index = Number.isInteger(count) && count >= 0 ? count : 0
  for (const [key, value] of AGENT_GIT_CONFIG) {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
    index++
  }
  env.GIT_CONFIG_COUNT = String(index)
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

interface ResolvedCommand {
  file: string
  args: string[]
}

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function resolveShellPath(cwd: string, target: string): string {
  return resolveWithHost(cwd, target, { home: os.homedir(), path })
}

/**
 * Many Node tools on Windows are npm-generated `.cmd` shims that ultimately run
 * `node <cli.js>`. Rather than invoking cmd.exe, parse that pattern and run the
 * node script directly.
 */
function parseNodeShim(file: string): { node: string; script: string } | null {
  try {
    const content = fs.readFileSync(file, 'utf8')
    const match = /"%_prog%"\s+"([^"]+\.(?:js|cjs|mjs))"\s*%\*/i.exec(content)
    if (!match) return null
    const dir = path.dirname(file)
    const script = path.resolve(dir, match[1].replace(/%dp0%/gi, dir))
    if (!fileExists(script)) return null
    const localNode = path.join(dir, 'node.exe')
    return { node: fileExists(localNode) ? localNode : 'node.exe', script }
  } catch {
    return null
  }
}

function resolveCommand(name: string, cwd: string, env: Record<string, string>): ResolvedCommand | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const tryFile = (base: string): string | null => {
    if (fileExists(base)) return base
    if (!path.extname(base)) {
      for (const ext of exts) {
        if (fileExists(base + ext)) return base + ext
      }
    }
    return null
  }

  let found: string | null = null
  if (/[\\/]/.test(name) || name.startsWith('.')) {
    found = tryFile(resolveShellPath(cwd, name))
  } else {
    const dirs = (env.PATH ?? '').split(path.delimiter)
    for (const dir of dirs) {
      if (!dir) continue
      found = tryFile(path.join(dir, name))
      if (found) break
    }
  }
  if (!found) return null

  const ext = path.extname(found).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    const shim = parseNodeShim(found)
    if (shim) return { file: shim.node, args: [shim.script] }
  }
  return { file: found, args: [] }
}

/**
 * The files the shell would execute for a bare program name: the program
 * itself, plus the script for npm-style shims. Empty when it is not found.
 */
export function locateProgram(name: string, cwd: string, env: Record<string, string>): string[] {
  const resolved = resolveCommand(name, cwd, env)
  return resolved ? [resolved.file, ...resolved.args] : []
}

export class ShellSession {
  readonly id: string
  cwd: string
  private readonly env: Record<string, string>
  private readonly history: string[] = []
  private child: ChildProcess | null = null
  private closed = false
  private lastCode = 0
  private timedOut = false

  constructor(id: string, cwd: string, env: Record<string, string>, private readonly sink: ShellSink) {
    this.id = id
    this.cwd = cwd
    this.env = { ...env }
  }

  get exitCode(): number {
    return this.lastCode
  }

  getInfo(): ShellInfo {
    return { id: this.id, cwd: this.cwd, prompt: this.promptText() }
  }

  promptText(): string {
    const home = os.homedir()
    let display = this.cwd
    if (display === home) display = '~'
    else if (display.startsWith(home + path.sep)) display = `~${display.slice(home.length)}`
    const name = display === '~' ? '~' : path.basename(display) || display
    return `${name}${GRAY}❯${RESET} `
  }

  private promptInfo(): ShellPromptInfo {
    return { id: this.id, cwd: this.cwd, prompt: this.promptText() }
  }

  async run(line: string): Promise<void> {
    if (this.closed) return
    const trimmed = line.trim()
    if (trimmed) this.history.push(trimmed)
    this.lastCode = 0
    this.timedOut = false

    try {
      for (const statement of parseLine(line)) {
        if (statement.cond === 'and' && this.lastCode !== 0) continue
        if (statement.cond === 'or' && this.lastCode === 0) continue
        this.lastCode = await this.executeStatement(statement.segments)
        if (this.closed) return
      }
    } catch (error) {
      this.writeError((error as Error).message)
      this.lastCode = 1
    }

    if (!this.closed) this.sink.prompt(this.promptInfo())
  }

  cancel(): void {
    const child = this.child
    this.child = null
    if (!child || !child.pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancel()
    this.sink.exit(0)
  }

  complete(line: string): string[] {
    const prefix = /([^\s]*)$/.exec(line)?.[1] ?? ''
    const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))

    if (slash >= 0) {
      const dirPart = prefix.slice(0, slash + 1)
      const base = prefix.slice(slash + 1).toLowerCase()
      try {
        return fs
          .readdirSync(resolveShellPath(this.cwd, dirPart))
          .filter((name) => name.toLowerCase().startsWith(base))
          .map((name) => dirPart + name)
          .slice(0, 50)
      } catch {
        return []
      }
    }

    const candidates = new Set<string>(SHELL_BUILTINS)
    try {
      for (const entry of fs.readdirSync(this.cwd)) candidates.add(entry)
    } catch {
      /* unreadable cwd */
    }
    for (const dir of (this.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      try {
        for (const file of fs.readdirSync(dir)) {
          const ext = path.extname(file).toLowerCase()
          if (ext === '.exe' || ext === '.com' || ext === '.cmd' || ext === '.bat') {
            candidates.add(path.basename(file, ext))
          }
        }
      } catch {
        /* skip unreadable PATH entries */
      }
    }
    const needle = prefix.toLowerCase()
    return [...candidates].filter((name) => name.toLowerCase().startsWith(needle)).sort().slice(0, 50)
  }

  private async executeStatement(segments: ShellSegment[]): Promise<number> {
    if (!segments.length) return 0

    const redirect = segments[segments.length - 1].redirect
    let input: string | null = null
    let output = ''
    let code = 0

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]
      const single = segments.length === 1
      const result = await this.executeCommand(segment.tokens, input, single)
      code = result.code
      output = result.output
      input = result.output
    }

    if (redirect) {
      try {
        await fsp.writeFile(resolveShellPath(this.cwd, redirect.file), output, redirect.append ? { flag: 'a' } : undefined)
      } catch (error) {
        this.writeError(`cannot write ${redirect.file}: ${(error as Error).message}`)
        return 1
      }
    } else if (output) {
      this.sink.data(output)
    }

    return code
  }

  private async executeCommand(
    tokens: string[],
    input: string | null,
    single: boolean,
  ): Promise<{ code: number; output: string }> {
    const name = commandName(tokens[0])
    if (isBuiltin(name)) {
      return this.runBuiltin(name, tokens.slice(1), input)
    }
    return this.runExternal(tokens, input, single)
  }

  private async runBuiltin(
    name: string,
    args: string[],
    input: string | null,
  ): Promise<{ code: number; output: string }> {
    const ok = (output = ''): { code: number; output: string } => ({ code: 0, output })
    const fail = (message: string): { code: number; output: string } => ({
      code: 1,
      output: `${RED}${message}${RESET}\n`,
    })

    switch (name) {
      case 'help':
        return ok(
          `${BOLD}eNCode Shell${RESET} — built-ins execute in-process; other commands run as real programs.\n\n` +
            `Built-ins: ${SHELL_BUILTINS.join(', ')}\n` +
            `Examples:\n` +
            `  ls -a            list files (blue directories)\n` +
            `  cd src           change directory\n` +
            `  cat README.md | wc -l   pipelines work\n` +
            `  echo hi > out.txt       redirect with > and >>\n` +
            `  node --version   external programs run without a cmd/PowerShell\n`,
        )
      case 'clear':
        this.sink.data('\x1b[2J\x1b[H')
        return ok()
      case 'pwd':
        return ok(`${this.cwd}\n`)
      case 'cd': {
        const target = args[0] ? resolveShellPath(this.cwd, args[0]) : os.homedir()
        if (!directoryExists(target)) return fail(`cd: no such directory: ${args[0] ?? target}`)
        this.cwd = target
        return ok()
      }
      case 'ls':
        return this.listDirectory(args)
      case 'cat':
        if (!args.length) return ok(input ?? '')
        return this.readFiles(args)
      case 'echo': {
        const noNewline = args[0] === '-n'
        const text = (noNewline ? args.slice(1) : args).join(' ')
        return ok(noNewline ? text : `${text}\n`)
      }
      case 'mkdir': {
        const targets = args.filter((arg) => !arg.startsWith('-'))
        if (!targets.length) return fail('mkdir: missing directory')
        let code = 0
        for (const target of targets) {
          try {
            await fsp.mkdir(resolveShellPath(this.cwd, target), { recursive: args.includes('-p') })
          } catch (error) {
            this.writeError(`mkdir: ${target}: ${(error as Error).message}`)
            code = 1
          }
        }
        return { code, output: '' }
      }
      case 'rm': {
        const recursive = args.some((arg) => arg === '-r' || arg === '-R' || arg === '-rf' || arg === '-fr')
        const targets = args.filter((arg) => !arg.startsWith('-'))
        if (!targets.length) return fail('rm: missing path')
        let code = 0
        for (const target of targets) {
          const abs = resolveShellPath(this.cwd, target)
          try {
            const stat = await fsp.stat(abs)
            if (stat.isDirectory()) {
              if (!recursive) {
                this.writeError(`rm: ${target} is a directory (use -r)`)
                code = 1
                continue
              }
              await fsp.rm(abs, { recursive: true, force: true })
            } else {
              await fsp.unlink(abs)
            }
          } catch (error) {
            this.writeError(`rm: ${target}: ${(error as Error).message}`)
            code = 1
          }
        }
        return { code, output: '' }
      }
      case 'mv':
      case 'cp': {
        if (args.length < 2) return fail(`${name}: source and destination required`)
        const source = resolveShellPath(this.cwd, args[0])
        const destination = resolveShellPath(this.cwd, args[1])
        try {
          if (name === 'mv') await fsp.rename(source, destination)
          else await fsp.cp(source, destination, { recursive: true })
          return ok()
        } catch (error) {
          return fail(`${name}: ${(error as Error).message}`)
        }
      }
      case 'touch': {
        if (!args.length) return fail('touch: missing file')
        let code = 0
        for (const target of args) {
          const abs = resolveShellPath(this.cwd, target)
          try {
            await fsp.appendFile(abs, '')
          } catch (error) {
            this.writeError(`touch: ${target}: ${(error as Error).message}`)
            code = 1
          }
        }
        return { code, output: '' }
      }
      case 'head':
      case 'tail':
        return this.headTail(name, args)
      case 'wc':
        return this.wordCount(args, input)
      case 'which': {
        if (!args[0]) return fail('which: missing command')
        const resolved = resolveCommand(args[0], this.cwd, this.env)
        return resolved ? ok(`${resolved.file}\n`) : fail(`${args[0]}: not found`)
      }
      case 'env':
        return ok(
          Object.entries(this.env)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n') + '\n',
        )
      case 'set':
      case 'export': {
        if (!args.length) return this.runBuiltin('env', [], null)
        let code = 0
        for (const assignment of args) {
          const index = assignment.indexOf('=')
          if (index <= 0) {
            this.writeError(`${name}: expected NAME=value`)
            code = 1
            continue
          }
          this.env[assignment.slice(0, index)] = assignment.slice(index + 1)
        }
        return { code, output: '' }
      }
      case 'unset':
        for (const key of args) delete this.env[key]
        return ok()
      case 'date':
        return ok(`${new Date().toString()}\n`)
      case 'whoami':
        return ok(`${os.userInfo().username}\n`)
      case 'history':
        return ok(this.history.map((entry, index) => `${String(index + 1).padStart(3)}  ${entry}`).join('\n') + '\n')
      case 'ver':
        return ok(`eNCode Shell 0.1.0 (${process.platform} ${process.arch}, node ${process.versions.node})\n`)
      case 'exit':
        this.closed = true
        this.cancel()
        this.sink.exit(0)
        return ok()
      default:
        return fail(`${name}: builtin not implemented`)
    }
  }

  private async listDirectory(args: string[]): Promise<{ code: number; output: string }> {
    const showHidden = args.some((arg) => arg.startsWith('-') && arg.includes('a'))
    const target = args.find((arg) => !arg.startsWith('-')) ?? '.'
    const abs = resolveShellPath(this.cwd, target)
    try {
      const entries = await fsp.readdir(abs, { withFileTypes: true })
      const visible = entries.filter((entry) => showHidden || !entry.name.startsWith('.'))
      visible.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      if (!visible.length) return { code: 0, output: `${DIM}(empty)${RESET}\n` }
      const names = visible.map((entry) =>
        entry.isDirectory() ? `${BLUE}${BOLD}${entry.name}/${RESET}` : entry.name,
      )
      return { code: 0, output: names.join('  ') + '\n' }
    } catch (error) {
      return { code: 1, output: `${RED}ls: ${target}: ${(error as Error).message}${RESET}\n` }
    }
  }

  private async readFiles(args: string[]): Promise<{ code: number; output: string }> {
    let output = ''
    let code = 0
    for (const target of args) {
      try {
        output += await fsp.readFile(resolveShellPath(this.cwd, target), 'utf8')
      } catch (error) {
        output += `${RED}cat: ${target}: ${(error as Error).message}${RESET}\n`
        code = 1
      }
    }
    return { code, output }
  }

  private async headTail(name: 'head' | 'tail', args: string[]): Promise<{ code: number; output: string }> {
    let count = 10
    const files: string[] = []
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '-n' && args[index + 1]) {
        count = Math.max(1, Number(args[++index]) || 10)
      } else if (!args[index].startsWith('-')) {
        files.push(args[index])
      }
    }
    if (!files.length) return { code: 1, output: `${RED}${name}: missing file${RESET}\n` }
    let output = ''
    let code = 0
    for (const file of files) {
      try {
        const text = await fsp.readFile(resolveShellPath(this.cwd, file), 'utf8')
        const lines = text.split(/\r?\n/)
        const selected = name === 'head' ? lines.slice(0, count) : lines.slice(-count)
        output += selected.join('\n') + '\n'
      } catch (error) {
        output += `${RED}${name}: ${file}: ${(error as Error).message}${RESET}\n`
        code = 1
      }
    }
    return { code, output }
  }

  private async wordCount(args: string[], input: string | null): Promise<{ code: number; output: string }> {
    let flag = ''
    let file: string | null = null
    for (const arg of args) {
      if (arg.startsWith('-')) flag = arg
      else file = arg
    }
    let text: string
    if (file) {
      try {
        text = await fsp.readFile(resolveShellPath(this.cwd, file), 'utf8')
      } catch (error) {
        return { code: 1, output: `${RED}wc: ${file}: ${(error as Error).message}${RESET}\n` }
      }
    } else {
      text = input ?? ''
    }
    const lines = text ? text.split(/\r?\n/).length : 0
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const chars = text.length
    const label = file ?? ''
    if (flag.includes('l')) return { code: 0, output: `${lines} ${label}\n`.trimStart() }
    if (flag.includes('w')) return { code: 0, output: `${words} ${label}\n`.trimStart() }
    if (flag.includes('c')) return { code: 0, output: `${chars} ${label}\n`.trimStart() }
    return { code: 0, output: `${lines}\t${words}\t${chars} ${label}\n`.trimStart() }
  }

  private async runExternal(
    tokens: string[],
    input: string | null,
    stream: boolean,
  ): Promise<{ code: number; output: string }> {
    const resolved = resolveCommand(tokens[0], this.cwd, this.env)
    if (!resolved) {
      return { code: 127, output: `${RED}${tokens[0]}: command not found${RESET}\n` }
    }

    try {
      const child = spawn(resolved.file, [...resolved.args, ...tokens.slice(1)], {
        cwd: this.cwd,
        env: { ...this.env, PWD: this.cwd },
        windowsHide: true,
        stdio: 'pipe',
        detached: process.platform !== 'win32',
      })
      this.child = child
      let collected = ''
      const handle = (buffer: Buffer) => {
        const text = buffer.toString('utf8')
        if (stream) this.sink.data(text)
        else collected += text
      }
      child.stdout?.on('data', handle)
      child.stderr?.on('data', handle)

      if (input !== null) child.stdin?.end(input)
      else child.stdin?.end()

      const code = await new Promise<number>((resolve) => {
        child.on('error', (error) => {
          if (stream) this.writeError(error.message)
          else collected += `${RED}${error.message}${RESET}\n`
          resolve(-1)
        })
        child.on('close', (exitCode) => resolve(exitCode ?? 0))
      })
      this.child = null
      return { code, output: stream ? '' : collected }
    } catch (error) {
      this.child = null
      return { code: 1, output: `${RED}${(error as Error).message}${RESET}\n` }
    }
  }

  private writeError(message: string): void {
    this.sink.data(`${RED}${message}${RESET}\n`)
  }

  setTimedOut(): void {
    this.timedOut = true
  }
}

export interface ShellCaptureResult {
  code: number
  output: string
  timedOut: boolean
  aborted: boolean
}

export class ShellService {
  private readonly sessions = new Map<string, ShellSession>()

  create(options: ShellCreateOptions, makeSink: (id: string) => ShellSink): ShellInfo {
    const id = randomUUID()
    const cwd = options.cwd || process.cwd()
    const sink = makeSink(id)
    const session = new ShellSession(id, cwd, currentEnv(), sink)
    this.sessions.set(id, session)
    return session.getInfo()
  }

  async run(id: string, line: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    await session.run(line)
  }

  cancel(id: string): void {
    this.sessions.get(id)?.cancel()
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.close()
  }

  complete(id: string, line: string): string[] {
    return this.sessions.get(id)?.complete(line) ?? []
  }

  /** Runs one command line headlessly and returns ANSI-stripped output. */
  async capture(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<ShellCaptureResult> {
    const chunks: string[] = []
    let resolvePrompt: (() => void) | null = null
    let exitCode = 0
    let timedOut = false
    let aborted = false

    const sink: ShellSink = {
      data: (text) => {
        chunks.push(text)
        onChunk?.(text)
      },
      prompt: () => resolvePrompt?.(),
      exit: (code) => {
        exitCode = code
        resolvePrompt?.()
      },
    }

    const session = new ShellSession('capture', cwd, agentEnvironment(), sink)
    const promptDone = new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })

    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        session.setTimedOut()
        session.cancel()
        resolve()
      }, timeoutMs)
    })
    const abort = new Promise<void>((resolve) => {
      if (signal.aborted) {
        aborted = true
        session.cancel()
        resolve()
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          session.cancel()
          resolve()
        },
        { once: true },
      )
    })

    void session.run(command)
    await Promise.race([promptDone, timeout, abort])
    if (timer) clearTimeout(timer)
    await new Promise((resolve) => setTimeout(resolve, 25))

    if (timedOut) exitCode = 124
    else if (aborted) exitCode = 130

    return { code: exitCode, output: stripAnsi(chunks.join('')), timedOut, aborted }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
