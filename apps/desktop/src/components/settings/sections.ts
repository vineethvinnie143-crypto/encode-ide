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
  {
    id: 'personalization',
    title: 'Personalization',
    description: 'What the agent should know about you and how you work, in every project.',
    keywords: 'instructions custom prompt system encode.md agents.md claude.md memory preferences about me style rules',
  },
  { id: 'notifications', title: 'Notifications', description: 'When eNCode tells you a request finished or the agent needs you.', keywords: 'notice notification alert toast taskbar flash done finished approval' },
  { id: 'appearance', title: 'Appearance', description: 'Theme, accent, fonts and sizes.', keywords: 'theme dark light font size accent density motion contrast' },
  {
    id: 'editor',
    title: 'Editor',
    description: 'How code shows: long lines, spaces and tabs, and the parts around the text.',
    keywords: 'code text word wrap whitespace minimap sticky scroll folding brackets breadcrumbs inlay hints semantic',
  },
  { id: 'shortcuts', title: 'Keyboard shortcuts', description: 'Every shortcut. Click one and press the new keys to change it.', keywords: 'keys keybindings hotkeys rebind chord' },
  { id: 'models', title: 'Models', description: 'The providers eNCode talks to, their keys and the model each one uses.', keywords: 'providers api keys openrouter free connect base url profile', startsCluster: true },
  { id: 'roles', title: 'Roles', description: 'Which models do each job, in order, and how hard they think.', keywords: 'builder reviewer explore plan compaction small tasks model per role effort free only' },
  { id: 'usage', title: 'Usage', description: 'What your requests used, by day, model and project, counted on this computer.', keywords: 'cost spend money dollars tokens bill billing credits calls statistics stats' },
  { id: 'agent', title: 'Agent', description: 'What the agent may do without asking, web search, checks and limits.', keywords: 'approval policy steps limits search web context window compaction', startsCluster: true },
  { id: 'computer', title: 'Computer use', description: 'Let the agent see and use other applications, and how to stop it.', keywords: 'computer use gui mouse keyboard screen desktop apps control' },
  { id: 'skills', title: 'Skills and agents', description: 'Playbooks the agent loads when they fit, and agents it can hand work to.', keywords: 'skills playbooks subagents agents plugins task delegate explore plan review' },
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
  { id: 'personalization.instructions', section: 'personalization', label: 'Your instructions', keywords: 'encode.md prompt rules about me every project' },
  { id: 'personalization.project', section: 'personalization', label: 'This project’s instructions', keywords: 'encode.md agents.md claude.md folder repository' },
  { id: 'notifications.done', section: 'notifications', label: 'When a request finishes', keywords: 'done notice toast' },
  { id: 'notifications.needs', section: 'notifications', label: 'When the agent needs you', keywords: 'approval question plan waiting' },
  { id: 'notifications.flash', section: 'notifications', label: 'Flash the taskbar button', keywords: 'attention blink' },
  { id: 'notifications.test', section: 'notifications', label: 'Show a test notice', keywords: 'try check windows' },
  { id: 'appearance.theme', section: 'appearance', label: 'Theme', keywords: 'dark light system mode' },
  { id: 'appearance.accent', section: 'appearance', label: 'Accent', keywords: 'colour color blue cyan jade amber' },
  { id: 'appearance.contrast', section: 'appearance', label: 'Contrast', keywords: 'high accessibility' },
  { id: 'appearance.colors', section: 'appearance', label: 'Colours', keywords: 'custom color colour themes theme import export share palette' },
  { id: 'appearance.themeEditor', section: 'appearance', label: 'Theme colours', keywords: 'custom color colour edit background text syntax' },
  { id: 'appearance.density', section: 'appearance', label: 'Density', keywords: 'compact comfortable spacing' },
  { id: 'appearance.motion', section: 'appearance', label: 'Reduce motion', keywords: 'animation' },
  { id: 'appearance.uiFont', section: 'appearance', label: 'Interface font', keywords: 'typeface text inter segoe' },
  { id: 'appearance.uiSize', section: 'appearance', label: 'Interface size', keywords: 'text font size zoom' },
  { id: 'appearance.codeFont', section: 'appearance', label: 'Code font', keywords: 'monospace jetbrains consolas' },
  { id: 'appearance.codeSize', section: 'appearance', label: 'Code size', keywords: 'font size' },
  { id: 'editor.inlineSuggest', section: 'editor', label: 'Suggest code as you type', keywords: 'ghost text inline completion autocomplete ai model tab accept' },
  { id: 'editor.wordWrap', section: 'editor', label: 'Word wrap', keywords: 'long lines soft wrap rows alt z' },
  { id: 'editor.wrapAt', section: 'editor', label: 'Wrap at', keywords: 'window edge column whichever first bounded width' },
  { id: 'editor.wrapColumn', section: 'editor', label: 'Wrap column', keywords: 'width characters ruler' },
  { id: 'editor.wrapIndent', section: 'editor', label: 'Indent wrapped rows', keywords: 'hanging indentation' },
  { id: 'editor.whitespace', section: 'editor', label: 'Show spaces and tabs', keywords: 'render whitespace dots invisible trailing boundary selection' },
  { id: 'editor.bidi', section: 'editor', label: 'Read right-to-left text in its own order', keywords: 'rtl bidi hebrew arabic persian urdu direction' },
  { id: 'editor.screenReader', section: 'editor', label: 'Screen reader mode', keywords: 'accessibility narrator nvda jaws blind braille' },
  { id: 'editor.tabMovesFocus', section: 'editor', label: 'Tab moves the focus', keywords: 'accessibility keyboard trap ctrl m' },
  { id: 'editor.breadcrumbs', section: 'editor', label: 'Breadcrumbs', keywords: 'path symbols bar' },
  { id: 'editor.folding', section: 'editor', label: 'Folding', keywords: 'fold collapse chevrons gutter' },
  { id: 'editor.stickyScroll', section: 'editor', label: 'Sticky scroll', keywords: 'pinned headers scope' },
  { id: 'editor.bracketColors', section: 'editor', label: 'Bracket colours', keywords: 'colors pairs rainbow nesting' },
  { id: 'editor.minimap', section: 'editor', label: 'Minimap', keywords: 'overview map picture' },
  { id: 'editor.inlayHints', section: 'editor', label: 'Inlay hints', keywords: 'types parameter names language server' },
  { id: 'editor.semanticHighlighting', section: 'editor', label: 'Semantic colours', keywords: 'highlighting tokens colors deprecated language server' },
  { id: 'shortcuts.list', section: 'shortcuts', label: 'Change a shortcut', keywords: 'keys rebind reset' },
  { id: 'models.profiles', section: 'models', label: 'Model connections', keywords: 'api key base url provider' },
  { id: 'models.add', section: 'models', label: 'Add a provider', keywords: 'openrouter deepseek anthropic openai custom local ollama' },
  { id: 'roles.free', section: 'roles', label: 'Only use free models', keywords: 'free pool billed paid cost' },
  { id: 'roles.list', section: 'roles', label: 'Models for each role', keywords: 'main explore plan review compaction small tasks effort' },
  { id: 'roles.guide', section: 'roles', label: 'Short instructions for strong models', keywords: 'guide prompt system instructions tokens cost' },
  { id: 'roles.smaller', section: 'roles', label: 'Help smaller models', keywords: 'weak cheap deepseek glm kimi qwen minimax think before edit plan first' },
  { id: 'usage.summary', section: 'usage', label: 'Cost and tokens', keywords: 'spend total month week' },
  { id: 'usage.models', section: 'usage', label: 'Usage by model', keywords: 'models providers' },
  { id: 'usage.projects', section: 'usage', label: 'Usage by project', keywords: 'folders repositories' },
  { id: 'roles.stronger', section: 'roles', label: 'Offer a stronger model when one fails twice', keywords: 'upgrade escalate stronger model failures retry cost ask' },
  { id: 'agent.policy', section: 'agent', label: 'Approvals', keywords: 'what eNCode may do without asking read only full access auto review policy' },
  { id: 'agent.askAgain', section: 'agent', label: 'Before a command that is hard to undo', keywords: 'irreversible destructive delete force push publish deploy drop confirm self-consistency full access' },
  { id: 'agent.search', section: 'agent', label: 'Web search', keywords: 'parallel brave tavily exa duckduckgo search key' },
  { id: 'agent.checks', section: 'agent', label: "Check the agent's work before it finishes", keywords: 'checks typecheck tests regression claims verify gate security scan fivem' },
  { id: 'agent.review', section: 'agent', label: "Have the Reviewer read the agent's work", keywords: 'reviewer review plan critique second opinion edge cases tests' },
  { id: 'agent.learnConventions', section: 'agent', label: 'Keep what a request taught', keywords: 'conventions learn rules memory instructions encode.md agents.md claude.md lessons remember' },
  { id: 'agent.limits', section: 'agent', label: 'Max agent steps', keywords: 'limits steps rounds' },
  { id: 'agent.contextCap', section: 'agent', label: 'Summarize the conversation past', keywords: 'context window size tokens compaction compact cap long conversations cost' },
  { id: 'computer.enabled', section: 'computer', label: 'Let the agent use this computer', keywords: 'computer use gui mouse keyboard turn on' },
  { id: 'computer.stop', section: 'computer', label: 'Stop the agent using the computer', keywords: 'ctrl alt esc banner emergency' },
  { id: 'skills.skills', section: 'skills', label: 'Skills', keywords: 'playbooks new create folder remove' },
  { id: 'skills.agents', section: 'skills', label: 'Agents', keywords: 'subagents new create task delegate' },
  { id: 'permissions.rules', section: 'permissions', label: 'Permission rules', keywords: 'allow deny ask protected trust' },
  { id: 'mcp.servers', section: 'mcp', label: 'MCP servers', keywords: 'tools servers' },
  { id: 'sandbox.settings', section: 'sandbox', label: 'Sandbox for commands', keywords: 'isolation network' },
  { id: 'code.enabled', section: 'code', label: 'Use language servers', keywords: 'lsp errors editor marks' },
  { id: 'code.errorGate', section: 'code', label: 'Send the agent back to fix errors', keywords: 'error gate finish diagnostics' },
  { id: 'code.formatOnSave', section: 'code', label: 'Format on save', keywords: 'formatter prettier save tidy style' },
  { id: 'code.formatOnType', section: 'code', label: 'Format as you type', keywords: 'formatter on type semicolon brace tidy' },
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
