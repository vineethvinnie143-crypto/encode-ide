import { create } from '../store'
import type { ReviewAction, ReviewBranches, ReviewCommit, ReviewCommitOutcome, ReviewCommitRequest, ReviewLoad, ReviewOptions, ReviewScope } from '@shared/types'
import { api } from '../api'
import { commentsMessage, scopePhrase } from '../review/comments'
import { forAgent, inRepository } from '../review/paths'
import { toggledForAll, type Anchor, type DiffLayout, type ReviewComment } from '../review/rows'
import { useChat } from './chat'
import { useGit } from './git'
import { usePanels } from './panels'
import { useUi } from './ui'
import { useWorkspace } from './workspace'

export type ScopeKind = ReviewScope['kind']

/** How the lines are drawn; none of it changes what git is asked. */
export interface ReviewView {
  layout: DiffLayout
  /** Marks the words that changed within a line. */
  words: boolean
  /** Long lines wrap; otherwise the list scrolls sideways. */
  wrap: boolean
}

interface ReviewStore {
  kind: ScopeKind
  /** The base of the Branch view; null: the one eNCode picks (the remote's default branch). */
  base: string | null
  /** The commit of the Commit view; null: the latest. */
  commit: string | null
  options: ReviewOptions
  view: ReviewView
  /** The last answer for the scope shown; null before the first. */
  load: ReviewLoad | null
  loading: boolean
  /** Why the main process could not answer, when it could not. */
  error: string | null
  /** The action being done, by key, so its button can show it. */
  busy: string | null
  /** Paths whose folding the person changed from how the file starts. */
  toggled: ReadonlySet<string>
  /** Comments by view, until they are sent. */
  comments: Readonly<Record<string, readonly ReviewComment[]>>
  editing: { anchor: Anchor; comment: ReviewComment | null } | null
  branches: ReviewBranches | null
  commits: ReviewCommit[] | null
  /** A file of the review to bring into view, by its path in the repository. */
  revealPath: string | null

  /** The scope the person chose, as the main process is asked for it; null while the Commit view has no commit yet. */
  scope(): ReviewScope | null
  /** The key of the view, which comments belong to. */
  viewKey(): string
  setKind(kind: ScopeKind): void
  setBase(base: string | null): void
  setCommit(commit: string): void
  setOptions(patch: Partial<ReviewOptions>): void
  setView(patch: Partial<ReviewView>): void
  /** Reads the scope again; asked while a read runs, it reads once more when that one ends. */
  refresh(): Promise<void>
  act(action: ReviewAction): Promise<void>
  undo(): Promise<void>
  toggleFold(path: string): void
  foldAll(fold: boolean): void
  startComment(anchor: Anchor, comment?: ReviewComment): void
  cancelComment(): void
  saveComment(text: string, excerpt: string): void
  removeComment(id: string): void
  /** Hands this view's comments to the agent: sent now, or queued behind the turn that is running. */
  sendComments(): void
  loadBranches(): Promise<void>
  loadCommits(): Promise<void>
  commitChanges(request: ReviewCommitRequest): Promise<ReviewCommitOutcome>
  /**
   * Opens the Review tab at a file, named the way the repository names it or the way the agent's tools and the open
   * folder do. It shows the working tree's changes (in `kind` when given), and the file once a read finds it there.
   */
  showFile(target: string, from: 'repository' | 'folder', kind?: 'unstaged' | 'staged'): void
  /** The file asked for is in view. */
  revealed(): void
  /** Forgets everything about the folder that was open: another one is. Called when the open folder changes. */
  reset(): void
}

const KEY = 'eNCode.review.v1'

interface Saved {
  kind: ScopeKind
  base: string | null
  options: ReviewOptions
  view: ReviewView
}

const DEFAULTS: Saved = { kind: 'unstaged', base: null, options: { context: 3, ignoreWhitespace: false }, view: { layout: 'unified', words: true, wrap: true } }

function loadSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null
    if (!raw || typeof raw !== 'object') return DEFAULTS
    const kind = raw.kind === 'staged' || raw.kind === 'branch' || raw.kind === 'commit' ? raw.kind : 'unstaged'
    const context = raw.options?.context
    return {
      kind,
      base: typeof raw.base === 'string' && raw.base ? raw.base : null,
      options: {
        // Infinity does not survive JSON: a whole-file view is saved as null.
        context: context === null ? Infinity : typeof context === 'number' && Number.isInteger(context) && context >= 0 && context <= 1000 ? context : 3,
        ignoreWhitespace: raw.options?.ignoreWhitespace === true,
      },
      view: { layout: raw.view?.layout === 'split' ? 'split' : 'unified', words: raw.view?.words !== false, wrap: raw.view?.wrap !== false },
    }
  } catch {
    return DEFAULTS
  }
}

function save(state: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage may be unavailable */
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Counts reads, so an old answer cannot replace a newer one. */
let generation = 0
let reading: Promise<void> | null = null
let again = false
/** A file `showFile` asked for, answered by the first read that started after the asking. */
let wanted: { target: string; from: 'repository' | 'folder'; after: number } | null = null

/** The file asked for, by its path in the repository, when this read is the one to answer and the review holds it. */
function wantedIn(load: ReviewLoad, mine: number): string | null {
  const request = wanted
  if (!request || mine <= request.after) return null
  wanted = null
  if (!load.ok) return null
  const { snapshot } = load
  const path = request.from === 'repository' ? request.target : inRepository(request.target, snapshot.repo, useWorkspace.getState().workspace?.root ?? null)
  return path && snapshot.files.some((file) => file.path === path) ? path : null
}

export const useReview = create<ReviewStore>((set, get) => {
  const saved = loadSaved()
  const persist = () => {
    const { kind, base, options, view } = get()
    save({ kind, base, options, view })
  }
  /** A new scope or option: what was shown no longer applies. */
  const reload = () => {
    set({ load: null, editing: null })
    persist()
    void get().refresh()
  }
  const show = (load: ReviewLoad, mine: number) => {
    if (mine !== generation) return
    const reveal = wantedIn(load, mine)
    set({ load, error: null, loading: false, ...(reveal ? { revealPath: reveal } : {}) })
  }

  return {
    kind: saved.kind,
    base: saved.base,
    commit: null,
    options: saved.options,
    view: saved.view,
    load: null,
    loading: false,
    error: null,
    busy: null,
    toggled: new Set(),
    comments: {},
    editing: null,
    branches: null,
    commits: null,
    revealPath: null,

    scope: () => {
      const { kind, base, commit, commits } = get()
      if (kind === 'branch') return base ? { kind, base } : { kind }
      if (kind === 'commit') {
        const chosen = commit ?? commits?.[0]?.oid ?? null
        return chosen ? { kind, commit: chosen } : null
      }
      return { kind }
    },

    viewKey: () => {
      const scope = get().scope()
      if (!scope) return 'commit:'
      return scope.kind === 'branch' ? `branch:${scope.base ?? ''}` : scope.kind === 'commit' ? `commit:${scope.commit}` : scope.kind
    },

    setKind: (kind) => {
      if (kind === get().kind) return
      set({ kind })
      reload()
    },
    setBase: (base) => {
      set({ base })
      reload()
    },
    setCommit: (commit) => {
      set({ commit })
      reload()
    },
    setOptions: (patch) => {
      set({ options: { ...get().options, ...patch } })
      reload()
    },
    setView: (patch) => {
      set({ view: { ...get().view, ...patch } })
      persist()
    },

    refresh: async () => {
      if (reading) {
        again = true
        return reading
      }
      const run = async () => {
        do {
          again = false
          const mine = ++generation
          set({ loading: true })
          try {
            if (get().kind === 'commit' && !get().commits) await get().loadCommits()
            const scope = get().scope()
            if (!scope) {
              show({ ok: false, message: 'This repository has no commits yet.' }, mine)
              continue
            }
            show(await api.review.load(scope, get().options), mine)
          } catch (error) {
            if (mine === generation) set({ error: describe(error), loading: false })
          }
        } while (again)
      }
      reading = run().finally(() => {
        reading = null
      })
      return reading
    },

    act: async (action) => {
      const scope = get().scope()
      if (!scope || get().busy) return
      const key = 'hunk' in action ? `${action.type}:${action.hunk}` : 'path' in action ? `${action.type}:${action.path}` : action.type
      set({ busy: key })
      const mine = ++generation
      try {
        const outcome = await api.review.act(scope, action, get().options)
        show(outcome.load, mine)
        if (!outcome.ok) useUi.getState().notify(outcome.stale ? 'info' : 'error', outcome.message)
        else if (outcome.undoable) useUi.getState().notify('success', outcome.message, { label: 'Undo', run: () => void get().undo() })
        void useGit.getState().refresh()
      } catch (error) {
        useUi.getState().notify('error', describe(error))
        void get().refresh()
      } finally {
        set({ busy: null })
      }
    },

    undo: async () => {
      const scope = get().scope()
      if (!scope || get().busy) return
      set({ busy: 'undo' })
      const mine = ++generation
      try {
        const outcome = await api.review.undo(scope, get().options)
        show(outcome.load, mine)
        useUi.getState().notify(outcome.ok ? 'success' : 'info', outcome.message)
        void useGit.getState().refresh()
      } catch (error) {
        useUi.getState().notify('error', describe(error))
      } finally {
        set({ busy: null })
      }
    },

    toggleFold: (path) => {
      const toggled = new Set(get().toggled)
      if (toggled.has(path)) toggled.delete(path)
      else toggled.add(path)
      set({ toggled })
    },
    foldAll: (fold) => {
      const load = get().load
      if (load?.ok) set({ toggled: toggledForAll(load.snapshot.files, fold) })
    },

    startComment: (anchor, comment) => set({ editing: { anchor, comment: comment ?? null } }),
    cancelComment: () => set({ editing: null }),
    saveComment: (text, excerpt) => {
      const editing = get().editing
      const body = text.trim()
      if (!editing) return
      const key = get().viewKey()
      const list = get().comments[key] ?? []
      let next: ReviewComment[]
      if (editing.comment) next = body ? list.map((item) => (item.id === editing.comment!.id ? { ...item, text: body } : item)) : list.filter((item) => item.id !== editing.comment!.id)
      else next = body ? [...list, { id: crypto.randomUUID(), ...editing.anchor, text: body, excerpt }] : [...list]
      set({ comments: { ...get().comments, [key]: next }, editing: null })
    },
    removeComment: (id) => {
      const key = get().viewKey()
      set({ comments: { ...get().comments, [key]: (get().comments[key] ?? []).filter((item) => item.id !== id) } })
    },
    sendComments: () => {
      const key = get().viewKey()
      const list = get().comments[key] ?? []
      const scope = get().scope()
      if (!list.length || !scope) return
      const load = get().load
      const snapshot = load?.ok ? load.snapshot : null
      const text = commentsMessage(list, scopePhrase(scope, snapshot), (path) => (snapshot ? forAgent(path, snapshot.repo) : path))
      const chat = useChat.getState()
      if (chat.running) chat.enqueue(text, { keepDraft: true })
      else chat.send(text, undefined, { keepDraft: true })
      set({ comments: { ...get().comments, [key]: [] }, editing: null })
      // The thread is where the agent answers: a full-width panel steps aside for it.
      if (usePanels.getState().side.layout === 'full') usePanels.getState().setLayout('split')
      useUi.getState().notify('success', chat.running ? `Queued ${list.length === 1 ? 'the comment' : `${list.length} comments`} for when the agent is done.` : `Sent ${list.length === 1 ? 'the comment' : `${list.length} comments`} to the agent.`)
    },

    loadBranches: async () => {
      try {
        set({ branches: await api.review.branches() })
      } catch (error) {
        useUi.getState().notify('error', describe(error))
      }
    },
    loadCommits: async () => {
      try {
        set({ commits: await api.review.commits() })
      } catch (error) {
        set({ commits: [] })
        useUi.getState().notify('error', describe(error))
      }
    },

    commitChanges: async (request) => {
      set({ busy: 'commit' })
      try {
        const outcome = await api.review.commit(request)
        if (outcome.ok) {
          const what = `${outcome.commit.short} ${outcome.commit.subject}`
          if (outcome.pushError) useUi.getState().notify('error', `Committed ${what}, but the push failed: ${outcome.pushError}`)
          else useUi.getState().notify('success', outcome.pushed ? `Committed ${what} and pushed it to ${outcome.pushed}.` : `Committed ${what}.`)
          set({ commits: null })
        }
        return outcome
      } catch (error) {
        return { ok: false, message: describe(error) }
      } finally {
        set({ busy: null })
        void get().refresh()
        void useGit.getState().refresh()
      }
    },

    showFile: (target, from, kind) => {
      const current = get().kind
      // The Branch view holds the working tree's changes too; the Commit view does not.
      const next = kind ?? (current === 'unstaged' || current === 'branch' ? current : 'unstaged')
      wanted = { target, from, after: generation }
      usePanels.getState().open('review')
      if (next !== current) get().setKind(next)
      else void get().refresh()
    },
    revealed: () => set({ revealPath: null }),

    reset: () => {
      generation++
      wanted = null
      set({ load: null, error: null, busy: null, toggled: new Set(), comments: {}, editing: null, branches: null, commits: null, commit: null, revealPath: null })
    },
  }
})

// The review belongs to the open folder: another folder starts it afresh, whether or not the tab is showing.
let folder = useWorkspace.getState().workspace?.root ?? null
useWorkspace.subscribe(() => {
  const next = useWorkspace.getState().workspace?.root ?? null
  if (next === folder) return
  folder = next
  useReview.getState().reset()
})
