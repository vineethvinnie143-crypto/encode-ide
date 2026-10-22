import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { ReviewSnapshot, RewindTurn } from '@shared/types'
import { api } from '../../api'
import { activeKind } from '../../panels/model'
import { useChat } from '../../stores/chat'
import { usePanels } from '../../stores/panels'
import { useReview, type ScopeKind } from '../../stores/review'
import { useSessions } from '../../stores/sessions'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { throttle } from '../../throttle'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { ChevronDown, Columns2, GitBranch, GitPullRequest, MessageSquare, RefreshCw, Rows, Settings2 } from '../../ui/icons'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { SkeletonRows } from '../../ui/Skeleton'
import { Spinner } from '../../ui/Spinner'
import { shortAge } from '../../ui/time'
import CommitDialog from './CommitDialog'
import DiffList from './DiffList'

const SCOPE_LABEL: Record<ScopeKind, string> = {
  unstaged: 'Unstaged',
  staged: 'Staged',
  branch: 'Branch',
  commit: 'Commit',
  turn: 'Last turn',
}

const NO_COMMENTS: readonly unknown[] = []

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/** The first line of a request, short enough for a menu row. */
function requestLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** The view's name and what it is compared with, for the header and the empty state. */
function emptyText(snapshot: ReviewSnapshot): { title: string; detail: string } {
  switch (snapshot.scope.kind) {
    case 'unstaged': {
      const staged = snapshot.counts?.staged ?? 0
      return staged
        ? { title: 'Nothing left to stage', detail: `${plural(staged, 'file')} ${staged === 1 ? 'is' : 'are'} staged and ready to commit.` }
        : { title: 'No changes', detail: 'What you or the agent change in this folder shows up here.' }
    }
    case 'staged':
      return { title: 'Nothing staged', detail: 'Stage files or single changes in the Unstaged view.' }
    case 'branch':
      return snapshot.base
        ? { title: 'No changes on this branch', detail: `It has nothing that ${snapshot.base.ref} does not.` }
        : { title: 'No branch to compare with', detail: 'This repository has no main, master or upstream branch to compare against.' }
    case 'commit':
      return { title: 'This commit changes no file', detail: 'It may be a merge, or only a message.' }
    case 'turn':
      return snapshot.turn?.id
        ? { title: 'Nothing left to review', detail: 'Every file this request changed is back to how it was before it.' }
        : { title: 'No changes from the agent yet', detail: 'What the agent changes with its file tools in this conversation shows up here, one request at a time.' }
  }
}

function ScopeMenu({ snapshot }: { snapshot: ReviewSnapshot | null }) {
  const kind = useReview((state) => state.kind)
  const turn = useReview((state) => state.turn)
  const counts = snapshot?.counts ?? null
  const entries = (): MenuEntry[] => {
    const review = useReview.getState()
    const pick = (next: ScopeKind) => () => review.setKind(next)
    return [
      { kind: 'group', id: 'g-tree', label: 'Working tree' },
      { id: 'unstaged', label: 'Unstaged', description: 'Changes in your files that are not staged', checked: kind === 'unstaged', trailing: counts ? String(counts.unstaged) : undefined, onSelect: pick('unstaged') },
      { id: 'staged', label: 'Staged', description: 'What the next commit takes', checked: kind === 'staged', trailing: counts ? String(counts.staged) : undefined, onSelect: pick('staged') },
      { kind: 'group', id: 'g-history', label: 'History' },
      { id: 'branch', label: 'Branch', description: 'Everything this branch adds to its base', checked: kind === 'branch', onSelect: pick('branch') },
      { id: 'commit', label: 'Commit', description: 'What one commit changed', checked: kind === 'commit', onSelect: pick('commit') },
      { kind: 'group', id: 'g-agent', label: 'Agent' },
      {
        id: 'turn',
        label: 'Last turn',
        description: 'What the agent changed for your latest request, with or without git',
        checked: kind === 'turn',
        onSelect: () => (kind === 'turn' ? review.setTurn(null) : review.setKind('turn')),
      },
    ]
  }
  const count = counts ? (kind === 'unstaged' ? counts.unstaged : kind === 'staged' ? counts.staged : null) : null
  return (
    <Menu
      label="What to review"
      width={300}
      entries={entries}
      trigger={(props) => (
        <button type="button" className="rv-scope" {...props}>
          <span>{kind === 'turn' && turn !== null ? 'Agent turn' : SCOPE_LABEL[kind]}</span>
          {count !== null && count > 0 && <span className="rv-count">{count}</span>}
          <ChevronDown size={14} />
        </button>
      )}
    />
  )
}

/**
 * The request of the Turn view: the latest one that changed files (the default, which follows new requests), or one
 * chosen from the conversation's requests that changed files, newest first.
 */
function TurnMenu({ snapshot }: { snapshot: ReviewSnapshot | null }) {
  const chosen = useReview((state) => state.turn)
  const sessionId = useSessions((state) => state.activeId)
  const entries = useChat((state) => state.entries)
  const [turns, setTurns] = useState<readonly RewindTurn[] | null>(null)
  // Read again with each review, so a request that changed files since is listed.
  useEffect(() => {
    if (!sessionId) return
    let live = true
    api.agent.checkpoints(sessionId).then(
      (info) => live && setTurns(info.available ? info.turns : []),
      () => live && setTurns([]),
    )
    return () => {
      live = false
    }
  }, [sessionId, snapshot])
  const requests = useMemo(() => new Map(entries.filter((entry) => entry.kind === 'user').map((entry) => [entry.id, entry.text ?? ''])), [entries])
  const shown = snapshot?.scope.kind === 'turn' ? (snapshot.turn ?? null) : null
  const shownText = shown?.id ? requests.get(shown.id) : undefined
  const list = (): MenuEntry[] => {
    const review = useReview.getState()
    // A request the conversation no longer holds (it went back past it) is not offered.
    const listed = (turns ?? []).filter((turn) => turn.files > 0 && requests.has(turn.turn)).reverse()
    return [
      { id: '@latest', label: 'Latest request', description: 'Follows each new request that changes files', checked: chosen === null, onSelect: () => review.setTurn(null) },
      ...(listed.length ? [{ kind: 'separator' as const, id: 'sep' }] : []),
      ...listed.map((turn) => ({
        id: turn.turn,
        label: requestLine(requests.get(turn.turn) ?? '') || '(no text)',
        description: `${plural(turn.files, 'file')} · ${shortAge(turn.at)}`,
        checked: chosen === turn.turn,
        onSelect: () => review.setTurn(turn.turn),
      })),
    ]
  }
  return (
    <Menu
      label="Request"
      width={360}
      entries={list}
      trigger={(props) => (
        <button type="button" className="rv-chip-select rv-turn-chip" title={shownText ? requestLine(shownText) : 'Choose a request'} {...props}>
          <MessageSquare size={13} />
          <span className="rv-chip-text">{shownText !== undefined ? requestLine(shownText) || '(no text)' : shown ? 'No request yet' : '…'}</span>
          {shown?.at !== undefined && <span className="rv-chip-mono">{shortAge(shown.at)}</span>}
          <ChevronDown size={13} />
        </button>
      )}
    />
  )
}

/** The base of the Branch view, chosen from the repository's branches. */
function BaseMenu({ snapshot }: { snapshot: ReviewSnapshot | null }) {
  const base = useReview((state) => state.base)
  const branches = useReview((state) => state.branches)
  useEffect(() => {
    if (!branches) void useReview.getState().loadBranches()
  }, [branches])
  const shown = (snapshot?.scope.kind === 'branch' ? snapshot.base?.ref : null) ?? base ?? branches?.base ?? 'base'
  const entries = (): MenuEntry[] => {
    const fallback = branches?.base ?? null
    // The default base is listed once, first; choosing it follows whatever the default is.
    const refs = (branches?.refs ?? []).filter((ref) => ref !== branches?.current && ref !== fallback)
    return [
      { id: '@default', label: fallback ?? 'Default', description: 'The default base', checked: base === null || base === fallback, onSelect: () => useReview.getState().setBase(null) },
      ...(refs.length ? [{ kind: 'separator' as const, id: 'sep' }] : []),
      ...refs.map((ref) => ({ id: ref, label: ref, checked: base === ref, onSelect: () => useReview.getState().setBase(ref) })),
    ]
  }
  return (
    <Menu
      label="Compare with"
      width={280}
      entries={entries}
      trigger={(props) => (
        <button type="button" className="rv-chip-select" title="Compare with another branch" {...props}>
          <GitBranch size={13} />
          <span className="rv-chip-text">vs {shown}</span>
          <ChevronDown size={13} />
        </button>
      )}
    />
  )
}

/** The commit of the Commit view, from the latest ones on HEAD. */
function CommitMenu({ snapshot }: { snapshot: ReviewSnapshot | null }) {
  const commits = useReview((state) => state.commits)
  const chosen = useReview((state) => state.commit)
  useEffect(() => {
    if (!commits) void useReview.getState().loadCommits()
  }, [commits])
  const current = snapshot?.commit ?? commits?.find((commit) => commit.oid === chosen) ?? commits?.[0]
  const entries = (): MenuEntry[] =>
    (commits ?? []).map((commit) => ({
      id: commit.oid,
      label: commit.subject || '(no message)',
      description: `${commit.short} · ${commit.author} · ${shortAge(commit.time * 1000)}`,
      checked: commit.oid === current?.oid,
      onSelect: () => useReview.getState().setCommit(commit.oid),
    }))
  return (
    <Menu
      label="Commit"
      width={360}
      entries={entries}
      trigger={(props) => (
        <button type="button" className="rv-chip-select" title={current ? `${current.short} ${current.subject}` : 'Choose a commit'} {...props}>
          <span className="rv-chip-mono">{current?.short ?? '…'}</span>
          <span className="rv-chip-text">{current?.subject ?? ''}</span>
          <ChevronDown size={13} />
        </button>
      )}
    />
  )
}

function OptionsMenu({ undo }: { undo: string | null }) {
  const view = useReview((state) => state.view)
  const options = useReview((state) => state.options)
  const entries = (): MenuEntry[] => {
    const review = useReview.getState()
    return [
      { kind: 'group', id: 'g-layout', label: 'Layout' },
      { id: 'unified', label: 'Unified', checked: view.layout === 'unified', onSelect: () => review.setView({ layout: 'unified' }) },
      { id: 'split', label: 'Side by side', checked: view.layout === 'split', onSelect: () => review.setView({ layout: 'split' }) },
      { id: 'wrap', label: 'Wrap long lines', checked: view.wrap, onSelect: () => review.setView({ wrap: !view.wrap }) },
      { kind: 'group', id: 'g-show', label: 'Show' },
      { id: 'words', label: 'Changed words', checked: view.words, onSelect: () => review.setView({ words: !view.words }) },
      { id: 'space', label: 'Whitespace changes', checked: !options.ignoreWhitespace, onSelect: () => review.setOptions({ ignoreWhitespace: !options.ignoreWhitespace }) },
      { kind: 'group', id: 'g-context', label: 'Lines around each change' },
      { id: 'c3', label: '3 lines', checked: options.context === 3, onSelect: () => review.setOptions({ context: 3 }) },
      { id: 'c10', label: '10 lines', checked: options.context === 10, onSelect: () => review.setOptions({ context: 10 }) },
      { id: 'cAll', label: 'Whole file', checked: options.context === Infinity, onSelect: () => review.setOptions({ context: Infinity }) },
      { kind: 'separator', id: 'sep-fold' },
      { id: 'fold', label: 'Fold all files', onSelect: () => review.foldAll(true) },
      { id: 'open', label: 'Open all files', onSelect: () => review.foldAll(false) },
      ...(undo ? [{ kind: 'separator' as const, id: 'sep-undo' }, { id: 'undo', label: `Undo: ${undo}`, shortcut: 'Ctrl+Z', onSelect: () => void review.undo() }] : []),
    ]
  }
  return (
    <Menu
      label="Review options"
      align="end"
      width={260}
      entries={entries}
      trigger={(props) => (
        <IconButton label="Review options" size="md" {...props}>
          <Settings2 size={15} />
        </IconButton>
      )}
    />
  )
}

/**
 * The Review tab: the open folder's changes by scope (unstaged, staged, the branch against its base, one commit, or
 * what one of the agent's turns changed), as diffs to read, stage, unstage or revert by file or by hunk, with comments
 * that go to the agent and a Commit dialog whose message the model drafts. It reads the changes again when files
 * change, when the agent finishes, and when eNCode comes back to the front.
 */
export default function ReviewPane() {
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const visible = usePanels((state) => state.side.layout !== 'hidden' && activeKind(state.side) === 'review')
  const kind = useReview((state) => state.kind)
  const load = useReview((state) => state.load)
  const loading = useReview((state) => state.loading)
  const error = useReview((state) => state.error)
  const busy = useReview((state) => state.busy)
  const viewKey = useReview((state) => state.viewKey())
  const comments = useReview((state) => state.comments[state.viewKey()] ?? NO_COMMENTS)
  const view = useReview((state) => state.view)
  const running = useChat((state) => state.running)
  // The Turn view is the open conversation's: another conversation is read afresh.
  const conversation = useSessions((state) => (kind === 'turn' ? state.activeId : null))
  const [committing, setCommitting] = useState(false)

  // While the tab is in front, the changes are read again when something may have changed them.
  useEffect(() => {
    if (!visible || !root) return
    void useReview.getState().refresh()
    const refresh = throttle(() => void useReview.getState().refresh(), 400)
    const offFiles = api.workspace.onFileChanged(() => refresh())
    const offAgent = api.agent.onEvent((event) => {
      if (event.type === 'done' || event.type === 'file-changed') refresh()
      // The Turn view is read-only while the agent works, and its requests change when the conversation goes back.
      else if ((event.type === 'status' || event.type === 'error' || event.type === 'session-reset') && useReview.getState().kind === 'turn') refresh()
    })
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      offFiles()
      offAgent()
      window.removeEventListener('focus', onFocus)
      refresh.cancel()
    }
  }, [visible, root, conversation])

  const snapshot = load?.ok ? load.snapshot : null
  const undo = load?.ok ? load.undo : null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('textarea, input')) return
    if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey && undo) {
      event.preventDefault()
      void useReview.getState().undo()
    }
  }

  const totals = useMemo(() => {
    if (!snapshot) return null
    return { files: snapshot.files.length, added: snapshot.added, removed: snapshot.removed }
  }, [snapshot])

  if (!root) {
    return (
      <div className="review-pane">
        <div className="panel-empty">
          <GitPullRequest size={20} />
          <span>Open a folder to review its changes.</span>
        </div>
      </div>
    )
  }

  const act = useReview.getState().act
  const editable = snapshot !== null && !snapshot.readOnly && snapshot.files.length > 0
  const working = snapshot !== null && (snapshot.scope.kind === 'unstaged' || snapshot.scope.kind === 'staged')
  const counts = snapshot?.counts ?? null
  const committable = working && counts !== null && counts.staged + counts.unstaged > 0
  // In the Turn view a file can be fixed (changed again by a later request, or with no known earlier version).
  const revertible = editable && snapshot.scope.kind === 'turn' && snapshot.files.some((file) => !file.fixed)
  const locked = busy !== null
  const failed = load !== null && !load.ok

  return (
    <div className="review-pane" onKeyDown={onKeyDown}>
      <div className="rv-bar">
        <ScopeMenu snapshot={snapshot} />
        {kind === 'branch' && <BaseMenu snapshot={snapshot} />}
        {kind === 'commit' && <CommitMenu snapshot={snapshot} />}
        {kind === 'turn' && <TurnMenu snapshot={snapshot} />}
        <span className="rv-bar-fill" />
        {totals && totals.files > 0 && (
          <span className="rv-totals" title={`${totals.files} ${totals.files === 1 ? 'file' : 'files'}`}>
            <span className="add-stat">+{totals.added}</span>
            <span className="del-stat">−{totals.removed}</span>
          </span>
        )}
        {loading && <Spinner size={14} className="rv-loading" label="Reading the changes" />}
        <IconButton label="Refresh" size="md" onClick={() => void useReview.getState().refresh()}>
          <RefreshCw size={15} />
        </IconButton>
        {!failed && (
          <>
            <IconButton
              label={view.layout === 'split' ? 'Unified layout' : 'Side by side'}
              size="md"
              active={view.layout === 'split'}
              onClick={() => useReview.getState().setView({ layout: view.layout === 'split' ? 'unified' : 'split' })}
            >
              {view.layout === 'split' ? <Rows size={15} /> : <Columns2 size={15} />}
            </IconButton>
            <OptionsMenu undo={undo} />
          </>
        )}
      </div>

      {error && !snapshot && (
        <div className="panel-empty">
          <span>eNCode could not read the changes: {error}</span>
          <Button size="sm" onClick={() => void useReview.getState().refresh()}>
            Try again
          </Button>
        </div>
      )}
      {load && !load.ok && (
        <div className="panel-empty">
          {kind === 'turn' ? <MessageSquare size={20} /> : <GitBranch size={20} />}
          <span>{load.message}</span>
          {kind !== 'turn' && (
            // A folder without git still has the agent's own record of what it changed.
            <Button size="sm" onClick={() => useReview.getState().setKind('turn')}>
              Review the agent’s last turn
            </Button>
          )}
        </div>
      )}
      {!load && !error && (
        <div className="rv-skeleton">
          <SkeletonRows rows={6} label="Reading the changes" />
        </div>
      )}
      {snapshot?.turn?.busy && snapshot.files.length > 0 && <div className="rv-banner is-quiet">eNCode is working on this conversation. Its changes can be reverted once it is done.</div>}
      {snapshot && snapshot.skipped > 0 && (
        <div className="rv-banner">
          {snapshot.scope.kind === 'turn'
            ? `${plural(snapshot.skipped, 'file')} ${snapshot.skipped === 1 ? 'is listed without its changes' : 'are listed without their changes'}: this request changed more than the review reads at once.`
            : `${snapshot.skipped} ${snapshot.skipped === 1 ? 'file is' : 'files are'} not shown: this review is too large to read at once. Commit or stage part of it to see the rest.`}
        </div>
      )}
      {snapshot &&
        (snapshot.files.length ? (
          <DiffList key={viewKey} snapshot={snapshot} />
        ) : (
          <div className="panel-empty rv-empty">
            <GitPullRequest size={22} />
            <strong>{emptyText(snapshot).title}</strong>
            <span>{emptyText(snapshot).detail}</span>
          </div>
        ))}

      {snapshot && ((editable && snapshot.scope.kind !== 'turn') || revertible || committable || comments.length > 0) && (
        <div className="rv-foot">
          {comments.length > 0 && (
            <Button size="sm" variant="primary" icon={<MessageSquare size={14} />} onClick={() => useReview.getState().sendComments()} title={running ? 'Queued until the agent is done' : undefined}>
              {running ? 'Queue' : 'Send'} {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            </Button>
          )}
          <span className="rv-bar-fill" />
          {snapshot.scope.kind === 'unstaged' && editable && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={async () => {
                  const ok = await useUi.getState().askConfirm({
                    title: 'Revert every unstaged change?',
                    body: 'Files go back to how they are staged, or to the last commit. New files go to the Recycle Bin. You can undo this right after.',
                    confirmLabel: 'Revert all',
                    danger: true,
                  })
                  if (ok) void act({ type: 'revert-all' })
                }}
              >
                Revert all
              </Button>
              <Button size="sm" disabled={locked} onClick={() => void act({ type: 'stage-all' })}>
                Stage all
              </Button>
            </>
          )}
          {snapshot.scope.kind === 'staged' && editable && (
            <Button size="sm" disabled={locked} onClick={() => void act({ type: 'unstage-all' })}>
              Unstage all
            </Button>
          )}
          {revertible && (
            <Button
              size="sm"
              className="rv-revert-turn"
              disabled={locked}
              onClick={async () => {
                const fixed = snapshot.files.filter((file) => file.fixed).length
                const ok = await useUi.getState().askConfirm({
                  title: 'Revert what this request changed?',
                  body: `Each file goes back to how it was before the request, and files it created are deleted.${fixed ? ` ${plural(fixed, 'file')} marked read only ${fixed === 1 ? 'stays' : 'stay'} as ${fixed === 1 ? 'it is' : 'they are'}.` : ''} You can undo this right after.`,
                  confirmLabel: 'Revert all',
                  danger: true,
                })
                if (ok) void act({ type: 'revert-all' })
              }}
            >
              Revert all
            </Button>
          )}
          {committable && (
            <Button size="sm" variant={comments.length ? 'default' : 'primary'} className={cx('rv-commit')} disabled={locked} onClick={() => setCommitting(true)}>
              Commit…
            </Button>
          )}
        </div>
      )}
      {snapshot && <CommitDialog open={committing} onClose={() => setCommitting(false)} snapshot={snapshot} />}
    </div>
  )
}
