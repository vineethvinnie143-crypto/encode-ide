import path from 'node:path'
import { parseBash, simpleCommands } from './bash-grammar'
import { gitBashToWindows, shellLineProblem } from './bash-policy'
import { isGuardedPath, isInside } from './paths'
import { parsePwsh } from './pwsh-grammar'
import { bashCall, nameOf, pwshCall, pwshHas, split, type Arg, type Call, type Split } from './command-words'
import type { PathApi } from './shell-grammar'

/**
 * The floor under Auto review. When the approval policy is Auto review, a model (the Reviewer) may approve a
 * shell command the person would otherwise be asked about. A model can be fooled by the text it reads, or can be
 * weak, so some commands never reach it: this module decides which. A command it stops is put to the person,
 * whatever the Reviewer would have said.
 *
 * A line goes to the Reviewer only when every command in it can be read to the end and none of them:
 *
 *  - runs with administrator rights, or moves data over the network by hand (curl, ssh, rsync),
 *  - changes the machine outside the project (packages, services, scheduled tasks, the registry, disks),
 *  - acts on containers, clusters or cloud accounts, or publishes anything,
 *  - starts a program that is only known when the line runs, or code the policy cannot read (eval, xargs,
 *    `python -c`, a script piped into a shell),
 *  - deletes recursively, changes permissions recursively, or writes (also by redirection) outside the project or
 *    into a protected folder,
 *  - rewrites or discards git history or work, sends to a remote that is not a configured name, or changes git's
 *    settings,
 *  - sets a variable that changes what programs run.
 *
 * It is a floor, not a sandbox: code the agent writes and then runs reaches the Reviewer by its name alone, and an
 * operating-system sandbox is what contains that (threat model R1). Every rule here errs toward asking.
 */

export interface ScreenContext {
  /** The workspace root, as a real path. */
  root: string
  /** Where the line starts. */
  cwd: string
  home: string
  dialect: 'bash' | 'pwsh'
  /** Path rules of the machine that runs the line. Defaults to this machine's. */
  platform?: 'win32' | 'posix'
  /** Folders outside the workspace the person counts as part of it. */
  extraRoots?: readonly string[]
  /** Whether `target` lies inside `folder` once links are resolved. It reads the disk, so the caller supplies it. */
  inside(folder: string, target: string): Promise<boolean>
}

export type Screened = { reviewable: true } | { reviewable: false; reason: string }

interface Use {
  target: string
  write: boolean
  /** The root itself may not be the target: a recursive change would reach all of it. */
  strict: boolean
}

interface Command {
  written: string
  name: string
  args: Arg[]
}

const MAX_DEPTH = 3
const MAX_COMMANDS = 60

class Stop extends Error {}
function stop(reason: string): never {
  throw new Stop(reason)
}

// ---------------------------------------------------------------------------------------------------------------
// What only the person may allow, by program

const BY_PROGRAM = new Map<string, string>()
function group(reason: string, names: readonly string[]): void {
  for (const name of names) BY_PROGRAM.set(name, reason)
}

group('runs with administrator rights', ['sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'runas', 'gsudo'])
group('moves data over the network by hand', [
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'nmap',
  'invoke-webrequest', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'bitsadmin', 'certutil', 'mshta', 'wscript',
  'cscript', 'rundll32', 'regsvr32', 'msiexec',
])
group('changes the machine outside the project', [
  'dd', 'mkfifo', 'mknod', 'fdisk', 'parted', 'format', 'diskpart', 'mount', 'umount', 'shutdown', 'reboot', 'halt',
  'poweroff', 'systemctl', 'service', 'launchctl', 'sc', 'schtasks', 'crontab', 'at', 'batch', 'reg', 'regedit',
  'setx', 'bcdedit', 'wmic', 'netsh', 'sysctl', 'modprobe', 'insmod', 'rmmod', 'iptables', 'ufw', 'firewall-cmd',
  'hostnamectl', 'timedatectl', 'useradd', 'userdel', 'usermod', 'groupadd', 'passwd', 'chpasswd', 'visudo', 'net',
  'new-service', 'set-service', 'stop-service', 'start-service', 'restart-service', 'restart-computer', 'stop-computer',
  'set-executionpolicy', 'register-scheduledtask', 'unregister-scheduledtask', 'new-itemproperty', 'set-itemproperty',
  'remove-itemproperty', 'sp',
])
group('stops other programs', ['kill', 'killall', 'pkill', 'taskkill', 'stop-process', 'spps', 'skill'])
group('installs software on the machine', [
  'apt', 'apt-get', 'aptitude', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'zypper', 'apk', 'brew', 'port', 'choco',
  'winget', 'scoop', 'snap', 'flatpak', 'nix', 'nix-env', 'emerge', 'pkg', 'install-module', 'install-package',
  'install-script', 'pipx',
])
group('acts on containers, clusters or cloud accounts', [
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'ansible', 'ansible-playbook', 'aws', 'gcloud',
  'gsutil', 'az', 'doctl', 'flyctl', 'fly', 'heroku', 'vercel', 'netlify', 'wrangler', 'firebase', 'supabase', 'gh', 'glab',
])
group('can download and run a package', ['npx', 'pnpx', 'bunx', 'uvx'])
group('runs code the policy cannot read', [
  'eval', 'source', '.', 'exec', 'xargs', 'parallel', 'watch', 'expect', 'script', 'invoke-expression', 'iex',
  'invoke-command', 'icm', 'cmd', 'wsl', 'trap', 'coproc', 'enable', 'start-process', 'saps', 'start',
])
group('runs another program with extra control over it', [
  'chroot', 'nsenter', 'unshare', 'strace', 'ltrace', 'gdb', 'lldb', 'flock', 'firejail', 'bwrap', 'proot', 'chrt',
  'taskset', 'numactl', 'unbuffer', 'faketime', 'fakeroot', 'dtruss', 'ktrace',
])
group("changes the shell's settings for the commands that follow", ['set', 'shopt', 'alias', 'unalias', 'umask', 'ulimit', 'hash', 'bind', 'complete'])

// ---------------------------------------------------------------------------------------------------------------
// Variables

/** Variables a command may be given for one run. Anything else can change what programs run (PATH, NODE_OPTIONS, GIT_*). */
const SAFE_VARIABLE =
  /^(?:CI|NODE_ENV|DEBUG|FORCE_COLOR|NO_COLOR|COLORTERM|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|PORT|HOST|HOSTNAME|VERBOSE|LOG_LEVEL|RUST_BACKTRACE|RUST_LOG|PYTHONDONTWRITEBYTECODE|PYTHONUNBUFFERED|PYTHONIOENCODING|PYTHONHASHSEED|PYTHONUTF8|NEXT_TELEMETRY_DISABLED|DISABLE_OPENCOLLECTIVE|COLUMNS|LINES|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ENV|MODE|PORT|DEBUG|VERBOSE|LEVEL|TIMEOUT))$/

// ---------------------------------------------------------------------------------------------------------------
// Reading a line

/** The grammar's reason a line was not read, as a clause that says what follows from it. */
function unread(reason: string): string {
  return /^uses /.test(reason) && !/[,]|which/.test(reason) ? `${reason}, which is not checked automatically` : reason
}

function callsOf(line: string, dialect: 'bash' | 'pwsh', home: string): Call[] {
  if (dialect === 'pwsh') {
    const parsed = parsePwsh(line)
    if (!parsed.ok) return stop(`the command ${unread(parsed.reason)}`)
    return parsed.script.statements.flatMap((statement) => statement.pipelines.flatMap((pipeline) => pipeline.commands.map(pwshCall)))
  }
  const parsed = parseBash(line)
  if (!parsed.ok) return stop(`the command ${unread(parsed.reason)}`)
  return simpleCommands(parsed.script).map((command) => bashCall(command, home))
}

// ---------------------------------------------------------------------------------------------------------------
// Options

// ---------------------------------------------------------------------------------------------------------------
// The checks

interface Scan {
  context: ScreenContext
  api: PathApi
  windows: boolean
  home: string
  cwd: string
  uses: Use[]
  calls: number
  depth: number
}

function resolveIn(scan: Scan, value: string): string {
  const spelled = scan.windows && scan.context.dialect === 'bash' ? gitBashToWindows(value) : value
  return scan.api.resolve(scan.cwd, spelled)
}

/** Records that a command reads or writes what its operands name; a name only known at run time stops the line. */
function paths(scan: Scan, operands: readonly Arg[], write: boolean, strict = false): void {
  for (const operand of operands) {
    if (operand.value === null) stop('a file name in the command is only known when it runs')
    if (operand.value === '-' || operand.value === '') continue
    scan.uses.push({ target: resolveIn(scan, operand.value), write, strict })
  }
}

const READS = new Set([
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'nl', 'od', 'hexdump', 'xxd', 'strings', 'file', 'stat', 'wc', 'sort', 'uniq',
  'cut', 'paste', 'diff', 'cmp', 'comm', 'join', 'fold', 'fmt', 'expand', 'unexpand', 'column', 'rev', 'ls', 'dir', 'vdir',
  'du', 'df', 'readlink', 'realpath', 'tree', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'b2sum', 'cksum', 'zcat',
  'bzcat', 'xzcat', 'get-content', 'get-childitem', 'get-item', 'select-string', 'get-filehash', 'test-path',
])
const WRITES = new Set([
  'tee', 'cp', 'mv', 'rmdir', 'mkdir', 'touch', 'ln', 'unlink', 'truncate', 'install', 'shred', 'split', 'csplit', 'tar',
  'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', '7z', '7za', 'set-content', 'add-content', 'out-file',
  'copy-item', 'move-item', 'new-item', 'rename-item', 'clear-content', 'compress-archive', 'expand-archive',
])
const OWNERSHIP = new Set(['chmod', 'chown', 'chgrp'])
const REMOVERS = new Set(['rm', 'remove-item'])
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'jq'])

/** How each interpreter is given a program as text: those arguments stop the line. */
const INLINE_CODE = new Map<string, RegExp>([
  ['python', /^-[A-Za-z]*c/], ['python2', /^-[A-Za-z]*c/], ['python3', /^-[A-Za-z]*c/], ['py', /^-[A-Za-z]*c/],
  ['node', /^(?:-[A-Za-z]*[epi]|--eval|--print|--interactive|--input-type.*)$/],
  ['nodejs', /^(?:-[A-Za-z]*[epi]|--eval|--print|--interactive)$/],
  ['deno', /^(?:eval|repl|-)$/], ['bun', /^(?:-[A-Za-z]*[ep]|--eval|--print)$/],
  ['ruby', /^-[A-Za-z]*e/], ['perl', /^-[A-Za-z]*[eE]/], ['php', /^-[A-Za-z]*r/], ['lua', /^-[A-Za-z]*e/],
  ['rscript', /^-[A-Za-z]*e/], ['julia', /^-[A-Za-z]*[eE]/], ['osascript', /^-[A-Za-z]*e/],
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])
const PACKAGE_MANAGERS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'twine', 'uv', 'poetry', 'cargo', 'gem', 'bundle', 'composer', 'dotnet',
  'nuget', 'go', 'mvn', 'gradle', 'gradlew', 'sbt', 'mix', 'cabal', 'stack', 'dart', 'flutter',
])
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PM_PUBLISH = new Set([
  'publish', 'push', 'upload', 'deploy', 'login', 'logout', 'adduser', 'signin', 'signout', 'token', 'owner', 'yank',
  'unpublish', 'dist-tag', 'deprecate', 'access', 'release', 'register',
])
/** Verbs whose later words are package names, test filters or flags, not an action of their own. */
const NAMING_VERBS = new Set([
  'test', 't', 'build', 'b', 'check', 'c', 'clippy', 'fmt', 'format', 'doc', 'bench', 'clean', 'tree', 'ls', 'list', 'outdated',
  'audit', 'start', 'dev', 'lint', 'ci', 'vet', 'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade',
])
const PM_INSTALL = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'ln', 'unlink', 'get', 'tool', 'global'])
/** What starts a download and run, by manager (`exec` of pnpm and yarn runs what the project already has). */
const PM_DOWNLOAD_AND_RUN = new Map<string, Set<string>>([
  ['npm', new Set(['exec', 'x', 'create'])],
  ['pnpm', new Set(['dlx', 'create'])],
  ['yarn', new Set(['dlx', 'create'])],
  ['bun', new Set(['x', 'create', 'dlx'])],
])
const GLOBAL_INSTALLERS = new Set(['cargo', 'go', 'gem'])

const URL_LIKE = /(?:^|[^A-Za-z])(?:https?|ftps?|git|ssh|file):\/\/|^git\+|^git@|^(?:github|gitlab|bitbucket):/i

/** A git remote spelled as an address or a path rather than a name that is configured. */
function remoteLike(value: string): boolean {
  return /:\/\//.test(value) || /^[\w.-]+@[\w.-]+:/.test(value) || /^(?:[\\/]|\.\.?[\\/]|~|[A-Za-z]:[\\/])/.test(value)
}

const GIT_KNOWN = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'diff-tree', 'merge-base', 'show-ref', 'for-each-ref', 'name-rev', 'grep', 'check-ignore', 'help',
  'version', 'add', 'commit', 'merge', 'cherry-pick', 'revert', 'apply', 'am', 'fetch', 'pull', 'push', 'switch', 'mv',
  'rm', 'stash', 'reflog', 'remote', 'config', 'reset', 'restore', 'branch', 'tag', 'rebase', 'init', 'format-patch',
  'worktree',
])

function gitCheck(scan: Scan, args: readonly Arg[]): void {
  let index = 0
  while (index < args.length) {
    const value = args[index].value
    if (value === null) return stop('git is given a word that is only known when the line runs')
    if (value === '-C') {
      const target = args[index + 1]
      if (!target) return stop('git -C has no folder')
      paths(scan, [target], false)
      index += 2
      continue
    }
    if (/^-c/.test(value) || value.startsWith('--config-env')) return stop('git is given settings on the command line, which can make it run other programs')
    if (/^--(?:git-dir|work-tree|exec-path|namespace|super-prefix|html-path|man-path|info-path)\b/.test(value)) return stop('git is pointed at another repository or program folder')
    if (value.startsWith('-')) {
      index++
      continue
    }
    break
  }
  if (index >= args.length) return
  const sub = (args[index].value ?? '').toLowerCase()
  const options = split(args.slice(index + 1), false)
  const operands = options.operands.map((operand) => operand.value)
  const has = (...names: string[]) => names.some((name) => (name.length === 1 ? options.short.has(name) : options.long.has(`--${name}`)))
  const longStarts = (prefix: string) => [...options.long].some((name) => name.startsWith(prefix))
  const refuse = (what: string): never => stop(`git ${sub} ${what}`)

  if (!GIT_KNOWN.has(sub)) return refuse('is not a command the policy knows, and an alias in the folder could run anything')
  if (sub === 'rebase' && has('x', 'exec')) refuse('runs a command at each step')
  if (sub === 'reset' && has('hard', 'merge', 'keep')) refuse('discards work')
  if (sub === 'restore' && !(has('staged') && !has('worktree', 'W'))) refuse('discards work')
  if (sub === 'branch' && has('d', 'D', 'delete', 'm', 'M', 'move', 'f', 'force', 'c', 'C', 'copy')) refuse('deletes or moves a branch')
  if (sub === 'tag' && has('d', 'delete', 'f', 'force')) refuse('deletes or moves a tag')
  if (sub === 'stash' && (operands[0] === 'drop' || operands[0] === 'clear')) refuse('throws stashed work away')
  if (sub === 'reflog' && (operands[0] === 'expire' || operands[0] === 'delete')) refuse('erases history')
  if (sub === 'worktree' && operands[0] !== 'list') refuse('changes worktrees')
  if (sub === 'remote' && !(operands.length === 0 || operands[0] === 'show' || operands[0] === 'get-url')) refuse('changes the remotes')
  if ((sub === 'diff' || sub === 'log' || sub === 'show' || sub === 'format-patch') && (has('no-index') || longStarts('--output'))) refuse('reads or writes files outside the repository')
  if (sub === 'config') {
    const reading = has('get', 'get-all', 'get-regexp', 'list', 'l', 'show-origin', 'show-scope', 'name-only')
    const writing = has('global', 'system', 'file', 'f', 'add', 'unset', 'unset-all', 'replace-all', 'edit', 'e', 'worktree', 'local', 'rename-section', 'remove-section')
    if (!reading || writing) refuse('changes git settings')
  }
  if (sub === 'init' && (longStarts('--template') || longStarts('--separate-git-dir'))) refuse('uses files from elsewhere')
  if (sub === 'push') {
    if (has('f', 'force', 'delete', 'd', 'mirror', 'prune') || longStarts('--force')) refuse('overwrites or deletes what is on the remote')
    for (const operand of operands) {
      if (operand === null) refuse('names a ref that is only known when the line runs')
      const text = operand as string
      if (text.startsWith('+') || text.startsWith(':') || remoteLike(text)) refuse('pushes somewhere other than a configured remote, or overwrites a branch')
    }
  }
  if (sub === 'fetch' || sub === 'pull') {
    for (const operand of operands) if (operand !== null && remoteLike(operand)) refuse('contacts an address instead of a configured remote')
  }
  // The files these name are paths in the folder; one that leads out of it is not an ordinary use.
  if (sub === 'add' || sub === 'mv' || sub === 'rm' || sub === 'init') paths(scan, options.operands, true)
  if (sub === 'apply' || sub === 'am') paths(scan, options.operands, false)
}

/** Options whose next word is their value, not an operand: `pnpm --filter web publish` publishes. */
const VALUE_OPTIONS = new Set(['--filter', '-F', '--dir', '-C', '--cwd', '--workspace', '--prefix', '--registry', '--cache', '--userconfig', '--globalconfig', '--loglevel', '--reporter', '--index-url', '--extra-index-url', '--manifest-path', '--target-dir', '--project', '--package'])

function packageManagerCheck(scan: Scan, name: string, args: readonly Arg[]): void {
  const options = split(args, false)
  if (args.some((arg) => arg.value === null)) return stop(`${name} is given a word that is only known when the line runs`)
  // The words that are not options or their values: the first picks the action.
  const words: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index].value as string
    if (value === '--') break
    if (VALUE_OPTIONS.has(value) && !value.includes('=')) index++
    else if (!value.startsWith('-')) words.push(value.toLowerCase())
  }
  // An option's value can push the action back by a place or two. After a verb that takes names, such as
  // `cargo test token`, later words are names and not actions.
  const early = NAMING_VERBS.has(words[0]) ? words.slice(0, 1) : words.slice(0, 3)
  const action = early.find((word) => PM_PUBLISH.has(word))
  if (action) return stop(`${name} ${action} publishes or signs in to a package registry`)
  const installing = early.some((word) => PM_INSTALL.has(word))
  const global = options.short.has('g') || ['--global', '--system', '--user', '--location'].some((option) => options.long.has(option)) || early.includes('global')
  if (installing && global) return stop(`${name} installs software on the machine, not in the project`)
  if (GLOBAL_INSTALLERS.has(name) && early.includes('install')) return stop(`${name} install installs a program on the machine`)
  if (name === 'dotnet' && early.includes('tool') && early.includes('install')) return stop('dotnet tool install installs software on the machine')
  // Only the first word picks the action: after `install`, a word is a package name.
  if (NODE_MANAGERS.has(name) && PM_DOWNLOAD_AND_RUN.get(name)?.has(words[0])) return stop(`${name} ${words[0]} can download and run a package`)
  if (name === 'npm' && words[0] === 'init' && words.length > 1) return stop('npm init would download and run a package')
  if (words[0] === 'config' && words.some((word) => word === 'set' || word === 'delete' || word === 'edit')) return stop(`${name} config changes ${name}'s settings for every project`)
  for (const option of options.long) {
    if (/^--(?:registry|userconfig|globalconfig|prefix|index-url|extra-index-url|find-links|trusted-host|source|cache)$/.test(option) || /^--@[\w-]+:registry$/.test(option)) {
      return stop(`${name} is pointed at another package source or settings file`)
    }
  }
  if ((name === 'pip' || name === 'pip3') && (options.short.has('i') || options.short.has('f'))) return stop(`${name} is pointed at another package source`)
  if (installing) {
    for (const arg of args) if (URL_LIKE.test(arg.value as string)) return stop(`${name} would fetch code from an address instead of the package registry`)
  }
}

function findCheck(scan: Scan, args: readonly Arg[]): void {
  const roots: Arg[] = []
  let started = false
  for (const arg of args) {
    const value = arg.value
    if (value === null) return stop('find is given a word that is only known when the line runs')
    if (/^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(value)) return stop(`find ${value} runs programs or changes files`)
    if (started) continue
    if (/^-(?:H|L|P|O\d|D.*)$/.test(value)) continue
    if (value.startsWith('-') || value === '(' || value === '!' || value === ',') started = true
    else roots.push(arg)
  }
  paths(scan, roots.length ? roots : [{ value: '.', glob: false, text: '.' }], false)
}

function patternFirst(scan: Scan, name: string, args: readonly Arg[]): void {
  const options = split(args, false)
  if (name === 'rg' && [...options.long].some((option) => option === '--pre' || option === '--pre-glob')) return stop('rg --pre runs a program on every file')
  const takesScript = !(options.short.has('e') || options.short.has('f') || options.long.has('--regexp') || options.long.has('--file') || options.long.has('--expression'))
  const rest = takesScript ? options.operands.slice(1) : options.operands
  if (/^[gnm]?awk$/.test(name) && takesScript) {
    const script = options.operands[0]?.value
    if (script === null) return stop('the awk program is only known when the line runs')
    if (script && /system\s*\(|\|\s*["']|["']\s*\||print[f]?\s*>|>>/.test(script)) return stop('the awk program runs commands or writes files')
  }
  const writing = name === 'sed' && (options.short.has('i') || options.long.has('--in-place'))
  paths(scan, rest.filter((operand) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(operand.value ?? '')), writing)
}

function removeCheck(scan: Scan, options: Split, pwsh: boolean): void {
  const recursive = pwsh ? pwshHas(options, 'recurse') : options.short.has('r') || options.short.has('R') || options.long.has('--recursive')
  if (options.long.has('--no-preserve-root')) return stop('rm would not protect the root of the disk')
  for (const operand of options.operands) {
    if (operand.value === null) return stop('a file to delete is only known when the line runs')
    if (!recursive || !operand.glob) continue
    if (/(?:^|[\\/])\.[^\\/]*$/.test(operand.value)) return stop('a pattern that starts with a dot would also match .git')
    // `rm -rf *` in the project's own folder empties it.
    if (scan.api.resolve(scan.api.dirname(resolveIn(scan, operand.value))) === scan.api.resolve(scan.context.root)) return stop('a recursive delete would empty the whole project')
  }
  paths(scan, options.operands, true, recursive)
}

/** The command a wrapper runs, `nothing` for one that only prints, or undefined when `name` wraps nothing. */
function unwrap(name: string, args: readonly Arg[]): Command | 'nothing' | undefined {
  const run = (skipOptions: (value: string) => number): Command | 'nothing' => {
    let index = 0
    while (index < args.length) {
      const value = args[index].value
      if (value === null) return stop(`${name} is given a word that is only known when the line runs`)
      const skip = skipOptions(value)
      if (skip <= 0) break
      index += skip
    }
    const command = args[index]
    if (!command) return 'nothing'
    if (command.value === null) return stop(`${name} would run a program that is only known when the line runs`)
    return { written: command.value, name: nameOf(command.value), args: args.slice(index + 1) as Arg[] }
  }
  const noOptions = (value: string): number => (value === '--' ? 1 : value.startsWith('-') ? stop(`${name} is given options the policy does not read`) : 0)
  switch (name) {
    case 'env':
      return run((value) => {
        if (value === '--') return 1
        if (value === '-u' || value === '-C' || value === '--unset' || value === '--chdir') return 2
        if (value.startsWith('-S') || value.startsWith('--split-string')) return stop('env -S splits text into a command the policy cannot read')
        if (value.startsWith('-')) return 1
        const variable = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value)?.[1]
        if (!variable) return 0
        if (!SAFE_VARIABLE.test(variable)) return stop(`the command sets ${variable} for one run, which can change what it runs`)
        return 1
      })
    case 'command':
    case 'builtin':
      // `command -v name` only looks a program up.
      if (args.some((arg) => arg.value === '-v' || arg.value === '-V')) return 'nothing'
      return run((value) => (value === '-p' ? 1 : 0))
    case 'time':
    case 'nohup':
    case 'setsid':
      return run((value) => (value === '-p' || value === '-c' || value === '-f' || value === '-w' ? 1 : noOptions(value)))
    case 'nice':
      return run((value) => (value === '-n' ? 2 : /^-\d+$/.test(value) || value.startsWith('--adjustment') ? 1 : 0))
    case 'ionice':
      return run((value) => (value === '-c' || value === '-n' ? 2 : value === '-t' ? 1 : 0))
    case 'stdbuf':
      return run((value) => (value === '-i' || value === '-o' || value === '-e' ? 2 : /^--(?:input|output|error)=/.test(value) ? 1 : 0))
    case 'timeout': {
      let seenDuration = false
      return run((value) => {
        if (value === '-s' || value === '-k' || value === '--signal' || value === '--kill-after') return 2
        if (value.startsWith('-')) return 1
        if (!seenDuration && /^\d+(?:\.\d+)?[smhd]?$/.test(value)) {
          seenDuration = true
          return 1
        }
        return 0
      })
    }
    default:
      return undefined
  }
}

function shellCheck(scan: Scan, name: string, args: readonly Arg[]): void {
  const values = args.map((arg) => arg.value)
  if (values.length === 1 && /^(?:--version|-version|-v|--help|-h)$/i.test(values[0] ?? '')) return
  if (values.includes(null)) return stop(`${name} is given a word that is only known when the line runs`)
  const strings = values as string[]
  const file = (value: string): Arg[] => [{ value, glob: false, text: value }]
  if (POWERSHELLS.has(name)) {
    if (strings.some((value) => /^-(?:e|ec|enc|encodedcommand|encodedargument)$/i.test(value))) return stop(`${name} is given its program encoded`)
    const command = strings.findIndex((value) => /^-(?:c|command)$/i.test(value))
    if (command >= 0) {
      if (strings[command + 1] === undefined) return stop(`${name} -Command has no program`)
      return inner(scan, strings[command + 1], 'pwsh')
    }
    const script = strings.findIndex((value) => /^-(?:f|file)$/i.test(value))
    if (script >= 0 && strings[script + 1]) return paths(scan, file(strings[script + 1]), false)
    const operands = strings.filter((value) => !value.startsWith('-'))
    if (operands.length === 0) return stop(`${name} would read its program from the pipeline`)
    return paths(scan, file(operands[0]), false)
  }
  const cluster = strings.findIndex((value) => /^-[A-Za-z]*c[A-Za-z]*$/.test(value))
  if (cluster >= 0) {
    if (strings[cluster + 1] === undefined) return stop(`${name} -c has no program`)
    return inner(scan, strings[cluster + 1], 'bash')
  }
  if (strings.includes('-s')) return stop(`${name} -s would read its program from the pipeline`)
  const operands = strings.filter((value) => !value.startsWith('-'))
  if (operands.length === 0) return stop(`${name} would read its program from the pipeline`)
  paths(scan, file(operands[0]), false)
}

/** The program text a shell is given with -c: judged like a line of its own. */
function inner(scan: Scan, code: string, dialect: 'bash' | 'pwsh'): void {
  if (scan.depth >= MAX_DEPTH) return stop('commands are nested too deeply to review')
  const problem = shellLineProblem(code)
  if (problem) return stop(`the program text ${problem.replace(/^empty command$/, 'is empty')}`)
  const nested: Scan = { ...scan, context: { ...scan.context, dialect }, depth: scan.depth + 1 }
  for (const call of callsOf(code, dialect, scan.home)) checkCall(nested, call)
  scan.uses.push(...nested.uses)
  scan.calls = nested.calls
}

function interpreterCheck(scan: Scan, name: string, inline: RegExp, args: readonly Arg[], options: Split): void {
  if (args.length === 1 && /^(?:-V|-v|--version|-version|--help|-h)$/.test(args[0].value ?? '')) return
  if (args.some((arg) => arg.value === null)) return stop(`${name} is given a word that is only known when the line runs`)
  if (args.some((arg) => inline.test(arg.value ?? ''))) return stop(`${name} is given its program as text, which the policy cannot read`)
  if (options.operands.length === 0) return stop(`${name} would read its program from the pipeline`)
  for (const operand of options.operands.slice(0, 2)) {
    if (operand.value && URL_LIKE.test(operand.value)) return stop(`${name} would run a program from an address`)
  }
  // The program is the first operand (or the module a -m option names); one given by path must be the project's.
  paths(scan, options.operands.slice(0, 1), false)
}

function redirectsCheck(scan: Scan, call: Call): void {
  for (const redirect of call.redirects) {
    const value = redirect.target.value
    if (value === null) return stop('a file the command writes to is only known when the line runs')
    if (!value) continue
    if (!redirect.write) {
      scan.uses.push({ target: resolveIn(scan, value), write: false, strict: false })
      continue
    }
    if (/^\/dev\/(?:null|stdout|stderr)$/.test(value) || value.toLowerCase() === '$null' || value.toLowerCase() === 'nul') continue
    if (/^\/dev\/(?:tcp|udp)\//.test(value)) return stop('the command opens a network connection')
    scan.uses.push({ target: resolveIn(scan, value), write: true, strict: false })
  }
}

function checkCall(scan: Scan, call: Call): void {
  if (++scan.calls > MAX_COMMANDS) return stop('the line has too many commands to review')
  const pwsh = scan.context.dialect === 'pwsh'
  for (const variable of call.assigns) {
    if (!SAFE_VARIABLE.test(variable)) return stop(`the command sets ${variable} for one run, which can change what it runs`)
  }
  redirectsCheck(scan, call)
  if (call.name === null || call.written === null) return stop('the command starts a program that is only known when the line runs')
  if (call.name === '') return

  // A wrapper runs the command after its own options; what it runs is what is judged.
  let command: Command = { written: call.written, name: call.name, args: call.args }
  for (let depth = 0; depth < 6; depth++) {
    const wrapped = unwrap(command.name, command.args)
    if (!wrapped) break
    if (wrapped === 'nothing') return
    command = wrapped
  }
  const { name, written, args } = command

  const reason = BY_PROGRAM.get(name) ?? (name.startsWith('mkfs') ? 'changes the machine outside the project' : undefined)
  if (reason) return stop(`the command starts ${name}, which ${reason}`)
  // A program given by path must be one of the project's own.
  if (/[\\/]/.test(written)) scan.uses.push({ target: resolveIn(scan, written), write: false, strict: false })

  const options = split(args, pwsh)
  if (name === 'git') return gitCheck(scan, args)
  if (PACKAGE_MANAGERS.has(name)) return packageManagerCheck(scan, name, args)
  if (name === 'find') return findCheck(scan, args)
  if (PATTERN_FIRST.has(name)) return patternFirst(scan, name, args)
  if (REMOVERS.has(name)) return removeCheck(scan, options, pwsh)
  if (OWNERSHIP.has(name)) {
    // The mode or the owner comes first; the rest are files.
    const recursive = options.short.has('R') || options.long.has('--recursive')
    return paths(scan, options.operands.slice(1), true, recursive)
  }
  if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'push-location') {
    const target = options.operands[0]
    if (!target || target.value === null || target.value === '-') return stop('cd goes to a folder that is only known when the line runs')
    const resolved = resolveIn(scan, target.value)
    scan.uses.push({ target: resolved, write: false, strict: false })
    scan.cwd = resolved
    return
  }
  if (WRITES.has(name)) return paths(scan, options.operands, true)
  if (READS.has(name)) return paths(scan, options.operands, false)
  if (SHELLS.has(name) || POWERSHELLS.has(name)) return shellCheck(scan, name, args)
  const inline = INLINE_CODE.get(name)
  if (inline) return interpreterCheck(scan, name, inline, args, options)
  if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'readonly' || name === 'set-variable') {
    for (const operand of options.operands) {
      const variable = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(operand.text)?.[1]
      if (variable && !SAFE_VARIABLE.test(variable)) return stop(`the command sets ${variable}, which can change what later commands run`)
      if (operand.value === null && !variable) return stop('a variable name is only known when the line runs')
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** A path as a reason shows it: relative to the project when it is inside, else in full. */
function shown(scan: Scan, target: string): string {
  const relative = scan.api.relative(scan.context.root, target)
  return relative && !relative.startsWith('..') && !scan.api.isAbsolute(relative) ? relative.split(scan.api.sep).join('/') : target
}

/**
 * Whether a shell line may go to the Reviewer, or only the person may allow it, and why. A line that cannot be
 * read to the end is never the Reviewer's.
 */
export async function screenCommand(line: string, context: ScreenContext): Promise<Screened> {
  const windows = (context.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')) === 'win32'
  const api: PathApi = windows ? path.win32 : path.posix
  try {
    if (!line.trim()) stop('the command is empty')
    const problem = shellLineProblem(line)
    if (problem) stop(`the command ${/^(?:contains|uses)\b/.test(problem) ? problem : `is ${problem}`}`)
    const scan: Scan = { context, api, windows, home: context.home, cwd: api.resolve(context.cwd), uses: [], calls: 0, depth: 0 }
    // The shell may have been left outside the project by an earlier command.
    scan.uses.push({ target: scan.cwd, write: false, strict: false })
    for (const call of callsOf(line, context.dialect, context.home)) checkCall(scan, call)

    const roots = [context.root, ...(context.extraRoots ?? [])]
    for (const use of scan.uses) {
      let inside = false
      for (const root of roots) {
        if (isInside(root, use.target, api) && (await context.inside(root, use.target))) {
          inside = true
          break
        }
      }
      if (!inside) stop(`${shown(scan, use.target)} is outside the project`)
      const relative = api.relative(context.root, use.target)
      if (use.write && relative && !relative.startsWith('..') && !api.isAbsolute(relative) && isGuardedPath(relative)) {
        stop(`${shown(scan, use.target)} is in a protected folder or file`)
      }
      if (use.strict && api.resolve(use.target) === api.resolve(context.root)) stop('a recursive change would reach the whole project')
    }
    return { reviewable: true }
  } catch (error) {
    if (error instanceof Stop) return { reviewable: false, reason: error.message || 'the command cannot be checked' }
    throw error
  }
}
