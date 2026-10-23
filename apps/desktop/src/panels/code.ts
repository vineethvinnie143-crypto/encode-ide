/**
 * The words of the language servers' screen and of the editor's footer, from the folder's report. Pure, so they are
 * unit tested.
 */
import type { LanguageLibraryInfo, LanguageServerInfo, LanguageServersReport } from '@shared/types'

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
  if (server.installing) {
    const percent = installPercent(server)
    return { label: percent === null ? 'Installing' : `Installing, ${percent}%`, tone: 'busy' }
  }
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
  return { title: 'No language server is installed', detail: 'Install the ones for the languages this folder uses, with one click below or yourself; eNCode finds them on the PATH or in the project too.', tone: 'warning' }
}

/**
 * The offer the editor makes for the open file: its server is missing, eNCode can install it, servers may run in the
 * folder, and the person has not said "Not now" to it. Null otherwise.
 */
export function installOffer(report: LanguageServersReport | null, path: string | null, declined: readonly string[]): { id: string; label: string; text: string } | null {
  if (!report || !path || report.state !== 'on') return null
  const server = serverForPath(report, path)
  if (!server || server.installing) return null
  if (server.state === 'missing') {
    if (!server.installer || declined.includes(server.id)) return null
    return { id: server.id, label: server.label, text: `No language server for ${server.label} files. Install one for errors as you type, completions and go to definition.` }
  }
  // The server is there: what it reads that the folder wants, such as FiveM's natives in a folder of resources.
  const library = server.libraries?.find((item) => !item.installed && !item.installing && !declined.includes(item.id))
  if (!library) return null
  return { id: library.id, label: library.label, text: `${library.what} are not installed. Install them so hovers, completion and checks know each one.` }
}

/** What an install is for, by id: a server, or a library under its server. */
export function installTarget(
  report: LanguageServersReport | null,
  id: string | null,
): { kind: 'server'; item: LanguageServerInfo } | { kind: 'library'; item: LanguageLibraryInfo; server: LanguageServerInfo } | null {
  if (!report || !id) return null
  for (const server of report.servers) {
    if (server.id === id) return { kind: 'server', item: server }
    const library = server.libraries?.find((item) => item.id === id)
    if (library) return { kind: 'library', item: library, server }
  }
  return null
}

/** "YAML's language server", "FiveM's natives for Lua": what an install is, for a title or a message. */
export function installName(report: LanguageServersReport | null, id: string): string {
  const target = installTarget(report, id)
  if (!target) return id
  return target.kind === 'library' ? target.item.what : `${target.item.label}'s language server`
}

/** "4.2 MB", "860 KB". */
export function sizeLabel(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** An install's progress as a whole percentage, or null while its size is not known. */
export function installPercent(server: { installing?: { done: number; total: number } }): number | null {
  const progress = server.installing
  if (!progress || progress.total <= 0) return null
  return Math.min(100, Math.floor((progress.done / progress.total) * 100))
}

/** ".ts .tsx .js and 5 more": what a server covers, short. */
export function filesLabel(server: LanguageServerInfo, shown = 4): string {
  if (server.files.length <= shown) return server.files.join(' ')
  return `${server.files.slice(0, shown).join(' ')} and ${server.files.length - shown} more`
}

/**
 * The servers in the order they matter: what runs, what failed, what is ready or installing or missing for files the
 * folder has, then the rest that is not installed. Within each, the host's order (the most files first).
 */
export function sortedServers(report: LanguageServersReport): LanguageServerInfo[] {
  const rank: Record<LanguageServerInfo['state'], number> = { running: 0, starting: 0, failed: 1, stopped: 2, off: 2, missing: 3 }
  const of = (server: LanguageServerInfo) => (server.installing || (server.state === 'missing' && (server.used?.files ?? 0) > 0) ? 2 : rank[server.state])
  return report.servers.map((server, index) => ({ server, index })).sort((a, b) => of(a.server) - of(b.server) || a.index - b.index).map(({ server }) => server)
}

/**
 * What the editor's footer says of the open file's server, or null when no server covers the file. `tooLarge`: the
 * file is larger than the servers are given.
 */
export function footerStatus(report: LanguageServersReport | null, path: string | null, tooLarge = false): { text: string; tone: Tone; title: string } | null {
  if (!report || !path) return null
  const server = serverForPath(report, path)
  if (!server) return null
  const name = server.label
  if (report.state === 'off') return { text: 'Language servers off', tone: 'quiet', title: 'Turn them on in Settings to see errors as you type.' }
  if (report.state === 'untrusted') return { text: `${name}: folder not trusted`, tone: 'warning', title: 'Language servers run only in folders you trust. Open Settings to trust this one.' }
  if (tooLarge) return { text: `${name}: file too large`, tone: 'quiet', title: `Files over 8 MB are not given to language servers, so ${name} does not check this one. Editing, colours and search still work.` }
  switch (server.state) {
    case 'running':
      return server.working ? { text: `${name}: checking`, tone: 'busy', title: `${name} is reading the project.` } : { text: name, tone: 'success', title: `${name} checks this file as you type.` }
    case 'starting':
      return { text: `${name}: starting`, tone: 'busy', title: server.command ?? '' }
    case 'missing':
      if (server.installing) return { text: `${name}: installing`, tone: 'busy', title: `eNCode is installing ${name}'s server.` }
      return { text: `${name}: not installed`, tone: 'warning', title: server.installer ? 'Click to install it, to see errors as you type.' : `Install it to see errors as you type: ${server.install}` }
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
export function noAnswerReason(report: LanguageServersReport | null, path: string, feature: string, tooLarge = false): string {
  const server = report ? serverForPath(report, path) : null
  if (!report || !server) return `No language server covers ${path.split('/').pop() ?? path}, so ${feature} is not available for it.`
  const name = server.label
  if (report.state === 'off') return `Language servers are off. Turn them on in Settings to use ${feature}.`
  if (report.state === 'untrusted') return `Language servers run only in folders you trust. Trust this folder to use ${feature}.`
  if (tooLarge) return `${path.split('/').pop() ?? path} is over 8 MB, more than language servers are given, so ${feature} is not available for it.`
  switch (server.state) {
    case 'missing':
      return server.installer ? `${name} is not installed. Install it from Settings > Language servers to use ${feature}.` : `${name} is not installed. Install it to use ${feature}: ${server.install}`
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
