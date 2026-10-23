import type { AgentHooks } from '@encode/core'
import { createCommandHooks, createProcessRunner, type CommandHooks, type HookGroup, type HookRunner, type HookShell } from '@encode/hooks'
import { agentEnvironment, detectShell, type ShellProgram } from '@encode/tools'
import type { WorkspaceConfig } from './config'

/** How a shell is told to run one command line, without reading the person's profile or asking anything. */
export function hookShell(program: ShellProgram): HookShell {
  return program.dialect === 'bash'
    ? { file: program.file, args: (command) => ['--noprofile', '--norc', '-c', command] }
    : { file: program.file, args: (command) => ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command] }
}

/**
 * Runs hook command lines in the shell the agent's commands use. Where there is none, every hook fails to start, which
 * the hooks package answers the way it answers any failure: a PreToolUse guard that cannot run denies its call.
 */
export function defaultHookRunner(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): HookRunner {
  const program = detectShell(env, platform)
  if (!program) {
    const error = 'No shell was found to run hooks in. Install Git for Windows or PowerShell 7, or set ENCODE_SHELL to the path of bash or pwsh.'
    return async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false, error })
  }
  return createProcessRunner(hookShell(program), platform)
}

export interface WorkspaceHookOptions {
  platform?: NodeJS.Platform
  /** Runs a command line. Default: the shell found for the agent's commands (found when the first hook runs). */
  runner?: HookRunner
  /** What hooks start from, before anything that looks like a secret is taken out. Default: this process's environment. */
  baseEnv?: Record<string, string | undefined>
  /** The conversation's file, for the `transcript_path` hooks are given. */
  transcriptPath?(sessionId: string): string | undefined
  /** Tells the person about a hook that failed or printed a message. */
  notice?(text: string): void
}

/**
 * The hooks of the settings a folder is under, as the agent's hooks. The settings are read again before the events that
 * start something (a session, a prompt); a tool call's own events use the picture the loop has just refreshed. Hooks
 * run only while the settings are whole: a half-written file must not decide which guards are in force.
 *
 * Hooks run with the person's rights, in the environment the agent's own commands get: variables that look like secrets
 * are left out unless the settings name them in `env`, and what the settings put in `env` is added.
 */
export function workspaceHooks(config: WorkspaceConfig, options: WorkspaceHookOptions = {}): AgentHooks {
  const platform = options.platform ?? process.platform
  const baseEnv = options.baseEnv ?? process.env
  let runner = options.runner
  let built: { groups: HookGroup[]; hooks: CommandHooks } | undefined

  async function now(fresh: boolean): Promise<CommandHooks | undefined> {
    const snapshot = fresh ? await config.refresh() : config.current()
    if (snapshot.broken || !snapshot.hooks.length) return undefined
    // Rebuilt only when the picture was: its list of hooks is a new array each time.
    if (built?.groups !== snapshot.hooks) {
      const { env } = agentEnvironment(baseEnv, { platform, extra: snapshot.effective.env })
      runner ??= defaultHookRunner(baseEnv, platform)
      built = {
        groups: snapshot.hooks,
        hooks: createCommandHooks(snapshot.hooks, {
          env,
          runner,
          ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
          ...(options.notice ? { notice: options.notice } : {}),
        }),
      }
    }
    return built.hooks
  }

  return {
    async sessionStart(event) {
      return (await now(true))?.sessionStart(event)
    },
    async userPromptSubmit(event) {
      return (await now(true))?.userPromptSubmit(event)
    },
    async preToolUse(event) {
      return (await now(false))?.preToolUse(event)
    },
    async postToolUse(event) {
      return (await now(false))?.postToolUse(event)
    },
    async beforeStop(event) {
      return (await now(false))?.beforeStop(event)
    },
    async preCompact(event) {
      return (await now(false))?.preCompact(event)
    },
    async notification(event) {
      return (await now(false))?.notification(event)
    },
    async sessionEnd(event) {
      return (await now(false))?.sessionEnd(event)
    },
    async subagentStart(event) {
      return (await now(false))?.subagentStart(event)
    },
  }
}
