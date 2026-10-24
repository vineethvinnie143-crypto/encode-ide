/**
 * The command line's arguments, read into what a run needs. Pure, so every way of calling it is tested; nothing here
 * touches the disk, the network or a key.
 */
import type { AgentMode, ApprovalPolicy } from '@encode/core'

export type OutputFormat = 'text' | 'json' | 'stream-json'

export interface CliOptions {
  command: 'chat' | 'sessions' | 'help' | 'version'
  /** The request from the arguments, words joined by spaces; empty when none was given. */
  prompt: string
  /** Answer one request and exit: no prompt, nothing asked, approvals refused unless the policy allows. */
  print: boolean
  outputFormat: OutputFormat
  /** `provider:model`, `@free` or `demo`; from ENCODE_MODEL when not given. */
  model?: string
  /** An OpenAI-compatible server for `model`; its key is ENCODE_API_KEY. */
  baseUrl?: string
  policy?: ApprovalPolicy
  mode: AgentMode
  /** Carry on with the latest session of this folder. */
  continue: boolean
  /** Carry on with this session: its id, or the start of it. */
  resume?: string
  /** The folder to work in; the current one when not given. */
  cwd?: string
  /** The operating-system sandbox around the agent's commands; on unless --no-sandbox. */
  sandbox: boolean
  /** Trust the folder without asking, so its own settings, hooks and servers may apply. */
  trust: boolean
  maxSteps?: number
  /** In --print, also write what the agent does to standard error. */
  verbose: boolean
  /** true or false when --color or --no-color was given. */
  color?: boolean
}

export class UsageError extends Error {}

export const POLICIES: readonly ApprovalPolicy[] = ['read-only', 'workspace-write', 'full-access', 'auto-review']
export const MODES: readonly AgentMode[] = ['code', 'ask', 'plan']
const FORMATS: readonly OutputFormat[] = ['text', 'json', 'stream-json']

const VALUED: Record<string, string> = {
  '-m': '--model',
  '--model': '--model',
  '--base-url': '--base-url',
  '--policy': '--policy',
  '--mode': '--mode',
  '-r': '--resume',
  '--resume': '--resume',
  '-C': '--cwd',
  '--cwd': '--cwd',
  '--output-format': '--output-format',
  '--max-steps': '--max-steps',
}

const SWITCHES: Record<string, string> = {
  '-p': '--print',
  '--print': '--print',
  '-c': '--continue',
  '--continue': '--continue',
  '--no-sandbox': '--no-sandbox',
  '--trust': '--trust',
  '--verbose': '--verbose',
  '--color': '--color',
  '--no-color': '--no-color',
  '-h': '--help',
  '--help': '--help',
  '-v': '--version',
  '--version': '--version',
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new UsageError(`${flag} is one of ${allowed.join(', ')}; not ${value}`)
  return value as T
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CliOptions {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  const words: string[] = []
  let rest = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (rest || !arg.startsWith('-') || arg === '-') {
      words.push(arg)
      continue
    }
    if (arg === '--') {
      rest = true
      continue
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const valued = VALUED[flag]
    if (valued) {
      const value = inline ?? argv[++index]
      if (value === undefined || (inline === undefined && value.startsWith('-') && value !== '-')) throw new UsageError(`${flag} needs a value`)
      values.set(valued, value)
      continue
    }
    const named = SWITCHES[flag]
    if (!named || inline !== undefined) throw new UsageError(`unknown option ${arg}`)
    switches.add(named)
  }

  let command: CliOptions['command'] = 'chat'
  if (switches.has('--help')) command = 'help'
  else if (switches.has('--version')) command = 'version'
  else if (words[0] === 'sessions' && words.length === 1) command = 'sessions'
  else if (words[0] === 'help' && words.length === 1) command = 'help'

  const maxSteps = values.get('--max-steps')
  const steps = maxSteps === undefined ? undefined : Number(maxSteps)
  if (steps !== undefined && (!Number.isInteger(steps) || steps < 1 || steps > 100)) throw new UsageError('--max-steps is a whole number from 1 to 100')
  if (switches.has('--color') && switches.has('--no-color')) throw new UsageError('give --color or --no-color, not both')
  if (switches.has('--continue') && values.has('--resume')) throw new UsageError('give --continue or --resume, not both')

  const model = values.get('--model') ?? (env.ENCODE_MODEL?.trim() || undefined)
  const baseUrl = values.get('--base-url') ?? (env.ENCODE_BASE_URL?.trim() || undefined)
  const policy = values.get('--policy')
  const resume = values.get('--resume')
  const cwd = values.get('--cwd')
  const format = values.get('--output-format')
  const print = switches.has('--print')
  if (format !== undefined && !print) throw new UsageError('--output-format goes with --print')

  return {
    command,
    prompt: command === 'chat' ? words.join(' ').trim() : '',
    print,
    outputFormat: format === undefined ? 'text' : oneOf('--output-format', format, FORMATS),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(policy !== undefined ? { policy: oneOf('--policy', policy, POLICIES) } : {}),
    mode: oneOf('--mode', values.get('--mode') ?? 'code', MODES),
    continue: switches.has('--continue'),
    ...(resume !== undefined ? { resume } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    sandbox: !switches.has('--no-sandbox'),
    trust: switches.has('--trust'),
    ...(steps !== undefined ? { maxSteps: steps } : {}),
    verbose: switches.has('--verbose'),
    ...(switches.has('--color') ? { color: true } : switches.has('--no-color') ? { color: false } : {}),
  }
}

export const USAGE = `Usage: encode [options] [request]

  encode                       work with eNCode in this folder, at a prompt
  encode "fix the failing test"  start with a request, then keep going at the prompt
  encode -p "explain src/a.ts"  answer one request and exit (print mode); also reads a pipe:
                                 git diff | encode -p "review this"
  encode sessions              this folder's sessions, newest first

Model (keys come from the environment only, and never reach the agent's commands):
  -m, --model <model>          openrouter:<id>   OPENROUTER_API_KEY
                               anthropic:<id>    ANTHROPIC_API_KEY
                               openai:<id>       OPENAI_API_KEY
                               deepseek:<id>     DEEPSEEK_API_KEY
                               ollama:<id>, lmstudio:<id>  a model on this computer, no key
                               @free             OpenRouter's free models (free models may keep what they are sent)
                               demo              a scripted agent, offline, to try the commands
                               Default: ENCODE_MODEL.
  --base-url <url>             any OpenAI-compatible server for --model <id>; key: ENCODE_API_KEY

Session:
  -c, --continue               carry on with this folder's latest session
  -r, --resume <id>            carry on with a session (its id or the start of it)
  --mode <code|ask|plan>       code (default) changes files; ask only reads; plan proposes a plan first
  --policy <policy>            read-only, workspace-write (default), full-access or auto-review
  --max-steps <n>              steps per request, 1 to 100 (default 30)
  -C, --cwd <folder>           work in this folder instead of the current one
  --trust                      trust the folder without asking (its settings, hooks and servers apply)
  --no-sandbox                 run commands outside the operating-system sandbox

Print mode:
  -p, --print                  answer one request and exit; nothing is asked: what the policy does not allow is refused
  --output-format <format>     text (the reply), json (one result object) or stream-json (every event, a line each)
  --verbose                    also write what the agent does to standard error

  --color, --no-color          colour on or off (default: on in a terminal, off with NO_COLOR)
  -h, --help                   this help
  -v, --version                the version

Exit status: 0 when the request finished, 1 when it ended on an error, 2 when eNCode could not start.`
