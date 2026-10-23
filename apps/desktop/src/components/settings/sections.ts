/**
 * The Settings page's sections and the settings in them that the page's search finds by name. One list, read by the
 * page's navigation, its search and the command palette. Pure, so the search is unit tested.
 */
import type { SettingsSection } from '../../stores/ui'

export interface SectionInfo {
  id: SettingsSection
  title: string
  /** One line under the section's heading. */
  description: string
  /** More words people look for it by. */
  keywords: string
  /** Sections are listed in clusters with a line between; a section that starts one says so. */
  startsCluster?: boolean
}

export const SECTIONS: readonly SectionInfo[] = [
  { id: 'general', title: 'General', description: 'How messages are sent, sleep while the agent works, and where chats keep their files.', keywords: 'enter send multiline steer queue follow-up sleep awake chats folder standalone' },
  { id: 'notifications', title: 'Notifications', description: 'When eNCode tells you a request finished or the agent needs you.', keywords: 'notice notification alert toast taskbar flash done finished approval' },
  { id: 'appearance', title: 'Appearance', description: 'Theme, accent, fonts and sizes.', keywords: 'theme dark light font size accent density motion contrast' },
  { id: 'shortcuts', title: 'Keyboard shortcuts', description: 'Every shortcut. Click one and press the new keys to change it.', keywords: 'keys keybindings hotkeys rebind chord' },
  { id: 'models', title: 'Models', description: 'The providers eNCode talks to, their keys and the model each one uses.', keywords: 'providers api keys openrouter free connect base url profile', startsCluster: true },
  { id: 'roles', title: 'Roles', description: 'Which models do each job, in order, and how hard they think.', keywords: 'builder reviewer explore plan compaction small tasks model per role effort free only' },
  { id: 'agent', title: 'Agent', description: 'What the agent may do without asking, the computer, web search and limits.', keywords: 'approval policy computer use gui steps limits search web', startsCluster: true },
  { id: 'permissions', title: 'Permissions', description: 'The rules for this folder and every folder, and which folders are trusted.', keywords: 'rules trust protected folders allow deny ask' },
  { id: 'mcp', title: 'MCP servers', description: 'The tools outside servers give the agent.', keywords: 'mcp tools servers integrations' },
  { id: 'sandbox', title: 'Sandbox', description: 'What the agent’s commands can reach on this computer.', keywords: 'isolation commands network write read' },
  { id: 'code', title: 'Language servers', description: 'The servers that find errors, definitions and references, for the editor and the agent.', keywords: 'lsp language server errors diagnostics squiggles intellisense definition references rename typescript python rust go clangd lua' },
  { id: 'archived', title: 'Archived sessions', description: 'Sessions you put away. Restore one to see it in the sidebar again.', keywords: 'archive restore unarchive deleted old sessions history', startsCluster: true },
]

export interface SettingInfo {
  /** The row it scrolls to: `data-setting` on the row. */
  id: string
  section: SettingsSection
  label: string
  keywords?: string
}

/** The settings the search lists by name; a section's own words find the section. */
export const SETTINGS: readonly SettingInfo[] = [
  { id: 'general.send', section: 'general', label: 'Send messages with', keywords: 'enter ctrl new line multiline' },
  { id: 'general.followUp', section: 'general', label: 'While the agent works', keywords: 'queue steer follow-up enter' },
  { id: 'general.keepAwake', section: 'general', label: 'Keep the computer awake while the agent works', keywords: 'sleep power suspend' },
  { id: 'general.chats', section: 'general', label: 'Folder for chats', keywords: 'standalone sessions without a project documents' },
  { id: 'notifications.done', section: 'notifications', label: 'When a request finishes', keywords: 'done notice toast' },
  { id: 'notifications.needs', section: 'notifications', label: 'When the agent needs you', keywords: 'approval question plan waiting' },
  { id: 'notifications.flash', section: 'notifications', label: 'Flash the taskbar button', keywords: 'attention blink' },
  { id: 'notifications.test', section: 'notifications', label: 'Show a test notice', keywords: 'try check windows' },
  { id: 'appearance.theme', section: 'appearance', label: 'Theme', keywords: 'dark light system mode' },
  { id: 'appearance.accent', section: 'appearance', label: 'Accent', keywords: 'colour color blue cyan jade amber' },
  { id: 'appearance.contrast', section: 'appearance', label: 'Contrast', keywords: 'high accessibility' },
  { id: 'appearance.density', section: 'appearance', label: 'Density', keywords: 'compact comfortable spacing' },
  { id: 'appearance.motion', section: 'appearance', label: 'Reduce motion', keywords: 'animation' },
  { id: 'appearance.uiFont', section: 'appearance', label: 'Interface font', keywords: 'typeface text inter segoe' },
  { id: 'appearance.uiSize', section: 'appearance', label: 'Interface size', keywords: 'text font size zoom' },
  { id: 'appearance.codeFont', section: 'appearance', label: 'Code font', keywords: 'monospace jetbrains consolas' },
  { id: 'appearance.codeSize', section: 'appearance', label: 'Code size', keywords: 'font size' },
  { id: 'shortcuts.list', section: 'shortcuts', label: 'Change a shortcut', keywords: 'keys rebind reset' },
  { id: 'models.profiles', section: 'models', label: 'Model connections', keywords: 'api key base url provider' },
  { id: 'models.add', section: 'models', label: 'Add a provider', keywords: 'openrouter deepseek anthropic openai custom local ollama' },
  { id: 'roles.free', section: 'roles', label: 'Only use free models', keywords: 'free pool billed paid cost' },
  { id: 'roles.list', section: 'roles', label: 'Models for each role', keywords: 'main explore plan review compaction small tasks effort' },
  { id: 'agent.policy', section: 'agent', label: 'Approvals', keywords: 'what eNCode may do without asking read only full access auto review policy' },
  { id: 'agent.computer', section: 'agent', label: 'Let the agent use this computer', keywords: 'computer use gui mouse keyboard' },
  { id: 'agent.search', section: 'agent', label: 'Web search', keywords: 'brave tavily duckduckgo search key' },
  { id: 'agent.limits', section: 'agent', label: 'Max agent steps', keywords: 'limits steps rounds' },
  { id: 'permissions.rules', section: 'permissions', label: 'Permission rules', keywords: 'allow deny ask protected trust' },
  { id: 'mcp.servers', section: 'mcp', label: 'MCP servers', keywords: 'tools servers' },
  { id: 'sandbox.settings', section: 'sandbox', label: 'Sandbox for commands', keywords: 'isolation network' },
  { id: 'code.enabled', section: 'code', label: 'Use language servers', keywords: 'lsp errors editor marks' },
  { id: 'code.errorGate', section: 'code', label: 'Send the agent back to fix errors', keywords: 'error gate finish diagnostics' },
  { id: 'code.servers', section: 'code', label: 'Language servers in this folder', keywords: 'install missing typescript pyright rust-analyzer gopls clangd' },
  { id: 'archived.list', section: 'archived', label: 'Archived sessions', keywords: 'restore delete' },
]

export const sectionInfo = (id: SettingsSection): SectionInfo => SECTIONS.find((section) => section.id === id) ?? SECTIONS[0]

export interface SearchHit {
  section: SectionInfo
  /** The settings in it that match; empty when only the section's own words did. */
  settings: SettingInfo[]
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter(Boolean)

/** Every word typed starts a word of the text: "keep aw" finds "Keep the computer awake". */
function matches(query: readonly string[], text: string): boolean {
  const haystack = words(text)
  return query.every((needle) => haystack.some((word) => word.startsWith(needle)))
}

/** The sections and settings whose names or words hold every word typed, in the page's order. */
export function searchSettings(query: string): SearchHit[] {
  const needles = words(query)
  if (!needles.length) return SECTIONS.map((section) => ({ section, settings: [] }))
  const hits: SearchHit[] = []
  for (const section of SECTIONS) {
    const settings = SETTINGS.filter((setting) => setting.section === section.id && matches(needles, `${setting.label} ${setting.keywords ?? ''}`))
    if (settings.length || matches(needles, `${section.title} ${section.keywords}`)) hits.push({ section, settings })
  }
  return hits
}
