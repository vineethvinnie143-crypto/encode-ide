import type { ApprovalPolicy } from '@shared/types'

/** Ordered from most to least restrictive. Enforcement lives in electron/agent/approval.ts. */
export const POLICY_OPTIONS: readonly ApprovalPolicy[] = ['read-only', 'workspace-write', 'auto-review', 'full-access']

export const POLICY_LABELS: Record<ApprovalPolicy, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'auto-review': 'Auto review',
  'full-access': 'Full access',
}

export const POLICY_DESCRIPTIONS: Record<ApprovalPolicy, string> = {
  'read-only': 'Reads and searches only. Edits and commands are blocked.',
  'workspace-write': 'Edits workspace files without asking. Asks before every command.',
  'auto-review': 'Runs read-only commands without asking. A second model, the Reviewer, approves other low-risk commands that fit your request, and asks you about the rest.',
  'full-access': 'Edits files and runs commands without asking. Use it only in workspaces you trust.',
}

/** What asks under every policy but Full access; see electron/agent/approval.ts. */
export const ALWAYS_ASKS_NOTE =
  'Except under Full access, eNCode always asks before changing anything inside .git or .encode, and before the agent first contacts a website in a session.'
