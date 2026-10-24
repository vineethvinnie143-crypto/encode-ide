/**
 * How eNCode names a folder on another machine (ADR 0111): `ssh://[user@]host[:port]/absolute/path`, with a folder
 * under that machine's home written `/~/...`. The window keeps such names in its recent folders and splits them for
 * the Open dialog; the main process checks them again (electron/remote/target.ts) before anything reaches ssh.
 */

export const REMOTE_SCHEME = 'ssh://'

/** True for a folder named the way this file names one. */
export function isRemoteRoot(root: string | null | undefined): root is string {
  return typeof root === 'string' && root.startsWith(REMOTE_SCHEME)
}

/** The machine (`user@host:port`) and the folder there (`/abs/path` or `~/path`) of such a name, or null. */
export function remoteParts(root: string): { machine: string; folder: string } | null {
  if (!isRemoteRoot(root)) return null
  const rest = root.slice(REMOTE_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const path = rest.slice(slash)
  return { machine: rest.slice(0, slash), folder: path.startsWith('/~') ? path.slice(1) : path }
}

/** The machine's host, for a short label: `vm` of `ssh://me@vm:2222/...`. */
export function remoteHost(machine: string): string {
  const host = machine.includes('@') ? machine.slice(machine.lastIndexOf('@') + 1) : machine
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
}
