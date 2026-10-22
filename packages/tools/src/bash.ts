/**
 * Bash, BashOutput and KillShell, with Claude Code's contracts. Bash runs in
 * the OS shell (Git Bash or PowerShell on Windows, bash elsewhere); its
 * description tells the model which one it is talking to, and whether the
 * commands are confined by a sandbox it may ask to leave.
 */
import { collapseRepeats, truncateMiddle } from './text'
import type { ShellDialect, Tool, ToolOutcome } from './types'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './shell/run'

export const BASH_OUTPUT_LIMIT = 30_000

function fail(content: string): ToolOutcome {
  return { ok: false, content }
}

interface BashInput extends Record<string, unknown> {
  command: string
  timeout?: number
  description?: string
  run_in_background?: boolean
  unsandboxed?: boolean
}

/** Set for a session whose commands run in a sandbox. */
export interface BashSandbox {
  /** A command may ask to run outside the sandbox (the person is asked each time). */
  escapable: boolean
}

/** What a command that failed says when the sandbox is what stopped it. */
const BLOCKED = /operation not permitted|read-only file system|access (?:is|to the path .{1,300}? is) denied|permission denied|\bE(?:PERM|ACCES|ROFS)\b|UnauthorizedAccess|couldn.t create signal pipe|NtCreateDirectoryObject/i

function bashDescription(dialect: ShellDialect, platform: NodeJS.Platform, sandbox: BashSandbox | undefined): string {
  const shellName = dialect === 'bash' ? (platform === 'win32' ? 'Git Bash' : 'bash') : 'PowerShell'
  const lines = [
    `Runs a command in ${shellName} and returns its output.`,
    '',
    '- Every command starts a fresh shell in the current working directory. A change of directory carries over to the next command; variables and other shell state do not. A command that leaves the workspace has its directory reset to the workspace root.',
    '- Quote paths that contain spaces.',
    '- Use the dedicated tools instead of shell commands for their jobs: Glob to find files, Grep to search contents, Read to view a file, Edit and Write to change files.',
    '- Commands cannot be interactive: there is no terminal and stdin is closed. Pass flags such as --yes, and never open an editor or a pager (use git commit -m).',
    `- timeout is in milliseconds: default ${DEFAULT_TIMEOUT_MS} (${DEFAULT_TIMEOUT_MS / 60_000} minutes), at most ${MAX_TIMEOUT_MS} (${MAX_TIMEOUT_MS / 60_000} minutes).`,
    '- For servers, watchers and other commands that keep running, set run_in_background to true instead of adding &. You get an id at once; read new output with BashOutput and stop the command with KillShell.',
    `- Output longer than ${BASH_OUTPUT_LIMIT} characters is shortened in the middle.`,
    '- Chain commands that depend on each other with &&.',
  ]
  if (sandbox) {
    lines.push(
      '- Commands run in a sandbox: they can write only in the workspace and the temp folder, and .git/hooks, .git/config and .encode are read-only.' +
        (sandbox.escapable
          ? ' If a command fails for that reason (Operation not permitted, Read-only file system, Access is denied), retry it with unsandboxed true; the person is asked first. Never use it on a first try.'
          : ''),
    )
  }
  if (dialect === 'bash' && platform === 'win32') {
    lines.push('- This is Git Bash on Windows: paths look like /c/Users/me/project, Windows programs (.exe and .cmd) run normally, and forward slashes work in Windows paths.')
  }
  if (dialect === 'pwsh') {
    lines.push('- This is PowerShell, not bash: use PowerShell syntax (Get-ChildItem, $env:NAME, ; between commands, `& "C:\\path with spaces\\tool.exe"`).')
  }
  lines.push('', 'Give description: five to ten words saying what the command does, such as "Run the unit tests" or "Install dependencies".')
  return lines.join('\n')
}

export function createBashTool(dialect: ShellDialect, platform: NodeJS.Platform, sandbox?: BashSandbox): Tool<BashInput> {
  return {
    definition: {
      name: 'Bash',
      description: bashDescription(dialect, platform, sandbox),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, description: 'The command to run.' },
          timeout: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, description: `Milliseconds before the command is stopped (default ${DEFAULT_TIMEOUT_MS}).` },
          description: { type: 'string', description: 'Five to ten words on what the command does.' },
          run_in_background: { type: 'boolean', description: 'Start the command and return at once; read its output with BashOutput.' },
          ...(sandbox?.escapable ? { unsandboxed: { type: 'boolean', description: 'Run outside the sandbox. The person is asked each time.' } } : {}),
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    kind: 'command',
    readOnly: false,
    access(input, ctx) {
      return {
        type: 'command',
        command: input.command,
        cwd: ctx.shell.state().cwd,
        background: Boolean(input.run_in_background),
        ...(input.unsandboxed ? { unsandboxed: true } : {}),
      }
    },
    describe(input) {
      return {
        title: input.description?.trim() || (input.run_in_background ? 'Run in the background' : 'Run command'),
        detail: input.command + (input.run_in_background ? '\n(in the background)' : '') + (input.unsandboxed ? '\n(outside the sandbox)' : ''),
      }
    },
    async run(input, ctx) {
      const view = ctx.shell.state().sandbox
      if (input.unsandboxed && view?.active && !view.allowUnsandboxed) {
        return fail('The settings do not let commands run outside the sandbox. Run the command without unsandboxed, or tell the person what it needs.')
      }
      const unsandboxed = Boolean(input.unsandboxed && view?.active)
      if (input.run_in_background) {
        const job = await ctx.jobs.start(input.command, { cwd: ctx.shell.state().cwd, ...(unsandboxed ? { unsandboxed } : {}) })
        if (job.status === 'error') return fail(`The command could not start: ${ctx.jobs.read(job.id)?.output.trim() || 'unknown error'}`)
        return {
          ok: true,
          content: `Started in the background with id ${job.id}. Read its output with BashOutput (bash_id "${job.id}"); stop it with KillShell (shell_id "${job.id}").`,
          display: { output: `Background job ${job.id}` },
        }
      }

      const result = await ctx.shell.run(input.command, { timeoutMs: input.timeout, signal: ctx.signal, onOutput: ctx.progress, ...(unsandboxed ? { unsandboxed } : {}) })
      const parts: string[] = []
      const body = collapseRepeats(result.output.replace(/\s+$/, ''))
      parts.push(body ? truncateMiddle(body, BASH_OUTPUT_LIMIT) : '(no output)')
      if (result.timedOut) {
        const seconds = Math.round((input.timeout ?? DEFAULT_TIMEOUT_MS) / 1000)
        parts.push(`The command ran longer than ${seconds} s and was stopped. Run long work with run_in_background, or raise timeout (at most ${MAX_TIMEOUT_MS}).`)
      } else if (result.interrupted) {
        parts.push('The command was interrupted.')
      } else if (result.exitCode !== 0) {
        parts.push(`Exit code ${result.exitCode ?? `unknown${result.signal ? ` (ended by ${result.signal})` : ''}`}`)
      }
      if (result.notice) parts.push(result.notice)
      if (view?.active && view.allowUnsandboxed && !unsandboxed && result.exitCode !== 0 && !result.timedOut && !result.interrupted && BLOCKED.test(body)) {
        parts.push('This may be the sandbox. If the command needs more than the workspace and the temp folder, retry it with unsandboxed true (the person is asked first).')
      }
      return {
        ok: result.exitCode === 0 && !result.timedOut && !result.interrupted,
        content: parts.join('\n\n'),
        display: { output: parts.join('\n\n') },
      }
    },
  }
}

interface BashOutputInput extends Record<string, unknown> {
  bash_id: string
  filter?: string
}

export const bashOutputTool: Tool<BashOutputInput> = {
  definition: {
    name: 'BashOutput',
    description: [
      'Reads what a background command printed since the last read.',
      '',
      '- bash_id is the id Bash returned when it started the command.',
      '- Also reports whether the command is still running, and its exit code once it ended.',
      '- filter is a regular expression; only output lines that match it are returned (the rest are still marked read).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        bash_id: { type: 'string', minLength: 1, description: 'The id of the background command.' },
        filter: { type: 'string', description: 'Only return lines that match this regular expression.' },
      },
      required: ['bash_id'],
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: true,
  modes: ['code', 'plan', 'ask'],
  check(input) {
    if (!input.filter) return undefined
    try {
      new RegExp(input.filter)
      return undefined
    } catch (error) {
      return `filter is not a valid regular expression: ${(error as Error).message}.`
    }
  },
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: `Read output of ${input.bash_id}` }),
  async run(input, ctx) {
    const read = ctx.jobs.read(input.bash_id, input.filter ? { filter: new RegExp(input.filter) } : {})
    if (!read) {
      const known = ctx.jobs.list().map((job) => job.id)
      return fail(`There is no background command ${input.bash_id}.${known.length ? ` Known ids: ${known.join(', ')}.` : ''}`)
    }
    const { job, output } = read
    const status = job.status === 'running' ? 'running' : `${job.status}${job.exitCode !== undefined ? `, exit code ${job.exitCode}` : ''}`
    const body = collapseRepeats(output.replace(/\s+$/, ''))
    return {
      ok: true,
      content: `Status: ${status}\n\n${body ? truncateMiddle(body, BASH_OUTPUT_LIMIT) : '(no new output)'}`,
    }
  },
}

interface KillShellInput extends Record<string, unknown> {
  shell_id: string
}

export const killShellTool: Tool<KillShellInput> = {
  definition: {
    name: 'KillShell',
    description: 'Stops a background command started with Bash, and everything it started. shell_id is the id Bash returned.',
    inputSchema: {
      type: 'object',
      properties: { shell_id: { type: 'string', minLength: 1, description: 'The id of the background command to stop.' } },
      required: ['shell_id'],
      additionalProperties: false,
    },
  },
  kind: 'command',
  readOnly: false,
  modes: ['code', 'plan', 'ask'],
  access: () => ({ type: 'none' }),
  describe: (input) => ({ title: `Stop ${input.shell_id}` }),
  async run(input, ctx) {
    const job = ctx.jobs.list().find((item) => item.id === input.shell_id)
    if (!job) return fail(`There is no background command ${input.shell_id}.`)
    if (job.status !== 'running') return { ok: true, content: `${input.shell_id} had already ended (${job.status}).` }
    await ctx.jobs.kill(input.shell_id)
    return { ok: true, content: `Stopped ${input.shell_id}: ${job.command}` }
  },
}
