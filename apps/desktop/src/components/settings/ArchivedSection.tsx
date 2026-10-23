import { useMemo, useState } from 'react'
import type { SessionSummary, Settings } from '@shared/types'
import { sessionActions } from '../../commands/app'
import { useSessions } from '../../stores/sessions'
import { isChat, projectName } from '../../stores/sidebar-model'
import { useUi } from '../../stores/ui'
import { Button, IconButton } from '../../ui/Button'
import { Archive, Trash2, Undo2 } from '../../ui/icons'
import { shortAge } from '../../ui/time'
import { SettingsGroup } from './Section'

/** Past this many, the list gets a field to find one by name. */
const FILTER_FROM = 8

/** Where an archived session belongs: its project's name, or Chat for one without a project. */
function placeOf(session: SessionSummary, chatsFolder: string): string {
  return isChat(session, chatsFolder) || !session.projectRoot ? 'Chat' : projectName(session.projectRoot)
}

/** Settings > Archived sessions: every session put away, newest first, to restore or delete. */
export function ArchivedSection({ settings }: { settings: Settings }) {
  const sessions = useSessions((state) => state.sessions)
  const [query, setQuery] = useState('')
  const archived = useMemo(() => sessions.filter((session) => session.archived).sort((a, b) => b.updatedAt - a.updatedAt), [sessions])
  const needle = query.trim().toLowerCase()
  const shown = needle ? archived.filter((session) => `${session.title} ${placeOf(session, settings.chatsFolder)}`.toLowerCase().includes(needle)) : archived

  const restore = async (session: SessionSummary) => {
    await sessionActions.restore(session)
    useUi.getState().notify('success', `Restored “${session.title}”.`, {
      label: 'Open',
      run: () => {
        useUi.getState().setSettingsOpen(false)
        void useSessions.getState().select(session.id)
      },
    })
  }

  return (
    <SettingsGroup className="archived-section">
      {archived.length > FILTER_FROM && (
        <div className="archived-filter">
          <input
            className="text-input"
            type="search"
            placeholder="Find an archived session"
            aria-label="Find an archived session"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                setQuery('')
              }
            }}
          />
        </div>
      )}
      <div className="archived-list" data-setting="archived.list">
        {shown.map((session) => (
          <div key={session.id} className="archived-row" data-session={session.id}>
            <span className="archived-text">
              <span className="archived-title" title={session.title}>
                {session.title}
              </span>
              <span className="archived-meta" title={new Date(session.updatedAt).toLocaleString()}>
                {placeOf(session, settings.chatsFolder)} · {shortAge(session.updatedAt)}
              </span>
            </span>
            <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => void restore(session)}>
              Restore
            </Button>
            <IconButton label="Delete…" size="sm" onClick={() => void sessionActions.remove(session)}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {!archived.length && (
          <div className="settings-empty">
            <Archive size={18} aria-hidden="true" />
            <span>No archived sessions. Archive one from its menu in the sidebar to keep it out of the way.</span>
          </div>
        )}
        {archived.length > 0 && !shown.length && <div className="settings-empty">No archived session matches “{query.trim()}”.</div>}
      </div>
    </SettingsGroup>
  )
}
