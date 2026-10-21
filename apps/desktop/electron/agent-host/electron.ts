/**
 * Starts the agent host as an Electron utility process. This is the only
 * module of the host's plumbing that imports Electron.
 */
import { utilityProcess } from 'electron'
import { childAsPort } from './ports'
import type { HostProcess } from './service'

export function spawnAgentHost(entry: string, log: (line: string) => void): HostProcess {
  const child = utilityProcess.fork(entry, [], { serviceName: 'eNCode agent', stdio: 'pipe' })
  const forward = (chunk: Buffer | string) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line)
  }
  child.stdout?.on('data', forward)
  child.stderr?.on('data', forward)
  return {
    port: childAsPort(child),
    kill: () => {
      child.kill()
    },
    onExit: (handler) => {
      child.once('exit', () => handler())
    },
  }
}
