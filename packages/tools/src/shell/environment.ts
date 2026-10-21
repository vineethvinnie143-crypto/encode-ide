/**
 * The environment the agent's commands run with: the user's own, minus
 * secrets, plus settings that keep commands non-interactive and stop a
 * repository's git config from starting programs.
 *
 * A prompt-injected command should not find provider keys or tokens to send
 * anywhere, so variables that look like credentials are removed unless the
 * user keeps them by name.
 */
import { GIT_SAFETY_CONFIG, envKey } from './programs'

/** Variables kept although their names look like secrets: they point at agents, not keys. */
const ALWAYS_KEEP = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'SSH_ASKPASS', 'GIT_ASKPASS'])

const SECRET_SEGMENTS = new Set([
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'AUTH',
  'COOKIE',
])

const SECRET_PAIRS = [
  ['API', 'KEY'],
  ['ACCESS', 'KEY'],
  ['PRIVATE', 'KEY'],
  ['SECRET', 'KEY'],
  ['CLIENT', 'SECRET'],
  ['SIGNING', 'KEY'],
  ['ENCRYPTION', 'KEY'],
]

/** Services whose `<NAME>_KEY` is a credential. */
const KEYED_SERVICES = new Set([
  'ANTHROPIC',
  'OPENAI',
  'OPENROUTER',
  'DEEPSEEK',
  'GEMINI',
  'GOOGLE',
  'MISTRAL',
  'GROQ',
  'TOGETHER',
  'XAI',
  'COHERE',
  'FIREWORKS',
  'PERPLEXITY',
  'HUGGINGFACE',
  'HF',
  'AZURE',
  'STRIPE',
  'SENDGRID',
  'TWILIO',
  'ENCODE',
])

/** Whether a variable name looks like it holds a credential. */
export function looksSecret(name: string): boolean {
  const upper = name.toUpperCase()
  if (ALWAYS_KEEP.has(upper) || upper.startsWith('GIT_CONFIG_')) return false
  const segments = upper.split(/[^A-Z0-9]+/).filter(Boolean)
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true
  for (let index = 0; index + 1 < segments.length; index++) {
    if (SECRET_PAIRS.some(([first, second]) => segments[index] === first && segments[index + 1] === second)) return true
  }
  return segments.length >= 2 && segments.at(-1) === 'KEY' && KEYED_SERVICES.has(segments[0])
}

export interface AgentEnvironmentOptions {
  platform?: NodeJS.Platform
  /** Names to keep even though they look like secrets. */
  keep?: readonly string[]
  /** Extra variables, set last. */
  extra?: Record<string, string>
}

export interface AgentEnvironment {
  env: Record<string, string>
  /** Names removed because they looked like secrets. */
  removed: string[]
}

export function agentEnvironment(base: NodeJS.ProcessEnv | Record<string, string | undefined>, options: AgentEnvironmentOptions = {}): AgentEnvironment {
  const platform = options.platform ?? process.platform
  const keep = new Set((options.keep ?? []).map((name) => name.toUpperCase()))
  const env: Record<string, string> = {}
  const removed: string[] = []
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    if (looksSecret(name) && !keep.has(name.toUpperCase())) {
      removed.push(name)
      continue
    }
    env[name] = value
  }

  const countKey = envKey(env, 'GIT_CONFIG_COUNT', platform)
  const count = Number(env[countKey] ?? 0)
  let index = Number.isInteger(count) && count >= 0 ? count : 0
  for (const [key, value] of GIT_SAFETY_CONFIG) {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
    index++
  }
  env[countKey] = String(index)

  const set = (name: string, value: string) => {
    env[envKey(env, name, platform)] = value
  }
  // Nobody can answer a prompt or close a pager or an editor.
  set('GIT_TERMINAL_PROMPT', '0')
  set('GIT_PAGER', 'cat')
  set('PAGER', 'cat')
  set('GIT_EDITOR', 'true')
  set('ENCODE_AGENT', '1')
  // cmd.exe (npm scripts, batch files) must not look for bare program names in the project.
  if (platform === 'win32') set('NoDefaultCurrentDirectoryInExePath', '1')
  for (const [name, value] of Object.entries(options.extra ?? {})) set(name, value)
  return { env, removed: removed.sort() }
}
