import path from 'node:path'
import { disabledIn, setMcpServerOff } from '@encode/config'
import { serverNameProblem } from '@encode/mcp'
import type { WorkspaceConfig } from './config'
import type { WorkspaceFs } from './fs'
import type { McpHub, McpReport } from './mcp'
import { keepLocalSettingsOutOfGit } from './remember'

/** What the MCP screen can do to a folder's servers. Adding and removing a server is done in the files. */
export type McpAction =
  | { type: 'approve'; name: string; /** The digest of the setup the person was shown. */ digest: string }
  | { type: 'forget'; name: string }
  | { type: 'restart'; name: string }
  | { type: 'turn-off'; name: string }
  | { type: 'turn-on'; name: string }

/** The servers as they are after the action, with what happened in words. */
export type McpOutcome =
  | { ok: true; report: McpReport; note?: string }
  | { ok: false; reason: string; report: McpReport }

const TYPES: readonly string[] = ['approve', 'forget', 'restart', 'turn-off', 'turn-on']
const DIGEST = /^[0-9a-f]{64}$/

/** Checks an action that came from a screen; the types are not trusted. Returns the reason it is refused, or null. */
export function mcpActionProblem(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'That is not an action.'
  const given = action as Record<string, unknown>
  if (typeof given.type !== 'string' || !TYPES.includes(given.type)) return 'That is not an action.'
  if (typeof given.name !== 'string') return 'Name the server.'
  const bad = serverNameProblem(given.name)
  if (bad) return `${JSON.stringify(given.name.slice(0, 48))} is not a server name: ${bad}.`
  if (given.type === 'approve' && (typeof given.digest !== 'string' || !DIGEST.test(given.digest))) return 'Approve the setup that was shown.'
  return null
}

const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Does what the screen asked and says how it went. The folder's files are read over afterwards, so the report is current. */
export async function actOnMcp(
  config: WorkspaceConfig,
  hub: McpHub,
  action: McpAction,
  options: { fs?: WorkspaceFs; platform?: NodeJS.Platform } = {},
): Promise<McpOutcome> {
  const platform = options.platform ?? process.platform
  const look = async () => hub.report(await config.refresh())
  const refused = async (reason: string): Promise<McpOutcome> => ({ ok: false, reason, report: await look() })
  const problem = mcpActionProblem(action)
  if (problem) return refused(problem)

  const snapshot = await config.refresh()
  hub.sync(snapshot)
  const entry = snapshot.mcp.servers.find((candidate) => candidate.name === action.name)
  if (!entry) return refused(`There is no MCP server called ${action.name} in this folder's files.`)
  // A server is only started, approved or restarted under settings that can be trusted.
  if (snapshot.broken && (action.type === 'approve' || action.type === 'restart')) return refused(snapshot.broken)

  let note: string | undefined
  switch (action.type) {
    case 'approve':
      try {
        await hub.approve(action.name, action.digest)
      } catch (error) {
        return refused(why(error))
      }
      break
    case 'forget': {
      if (entry.scope !== 'project') return refused(`${action.name} is your own server, so there is no approval to take back. Turn it off instead.`)
      await config.trustStore.revokeServer(config.root, action.name)
      const after = await config.refresh()
      hub.sync(after)
      const { policy } = after.mcp
      if (policy.enableAll || policy.enabled.includes(action.name)) note = "The project's settings still let it run (enableAllProjectMcpServers or enabledMcpjsonServers)."
      break
    }
    case 'restart':
      try {
        await hub.restart(action.name)
      } catch (error) {
        return refused(why(error))
      }
      break
    case 'turn-off':
    case 'turn-on': {
      const off = action.type === 'turn-off'
      const fs = options.fs ?? config.fileSystem
      // A project's server is turned off in the person's own local settings, so that the project's file stays as it is.
      const scope = entry.scope === 'user' ? 'user' : 'local'
      const result = await setMcpServerOff({ name: action.name, off, scope, home: config.home, root: config.root, fs, platform })
      if (!result.ok) return refused(result.reason)
      // Best effort: failing to tidy a git file must not lose the choice that was just saved.
      if (scope === 'local' && result.changed) await keepLocalSettingsOutOfGit(config.root, fs, platform === 'win32' ? path.win32 : path.posix).catch(() => undefined)
      const after = await config.refresh()
      hub.sync(after)
      const elsewhere = off ? [] : disabledIn(after.sources, action.name)
      if (elsewhere.length) note = `It is still turned off in ${elsewhere.join(' and ')}. Take it off that list to turn it on.`
      else if (!result.changed) note = off ? 'It was already turned off.' : 'It was not turned off.'
      break
    }
  }
  return { ok: true, report: await look(), ...(note ? { note } : {}) }
}
