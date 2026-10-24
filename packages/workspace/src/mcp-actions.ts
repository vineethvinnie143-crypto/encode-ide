import path from 'node:path'
import { disabledIn, readSettingsDocument, setMcpServerOff, writeSettingsDocument } from '@encode/config'
import { mcpConfigFiles, parseSetup, serverNameProblem } from '@encode/mcp'
import type { WorkspaceConfig } from './config'
import type { WorkspaceFs } from './fs'
import type { McpHub, McpReport } from './mcp'
import { keepLocalSettingsOutOfGit } from './remember'

/** A server as the Add form describes it, in the files' own format. */
export type McpNewServer =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> }

/** What the MCP screen can do to a folder's servers. */
export type McpAction =
  | { type: 'approve'; name: string; /** The digest of the setup the person was shown. */ digest: string }
  | { type: 'forget'; name: string }
  | { type: 'restart'; name: string }
  | { type: 'turn-off'; name: string }
  | { type: 'turn-on'; name: string }
  /** Writes the server into ~/.encode/mcp.json (`user`) or the project's .mcp.json (`project`). */
  | { type: 'add'; name: string; scope: 'user' | 'project'; setup: McpNewServer }
  /** Takes the server out of every file of its scope that lists it. */
  | { type: 'remove'; name: string }

/** The servers as they are after the action, with what happened in words. */
export type McpOutcome =
  | { ok: true; report: McpReport; note?: string }
  | { ok: false; reason: string; report: McpReport }

const TYPES: readonly string[] = ['approve', 'forget', 'restart', 'turn-off', 'turn-on', 'add', 'remove']
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
  if (given.type === 'add') {
    if (given.scope !== 'user' && given.scope !== 'project') return 'Say whether the server is yours or the project’s.'
    const parsed = parseSetup(given.setup)
    if (typeof parsed === 'string') return `The server cannot be used as described: ${parsed}.`
    if (parsed.notes.length) return `The server cannot be used as described: ${parsed.notes[0]}.`
  }
  return null
}

/** The entry as the file holds it: no type for a program, and no empty lists. */
function entryOf(setup: McpNewServer): Record<string, unknown> {
  if (setup.type === 'stdio') return { command: setup.command, ...(setup.args.length ? { args: setup.args } : {}), ...(Object.keys(setup.env).length ? { env: setup.env } : {}) }
  return { type: setup.type, url: setup.url, ...(Object.keys(setup.headers).length ? { headers: setup.headers } : {}) }
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
  const fs = options.fs ?? config.fileSystem
  const files = mcpConfigFiles(config.home, config.root, platform === 'win32' ? path.win32 : path.posix)
  if (action.type === 'add') {
    const taken = snapshot.mcp.servers.find((candidate) => candidate.name === action.name)
    if (taken) return refused(`There is a server called ${action.name} already, in ${taken.file}. Choose another name.`)
    const file = files.find((candidate) => candidate.scope === action.scope)!.file
    const loaded = await readSettingsDocument(fs, file, 'adding a server')
    if (!loaded.ok) return refused(loaded.reason)
    const servers = loaded.document.mcpServers ?? {}
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return refused(`"mcpServers" in ${file} is not an object; fix it before adding a server there.`)
    if (Object.hasOwn(servers, action.name)) return refused(`${file} lists ${action.name} already, in a form eNCode cannot use. Fix or remove that entry first.`)
    const unwritten = await writeSettingsDocument(fs, file, { ...loaded.document, mcpServers: { ...servers, [action.name]: entryOf(action.setup) } })
    if (unwritten) return refused(unwritten)
    const after = await config.refresh()
    hub.sync(after)
    const added = after.mcp.servers.find((candidate) => candidate.name === action.name)
    let note: string | undefined
    if (action.scope === 'project' && added?.scope === 'project') {
      // The person wrote this entry here and now, which is approving it; it still waits for a trusted folder.
      if (after.broken) note = 'It starts once the settings can be read again.'
      else if (!after.folder.trusted) note = 'It waits until you trust this folder.'
      else {
        // The hub may not have taken the new entry in yet, so the approval goes to the trust store and the hub follows it.
        await config.trustStore.approveServer(config.root, action.name, added.digest)
        hub.sync(await config.refresh())
      }
      if (!note) note = 'It is in the project’s .mcp.json, which everyone who uses the project shares.'
    }
    return { ok: true, report: await look(), ...(note ? { note } : {}) }
  }

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
    case 'remove': {
      // A project server can be in both of the project's files; the one in .encode/mcp.json hides the other, so both go.
      for (const { file } of files.filter((candidate) => candidate.scope === entry.scope)) {
        const loaded = await readSettingsDocument(fs, file, 'removing a server')
        if (!loaded.ok) return refused(loaded.reason)
        const servers = loaded.document.mcpServers
        if (typeof servers !== 'object' || servers === null || Array.isArray(servers) || !Object.hasOwn(servers, action.name)) continue
        const { [action.name]: _removed, ...rest } = servers as Record<string, unknown>
        const unwritten = await writeSettingsDocument(fs, file, { ...loaded.document, mcpServers: rest })
        if (unwritten) return refused(unwritten)
      }
      if (entry.scope === 'project') {
        await config.trustStore.revokeServer(config.root, action.name)
        note = 'It is gone from the project’s file, which everyone who uses the project shares.'
      }
      hub.sync(await config.refresh())
      break
    }
    case 'turn-off':
    case 'turn-on': {
      const off = action.type === 'turn-off'
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
