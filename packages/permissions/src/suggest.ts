import path from 'node:path'
import { parseRule, splitCommands } from './rules'

/**
 * The rule behind "Always allow this": the narrowest rule that would have
 * allowed the call that was just approved, and no wider than it looks.
 *
 * A command gets a prefix rule (`Bash(npm run build:*)`) only when its
 * program and subcommand are from a short list of everyday project
 * commands. Programs that run whatever they are given (shells, interpreters,
 * sudo, npx, curl, ssh), that delete or overwrite (rm, mv, dd), and every
 * subcommand that changes history or sends work elsewhere (git push, git
 * reset) get the exact command or nothing: a rule for `bash:*` or
 * `git push:*` would allow far more than the user was shown. Lines the
 * grammar cannot read, with a word known only at run time, a wildcard, or a
 * redirect that writes get no suggestion at all, since no rule could say
 * what they do.
 */

export type RuleCall =
  | { type: 'command'; line: string; dialect: 'bash' | 'pwsh' }
  | { type: 'edit'; path: string; root: string; windows: boolean }
  | { type: 'read'; path: string; root: string; windows: boolean }
  | { type: 'web'; url: string }
  | { type: 'mcp'; server: string; tool: string }

export interface RuleSuggestion {
  /** Rules to save together; a line of several commands needs one for each. */
  rules: string[]
  /** What the button promises, in a phrase: "npm run build, and anything after it". */
  label: string
}

const DYNAMIC = '\u0000'

/** Run whatever they are told, or change what they touch in ways no prefix can bound. Only an exact command is offered. */
const EXACT_ONLY = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'wsl',
  'env', 'sudo', 'su', 'doas', 'xargs', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'watch', 'eval', 'exec', 'command', 'builtin', 'source', '.',
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'rscript', 'osascript', 'java',
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'dlx',
  'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'curl', 'wget', 'ftp',
  'find', 'awk', 'gawk', 'sed', 'perl', 'tee', 'vi', 'vim', 'nano', 'less', 'more', 'man',
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'shred', 'kill', 'pkill', 'killall', 'mkfs', 'mount', 'umount', 'crontab', 'at',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'ansible', 'aws', 'gcloud', 'az', 'gh', 'heroku', 'vercel', 'netlify', 'fly', 'flyctl',
])

/** Builtins that print nothing worth feeding to another command and change nothing outside the line; the line's other commands still need rules. */
const HARMLESS = new Set(['cd', 'pushd', 'popd', 'pwd', 'true', 'false', 'exit'])

/** Shells and interpreters read a script from their input when they are given none to run, so a rule that names them bare would allow anything piped in. */
const READS_SCRIPTS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'rscript', 'osascript', 'source', '.', 'eval', 'exec'])

/** Test, build and inspect commands of everyday projects. A prefix of the program alone. */
const PROGRAM_ONLY = new Set(['pytest', 'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'prettier', 'ruff', 'mypy', 'black', 'flake8', 'isort', 'rspec', 'phpunit', 'ctest', 'ninja', 'rustfmt', 'gofmt', 'clang-format'])

/** Programs whose second word is the subcommand, and the subcommands a prefix rule covers. */
const SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'fetch', 'stash', 'tag', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'switch', 'pull', 'merge', 'remote'],
  cargo: ['build', 'check', 'test', 'clippy', 'fmt', 'run', 'doc', 'bench', 'tree', 'metadata'],
  go: ['build', 'test', 'vet', 'fmt', 'mod', 'run', 'generate', 'list', 'env', 'version'],
  dotnet: ['build', 'test', 'run', 'restore', 'format', 'clean'],
  gradle: ['build', 'test', 'check', 'assemble', 'clean', 'tasks'],
  mvn: ['compile', 'test', 'package', 'verify', 'clean', 'install'],
  pip: ['install', 'list', 'show', 'freeze', 'check'],
  uv: ['sync', 'lock', 'pip', 'run'],
  poetry: ['install', 'build', 'run', 'show', 'check', 'lock'],
  bundle: ['install', 'exec', 'check', 'list'],
  rake: [],
  make: [],
}

/** Package managers: a few subcommands, and `run <script>`, which is covered per script. */
const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
  npm: ['test', 'ci', 'install', 'i', 'add', 'update', 'outdated', 'ls', 'list', 'audit', 'pack', 'start', 'build', 'lint'],
  pnpm: ['test', 'install', 'i', 'add', 'update', 'outdated', 'ls', 'list', 'audit', 'start', 'build', 'lint', 'typecheck'],
  yarn: ['test', 'install', 'add', 'upgrade', 'outdated', 'list', 'audit', 'start', 'build', 'lint'],
  bun: ['test', 'install', 'add', 'update', 'outdated', 'build'],
}

/** Subcommands never covered by a prefix, whatever the table says. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

/** Words that are an option, a path or a value, not a subcommand. */
const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/

function programKey(word: string): string {
  return word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '')
}

interface CommandRule {
  rule: string
  /** What to call it in the button. */
  words: string
  /** True for the commands that need a rule only so the line as a whole is allowed. */
  quiet?: boolean
}

function ruleForCommand(words: string[]): CommandRule | null {
  if (words.some((word) => word.includes(DYNAMIC) || word.includes('*') || !word)) return null
  if (words.every((word) => /^[A-Za-z_]\w*=/.test(word))) return null
  const exact: CommandRule = { rule: `Bash(${words.join(' ')})`, words: words.join(' ') }
  // A leading assignment (CI=1 npm test) or a path as the program (./build.sh) is part of what was approved.
  if (/^[A-Za-z_]\w*=/.test(words[0]) || /[\\/]/.test(words[0])) return exact
  const program = programKey(words[0])
  if (HARMLESS.has(program)) return { rule: `Bash(${words[0]}:*)`, words: words[0], quiet: true }
  if (READS_SCRIPTS.has(program) && (words.length < 2 || words.includes('-') || words.includes('/dev/stdin'))) return null
  if (EXACT_ONLY.has(program) || (program.includes('-') && /^[A-Z]/.test(words[0]))) return exact
  const prefix = (count: number): CommandRule => ({ rule: `Bash(${words.slice(0, count).join(' ')}:*)`, words: words.slice(0, count).join(' ') })

  if (PROGRAM_ONLY.has(program)) return prefix(1)
  if (Object.hasOwn(PACKAGE_MANAGERS, program)) {
    const sub = words[1]
    if (sub === 'run' || sub === 'run-script') return words[2] && SCRIPT_NAME.test(words[2]) ? prefix(3) : exact
    return sub && PACKAGE_MANAGERS[program].includes(sub) ? prefix(2) : exact
  }
  if (program === 'make' || program === 'rake') return words[1] && SCRIPT_NAME.test(words[1]) ? prefix(2) : exact
  if (Object.hasOwn(SUBCOMMANDS, program)) {
    const sub = words[1]
    return sub && SUBCOMMAND_WORD.test(sub) && SUBCOMMANDS[program].includes(sub) ? prefix(2) : exact
  }
  return exact
}

function suggestCommand(line: string, dialect: 'bash' | 'pwsh'): RuleSuggestion | null {
  const split = splitCommands(line, dialect)
  // What a redirect feeds a command is not in its words, so no rule can say what such a line does.
  if (!split || split.writes || split.fed.some(Boolean) || !split.commands.length) return null
  const seen = new Set<string>()
  const rules: string[] = []
  const named: string[] = []
  for (const words of split.commands) {
    const made = ruleForCommand(words)
    if (!made) return null
    if (seen.has(made.rule)) continue
    seen.add(made.rule)
    rules.push(made.rule)
    if (!made.quiet) named.push(made.rule.endsWith(':*)') ? `${made.words}, and anything after it` : made.words)
  }
  // Every rule must read back as a rule, or none is offered.
  for (const rule of rules) if (!parseRule(rule, 'allow', 'local').ok) return null
  return { rules, label: named.length ? named.join('; ') : rules.map((rule) => rule.slice(5, -1)).join('; ') }
}

function relativeInside(target: string, root: string, windows: boolean): string[] | null {
  const api = windows ? path.win32 : path.posix
  const relative = api.relative(root, target)
  if (!relative || relative.startsWith('..') || api.isAbsolute(relative)) return null
  const parts = relative.split(/[\\/]/)
  // A glob character in a name would turn the rule into something else.
  if (parts.some((part) => /[*?[\]\\!#{}]/.test(part) || !part)) return null
  return parts
}

/** Folders the approval policy always asks about; a saved rule could not change that. */
const PROTECTED = new Set(['.git', '.encode', '.ssh', '.aws', '.gnupg'])

function suggestPath(tool: 'Edit' | 'Read', target: string, root: string, windows: boolean): RuleSuggestion | null {
  const parts = relativeInside(target, root, windows)
  if (!parts || parts.some((part) => PROTECTED.has(part.toLowerCase()))) return null
  // The MCP file names programs to start: the approval asks before a write there whatever a rule says, so none is offered.
  if (tool === 'Edit' && parts.length === 1 && parts[0].toLowerCase() === '.mcp.json') return null
  const verb = tool === 'Edit' ? 'edit' : 'read'
  // A file at the top of the project is named exactly (package.json, tsconfig.json); anywhere deeper, its folder.
  if (parts.length === 1) return { rules: [`${tool}(/${parts[0]})`], label: `${verb} ${parts[0]}` }
  const folder = parts.slice(0, -1).join('/')
  return { rules: [`${tool}(/${folder}/**)`], label: `${verb} anything in ${folder}/` }
}

export function suggestRule(call: RuleCall): RuleSuggestion | null {
  switch (call.type) {
    case 'command':
      return suggestCommand(call.line, call.dialect)
    case 'edit':
      return suggestPath('Edit', call.path, call.root, call.windows)
    case 'read':
      return suggestPath('Read', call.path, call.root, call.windows)
    case 'web': {
      let host: string
      try {
        host = new URL(call.url).hostname.toLowerCase().replace(/\.$/, '')
      } catch {
        return null
      }
      // An address, a bare name or a port-forwarded host is not a site to allow by name.
      if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null
      return { rules: [`WebFetch(domain:${host})`], label: `fetch from ${host}` }
    }
    case 'mcp': {
      const tool = call.tool.replace(/[^A-Za-z0-9_-]/g, '_')
      const rule = `mcp__${call.server}__${tool}`
      return /^mcp__[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rule) && parseRule(rule, 'allow', 'local').ok ? { rules: [rule], label: `${call.tool} of ${call.server}` } : null
    }
  }
}
