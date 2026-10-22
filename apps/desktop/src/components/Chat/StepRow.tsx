import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  FileText,
  Globe,
  ListTree,
  Loader2,
  MessageCircleQuestion,
  Network,
  Pencil,
  Search,
  SquareTerminal,
  XCircle,
} from '../../ui/icons'
import type { ConversationEntry } from '@shared/types'
import { cx } from '../../ui/cx'
import DiffView from './DiffView'
import { stepKind, summarizeSteps, toolPath, type StepKind } from './turns'

const TOOL_META: Record<string, { label: string; icon: typeof FileText }> = {
  Read: { label: 'Read', icon: FileText },
  Write: { label: 'Wrote', icon: Pencil },
  Edit: { label: 'Edited', icon: Pencil },
  MultiEdit: { label: 'Edited', icon: Pencil },
  Glob: { label: 'Listed', icon: ListTree },
  Grep: { label: 'Searched', icon: Search },
  Bash: { label: 'Ran', icon: SquareTerminal },
  BashOutput: { label: 'Read output', icon: SquareTerminal },
  KillShell: { label: 'Stopped', icon: SquareTerminal },
  WebFetch: { label: 'Fetched', icon: Globe },
  WebSearch: { label: 'Searched the web', icon: Globe },
  Task: { label: 'Subagent', icon: Network },
  AskUserQuestion: { label: 'Asked', icon: MessageCircleQuestion },
  TodoWrite: { label: 'Updated tasks', icon: ListTree },
  ExitPlanMode: { label: 'Proposed a plan', icon: ListTree },
  Skill: { label: 'Skill', icon: FileText },
  CreateGoal: { label: 'Goal', icon: CheckCircle2 },
  UpdateGoal: { label: 'Goal', icon: CheckCircle2 },
  GetGoal: { label: 'Goal', icon: CheckCircle2 },
  read: { label: 'Read', icon: FileText },
  read_file: { label: 'Read', icon: FileText },
  write: { label: 'Wrote', icon: Pencil },
  write_file: { label: 'Wrote', icon: Pencil },
  edit: { label: 'Edited', icon: Pencil },
  replace_in_file: { label: 'Edited', icon: Pencil },
  glob: { label: 'Listed', icon: ListTree },
  list_files: { label: 'Listed', icon: ListTree },
  grep: { label: 'Searched', icon: Search },
  search_files: { label: 'Searched', icon: Search },
  pwsh: { label: 'Ran', icon: SquareTerminal },
  run_command: { label: 'Ran', icon: SquareTerminal },
  ask_user_question: { label: 'Asked', icon: MessageCircleQuestion },
  ask_followup_question: { label: 'Asked', icon: MessageCircleQuestion },
  attempt_completion: { label: 'Done', icon: CheckCircle2 },
  task: { label: 'Subagent', icon: Network },
  web_fetch: { label: 'Fetched', icon: Globe },
  web_search: { label: 'Searched the web', icon: Globe },
}

const KIND_ICON: Record<StepKind, typeof FileText> = {
  read: FileText,
  search: Search,
  edit: Pencil,
  shell: SquareTerminal,
  web: Globe,
  subagent: Network,
  ask: MessageCircleQuestion,
  other: FileText,
}

/** Tools whose header line says enough until they produce output. */
const QUIET_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'BashOutput', 'read', 'read_file', 'glob', 'list_files', 'grep', 'search_files', 'pwsh', 'run_command'])

const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Done',
  rejected: 'Declined',
  error: 'Failed',
}

function detailOf(entry: ConversationEntry): string {
  const tool = entry.tool
  if (!tool) return ''
  const input = tool.input ?? {}
  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'read':
    case 'read_file':
    case 'write':
    case 'write_file':
    case 'edit':
    case 'replace_in_file':
      return toolPath(input) ?? ''
    case 'Glob':
      return String(input.pattern ?? '')
    case 'glob':
    case 'list_files':
      return String(input.path || '.')
    case 'Grep':
      return String(input.pattern ?? '')
    case 'grep':
    case 'search_files':
      return String(input.query ?? '')
    case 'Bash':
    case 'pwsh':
    case 'run_command':
      return String(input.command ?? '')
    case 'BashOutput':
      return String(input.bash_id ?? '')
    case 'KillShell':
      return String(input.shell_id ?? '')
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined) : undefined
      return String(first?.question ?? '')
    }
    case 'ask_user_question':
    case 'ask_followup_question':
      return String(input.question ?? '')
    case 'WebFetch':
    case 'web_fetch':
      return String(input.url ?? '')
    case 'WebSearch':
    case 'web_search':
      return String(input.query ?? '')
    case 'Task':
      return String(input.description || String(input.prompt ?? '').split('\n', 1)[0])
    case 'task':
      return String(input.prompt ?? '').split('\n', 1)[0]
    case 'Skill':
      return String(input.skill ?? '')
    default:
      return ''
  }
}

/** One step the agent took: a 26 px row that opens inline to its command and output, its diff, or what it found. */
export default function StepRow({ entry, nested }: { entry: ConversationEntry; nested?: boolean }) {
  const tool = entry.tool
  const [expanded, setExpanded] = useState(Boolean(tool?.diff?.length) || tool?.state === 'waiting')

  useEffect(() => {
    if (tool?.diff?.length) setExpanded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.diff])

  if (!tool) return null

  const meta = TOOL_META[tool.name] ?? { label: tool.name.replace(/_/g, ' '), icon: FileText }
  const Icon = meta.icon
  const detail = detailOf(entry)
  const state = tool.state ?? 'done'
  const isShell = stepKind(tool.name) === 'shell'
  const hasBody = Boolean(tool.output || tool.diff?.length || !QUIET_TOOLS.has(tool.name))
  const additions = tool.diff?.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'add').length, 0) ?? 0
  const deletions = tool.diff?.reduce((total, hunk) => total + hunk.lines.filter((line) => line.type === 'del').length, 0) ?? 0
  const content = tool.input.content
  const sizeLabel =
    typeof content === 'string' && content.length > 0
      ? content.length >= 1024
        ? `${Math.round(content.length / 1024)}KB`
        : `${content.length}B`
      : ''

  return (
    <div className={cx('tool-row', `tool-${state}`, nested && 'is-nested')}>
      <button type="button" className="tool-row-toggle" aria-expanded={hasBody ? expanded : undefined} onClick={() => setExpanded((value) => !value)}>
        <Icon size={14} className="tool-row-icon" />
        <span className="tool-row-label">{meta.label}</span>
        {detail && <span className="tool-row-detail">{detail}</span>}
        {sizeLabel && <span className="tool-row-size">{sizeLabel}</span>}
        {(additions > 0 || deletions > 0) && (
          <span className="diff-stats">
            <span className="add-stat">+{additions}</span>
            <span className="del-stat">−{deletions}</span>
          </span>
        )}
        {state === 'running' && <Loader2 size={13} className="spin tool-row-state" />}
        {state === 'waiting' && <ChevronRight size={13} className="tool-row-state" />}
        {(state === 'rejected' || state === 'error') && <XCircle size={13} className="tool-row-state is-bad" />}
      </button>

      {expanded && hasBody && (
        <div className={cx('tool-row-body', isShell && 'is-card')}>
          {isShell ? (
            <>
              <div className="step-card-head">
                <SquareTerminal size={14} />
                <span className="step-card-command">{detail}</span>
                <span className={cx('step-status', `is-${state}`)}>{STATE_LABEL[state] ?? state}</span>
              </div>
              {tool.output && <pre className="tool-row-output">{tool.output}</pre>}
            </>
          ) : (
            <>
              {tool.diff && tool.diff.length > 0 && <DiffView diff={tool.diff} />}
              {tool.output && <pre className="tool-row-output">{tool.output}</pre>}
              {!tool.diff?.length && !tool.output && Object.keys(tool.input ?? {}).length > 0 && (
                <pre className="tool-row-output">{JSON.stringify(tool.input, null, 2)}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Several small steps of one kind as a single line ("Read 4 files") that opens into its rows. */
export function GroupRow({ kind, entries }: { kind: StepKind; entries: ConversationEntry[] }) {
  const [open, setOpen] = useState(false)
  const Icon = KIND_ICON[kind]
  const running = entries.some((entry) => entry.tool?.state === 'running')
  return (
    <div className="tool-row tool-group">
      <button type="button" className="tool-row-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon size={14} className="tool-row-icon" />
        <span className="tool-row-label">{summarizeSteps(entries)}</span>
        {running ? <Loader2 size={13} className="spin tool-row-state" /> : <ChevronRight size={13} className={cx('tool-row-state', 'group-chevron', open && 'is-open')} />}
      </button>
      {open && (
        <div className="group-rows">
          {entries.map((entry) => (
            <StepRow key={entry.id} entry={entry} nested />
          ))}
        </div>
      )}
    </div>
  )
}
