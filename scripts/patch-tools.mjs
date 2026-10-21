/** Aligns the agent tool surface with the harness naming. */
import fs from 'node:fs'

const tools = 'electron/agent/tools.ts'
const card = 'src/components/Chat/ToolCard.tsx'
const edits = [
  // Tool definitions: harness names
  [tools, "      name: 'read_file',", "      name: 'read',"],
  [tools, "      name: 'write_file',", "      name: 'write',"],
  [tools, "      name: 'replace_in_file',", "      name: 'edit',"],
  [tools, "      name: 'list_files',", "      name: 'glob',"],
  [tools, "      name: 'search_files',", "      name: 'grep',"],
  [tools, "      name: 'run_command',", "      name: 'pwsh',"],
  [tools, "      name: 'ask_followup_question',", "      name: 'ask_user_question',"],
  // Execution: accept both names
  [tools, "      case 'list_files':", "      case 'glob':\n      case 'list_files':"],
  [tools, "      case 'read_file':", "      case 'read':\n      case 'read_file':"],
  [tools, "      case 'write_file':", "      case 'write':\n      case 'write_file':"],
  [tools, "      case 'replace_in_file':", "      case 'edit':\n      case 'replace_in_file':"],
  [tools, "      case 'search_files':", "      case 'grep':\n      case 'search_files':"],
  [tools, "      case 'run_command':", "      case 'pwsh':\n      case 'run_command':"],
  [tools, "      case 'ask_followup_question': {", "      case 'ask_user_question':\n      case 'ask_followup_question': {"],
  // get_goal
  [tools, "      case 'create_goal': {",
    `      case 'get_goal': {
        const goal = ctx.goals.get()
        return { ok: true, output: goal ? JSON.stringify(goal, null, 2) : 'No goal is set.' }
      }
      case 'create_goal': {`],
  // Policy checks accept the new names
  [tools, "(name === 'write_file' || name === 'replace_in_file' || name === 'run_command')",
    "(name === 'write' || name === 'write_file' || name === 'edit' || name === 'replace_in_file' || name === 'pwsh' || name === 'run_command')"],
  [tools, "if (policy === 'read-only' && (name === 'write_file' || name === 'replace_in_file' || name === 'run_command'))",
    "if (policy === 'read-only' && (name === 'write' || name === 'write_file' || name === 'edit' || name === 'replace_in_file' || name === 'pwsh' || name === 'run_command'))"],
  [tools, "    case 'workspace-write':\n      return tool === 'run_command'",
    "    case 'workspace-write':\n      return tool === 'run_command' || tool === 'pwsh'"],
  [tools, "      if (tool !== 'run_command') return false",
    "      if (tool !== 'run_command' && tool !== 'pwsh') return false"],
  [tools, "  if (tool === 'write_file' || tool === 'replace_in_file') return !settings.autoApprove\n  if (tool === 'run_command') return !settings.autoApproveCommands",
    "  if (tool === 'write' || tool === 'write_file' || tool === 'edit' || tool === 'replace_in_file') return !settings.autoApprove\n  if (tool === 'run_command' || tool === 'pwsh') return !settings.autoApproveCommands"],
  // get_goal schema
  [tools, "      name: 'create_goal',",
    `      name: 'create_goal',`],
  // Tool card labels for the new names
  [card, "  read_file: { label: 'Read', icon: FileText },",
    "  read: { label: 'Read', icon: FileText },\n  read_file: { label: 'Read', icon: FileText },"],
  [card, "  write_file: { label: 'Write', icon: Pencil },",
    "  write: { label: 'Write', icon: Pencil },\n  write_file: { label: 'Write', icon: Pencil },"],
  [card, "  replace_in_file: { label: 'Edit', icon: Pencil },",
    "  edit: { label: 'Edit', icon: Pencil },\n  replace_in_file: { label: 'Edit', icon: Pencil },"],
  [card, "  list_files: { label: 'List', icon: ListTree },",
    "  glob: { label: 'Glob', icon: ListTree },\n  list_files: { label: 'List', icon: ListTree },"],
  [card, "  search_files: { label: 'Search', icon: Search },",
    "  grep: { label: 'Grep', icon: Search },\n  search_files: { label: 'Search', icon: Search },"],
  [card, "  run_command: { label: 'Shell', icon: SquareTerminal },",
    "  pwsh: { label: 'Pwsh', icon: SquareTerminal },\n  run_command: { label: 'Shell', icon: SquareTerminal },"],
  [card, "  ask_followup_question: { label: 'Ask', icon: MessageCircleQuestion },",
    "  ask_user_question: { label: 'Ask', icon: MessageCircleQuestion },\n  ask_followup_question: { label: 'Ask', icon: MessageCircleQuestion },"],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS ${file}: ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length}`)
