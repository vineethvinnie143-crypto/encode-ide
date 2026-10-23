/**
 * The words of the language servers' screen and of the editor's footer, from the folder's report. Pure, so they are
 * unit tested.
 */
import type { LanguageServerInfo, LanguageServersReport } from '@shared/types'

export type Tone = 'quiet' | 'busy' | 'success' | 'warning' | 'danger'

/** The server that covers a file, as the host picks it: a whole file name first, then the extension. */
export function serverForPath(report: LanguageServersReport | null, path: string): LanguageServerInfo | null {
  if (!report) return null
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  for (const server of report.servers) {
    if (server.files.some((file) => file.toLowerCase() === name || (extension && file === extension))) return server
  }
  return null
}

/** A server's state in a word or two. */
export function stateLabel(server: LanguageServerInfo): { label: string; tone: Tone } {
  switch (server.state) {
    case 'running':
      return server.working ? { label: 'Checking', tone: 'busy' } : { label: 'Running', tone: 'success' }
    case 'starting':
      return { label: 'Starting', tone: 'busy' }
    case 'stopped':
      return server.detail ? { label: 'Stopped', tone: 'warning' } : { label: 'Ready', tone: 'quiet' }
    case 'missing':
      return { label: 'Not installed', tone: 'quiet' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'off':
      return { label: 'Off', tone: 'quiet' }
  }
}

/** The line at the top of the screen: whether servers run in this folder, and what to do when they do not. */
export function headline(report: LanguageServersReport): { title: string; detail: string; tone: Tone; action?: 'trust' | 'turn-on' } {
  if (report.state === 'off') return { title: 'Language servers are off', detail: 'The editor marks no errors, and the agent edits without hearing what its changes broke.', tone: 'quiet', action: 'turn-on' }
  if (report.state === 'untrusted') {
    return {
      title: 'This folder is not trusted',
      detail: 'A language server can run code the project names (its plugins, its build scripts), so servers start only in folders you trust.',
      tone: 'warning',
      action: 'trust',
    }
  }
  const running = report.servers.filter((server) => server.state === 'running' || server.state === 'starting').length
  const installed = report.servers.filter((server) => server.state !== 'missing').length
  if (running) return { title: `${running} ${running === 1 ? 'server' : 'servers'} running`, detail: 'A server starts when a file of its language is opened, and stops after a while unused.', tone: 'success' }
  if (installed) return { title: 'Ready', detail: 'A server starts when a file of its language is opened, in the editor or by the agent.', tone: 'quiet' }
  return { title: 'No language server is installed', detail: 'Install the ones for the languages you use; eNCode finds them on the PATH or in the project.', tone: 'warning' }
}

/** ".ts .tsx .js and 5 more": what a server covers, short. */
export function filesLabel(server: LanguageServerInfo, shown = 4): string {
  if (server.files.length <= shown) return server.files.join(' ')
  return `${server.files.slice(0, shown).join(' ')} and ${server.files.length - shown} more`
}

/** The servers in the order they matter: what runs, what failed, what is ready, then what is not installed. */
export function sortedServers(report: LanguageServersReport): LanguageServerInfo[] {
  const rank: Record<LanguageServerInfo['state'], number> = { running: 0, starting: 0, failed: 1, stopped: 2, off: 2, missing: 3 }
  return report.servers.map((server, index) => ({ server, index })).sort((a, b) => rank[a.server.state] - rank[b.server.state] || a.index - b.index).map(({ server }) => server)
}

/** What the editor's footer says of the open file's server, or null when no server covers the file. */
export function footerStatus(report: LanguageServersReport | null, path: string | null): { text: string; tone: Tone; title: string } | null {
  if (!report || !path) return null
  const server = serverForPath(report, path)
  if (!server) return null
  const name = server.label
  if (report.state === 'off') return { text: 'Language servers off', tone: 'quiet', title: 'Turn them on in Settings to see errors as you type.' }
  if (report.state === 'untrusted') return { text: `${name}: folder not trusted`, tone: 'warning', title: 'Language servers run only in folders you trust. Open Settings to trust this one.' }
  switch (server.state) {
    case 'running':
      return server.working ? { text: `${name}: checking`, tone: 'busy', title: `${name} is reading the project.` } : { text: name, tone: 'success', title: `${name} checks this file as you type.` }
    case 'starting':
      return { text: `${name}: starting`, tone: 'busy', title: server.command ?? '' }
    case 'missing':
      return { text: `${name}: not installed`, tone: 'warning', title: `Install it to see errors as you type: ${server.install}` }
    case 'failed':
      return { text: `${name}: failed`, tone: 'danger', title: server.detail ?? `${name} failed.` }
    case 'stopped':
    case 'off':
      return { text: name, tone: 'quiet', title: server.detail ?? `${name} starts when it is needed.` }
  }
}

/**
 * Why the servers gave no answer to something the person asked of a file ("go to definition"), as a sentence with
 * what to do about it.
 */
export function noAnswerReason(report: LanguageServersReport | null, path: string, feature: string): string {
  const server = report ? serverForPath(report, path) : null
  if (!report || !server) return `No language server covers ${path.split('/').pop() ?? path}, so ${feature} is not available for it.`
  const name = server.label
  if (report.state === 'off') return `Language servers are off. Turn them on in Settings to use ${feature}.`
  if (report.state === 'untrusted') return `Language servers run only in folders you trust. Trust this folder to use ${feature}.`
  switch (server.state) {
    case 'missing':
      return `${name} is not installed. Install it to use ${feature}: ${server.install}`
    case 'failed':
      return `${name} failed. Settings > Language servers shows what it said.`
    case 'starting':
      return `${name} is still starting. Try again in a moment.`
    case 'running':
      return `${name} does not offer ${feature}.`
    case 'stopped':
    case 'off':
      return `${name} did not answer. Try again.`
  }
}
