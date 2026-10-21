/** One-shot source patch that adds the harness approval-policy model. */
import fs from 'node:fs'

const edits = [
  ['electron/services/settings.ts', "import type { AgentMode, ModelProfile, ProfileKind, Settings } from '../../shared/types'",
    "import type { AgentMode, ApprovalPolicy, ModelProfile, ProfileKind, Settings } from '../../shared/types'"],
  ['electron/services/settings.ts', '    autoApprove: false,\n    autoApproveCommands: false,',
    "    policy: 'workspace-write',\n    autoApprove: true,\n    autoApproveCommands: false,"],
  ['electron/services/settings.ts', "function str(value: unknown, fallback = ''): string {",
    "const POLICIES: ApprovalPolicy[] = ['read-only', 'workspace-write', 'full-access', 'auto-review']\n\nfunction normalizePolicy(value: unknown, fallback: ApprovalPolicy): ApprovalPolicy {\n  return POLICIES.includes(value as ApprovalPolicy) ? (value as ApprovalPolicy) : fallback\n}\n\nfunction str(value: unknown, fallback = ''): string {"],
  ['electron/services/settings.ts', '      autoApprove: typeof input.autoApprove === \'boolean\' ? input.autoApprove : base.autoApprove,',
    '      policy: normalizePolicy(input.policy, base.policy),\n      autoApprove: typeof input.autoApprove === \'boolean\' ? input.autoApprove : base.autoApprove,'],
  ['electron/services/settings.ts', '      autoApprove: this.data.autoApprove,\n      autoApproveCommands: this.data.autoApproveCommands,',
    '      policy: this.data.policy,\n      autoApprove: this.data.autoApprove,\n      autoApproveCommands: this.data.autoApproveCommands,'],
  ['electron/services/settings.ts', '    if (typeof patch.autoApprove === \'boolean\') next.autoApprove = patch.autoApprove',
    "    if (patch.policy) {\n      next.policy = patch.policy\n      next.autoApprove = patch.policy !== 'read-only'\n      next.autoApproveCommands = patch.policy === 'full-access'\n    }\n    if (typeof patch.autoApprove === 'boolean') next.autoApprove = patch.autoApprove"],
  ['electron/agent/tools.ts', "import type { AgentMode, Settings } from '../../shared/types'",
    "import type { AgentMode, ApprovalPolicy, Settings } from '../../shared/types'"],
  ['electron/agent/tools.ts', "      return err('This is ASK mode (read-only). File edits and commands are disabled. Explain the proposed change instead, or switch to CODE mode.')",
    "      return err('This is ASK mode (read-only). File edits and commands are disabled. Explain the proposed change instead, or switch to CODE mode.')\n    }\n\n    const policy = (ctx.settings.raw() as { policy?: ApprovalPolicy }).policy\n    if (policy === 'read-only' && (name === 'write_file' || name === 'replace_in_file' || name === 'run_command')) {\n      return err('This session is in Read Only policy, so file changes and commands are blocked. Ask the user to switch the policy (Workspace Write, Full access or Auto review) to continue.')"],
  ['electron/agent/tools.ts', 'export function requiresApprovalFor(\n  tool: string,\n  settings: Pick<Settings, \'autoApprove\' | \'autoApproveCommands\'>,\n  mode: AgentMode,\n): boolean {\n  if (mode === \'ask\') return false\n  if (tool === \'write_file\' || tool === \'replace_in_file\') return !settings.autoApprove\n  if (tool === \'run_command\') return !settings.autoApproveCommands\n  return false\n}',
    "const SAFE_COMMAND = /^(ls|dir|cat|type|pwd|head|tail|wc|which|git status|git diff|git log|node --version|npm --version|npm test|npm run (build|test|lint|typecheck)|tsc)\\b/i\n\n/** Mirrors the harness policy menu: read-only, workspace-write, full-access, auto-review. */\nexport function requiresApprovalFor(\n  tool: string,\n  settings: Pick<Settings, 'autoApprove' | 'autoApproveCommands'> & { policy?: ApprovalPolicy },\n  mode: AgentMode,\n  input: Record<string, unknown> = {},\n): boolean {\n  if (mode === 'ask') return false\n  switch (settings.policy) {\n    case 'read-only':\n    case 'full-access':\n      return false\n    case 'workspace-write':\n      return tool === 'run_command'\n    case 'auto-review':\n      if (tool !== 'run_command') return false\n      return !SAFE_COMMAND.test(String(input.command ?? '').trim())\n    default:\n      break\n  }\n  if (tool === 'write_file' || tool === 'replace_in_file') return !settings.autoApprove\n  if (tool === 'run_command') return !settings.autoApproveCommands\n  return false\n}"],
  ['electron/agent/agent.ts', 'if (requiresApprovalFor(call.name, settings, mode)) {',
    'if (requiresApprovalFor(call.name, settings, mode, call.input)) {'],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS  ${file}: ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length} edits`)
