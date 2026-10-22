import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { SessionSummary } from '@shared/types'
import { commandRegistry, sessionActions } from '../../commands/app'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import {
  activityGroups,
  buildSidebar,
  projectName,
  rootKey,
  rowStatus,
  sameRoot,
  type RowStatus,
} from '../../stores/sidebar-model'
import { useStatus } from '../../stores/status'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Archive, Bell, ChevronDown, ChevronRight, Folder, FolderOpen, Pin, PenSquare, Plus, Search, Trash2, Undo2 } from '../../ui/icons'
import { Kbd } from '../../ui/Kbd'
import { ContextMenu, Menu, type MenuEntry } from '../../ui/Menu'
import { Spinner } from '../../ui/Spinner'
import { shortAge } from '../../ui/time'

const STATUS_TEXT: Record<RowStatus, string> = { running: 'running', approval: 'needs approval', unread: 'unread', idle: '' }

/** A 14 px slot before each title: a spinner while running, an amber dot for approval, an accent dot for unread. */
function StatusSlot({ status }: { status: RowStatus }) {
  return (
    <span className="slot" aria-hidden="true">
      {status === 'running' ? <Spinner size={12} /> : status === 'approval' ? <span className="dot attn" /> : status === 'unread' ? <span className="dot unread" /> : null}
    </span>
  )
}

function rowLabel(session: SessionSummary, status: RowStatus): string {
  return STATUS_TEXT[status] ? `${session.title}, ${STATUS_TEXT[status]}` : session.title
}

interface RowProps {
  session: SessionSummary
  active: boolean
  status: RowStatus
  nested?: boolean
  renaming: boolean
  onOpen: () => void
  onContext: (event: MouseEvent, session: SessionSummary) => void
  onStartRename: () => void
  onFinishRename: (title: string | null) => void
}

function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const done = useRef(false)
  const finish = (title: string | null) => {
    if (done.current) return
    done.current = true
    onDone(title)
  }
  return (
    <input
      className="sb-rename"
      aria-label="Session name"
      defaultValue={initial}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish(event.currentTarget.value)
        else if (event.key === 'Escape') finish(null)
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  )
}

function SessionRow({ session, active, status, nested, renaming, onOpen, onContext, onStartRename, onFinishRename }: RowProps) {
  const meta = status === 'approval' ? 'Approval' : shortAge(session.updatedAt)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'F2') {
      event.preventDefault()
      onStartRename()
    }
  }
  return (
    <div className={cx('sb-row', 'sb-session', nested && 'sb-sub', active && 'is-active')} onContextMenu={(event) => onContext(event, session)}>
      {renaming ? (
        <>
          <StatusSlot status={status} />
          <RenameField initial={session.title} onDone={onFinishRename} />
        </>
      ) : (
        <>
          <button
            type="button"
            className="sb-row-main"
            title={session.title}
            aria-label={rowLabel(session, status)}
            aria-current={active ? 'true' : undefined}
            onClick={onOpen}
            onDoubleClick={onStartRename}
            onKeyDown={onKeyDown}
          >
            <StatusSlot status={status} />
            <span className="title">{session.title}</span>
            <span className={cx('meta', status === 'approval' && 'warn')}>{meta}</span>
          </button>
          <span className="sb-row-actions">
            <IconButton
              label={session.pinned ? 'Unpin' : 'Pin'}
              size="sm"
              onClick={() => void sessionActions.togglePin(session)}
            >
              <Pin size={14} />
            </IconButton>
            <IconButton label="Archive" size="sm" onClick={() => void sessionActions.archive(session)}>
              <Archive size={14} />
            </IconButton>
          </span>
        </>
      )}
    </div>
  )
}

/** Two lines for the Activity view: the title, and the start of the last reply. */
function ActivityRow({
  session,
  active,
  status,
  onOpen,
  onContext,
}: {
  session: SessionSummary
  active: boolean
  status: RowStatus
  onOpen: () => void
  onContext: (event: MouseEvent, session: SessionSummary) => void
}) {
  return (
    <button
      type="button"
      className={cx('sb-activity-row', active && 'is-active')}
      aria-label={rowLabel(session, status)}
      onClick={onOpen}
      onContextMenu={(event) => onContext(event, session)}
    >
      <StatusSlot status={status} />
      <span className="sb-activity-text">
        <span className="title">{session.title}</span>
        <span className="preview">{session.preview || (session.projectRoot ? projectName(session.projectRoot) : 'No messages yet')}</span>
      </span>
      <span className={cx('meta', status === 'approval' && 'warn')}>{status === 'approval' ? 'Approval' : shortAge(session.updatedAt)}</span>
    </button>
  )
}

export default function SessionSidebar() {
  const sessions = useSessions((state) => state.sessions)
  const activeId = useSessions((state) => state.activeId)
  const statuses = useStatus((state) => state.statusById)
  const workspace = useWorkspace((state) => state.workspace)
  const recentRoots = useSettings((state) => state.settings?.recentWorkspaces)
  const mode = useUi((state) => state.sidebarMode)
  const collapsed = useUi((state) => state.collapsedProjects)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionSummary } | null>(null)

  const model = useMemo(
    () => buildSidebar(sessions, { workspaceRoot: workspace?.root ?? null, recentRoots: recentRoots ?? [] }),
    [sessions, workspace?.root, recentRoots],
  )
  const groups = useMemo(() => activityGroups(sessions, statuses), [sessions, statuses])
  const archived = useMemo(() => sessions.filter((session) => session.archived).sort((a, b) => b.updatedAt - a.updatedAt), [sessions])

  const statusOf = (session: SessionSummary): RowStatus => rowStatus(session, statuses[session.id])
  const open = (session: SessionSummary) => void useSessions.getState().select(session.id)
  const showMenu = (event: MouseEvent, session: SessionSummary) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, session })
  }

  const contextEntries = (session: SessionSummary): MenuEntry[] => {
    const others = model.projects.filter((project) => !sameRoot(project.root, session.projectRoot)).slice(0, 8)
    const entries: MenuEntry[] = [
      { id: 'rename', label: 'Rename', shortcut: 'F2', onSelect: () => setRenamingId(session.id) },
      { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin', onSelect: () => void sessionActions.togglePin(session) },
      { id: 'unread', label: session.unread ? 'Mark as read' : 'Mark as unread', onSelect: () => void sessionActions.toggleUnread(session) },
    ]
    if (others.length || session.projectRoot) {
      entries.push({ kind: 'separator', id: 'sep-move' }, { kind: 'group', id: 'g-move', label: 'Move to project' })
      for (const project of others) {
        entries.push({ id: `move-${rootKey(project.root)}`, label: project.name, onSelect: () => void sessionActions.moveToProject(session, project.root) })
      }
      if (session.projectRoot) entries.push({ id: 'move-none', label: 'No project', onSelect: () => void sessionActions.moveToProject(session, null) })
    }
    entries.push(
      { kind: 'separator', id: 'sep-copy' },
      { id: 'fork', label: 'Fork session', onSelect: () => void sessionActions.fork(session) },
      { id: 'export', label: 'Export session…', onSelect: () => void sessionActions.export(session) },
      { kind: 'separator', id: 'sep-end' },
      { id: 'archive', label: 'Archive', onSelect: () => void sessionActions.archive(session) },
      { id: 'delete', label: 'Delete…', danger: true, onSelect: () => void sessionActions.remove(session) },
    )
    return entries
  }

  const switcherEntries = (): MenuEntry[] => {
    const roots = new Map<string, string>()
    for (const root of [workspace?.root, ...(recentRoots ?? [])]) if (root && !roots.has(rootKey(root))) roots.set(rootKey(root), root)
    const entries: MenuEntry[] = [...roots.values()].map((root) => ({
      id: rootKey(root),
      label: projectName(root),
      checked: sameRoot(root, workspace?.root),
      onSelect: () => void useWorkspace.getState().openPath(root),
    }))
    if (entries.length) entries.push({ kind: 'separator', id: 'sep-open' })
    entries.push({ id: 'open', label: 'Open folder…', shortcut: commandRegistry.shortcut('file.openFolder'), onSelect: () => void useWorkspace.getState().openDialog() })
    return entries
  }

  const rowProps = (session: SessionSummary, nested = false): RowProps => ({
    session,
    nested,
    active: session.id === activeId,
    status: statusOf(session),
    renaming: renamingId === session.id,
    onOpen: () => open(session),
    onContext: showMenu,
    onStartRename: () => setRenamingId(session.id),
    onFinishRename: (title) => {
      setRenamingId(null)
      if (title?.trim() && title.trim() !== session.title) void useSessions.getState().rename(session.id, title)
    },
  })

  const empty = !model.pinned.length && !model.projects.length && !model.recents.length

  return (
    <aside className="session-sidebar" aria-label="Sessions">
      <div className="sb-head">
        <Menu
          label="Projects"
          width={280}
          entries={switcherEntries}
          trigger={(props) => (
            <button type="button" className="proj-switch" title={workspace?.root ?? 'Open a folder'} {...props}>
              <span className="proj-mark">{(workspace?.name ?? 'e').slice(0, 1).toLowerCase()}</span>
              <span className="proj-name">{workspace?.name ?? 'No folder open'}</span>
              <ChevronDown size={14} className="muted" />
            </button>
          )}
        />
        <span className="grow" />
        <IconButton
          label="Activity view"
          shortcut={commandRegistry.shortcut('view.activity')}
          size="md"
          active={mode === 'activity'}
          onClick={() => commandRegistry.run('view.activity')}
        >
          <Bell size={16} />
        </IconButton>
        <IconButton label="Search" shortcut={commandRegistry.shortcut('app.palette')} size="md" onClick={() => commandRegistry.run('app.palette')}>
          <Search size={16} />
        </IconButton>
      </div>

      <div className="sb-list">
        {mode === 'projects' && (
          <>
            <button type="button" className="sb-row sb-new" onClick={() => commandRegistry.run('file.newSession')}>
              <PenSquare size={16} className="ic" />
              <span className="title">New session</span>
              <Kbd keys={commandRegistry.shortcut('file.newSession') ?? ''} plain />
            </button>

            {model.pinned.length > 0 && (
              <section aria-label="Pinned">
                <div className="sb-label">
                  <span>Pinned</span>
                </div>
                {model.pinned.map((session) => (
                  <SessionRow key={session.id} {...rowProps(session)} />
                ))}
              </section>
            )}

            <section aria-label="Projects">
              <div className="sb-label">
                <span>Projects</span>
                <IconButton label="Open folder" size="sm" onClick={() => commandRegistry.run('file.openFolder')}>
                  <Plus size={14} />
                </IconButton>
              </div>
              {model.projects.map((project) => {
                const key = rootKey(project.root)
                const folded = collapsed.includes(key)
                const current = sameRoot(project.root, workspace?.root)
                return (
                  <div key={key} className="sb-project">
                    <button
                      type="button"
                      className="sb-row"
                      aria-expanded={!folded}
                      title={project.root}
                      onClick={() => useUi.getState().toggleProject(key)}
                    >
                      <ChevronRight size={14} className={cx('sb-chevron', !folded && 'is-open')} />
                      {current ? <FolderOpen size={16} className="ic" /> : <Folder size={16} className="ic" />}
                      <span className="title">{project.name}</span>
                      {folded && project.sessions.length > 0 && <span className="meta">{project.sessions.length}</span>}
                    </button>
                    {!folded && project.sessions.map((session) => <SessionRow key={session.id} {...rowProps(session, true)} />)}
                    {!folded && project.sessions.length === 0 && <div className="sb-empty-sub">No sessions yet</div>}
                  </div>
                )
              })}
            </section>

            {model.recents.length > 0 && (
              <section aria-label="Recents">
                <div className="sb-label">
                  <span>Recents</span>
                </div>
                {model.recents.map((session) => (
                  <SessionRow key={session.id} {...rowProps(session)} />
                ))}
              </section>
            )}
            {empty && <div className="sb-empty">No sessions yet.</div>}
          </>
        )}

        {mode === 'activity' && (
          <>
            {groups.map((group) => (
              <section key={group.id} aria-label={group.title}>
                <div className="sb-label">
                  <span>{group.title}</span>
                </div>
                {group.sessions.map((session) => (
                  <ActivityRow
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    status={statusOf(session)}
                    onOpen={() => open(session)}
                    onContext={showMenu}
                  />
                ))}
              </section>
            ))}
            {!groups.length && <div className="sb-empty">Nothing here yet. Sessions that need you, run or finish show up here.</div>}
          </>
        )}

        {mode === 'archived' && (
          <>
            <div className="sb-label">
              <span>Archived</span>
            </div>
            {archived.map((session) => (
              <div key={session.id} className="sb-row sb-session">
                <span className="slot" aria-hidden="true" />
                <span className="title" title={session.title}>
                  {session.title}
                </span>
                <span className="sb-row-actions is-visible">
                  <IconButton label="Restore" size="sm" onClick={() => void sessionActions.restore(session)}>
                    <Undo2 size={14} />
                  </IconButton>
                  <IconButton label="Delete" size="sm" onClick={() => void sessionActions.remove(session)}>
                    <Trash2 size={14} />
                  </IconButton>
                </span>
              </div>
            ))}
            {!archived.length && <div className="sb-empty">No archived sessions. Archive one from its context menu to keep it out of the way.</div>}
          </>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={contextEntries(menu.session)} label="Session" onClose={() => setMenu(null)} />}
    </aside>
  )
}
