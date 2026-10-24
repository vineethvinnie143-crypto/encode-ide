import path from 'node:path'
import { gitBashToWindows, shellLineProblem } from './bash-policy'
import { parseBash, simpleCommands } from './bash-grammar'
import { bashCall, nameOf, pwshCall, pwshHas, split, type Arg, type Call, type Split } from './command-words'
import { isInside } from './paths'
import { parsePwsh } from './pwsh-grammar'
import type { PathApi } from './shell-grammar'

/**
 * Which shell lines are hard to undo (ADR 0097): what they delete, overwrite or send out cannot be brought back by a
 * rewind, which restores only what the file tools wrote. When such a line would run without the person seeing it
 * (Full access, a rule or a hook allowed it), eNCode asks the agent's model about it once more before it runs.
 *
 * It reads what a line does, not whether it is allowed, so it is narrow where the floor under Auto review is wide:
 *
 *  - deletes recursively (`rm -r`, `Remove-Item -Recurse`, `find -delete`), outside the project, or beyond recovery
 *    (`shred`); a build output, a dependency folder or a temporary folder is not counted, since it is made again;
 *  - discards uncommitted work or the history git keeps to recover it, deletes an unmerged branch, rewrites history;
 *  - sends commits to a remote, overwrites or deletes there; publishes a package or an image; acts on GitHub;
 *  - deploys, destroys or changes live infrastructure (Terraform, Kubernetes, Helm, the cloud CLIs, Docker's data);
 *  - drops or empties database data (a client given `DROP TABLE`, an ORM's reset);
 *  - erases a disk, writes raw data over a file, or restarts the machine; changes permissions recursively.
 *
 * A line it cannot read to the end is matched by its words instead, toward asking.
 */

export interface UndoContext {
  /** The workspace root. */
  root: string
  /** Where the line starts. */
  cwd: string
  home: string
  dialect: 'bash' | 'pwsh'
  platform?: 'win32' | 'posix'
  /** Folders outside the workspace the person counts as part of it. */
  extraRoots?: readonly string[]
}

interface Reading {
  context: UndoContext
  api: PathApi
  windows: boolean
  cwd: string
  depth: number
}

const MAX_DEPTH = 3
const MAX_COMMANDS = 60

/**
 * Folders a build or an install makes again: deleting them loses nothing. Not `build`, `out` or `bin`, which hold
 * source in enough projects (build scripts, a CLI's entry, Rails' binstubs) that a delete of one is asked about.
 */
const REMADE = new Set([
  'node_modules', 'dist', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  '.vite', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', 'obj', '.gradle', 'tmp',
  'temp', '.tmp', '.eslintcache', 'storybook-static', '.angular', '.expo',
])

/** What a line it cannot read says it does, by its words: toward asking. */
const UNREAD =
  /\brm\s+-[A-Za-z]*[rR]|\bRemove-Item\b[^|;\n]{0,200}\s-Rec|\b(?:rd|rmdir)\s+\/s\b|\bshred\b|\bgit\s+(?:push\b|reset\s+--hard|clean\s+-[A-Za-z]*f|checkout\s+(?:-f\b|--\s|\.(?:\s|$))|stash\s+(?:drop|clear)|branch\s+-D)|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\b(?:terraform|tofu|pulumi)\s+(?:apply|destroy|up)\b|\bkubectl\s+delete\b|\bmkfs|\bdd\b[^|;\n]{0,200}\bof=|\bformat\s+[A-Za-z]:/i

const DESTRUCTIVE_SQL =
  /\b(?:drop\s+(?:table|database|schema|view|collection)|truncate\b|delete\s+from\s+[\w."`\[\]]+\s*(?:;|$)|alter\s+table\s+\S+\s+drop\b|flushall|flushdb)|\.drop(?:Database)?\s*\(/i
const DATABASE_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongosh', 'mongo', 'redis-cli', 'cqlsh', 'clickhouse-client', 'duckdb', 'invoke-sqlcmd'])
/** An ORM or framework task that empties or drops the database, by its words wherever they are run from. */
const DATABASE_RESET =
  /\bprisma\s+(?:migrate\s+reset|db\s+push\b[^\n]{0,200}--(?:force-reset|accept-data-loss))|\b(?:rails|rake)\s+db:(?:drop|reset|purge|schema:load)\b|\bartisan\s+(?:migrate:(?:fresh|reset|rollback)|db:wipe)\b|\bmanage\.py\s+(?:flush|reset_db)\b|\bdjango-admin\s+flush\b|\bsequelize(?:-cli)?\s+db:drop\b|\btypeorm\s+schema:drop\b|\bknex\s+migrate:rollback\b|\bsupabase\s+db\s+reset\b/i

const REMOVERS = new Set(['rm', 'remove-item', 'unlink'])
const OWNERSHIP = new Set(['chmod', 'chown', 'chgrp'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const DISKS = new Set(['fdisk', 'parted', 'diskpart', 'format', 'wipefs', 'sgdisk', 'format-volume', 'clear-disk'])
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'restart-computer', 'stop-computer'])
/** Programs that run the command after their own options. */
const WRAPPERS = new Set(['env', 'command', 'builtin', 'time', 'nohup', 'setsid', 'nice', 'ionice', 'stdbuf', 'timeout', 'sudo', 'doas', 'gsudo', 'exec', 'npx', 'pnpx', 'bunx', 'xargs'])
/** xargs options whose next word is their value. */
const XARGS_VALUES = new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a'])

const values = (args: readonly Arg[]): string[] => args.map((arg) => arg.value ?? '')

/** The words of a command that are not options, in lower case: what it is asked to do. */
function words(args: readonly Arg[]): string[] {
  return args.filter((arg) => arg.value !== null && !arg.value.startsWith('-')).map((arg) => (arg.value as string).toLowerCase())
}

function resolveIn(reading: Reading, value: string): string {
  const spelled = reading.windows && reading.context.dialect === 'bash' ? gitBashToWindows(value) : value
  return reading.api.resolve(reading.cwd, spelled.replace(/^~(?=$|[\\/])/, reading.context.home))
}

/** A path as a reason shows it: relative to the project when it is inside, else in full. */
function shown(reading: Reading, target: string): string {
  const relative = reading.api.relative(reading.context.root, target)
  if (!relative) return 'the whole project'
  return !relative.startsWith('..') && !reading.api.isAbsolute(relative) ? relative.split(reading.api.sep).join('/') : target
}

function insideProject(reading: Reading, target: string): boolean {
  return [reading.context.root, ...(reading.context.extraRoots ?? [])].some((root) => isInside(root, target, reading.api))
}

/** A folder made again by a build or an install, or a temporary one: deleting it is not hard to undo. */
function remade(reading: Reading, target: string): boolean {
  if (insideProject(reading, target)) {
    const relative = reading.api.relative(reading.context.root, target)
    return Boolean(relative) && relative.split(reading.api.sep).some((segment) => REMADE.has(segment.toLowerCase()))
  }
  const temp = reading.windows ? /^[A-Za-z]:\\(?:Windows\\Temp|Users\\[^\\]+\\AppData\\Local\\Temp)\\./i : /^\/(?:tmp|var\/tmp|private\/tmp)\/./
  return temp.test(target)
}

function removal(reading: Reading, name: string, options: Split, pwsh: boolean): string | null {
  if (name === 'shred') return `destroys ${options.operands.map((operand) => operand.value ?? 'a file').join(', ')} beyond recovery`
  const recursive = pwsh ? pwshHas(options, 'recurse') : options.short.has('r') || options.short.has('R') || options.long.has('--recursive')
  for (const operand of options.operands) {
    if (operand.value === null) {
      if (recursive) return 'deletes a folder only known when the line runs, and everything in it'
      continue
    }
    if (!operand.value || operand.value === '-') continue
    const target = resolveIn(reading, operand.value)
    if (recursive && !remade(reading, target)) return `deletes ${shown(reading, target)} and everything in it`
    if (!insideProject(reading, target) && !remade(reading, target)) return `deletes ${shown(reading, target)}, outside the project`
  }
  return null
}

function findDeletes(args: readonly Arg[]): string | null {
  const list = values(args)
  for (const [index, value] of list.entries()) {
    if (value === '-delete') return 'deletes every file find matches'
    if (/^-(?:exec|execdir|ok|okdir)$/.test(value) && /^(?:rm|shred|unlink)$/.test(nameOf(list[index + 1] ?? ''))) return 'deletes every file find matches'
  }
  return null
}

function git(args: readonly Arg[]): string | null {
  let index = 0
  while (index < args.length) {
    const value = args[index].value ?? ''
    if (value === '-C' || value === '-c' || value === '--git-dir' || value === '--work-tree') index += 2
    else if (value.startsWith('-')) index++
    else break
  }
  const sub = (args[index]?.value ?? '').toLowerCase()
  const rest = args.slice(index + 1)
  const options = split(rest, false)
  const operands = options.operands.map((operand) => operand.value)
  const has = (...names: string[]) => names.some((name) => (name.length === 1 ? options.short.has(name) : options.long.has(`--${name}`)))
  const forced = has('f', 'force') || [...options.long].some((option) => option.startsWith('--force'))
  switch (sub) {
    case 'reset':
      return has('hard', 'merge', 'keep') ? 'discards uncommitted changes (git reset --hard)' : null
    case 'checkout': {
      const afterDashes = values(rest).indexOf('--')
      const files = afterDashes >= 0 && afterDashes < rest.length - 1
      return forced || files || operands.includes('.') ? 'discards uncommitted changes to files' : null
    }
    case 'restore':
      return has('staged') && !has('worktree', 'W') ? null : 'discards uncommitted changes to files'
    case 'clean':
      return forced && !has('n', 'dry-run') ? 'deletes the files git does not track' : null
    case 'stash':
      return operands[0] === 'drop' || operands[0] === 'clear' ? 'throws stashed work away' : null
    case 'branch':
      return has('D') || (has('d', 'delete') && forced) ? 'deletes a branch whose work may not be merged anywhere' : null
    case 'reflog':
      return operands[0] === 'expire' || operands[0] === 'delete' ? 'erases the history git keeps to recover lost work' : null
    case 'gc':
      return [...options.long].some((option) => option === '--prune') && values(rest).some((value) => /^--prune=(?:now|all)$/.test(value)) ? 'erases the history git keeps to recover lost work' : null
    case 'filter-branch':
    case 'filter-repo':
      return 'rewrites the whole history of the repository'
    case 'worktree':
      return operands[0] === 'remove' && forced ? 'deletes a worktree with the changes in it' : null
    case 'push': {
      if (forced || operands.some((operand) => operand?.startsWith('+'))) return 'overwrites history on the remote'
      if (has('d', 'delete') || operands.some((operand) => operand?.startsWith(':'))) return 'deletes a branch or tag on the remote'
      if (has('mirror', 'prune')) return 'deletes on the remote what is not here'
      return `sends commits to ${operands[0] ?? 'the remote'}, where others can fetch them`
    }
    default:
      return null
  }
}

function publishes(name: string, args: readonly Arg[]): string | null {
  const said = words(args)
  const first = said.slice(0, 3)
  if (NODE_MANAGERS.has(name)) {
    if (first.includes('publish')) return 'publishes a package to the registry'
    if (first.includes('unpublish') || first.includes('deprecate')) return 'changes a package already published'
    return null
  }
  if (name === 'cargo') return said[0] === 'publish' ? 'publishes a crate to crates.io' : said[0] === 'yank' ? 'yanks a published crate' : null
  if (name === 'twine' || name === 'poetry' || name === 'flit' || name === 'hatch' || name === 'uv') return said[0] === 'upload' || said[0] === 'publish' ? 'publishes a package to the registry' : null
  if (name === 'gem') return said[0] === 'push' || said[0] === 'yank' ? 'publishes or yanks a gem' : null
  if (name === 'dotnet') return said[0] === 'nuget' && (said[1] === 'push' || said[1] === 'delete') ? 'publishes or removes a NuGet package' : null
  if (name === 'vsce' || name === 'ovsx') return said[0] === 'publish' || said[0] === 'unpublish' ? 'publishes an editor extension' : null
  if (name === 'gh' || name === 'glab') {
    const [area, verb] = said
    const acts: Record<string, string[]> = {
      pr: ['merge', 'close'],
      mr: ['merge', 'close'],
      release: ['create', 'delete', 'upload', 'edit'],
      repo: ['delete', 'archive', 'rename', 'edit', 'create'],
      issue: ['close', 'delete', 'transfer'],
      secret: ['set', 'delete'],
      variable: ['set', 'delete'],
      workflow: ['run', 'disable'],
    }
    if (area && verb && acts[area]?.includes(verb)) return `changes the repository on ${name === 'gh' ? 'GitHub' : 'GitLab'} for everyone who uses it (${name} ${area} ${verb})`
    if (area === 'api' && values(args).some((value, index, list) => /^(?:-X|--method)$/.test(list[index - 1] ?? '') && /^(?:DELETE|PUT|PATCH|POST)$/i.test(value))) return `changes the repository on ${name === 'gh' ? 'GitHub' : 'GitLab'} through its API`
  }
  return null
}

function infrastructure(name: string, args: readonly Arg[]): string | null {
  const said = words(args)
  const flags = values(args).map((value) => value.toLowerCase())
  switch (name) {
    case 'terraform':
    case 'tofu':
      if (said[0] === 'destroy') return 'destroys live infrastructure'
      if (said[0] === 'apply' || said[0] === 'import' || said[0] === 'taint' || (said[0] === 'state' && ['rm', 'mv', 'push'].includes(said[1] ?? ''))) return 'changes live infrastructure'
      return null
    case 'pulumi':
      return said[0] === 'destroy' ? 'destroys live infrastructure' : said[0] === 'up' || said[0] === 'update' ? 'changes live infrastructure' : null
    case 'kubectl':
      if (said[0] === 'delete') return 'deletes from the cluster'
      return ['apply', 'replace', 'patch', 'scale', 'drain', 'edit', 'set', 'rollout', 'create'].includes(said[0] ?? '') ? 'changes what runs in the cluster' : null
    case 'helm':
      return ['install', 'upgrade', 'uninstall', 'delete', 'rollback'].includes(said[0] ?? '') ? 'changes what runs in the cluster' : null
    case 'aws':
      if ((said[0] === 's3' && (said[1] === 'rm' || said[1] === 'rb' || (said[1] === 'sync' && flags.includes('--delete')))) || said.some((word) => /^(?:delete|terminate|remove|deregister|purge)-/.test(word))) return 'deletes from the cloud account'
      return said.includes('deploy') ? 'deploys to the cloud account' : null
    case 'gcloud':
    case 'az':
      return said.includes('delete') ? 'deletes from the cloud account' : said.includes('deploy') ? 'deploys to the cloud account' : null
    case 'docker':
    case 'podman': {
      if (said[0] === 'push') return 'publishes an image'
      const verb = said[0] === 'container' || said[0] === 'image' || said[0] === 'volume' || said[0] === 'network' || said[0] === 'system' || said[0] === 'builder' ? said[1] : said[0]
      if (verb === 'rm' || verb === 'rmi' || verb === 'prune') return 'deletes containers, images or their data'
      if (said[0] === 'compose' && said[1] === 'down' && (flags.includes('-v') || flags.includes('--volumes'))) return 'deletes containers, images or their data'
      return null
    }
    case 'fly':
    case 'flyctl':
      return said.includes('destroy') ? 'destroys an app' : ['deploy', 'scale'].includes(said[0] ?? '') || (said[0] === 'secrets' && said[1] !== 'list') ? 'changes a live app' : null
    case 'heroku':
      return said.some((word) => /^(?:apps:destroy|pg:reset|releases:rollback|maintenance:on)$/.test(word)) ? 'changes or destroys a live app' : null
    case 'vercel':
    case 'netlify':
      if (said[0] === 'rm' || said[0] === 'remove') return 'deletes a deployment'
      return (said[0] === 'deploy' || said.length === 0) && (flags.includes('--prod') || flags.includes('--production')) ? 'deploys to production' : null
    case 'wrangler':
      return ['deploy', 'publish', 'delete', 'rollback'].includes(said[0] ?? '') ? 'changes a live worker' : null
    case 'firebase':
      return said[0] === 'deploy' ? 'deploys to production' : null
    default:
      return null
  }
}

function database(name: string, args: readonly Arg[]): string | null {
  const text = `${name} ${values(args).join(' ')}`
  if (DATABASE_RESET.test(text)) return 'drops or empties the database'
  if (name === 'dropdb') return 'drops a database'
  if (DATABASE_CLIENTS.has(name) && DESTRUCTIVE_SQL.test(values(args).join(' '))) return 'drops or empties database data'
  return null
}

function machine(reading: Reading, name: string, args: readonly Arg[], options: Split): string | null {
  if (DISKS.has(name) || name.startsWith('mkfs')) return 'erases a disk or partition'
  if (POWER.has(name)) return 'restarts or turns off the machine'
  if (name === 'dd') {
    const target = values(args).find((value) => value.startsWith('of='))
    return target ? `writes raw data over ${shown(reading, resolveIn(reading, target.slice(3)))}` : null
  }
  if (OWNERSHIP.has(name) && (options.short.has('R') || options.long.has('--recursive'))) {
    const target = options.operands[1]?.value
    return `changes who may use ${target ? shown(reading, resolveIn(reading, target)) : 'files'} and everything in it`
  }
  return null
}

/** The command a wrapper runs, after its options, assignments and values. */
function unwrap(name: string, args: readonly Arg[]): { written: string | null; name: string | null; args: Arg[] } | undefined {
  if (!WRAPPERS.has(name)) return undefined
  let index = 0
  while (index < args.length) {
    const value = args[index].value
    if (value === null) break
    if (value === '--') {
      index++
      break
    }
    const takesValue = ((name === 'nice' || name === 'ionice') && (value === '-n' || value === '-c')) || (name === 'xargs' && XARGS_VALUES.has(value))
    const skippable = value.startsWith('-') || (name === 'env' && /^[A-Za-z_]\w*=/.test(value)) || (name === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(value))
    if (!skippable) break
    index += takesValue ? 2 : 1
  }
  const command = args[index]
  if (!command) return { written: '', name: '', args: [] }
  // What xargs runs gets more words from its input: one only known when the line runs.
  const piped: Arg[] = name === 'xargs' ? [{ value: null, glob: false, text: '(input)' }] : []
  return { written: command.value, name: command.value === null ? null : nameOf(command.value), args: [...args.slice(index + 1), ...piped] }
}

function readCalls(line: string, dialect: 'bash' | 'pwsh', home: string): Call[] | null {
  if (dialect === 'pwsh') {
    const parsed = parsePwsh(line)
    return parsed.ok ? parsed.script.statements.flatMap((statement) => statement.pipelines.flatMap((pipeline) => pipeline.commands.map(pwshCall))) : null
  }
  const parsed = parseBash(line)
  return parsed.ok ? simpleCommands(parsed.script).map((command) => bashCall(command, home)) : null
}

function readLine(reading: Reading, line: string, dialect: 'bash' | 'pwsh'): string | null {
  const calls = shellLineProblem(line) ? null : readCalls(line, dialect, reading.context.home)
  if (!calls || calls.length > MAX_COMMANDS) return UNREAD.test(line) ? 'may delete, overwrite or send out what cannot be brought back (eNCode could not read all of it)' : null
  const pwsh = dialect === 'pwsh'
  for (const call of calls) {
    let command: { written: string | null; name: string | null; args: Arg[] } = call
    for (let depth = 0; depth < 6 && command.name; depth++) {
      const inner = unwrap(command.name, command.args)
      if (!inner) break
      command = inner
    }
    if (command.name === null) {
      const text = [command.written ?? '', ...command.args.map((arg) => arg.text)].join(' ')
      if (UNREAD.test(text)) return 'may delete, overwrite or send out what cannot be brought back (eNCode could not read all of it)'
      continue
    }
    const { name, args } = command
    if (!name) continue
    if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'push-location') {
      const target = args.find((arg) => !(arg.value ?? '').startsWith('-'))?.value
      if (target && target !== '-') reading.cwd = resolveIn(reading, target)
      continue
    }
    if ((SHELLS.has(name) || POWERSHELLS.has(name)) && reading.depth < MAX_DEPTH) {
      const list = values(args)
      const flag = list.findIndex((value) => (POWERSHELLS.has(name) ? /^-(?:c|command)$/i.test(value) : /^-[A-Za-z]*c[A-Za-z]*$/.test(value)))
      const code = flag >= 0 ? args[flag + 1] : undefined
      if (code) {
        const found = code.value === null ? (UNREAD.test(code.text) ? 'may delete, overwrite or send out what cannot be brought back (eNCode could not read all of it)' : null) : readLine({ ...reading, depth: reading.depth + 1 }, code.value, POWERSHELLS.has(name) ? 'pwsh' : 'bash')
        if (found) return found
      }
      continue
    }
    if (name === 'cmd' && reading.depth < MAX_DEPTH) {
      const text = args.map((arg) => arg.value ?? arg.text).join(' ')
      if (UNREAD.test(text)) return 'may delete, overwrite or send out what cannot be brought back'
      continue
    }
    const options = split(args, pwsh)
    const found =
      (REMOVERS.has(name) || name === 'shred' ? removal(reading, name, options, pwsh) : null) ??
      (name === 'find' ? findDeletes(args) : null) ??
      (name === 'git' ? git(args) : null) ??
      publishes(name, args) ??
      infrastructure(name, args) ??
      database(name, args) ??
      machine(reading, name, args, options)
    if (found) return found
  }
  return null
}

/** Why a shell line would be hard to undo, as a clause ("deletes src and everything in it"), or null when it is not. */
export function hardToUndo(line: string, context: UndoContext): string | null {
  const windows = (context.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32'
  const api: PathApi = windows ? path.win32 : path.posix
  if (!line.trim()) return null
  return readLine({ context, api, windows, cwd: api.resolve(context.cwd), depth: 0 }, line, context.dialect)
}
