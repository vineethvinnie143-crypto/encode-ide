import type { AboutInfo, Settings } from '../../shared/types'
import { buildLine } from '../../shared/about'
import { MODEL_ROLES, freeProfile, labelOfRef, mainRefs } from '../../shared/models'
import { searchProviderInfo } from '../../shared/search'
import { redact, type RedactContext } from './redact'

export interface DisplayInfo {
  width: number
  height: number
  /** 1 for 100%, 1.25 for 125%. */
  scale: number
  primary: boolean
}

export interface DiagnosticsInput {
  about: AboutInfo
  generatedAt: number
  system: {
    totalMemory: number
    freeMemory: number
    cpuCount: number
    cpuModel: string
    locale: string
    displays: DisplayInfo[]
  }
  /** As the interface sees them: a key is only a "stored or not". */
  settings: Settings
  agentHost: { running: boolean; failures: number; working: number } | null
  /** Counts only; what the conversations say never goes into a report. */
  sessions: { total: number; archived: number } | null
  workspaceOpen: boolean
  /** The names (never the values) of the ENCODE_* variables the process was started with. */
  environment: string[]
  /** The end of the log files, newest last. */
  logLines: string[]
  logDir: string
  redact: RedactContext
}

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([name]) => name.length))
  return rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`)
}

/**
 * The text a tester sends when something goes wrong. It says what build this is, what it runs on, how it is
 * set up and what it logged recently. It has no key, no file or conversation text, and none of the folders the
 * settings remember; a log line may still name a path. The whole text goes through `redact` once more at the end,
 * whatever was put in.
 */
export function diagnosticsReport(input: DiagnosticsInput): string {
  const { about, settings, system, agentHost, sessions } = input
  const out: string[] = []
  const section = (title: string, rows: [string, string][]) => out.push('', title, ...table(rows))

  out.push('eNCode diagnostics', '==================', buildLine(about), `Report made ${new Date(input.generatedAt).toISOString()}`)
  out.push(
    '',
    'This report has no API keys, no file contents and no conversation text. Your user folder is shown as ~.',
    'A log line can still name a file or folder when something went wrong with it. It is plain text: read it before you send it.',
  )

  section('Build', [
    ['Version', `${about.version} (${about.channel})`],
    ['Commit', about.commit ? `${about.commit}${about.dirty ? ' + local changes' : ''}` : 'not recorded'],
    ['Built', about.builtAt || 'not recorded'],
    ['Installed as a program', about.packaged ? 'yes' : 'no, run from the sources'],
  ])

  section('System', [
    ['Operating system', `${about.os} ${about.arch}`],
    ['Electron', `${about.electron}, Chromium ${about.chrome}, Node ${about.node}`],
    ['Memory', `${gigabytes(system.totalMemory)} in all, ${gigabytes(system.freeMemory)} free`],
    ['Processor', `${system.cpuCount} x ${system.cpuModel}`],
    ['Language', system.locale],
    ...system.displays.map((display, index): [string, string] => [
      index === 0 ? 'Displays' : '',
      `${display.width}x${display.height} at ${Math.round(display.scale * 100)}%${display.primary ? ' (main)' : ''}`,
    ]),
    ...(input.environment.length ? ([['Variables set', input.environment.join(', ')]] as [string, string][]) : []),
  ])

  const keys = settings.keyStorage.mode === 'keychain' ? 'sealed by the operating system' : `kept in memory only (${settings.keyStorage.reason})`
  const search = searchProviderInfo(settings.searchProvider)
  section('Settings', [
    ['What the agent may do', settings.policy],
    ['Agent mode', settings.agentMode],
    ['Limits', `${settings.maxSteps} steps a turn, ${settings.maxGoalRounds} rounds for a goal`],
    ['Web search', `${search.name}${search.needsKey ? (settings.searchKeys.includes(search.id) ? ', key stored' : ', NO KEY') : ', needs no key'}`],
    ['Appearance', JSON.stringify(settings.appearance)],
    ['API keys', keys],
    ['Folders', `${settings.recentWorkspaces.length} remembered, ${input.workspaceOpen ? 'one open' : 'none open'}`],
  ])
  out.push('', 'Models')
  for (const profile of settings.profiles) {
    const active = profile.id === settings.activeProfileId ? '*' : ' '
    const server = profile.baseUrl ? ` ${profile.baseUrl}` : ''
    const key = profile.kind === 'demo' ? 'needs no key' : profile.hasApiKey ? 'key stored' : 'NO KEY'
    out.push(`  ${active} ${profile.name} [${profile.kind}]${server}, model ${profile.model || 'not chosen'}, ${key}`)
  }
  const free = freeProfile(settings)
  const roles = MODEL_ROLES.map((role): [string, string[]] => [role, role === 'main' ? mainRefs(settings) : (settings.roles[role] ?? [])]).filter(([, refs]) => refs.length)
  out.push(
    `  Only free models: ${settings.freeOnly ? 'on' : 'off'}; the free models come from ${free ? free.name : 'no connection'}`,
    ...(roles.length ? roles.map(([role, refs]) => `  ${role}: ${refs.map((ref) => labelOfRef(settings, ref)).join(', then ')}`) : ['  No model chosen for any role']),
  )

  section('Agent', [
    ['Process', agentHost ? `${agentHost.running ? 'running' : 'not running'}, ${agentHost.failures} stops in a row, ${agentHost.working} sessions working` : 'unknown'],
    ['Sessions', sessions ? `${sessions.total} (${sessions.archived} archived)` : 'unknown'],
  ])

  out.push('', `Log: the last ${input.logLines.length} lines from ${input.logDir}`, '')
  out.push(...input.logLines.map((line) => `  ${line}`))
  return `${redact(out.join('\n'), input.redact)}\n`
}

/** `eNCode-diagnostics-20261022-0630.txt`, in the user's own clock. */
export function diagnosticsFileName(at: number): string {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, '0')
  return `eNCode-diagnostics-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}.txt`
}
