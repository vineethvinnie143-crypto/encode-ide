/**
 * What eNCode runs on the other machine to start its agent there (ADR 0111). One SSH command does it all:
 *
 * 1. A POSIX shell script finds a Node.js 22 or newer: eNCode's own under `~/.encode-server/node`, the one on the PATH,
 *    one nvm installed, or one in a usual place. Without one it says so on a line of its own and ends.
 * 2. A small loader, given to that Node, checks `~/.encode-server/<version>/encode-server.cjs` against the checksum of
 *    the build this PC runs. When it is missing or different it asks for it, and this PC sends it on the same
 *    connection; it is written beside the old one and renamed into place once its checksum is right.
 * 3. The loader says it is starting and runs the program, which then reads and writes eNCode's messages on the same
 *    standard input and output. After an upload the loader leaves standard input paused, with what came after the
 *    program put back in front: the program resumes it once it listens, so nothing is lost in between.
 *
 * Lines are marked `ENCODE-<WHAT> <nonce>`, the nonce new for every connection, so what a login script prints first
 * is passed over and cannot be taken for an answer.
 *
 * The command is read by the account's login shell before `sh` runs it, and that shell may be bash, zsh, fish or csh.
 * So the script is one line in single quotes with no single quote and no `!` inside, and the loader goes as base64.
 */

/** The marked lines the other machine writes. */
export const MARKS = ['START', 'UPLOAD', 'NODE-MISSING', 'NODE-OLD', 'FAILED'] as const
export type Mark = (typeof MARKS)[number]

/** The oldest Node.js the program runs on: it is built for Node 22. */
export const MIN_NODE_MAJOR = 22

/** The Node.js eNCode puts on a machine that has none (ADR 0111), with the checksums of its official builds. */
export const NODE_RELEASE = {
  version: '24.22.1',
  base: 'https://nodejs.org/dist/v24.22.1',
  builds: {
    'linux-x64': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
    'linux-arm64': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
    'darwin-x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
    'darwin-arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  } as Record<string, string>,
}

const SAFE_ARG = /^[A-Za-z0-9._:+-]{1,128}$/

/** Quotes a script for the login shell: one line, in single quotes, with nothing inside that a shell would read. */
export function shellQuoted(script: string): string {
  if (/['!\n\r]/.test(script)) throw new Error('A script sent over SSH has no single quote, no "!" and no line break.')
  return `'${script}'`
}

/**
 * The loader: Node runs it with the program's path, its checksum and the nonce. It reads an upload as a decimal
 * length on a line, then that many bytes, and gives back to standard input whatever came after, for the program.
 */
const LOADER = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [file, sha, nonce] = process.argv.slice(2);
const say = (what, extra) => process.stdout.write('\\nENCODE-' + what + ' ' + nonce + (extra ? ' ' + extra : '') + '\\n');
const sum = (data) => crypto.createHash('sha256').update(data).digest('hex');
const start = () => { say('START'); process.env.ENCODE_SERVER_NONCE = nonce; require(file); };
let current = null;
try { current = fs.readFileSync(file); } catch {}
if (current && sum(current) === sha) start();
else {
  say('UPLOAD');
  let pending = Buffer.alloc(0), size = -1;
  const take = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (size < 0) {
      const at = pending.indexOf(10);
      if (at < 0) { if (pending.length > 32) { say('FAILED', 'bad-upload'); process.exit(3); } return; }
      size = Number(pending.subarray(0, at).toString());
      pending = pending.subarray(at + 1);
      if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 * 1024) { say('FAILED', 'bad-upload'); process.exit(3); }
    }
    if (pending.length < size) return;
    const data = pending.subarray(0, size), rest = pending.subarray(size);
    process.stdin.off('data', take);
    process.stdin.pause();
    if (sum(data) !== sha) { say('FAILED', 'checksum'); process.exit(3); }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.part';
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
    if (rest.length) process.stdin.unshift(rest);
    start();
  };
  process.stdin.on('data', take);
}
`

export interface StartCommand {
  /** The build: the folder under `~/.encode-server` its program goes in. */
  version: string
  /** The program's sha256, in hex. */
  sha256: string
  nonce: string
  /** For tests: where Node.js is looked for. Default: eNCode's own, the PATH's, nvm's, Volta's and the usual places. */
  nodes?: string[]
}

const NODES = ['"$D/node/bin/node"', '"$(command -v node 2>/dev/null)"', '"$HOME"/.nvm/versions/node/v*/bin/node', '"$HOME"/.volta/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']

/** The command that starts eNCode's program on the other machine, for `sshArgs`. */
export function startCommand({ version, sha256, nonce, nodes = NODES }: StartCommand): string {
  for (const value of [version, sha256, nonce]) if (!SAFE_ARG.test(value)) throw new Error(`Not a safe argument: ${value}`)
  const loader = Buffer.from(LOADER, 'utf8').toString('base64')
  // No umask here: the agent's commands inherit it, and the files they make must come out as the account's usual ones.
  const script = [
    `D="$HOME/.encode-server"; S="$D/${version}/encode-server.cjs"; N=""; B=0`,
    // The best Node found: the highest major version, 22 or newer.
    `for c in ${nodes.join(' ')} ""; do if [ -n "$c" ] && [ -x "$c" ]; then v=$("$c" -p process.versions.node 2>/dev/null); m=\${v%%.*}; if [ "$m" -gt "$B" ] 2>/dev/null; then B=$m; N=$c; fi; fi; done`,
    `if [ -z "$N" ]; then printf "\\nENCODE-NODE-MISSING ${nonce} %s-%s\\n" "$(uname -s)" "$(uname -m)"; exit 0; fi`,
    `if [ "$B" -lt ${MIN_NODE_MAJOR} ]; then printf "\\nENCODE-NODE-OLD ${nonce} %s-%s %s\\n" "$(uname -s)" "$(uname -m)" "$B"; exit 0; fi`,
    `exec "$N" -e "eval(atob(process.argv[1]))" ${loader} "$S" ${sha256} ${nonce}`,
  ].join('; ')
  return `sh -c ${shellQuoted(script)}`
}

/** The platform names of Node's builds, from `uname -s` and `uname -m`. */
export function nodePlatform(uname: string): string | null {
  const [system = '', machine = ''] = uname.trim().split('-')
  const os = system === 'Linux' ? 'linux' : system === 'Darwin' ? 'darwin' : null
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null
  return os && arch ? `${os}-${arch}` : null
}

export interface InstallCommand {
  /** From nodePlatform. */
  platform: string
  nonce: string
  /** For tests: where the build is downloaded from. Default: nodejs.org. */
  base?: string
}

/**
 * Puts the official Node.js build in `~/.encode-server/node-v<version>` and points `~/.encode-server/node` at it. It
 * downloads with curl or wget, checks the checksum pinned here, and touches nothing outside that folder. Its last line
 * is `ENCODE-INSTALLED <nonce>` or `ENCODE-FAILED <nonce> <why>`.
 */
export function installCommand({ platform, nonce, base = NODE_RELEASE.base }: InstallCommand): string {
  const sha = NODE_RELEASE.builds[platform]
  if (!sha) throw new Error(`eNCode has no Node.js build for ${platform}.`)
  if (!SAFE_ARG.test(nonce)) throw new Error(`Not a safe argument: ${nonce}`)
  if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(base)) throw new Error(`Not a safe address: ${base}`)
  const name = `node-v${NODE_RELEASE.version}-${platform}`
  const fail = (why: string) => `{ printf "\\nENCODE-FAILED ${nonce} ${why}\\n"; rm -rf "$T"; exit 0; }`
  const script = [
    'umask 077',
    `D="$HOME/.encode-server"; T="$D/.node-download-$$"`,
    `mkdir -p "$T" || ${fail('folder')}`,
    `if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$T/n.tgz" "${base}/${name}.tar.gz" || ${fail('download')}; elif command -v wget >/dev/null 2>&1; then wget -q -O "$T/n.tgz" "${base}/${name}.tar.gz" || ${fail('download')}; else ${fail('no-downloader')}; fi`,
    `if command -v sha256sum >/dev/null 2>&1; then H=$(sha256sum "$T/n.tgz"); else H=$(shasum -a 256 "$T/n.tgz"); fi`,
    `case "$H" in ${sha}*) ;; *) ${fail('checksum')};; esac`,
    `tar -xzf "$T/n.tgz" -C "$T" || ${fail('unpack')}`,
    `rm -rf "$D/${name}"; mv "$T/${name}" "$D/${name}" || ${fail('move')}`,
    // A link to a folder is replaced, not followed: mv onto it would move the new link inside the old folder.
    `rm -f "$D/node"; ln -s "$D/${name}" "$D/node" || ${fail('link')}`,
    'rm -rf "$T"',
    `"$D/node/bin/node" -p process.versions.node >/dev/null 2>&1 || ${fail('run')}`,
    `printf "\\nENCODE-INSTALLED ${nonce}\\n"`,
  ].join('; ')
  return `sh -c ${shellQuoted(script)}`
}
