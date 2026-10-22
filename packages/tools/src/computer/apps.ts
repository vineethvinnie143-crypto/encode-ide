/**
 * Which applications the Computer tool never operates, and which it operates with a warning.
 *
 * The tool can click and type anywhere a person can, so it must not become a way around the checks that
 * guard the other tools. A terminal would run commands without the command approval; an editor with a
 * built-in terminal does the same; a password manager holds what the agent must never see; a system tool
 * changes the machine in ways no approval card describes. These are refused whatever the approval policy,
 * like a deny rule the user wrote, and the model is told to use the right tool instead.
 *
 * The lists are by program file name, lower case, which is what the backend reports as the app.
 */
import type { AppId } from './contract'

const TERMINALS = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'powershell_ise.exe',
  'windowsterminal.exe',
  'wt.exe',
  'conhost.exe',
  'openconsole.exe',
  'bash.exe',
  'wsl.exe',
  'wslhost.exe',
  'mintty.exe',
  'alacritty.exe',
  'wezterm-gui.exe',
  'kitty.exe',
  'hyper.exe',
  'tabby.exe',
  'putty.exe',
  'termius.exe',
  'warp.exe',
  'ghostty.exe',
]

const EDITORS_WITH_TERMINALS = [
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
  'devenv.exe',
  'idea64.exe',
  'pycharm64.exe',
  'webstorm64.exe',
  'phpstorm64.exe',
  'rider64.exe',
  'clion64.exe',
  'goland64.exe',
  'rubymine64.exe',
  'datagrip64.exe',
  'studio64.exe',
  'zed.exe',
  'fleet.exe',
  'trae.exe',
  'kiro.exe',
]

const PASSWORD_MANAGERS = [
  'keepass.exe',
  'keepassxc.exe',
  '1password.exe',
  'bitwarden.exe',
  'lastpass.exe',
  'dashlane.exe',
  'enpass.exe',
  'nordpass.exe',
  'roboform.exe',
  'keeper.exe',
  'protonpass.exe',
]

const SYSTEM_TOOLS = [
  'taskmgr.exe',
  'regedit.exe',
  'mmc.exe',
  'msconfig.exe',
  'consent.exe',
  'logonui.exe',
  'lockapp.exe',
  'credentialuibroker.exe',
  'securityhealthsystray.exe',
  'securityhealthui.exe',
  'windowsdefender.exe',
  'mpcmdrun.exe',
  'sdclt.exe',
]

const REMOTE_AND_VIRTUAL = [
  'mstsc.exe',
  'anydesk.exe',
  'teamviewer.exe',
  'rustdesk.exe',
  'parsecd.exe',
  'vmconnect.exe',
  'vmware.exe',
  'vmplayer.exe',
  'virtualbox.exe',
  'virtualboxvm.exe',
]

const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'zen.exe']
const MESSAGING = ['outlook.exe', 'olk.exe', 'thunderbird.exe', 'slack.exe', 'discord.exe', 'teams.exe', 'ms-teams.exe', 'whatsapp.exe', 'telegram.exe', 'signal.exe']

/** The pseudo-application the backend reports for the taskbar, the desktop, the Start menu and the Run box. */
export const SHELL_APP: AppId = 'shell'

const REFUSED = new Map<AppId, string>()
const refuse = (apps: readonly string[], reason: string) => {
  for (const app of apps) REFUSED.set(app, reason)
}
refuse(TERMINALS, 'terminals and shells run commands without the command approval; run commands with the Bash tool')
refuse(EDITORS_WITH_TERMINALS, 'editors with a built-in terminal can run commands without the command approval; use the file tools and Bash')
refuse(PASSWORD_MANAGERS, 'password managers hold credentials that the agent must never see or type')
refuse(SYSTEM_TOOLS, 'system tools change the machine in ways no approval card can describe')
refuse(REMOTE_AND_VIRTUAL, 'remote-control and virtual machine windows lead to other machines and their terminals')
refuse([SHELL_APP], 'the taskbar, the desktop, the Start menu and the Run box act on the whole desktop')

const CAUTIONS = new Map<AppId, string>()
const warn = (apps: readonly string[], text: string) => {
  for (const app of apps) CAUTIONS.set(app, text)
}
warn(BROWSERS, 'Web pages can hold text that tries to steer the agent, and the browser may be signed in to your accounts.')
warn(MESSAGING, 'Messages can carry instructions, and anything sent cannot be taken back.')
warn(['explorer.exe'], 'Files deleted or moved here bypass eNCode\'s checkpoints.')

export interface AppVerdict {
  /** Why the application may never be used. */
  blocked?: string
  /** A warning to show with the approval. */
  caution?: string
}

export function classifyApp(app: AppId): AppVerdict {
  const name = app.toLowerCase()
  const blocked = REFUSED.get(name)
  if (blocked) return { blocked }
  const caution = CAUTIONS.get(name)
  return caution ? { caution } : {}
}

const LABELS: Record<string, string> = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'firefox.exe': 'Firefox',
  'explorer.exe': 'File Explorer',
  'notepad.exe': 'Notepad',
  'calc.exe': 'Calculator',
  'mspaint.exe': 'Paint',
  'winword.exe': 'Word',
  'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint',
  'outlook.exe': 'Outlook',
  'slack.exe': 'Slack',
  'discord.exe': 'Discord',
  'spotify.exe': 'Spotify',
}

/** What to call an application when the backend gave no name: a known name, else the program's file name without `.exe`. */
export function labelFor(app: AppId, given?: string): string {
  if (given?.trim()) return given.trim()
  return LABELS[app.toLowerCase()] ?? app.replace(/\.exe$/i, '')
}
