import { AlertTriangle, Copy, Info } from '../../ui/icons'
import type { ConversationEntry } from '@shared/types'
import { renderMarkdown } from '../../markdown'
import ToolCard from './ToolCard'

function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
        if (!anchor?.href) return
        event.preventDefault()
        window.open(anchor.href, '_blank')
      }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  )
}

function timeOf(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function ChatMessage({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'user') {
    return (
      <div className="chat-user">
        <div className="chat-user-bubble">{entry.text}</div>
        <div className="chat-meta">
          {timeOf(entry.createdAt)}
          <button
            className="chat-copy"
            title="Copy message"
            onClick={() => void navigator.clipboard.writeText(entry.text ?? '')}
          >
            <Copy size={11} />
          </button>
        </div>
      </div>
    )
  }

  if (entry.kind === 'assistant') {
    if (!entry.text && entry.streaming) {
      return (
        <div className="msg msg-assistant">
          <div className="thinking-dots">
            <span />
            <span />
            <span />
          </div>
        </div>
      )
    }
    return (
      <div className="msg msg-assistant">
        <Markdown text={entry.text ?? ''} />
        {entry.streaming && <span className="stream-caret" />}
      </div>
    )
  }

  if (entry.kind === 'tool') {
    return <ToolCard entry={entry} />
  }

  if (entry.kind === 'notice') {
    return (
      <div className="msg msg-notice">
        <Info size={13} />
        <span>{entry.text}</span>
      </div>
    )
  }

  return (
    <div className="msg msg-error">
      <AlertTriangle size={14} />
      <span>{entry.text}</span>
    </div>
  )
}
