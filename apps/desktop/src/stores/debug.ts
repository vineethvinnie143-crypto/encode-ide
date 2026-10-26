/**
 * The open folder's debugger as the panel and the editor see it (ADR 0143): its runs and where they are paused, the
 * frame the panel shows with its scopes and watches, the breakpoints of each file, and what the runs printed. The
 * agent host holds the runs and keeps the breakpoints; this store follows it and sends it what the person changes.
 */
import { create } from '../store'
import type { DebugAction, DebugBreakpoint, DebugConfigs, DebugEvaluateResult, DebugExceptionFilters, DebugOutputLine, DebugScope, DebugState, DebugVariable } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { addAt, chooseFrame, currentRun, frameOf, moveLines, placeOf, plain, toggleAt, type FrameChoice } from '../panels/debug'
import { useEditor } from './editor'
import { usePanels } from './panels'
import { useUi } from './ui'

export interface ConsoleItem {
  id: number
  /** What a run printed, what the person typed, and what it gave back. */
  kind: DebugOutputLine['category'] | 'input' | 'result' | 'failed'
  text: string
  source?: { path: string; line: number }
  /** A value with children, opened like a variable. */
  ref?: number
  run?: string
}

interface DebugStore {
  /** As last read; null when no folder is open or the debugger cannot be reached. */
  state: DebugState | null
  configs: DebugConfigs | null
  /** The configuration the toolbar starts, by id. */
  chosen: string | null
  /** The frame the panel shows. */
  frame: FrameChoice | null
  scopes: DebugScope[]
  /** The children of an opened value, by its reference; `loading` while they are asked for. */
  children: Record<number, DebugVariable[] | 'loading'>
  console: ConsoleItem[]
  watches: string[]
  watchValues: Record<string, DebugEvaluateResult>

  refresh(): Promise<void>
  loadConfigs(): Promise<void>
  choose(id: string): void
  /** Starts the chosen configuration (or `id`); a configuration of the file runs the editor's file. */
  start(id?: string): Promise<void>
  /** Continue, pause, step, stop or restart the run in front, on the program the panel shows. */
  act(action: DebugAction): Promise<void>
  /** F5: continues a paused run, starts one when none runs. */
  continueOrStart(): Promise<void>
  dismiss(run: string): Promise<void>
  selectFrame(choice: FrameChoice): void
  open(ref: number): Promise<void>
  evaluate(text: string): Promise<void>
  addWatch(expression: string): void
  removeWatch(index: number): void
  clearConsole(): void

  toggleBreakpoint(path: string, line: number): void
  addBreakpoint(path: string, line: number, extra: Pick<DebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage'>): void
  /** Changes a breakpoint, or (null) takes it away. */
  editBreakpoint(path: string, id: string, patch: Partial<Pick<DebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage' | 'enabled'>> | null): void
  /** An edit moved lines: the file's breakpoints follow them. */
  moveBreakpoints(path: string, moved: (line: number) => number): void
  removeAllBreakpoints(): void
  setExceptions(filters: DebugExceptionFilters): void
}

const WATCH_KEY = 'encode.debug.watches'
const CHOSEN_KEY = 'encode.debug.chosen'
const MAX_CONSOLE = 5_000
const MAX_WATCHES = 50
/** Breakpoints moved by typing go to the host once typing pauses. */
const MOVE_DELAY_MS = 300

function readList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_WATCHES) : []
  } catch {
    return []
  }
}

function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not kept: it comes back empty next time.
  }
}

function readChosen(): string | null {
  try {
    return localStorage.getItem(CHOSEN_KEY)
  } catch {
    return null
  }
}

let nextItem = 1
/** Counts reads of the state, so a slow old answer cannot replace a newer one. */
let generation = 0
/** Where the program was last paused, so the editor goes there once, not at every change. */
let shownPause: string | null = null
const moveTimers = new Map<string, number>()
/** Breakpoints moved by typing that the host has not been told of yet, by file: a state read meanwhile keeps them. */
const pendingMoves = new Map<string, DebugBreakpoint[]>()

/** The host's state with the moves it has not been told of yet: each moved breakpoint on its new line, its run state kept. */
function withPending(state: DebugState | null): DebugState | null {
  if (!state || !pendingMoves.size) return state
  const breakpoints = { ...state.breakpoints }
  for (const [path, list] of pendingMoves) {
    const before = new Map((breakpoints[path] ?? []).map((item) => [item.id, item]))
    breakpoints[path] = list.map((item) => {
      const was = before.get(item.id)
      if (!was) return item
      const { placed: _placed, ...kept } = was
      return { ...kept, ...item }
    })
  }
  return { ...state, breakpoints }
}

export const useDebug = create<DebugStore>((set, get) => {
  const notify = (text: string) => useUi.getState().notify('error', text)

  /** The breakpoints of a file as they stand here, sent to the host; what it says back comes with the next state. */
  const sendBreakpoints = (path: string, list: DebugBreakpoint[]) => {
    window.clearTimeout(moveTimers.get(path))
    moveTimers.delete(path)
    pendingMoves.delete(path)
    const state = get().state
    if (state) set({ state: { ...state, breakpoints: { ...state.breakpoints, [path]: list } } })
    void api.debug
      .setBreakpoints(path, list)
      .then((result) => {
        if (!result.ok) {
          notify(result.reason)
          void get().refresh()
        }
      })
      .catch((error: unknown) => notify(errorText(error)))
  }
  const listOf = (path: string): DebugBreakpoint[] => (get().state?.breakpoints[path] ?? []).map(plain)

  /** The scopes and watches of the frame shown, read again. */
  const loadFrame = async () => {
    const { frame, watches } = get()
    if (!frame) return set({ scopes: [], children: {}, watchValues: {} })
    const scopes = await api.debug.scopes(frame.run, frame.frame).catch(() => [] as DebugScope[])
    if (get().frame !== frame) return
    set({ scopes, children: {} })
    // The first scope that is not costly opens by itself, as the person nearly always wants it.
    const first = scopes.find((scope) => !scope.expensive)
    if (first) void get().open(first.ref)
    const values: Record<string, DebugEvaluateResult> = {}
    await Promise.all(
      watches.map(async (expression) => {
        values[expression] = await api.debug.evaluate(frame.run, expression, { frame: frame.frame, thread: frame.thread, context: 'watch' }).catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
      }),
    )
    if (get().frame === frame) set({ watchValues: values })
  }

  return {
    state: null,
    configs: null,
    chosen: readChosen(),
    frame: null,
    scopes: [],
    children: {},
    console: [],
    watches: readList(WATCH_KEY),
    watchValues: {},

    refresh: async () => {
      const mine = ++generation
      const state = withPending(await api.debug.state().catch(() => null))
      if (mine !== generation) return
      const before = get().frame
      const frame = chooseFrame(state, before)
      const same = before && frame && before.run === frame.run && before.thread === frame.thread && before.frame === frame.frame
      set({ state, ...(same ? {} : { frame }) })
      if (!same) void loadFrame()
      // A program that paused somewhere new: the editor shows the line, and the panel comes up.
      const place = placeOf(state, frame)
      const key = place && frame ? `${frame.run}:${frame.thread}:${place.path}:${place.line}:${frameOf(state, frame)?.thread.reason ?? ''}` : null
      if (key && key !== shownPause && place) {
        void useEditor.getState().openAt(place.path, { start: { line: place.line - 1, character: 0 }, end: { line: place.line - 1, character: 0 } })
        usePanels.getState().openBottom('debug')
      }
      shownPause = key
    },

    loadConfigs: async () => {
      const configs = await api.debug.configs().catch(() => null)
      set({ configs })
      const { chosen } = get()
      if (configs && (!chosen || !configs.configs.some((item) => item.id === chosen))) set({ chosen: configs.configs[0]?.id ?? null })
    },

    choose: (id) => {
      set({ chosen: id })
      try {
        localStorage.setItem(CHOSEN_KEY, id)
      } catch {
        // Not kept.
      }
    },

    start: async (id) => {
      if (!get().configs) await get().loadConfigs()
      const configs = get().configs
      const configId = id ?? get().chosen ?? configs?.configs[0]?.id
      const config = configs?.configs.find((item) => item.id === configId)
      if (!config) return notify('There is nothing to debug here yet. Open a folder, then a file to run.')
      if (config.problem) return notify(config.problem)
      const editor = useEditor.getState()
      const file = config.file ? editor.activePath : undefined
      if (config.file && !file) return notify('Open the file to debug first.')
      usePanels.getState().openBottom('debug')
      const result = await api.debug.start(config.id, file ?? undefined).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }))
      if (!result.ok) {
        set({ console: [...get().console, { id: nextItem++, kind: 'failed' as const, text: result.reason }].slice(-MAX_CONSOLE) })
        return notify(result.reason)
      }
      await get().refresh()
    },

    act: async (action) => {
      const { state, frame } = get()
      const run = currentRun(state, frame)
      if (!run) return
      const thread = action.thread ?? (frame && frame.run === run.id ? frame.thread : run.threads.find((item) => item.state === 'paused')?.id)
      const result = await api.debug.act(run.id, { ...action, ...(thread !== undefined ? { thread } : {}) }).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }))
      if (!result.ok) notify(result.reason)
      await get().refresh()
    },

    continueOrStart: async () => {
      const run = currentRun(get().state, get().frame)
      if (!run) return get().start()
      if (run.threads.some((thread) => thread.state === 'paused')) return get().act({ kind: 'continue' })
    },

    dismiss: async (run) => {
      await api.debug.act(run, { kind: 'dismiss' }).catch(() => undefined)
      await get().refresh()
    },

    selectFrame: (choice) => {
      set({ frame: choice })
      void loadFrame()
      const place = placeOf(get().state, choice)
      if (place) void useEditor.getState().openAt(place.path, { start: { line: place.line - 1, character: 0 }, end: { line: place.line - 1, character: 0 } })
    },

    open: async (ref) => {
      const frame = get().frame
      const run = frame?.run ?? currentRun(get().state, frame)?.id
      if (!run || get().children[ref]) return
      set({ children: { ...get().children, [ref]: 'loading' } })
      const list = await api.debug.variables(run, ref).catch(() => [] as DebugVariable[])
      set({ children: { ...get().children, [ref]: list } })
    },

    evaluate: async (text) => {
      const expression = text.trim()
      if (!expression) return
      const { state, frame } = get()
      const run = currentRun(state, frame)
      const input: ConsoleItem = { id: nextItem++, kind: 'input', text: expression }
      if (!run) return set({ console: [...get().console, input, { id: nextItem++, kind: 'failed' as const, text: 'Start a run first: the console reads values of a running program.' }].slice(-MAX_CONSOLE) })
      set({ console: [...get().console, input].slice(-MAX_CONSOLE) })
      const on = frame && frame.run === run.id ? { frame: frame.frame, thread: frame.thread } : {}
      const result = await api.debug.evaluate(run.id, expression, { ...on, context: 'repl' }).catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
      const item: ConsoleItem = result.ok ? { id: nextItem++, kind: 'result', text: result.value, run: run.id, ...(result.ref ? { ref: result.ref } : {}) } : { id: nextItem++, kind: 'failed', text: result.message }
      set({ console: [...get().console, item].slice(-MAX_CONSOLE) })
      // What the expression did may change what the panel shows.
      void loadFrame()
    },

    addWatch: (expression) => {
      const text = expression.trim()
      if (!text || get().watches.includes(text)) return
      const watches = [...get().watches, text].slice(-MAX_WATCHES)
      set({ watches })
      keep(WATCH_KEY, watches)
      void loadFrame()
    },

    removeWatch: (index) => {
      const watches = get().watches.filter((_, at) => at !== index)
      set({ watches })
      keep(WATCH_KEY, watches)
    },

    clearConsole: () => set({ console: [] }),

    toggleBreakpoint: (path, line) => sendBreakpoints(path, toggleAt(listOf(path), line)),
    addBreakpoint: (path, line, extra) => sendBreakpoints(path, addAt(listOf(path), line, extra)),
    editBreakpoint: (path, id, patch) => {
      const list = listOf(path)
      if (patch === null) return sendBreakpoints(path, list.filter((item) => item.id !== id))
      sendBreakpoints(
        path,
        list.map((item) => {
          if (item.id !== id) return item
          const next: DebugBreakpoint = { ...item, ...patch }
          for (const key of ['condition', 'hitCondition', 'logMessage'] as const) if (!next[key]?.trim()) delete next[key]
          return next
        }),
      )
    },
    moveBreakpoints: (path, moved) => {
      const state = get().state
      const list = state?.breakpoints[path]
      if (!state || !list?.length) return
      const next = moveLines(list.map(plain), moved)
      if (!next) return
      // Drawn where they went at once; told to the host once typing pauses.
      pendingMoves.set(path, next)
      set({ state: withPending(state) })
      window.clearTimeout(moveTimers.get(path))
      moveTimers.set(
        path,
        window.setTimeout(() => {
          const list = pendingMoves.get(path)
          if (list) sendBreakpoints(path, list)
        }, MOVE_DELAY_MS),
      )
    },
    removeAllBreakpoints: () => {
      for (const path of Object.keys(get().state?.breakpoints ?? {})) sendBreakpoints(path, [])
    },
    setExceptions: (filters) => {
      const state = get().state
      if (state) set({ state: { ...state, exceptions: filters } })
      void api.debug.setExceptions(filters).then((result) => {
        if (!result.ok) notify(result.reason)
      })
    },
  }
})

/** What a run printed, as it arrives; a burst is added in one change. */
export function appendDebugOutput(run: string, lines: DebugOutputLine[]): void {
  if (!lines.length) return
  const items = lines.map((line): ConsoleItem => ({ id: nextItem++, kind: line.category, text: line.text, run, ...(line.source ? { source: line.source } : {}) }))
  useDebug.setState({ console: [...useDebug.getState().console, ...items].slice(-MAX_CONSOLE) })
}

/** The folder changed: what was shown of the last one goes. */
export function resetDebug(): void {
  generation++
  shownPause = null
  for (const timer of moveTimers.values()) window.clearTimeout(timer)
  moveTimers.clear()
  pendingMoves.clear()
  useDebug.setState({ state: null, configs: null, frame: null, scopes: [], children: {}, console: [], watchValues: {} })
}

/**
 * The value a hover shows while the program is paused in `path`: of `expression`, in the frame the panel shows. Null
 * when nothing is paused there, or the expression cannot be read without running something (V8 refuses those).
 */
export async function debugHoverValue(path: string, expression: string): Promise<string | null> {
  const { state, frame } = useDebug.getState()
  const place = placeOf(state, frame)
  if (!frame || !place || place.path !== path) return null
  const result = await api.debug.evaluate(frame.run, expression, { frame: frame.frame, thread: frame.thread, context: 'hover' }).catch(() => null)
  return result?.ok && result.value ? result.value : null
}
