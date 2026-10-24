/**
 * A folder on another machine, as eNCode names it (ADR 0111): `ssh://[user@]host[:port]/absolute/path`. The host is a
 * name from the person's `~/.ssh/config`, a DNS name or an address; `ssh` reads its own configuration for everything
 * else (keys, proxies, the user and port when they are left out).
 *
 * What the person types reaches the `ssh` command line, so it is held to a narrow shape: a host that starts with `-`
 * would be read as an option (`-oProxyCommand=...` runs a program), and a space or a control character would split the
 * argument. The path is the other machine's, absolute, or under its home (`~/project`).
 */

import { REMOTE_SCHEME, isRemoteRoot } from '../../shared/remote'

export interface SshTarget {
  /** The name `ssh` is given: a config alias, a DNS name or an address (an IPv6 one without brackets). */
  host: string
  user?: string
  port?: number
}

export interface RemoteFolder extends SshTarget {
  /** The folder on that machine: absolute, or starting with `~/` for its home. */
  path: string
}

const HOST = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,252}[A-Za-z0-9_])?|\[[0-9A-Fa-f:.%a-zA-Z]{2,60}\])$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/

export { REMOTE_SCHEME, isRemoteRoot } from '../../shared/remote'

/** Reads what the person typed in the Host box: `host`, `user@host`, `user@host:2222` or `[::1]:2222`. */
export function parseTarget(text: string): SshTarget | { error: string } {
  const value = text.trim()
  if (!value) return { error: 'Type the machine: a name from your SSH config, or user@address.' }
  if (CONTROL.test(value) || /\s/.test(value)) return { error: 'A machine name has no spaces.' }
  if (value.startsWith('-')) return { error: 'A machine name cannot start with "-".' }
  let rest = value
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (!USER.test(user)) return { error: `"${user}" is not a user name SSH takes.` }
  }
  let port: number | undefined
  const bracket = rest.match(/^(\[[^\]]+\])(?::(\d+))?$/)
  let host = rest
  if (bracket) {
    host = bracket[1]!
    if (bracket[2]) port = Number(bracket[2])
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon !== -1 && rest.indexOf(':') === colon) {
      host = rest.slice(0, colon)
      const digits = rest.slice(colon + 1)
      if (!/^\d+$/.test(digits)) return { error: 'The port after ":" is a number.' }
      port = Number(digits)
    }
  }
  if (port !== undefined && (port < 1 || port > 65535)) return { error: 'A port is a number from 1 to 65535.' }
  if (!HOST.test(host)) return { error: `"${host}" is not a machine name SSH takes.` }
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  return { host: bare, ...(user ? { user } : {}), ...(port ? { port } : {}) }
}

/** Reads the Folder box: an absolute path on the other machine, or one under its home. */
export function parseRemotePath(text: string): string | { error: string } {
  const value = text.trim()
  if (!value) return { error: 'Type the folder on that machine, such as /home/you/project or ~/project.' }
  if (CONTROL.test(value)) return { error: 'A folder path has no control characters.' }
  if (value.length > 4096) return { error: 'That folder path is too long.' }
  if (value !== '~' && !value.startsWith('/') && !value.startsWith('~/')) return { error: 'Type the whole path: it starts with / or ~/.' }
  const parts = value.split('/')
  if (parts.some((part) => part === '..')) return { error: 'Type the path without "..".' }
  const joined = parts.filter((part, index) => part !== '' || index === 0).join('/')
  return joined === '' ? '/' : joined
}

/** What the person sees for a machine: `user@host:port`, as they would type it. */
export function targetLabel(target: SshTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  return `${target.user ? `${target.user}@` : ''}${host}${target.port ? `:${target.port}` : ''}`
}

/** The folder's name in eNCode: `ssh://user@host:port/path`. A path under the home keeps its `~`. */
export function remoteRoot(folder: RemoteFolder): string {
  const path = folder.path.startsWith('/') ? folder.path : `/${folder.path}`
  return `${REMOTE_SCHEME}${targetLabel(folder)}${path}`
}

/** The other way. Null for anything that is not a remote folder written by remoteRoot. */
export function parseRemoteRoot(root: string): RemoteFolder | null {
  if (!isRemoteRoot(root)) return null
  const rest = root.slice(REMOTE_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const target = parseTarget(rest.slice(0, slash))
  if ('error' in target) return null
  let path = rest.slice(slash)
  if (path.startsWith('/~')) path = path.slice(1)
  const parsed = parseRemotePath(path)
  if (typeof parsed !== 'string') return null
  return { ...target, path: parsed }
}

/** The SSH options eNCode always sets, before any the person's config adds. */
export const SSH_OPTIONS: readonly string[] = [
  // No terminal, no escape character, no agent or X11 forwarding: the connection carries eNCode's messages only.
  '-T',
  '-e',
  'none',
  '-a',
  '-x',
  '-o',
  'ClearAllForwardings=yes',
  // eNCode cannot answer a password prompt yet: SSH signs in with a key (or the agent), or fails at once.
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=20',
  // A connection that went quiet is noticed within a minute.
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
]

/** The `ssh` arguments for a command on the machine. The destination comes after `--`, so it is never read as an option. */
export function sshArgs(target: SshTarget, command: string): string[] {
  return [...SSH_OPTIONS, ...(target.user ? ['-l', target.user] : []), ...(target.port ? ['-p', String(target.port)] : []), '--', target.host, command]
}

/** The host names of a `~/.ssh/config`, for the Host box's suggestions: no patterns, no negations. */
export function configHosts(text: string): string[] {
  const hosts = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    // `Host` itself, not HostName or HostKeyAlias.
    const match = line.match(/^host(?:\s*=\s*|\s+)(.+)$/i)
    if (!match) continue
    for (const name of match[1]!.split(/\s+/)) {
      if (!name || /[*?!]/.test(name)) continue
      const parsed = parseTarget(name)
      if (!('error' in parsed) && !parsed.user && !parsed.port) hosts.add(parsed.host)
    }
  }
  return [...hosts].slice(0, 200)
}
