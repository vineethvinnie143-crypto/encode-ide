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
  'auto-review': 'Like Workspace Write, and runs read-only commands such as ls, cat or git status without asking.',
  'full-access': 'Edits files and runs commands without asking. Use it only in workspaces you trust.',
}

export const PROTECTED_NOTE = 'Changes inside .git and .eNCode always ask first, except under Full access.'
