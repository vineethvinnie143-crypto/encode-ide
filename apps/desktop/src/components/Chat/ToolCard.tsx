import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  FileText,
  ListTree,
  Loader2,
  MessageCircleQuestion,
  Network,
  Pencil,
  Search,
  SquareTerminal,
  XCircle,
} from 'lucide-react'
import type { ConversationEntry } from '@shared/types'
import DiffView from './DiffView'

const TOOL_META: Record<string, { label: string; icon: typeof FileText }> = {
  read: { label: 'Read', icon: FileText },
  read_file: { label: 'Read', icon: FileText },
  write: { label: 'Write', icon: Pencil },
  write_file: { label: 'Write', icon: Pencil },
  edit: { label: 'Edit', icon: Pencil },
  replace_in_file: { label: 'Edit', icon: Pencil },
  glob: { label: 'Glob', icon: ListTree },
  list_files: { label: 'List', icon: ListTree },
  grep: { label: 'Grep', icon: Search },
  search_files: { label: 'Search', icon: Search },
  pwsh: { label: 'Shell', icon: SquareTerminal },
  run_command: { label: 'Shell', icon: SquareTerminal },
  ask_user_question: { label: 'Ask', icon: MessageCircleQuestion },
  ask_followup_question: { label: 'Ask', icon: MessageCircleQuestion },
  attempt_completion: { label: 'Done', icon: CheckCircle2 },
  task: { label: 'Subagent', icon: Network },
}

/** Tools whose header line says enough until they produce output. */
const QUIET_TOOLS = new Set(['read', 'read_file', 'glob', 'list_files', 'grep', 'search_files', 'pwsh', 'run_command'])

function detailOf(entry: ConversationEntry): string {
  const tool = entry.tool
  if (!tool) return ''
  const input = tool.input ?? {}
  switch (tool.name) {
    case 'read':
    case 'read_file':
    case 'write':
    case 'write_file':
    case 'edit':
    case 'replace_in_file':
      return String(input.path ?? '')
    case 'glob':
    case 'list_files':
      return String(input.path || '.')
    case 'grep':
    case 'search_files':
      return String(input.query ?? '')
    case 'pwsh':
    case 'run_command':
      return String(input.command ?? '')
    case 'ask_user_question':
    case 'ask_followup_question':
      return String(input.question ?? '')
    case 'web_fetch':
      return String(input.url ?? '')
    case 'web_search':
      return String(input.query ?? '')
    case 'task':
      return String(input.prompt ?? '').split('\n', 1)[0]
    default:
      return ''
  }
}

export default function ToolCard({ entry }: { entry: ConversationEntry }) {
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
    <div className={`tool-row tool-${state}`}>
      <div className="tool-row-head">
        <button className="tool-row-toggle" onClick={() => setExpanded((value) => !value)}>
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
          {state === 'rejected' && <XCircle size={13} className="tool-row-state is-bad" />}
          {state === 'error' && <XCircle size={13} className="tool-row-state is-bad" />}
          {state === 'done' && <CheckCircle2 size={13} className="tool-row-state is-good" />}
        </button>
      </div>

      {expanded && hasBody && (
        <div className="tool-row-body">
          {tool.diff && tool.diff.length > 0 && <DiffView diff={tool.diff} />}
          {tool.output && <pre className="tool-row-output">{tool.output}</pre>}
          {!tool.diff?.length && !tool.output && Object.keys(tool.input ?? {}).length > 0 && (
            <pre className="tool-row-output">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}
