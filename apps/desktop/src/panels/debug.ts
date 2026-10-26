/**
 * The debug panel and the editor's breakpoints as data (ADR 0143): which frame is chosen, where the program is
 * paused, how a breakpoint is drawn and what the toolbar offers. Pure, so they are unit tested.
 */
import type { DebugBreakpoint, DebugFolderBreakpoint, DebugFrame, DebugRun, DebugState, DebugThread } from '@shared/types'

/** The frame the panel shows: of a run, one of its programs, and a frame of its stack. */
export interface FrameChoice {
  run: string
  thread: number
  frame: number
}

/** A place in a file of the folder, 1-based. */
export interface DebugPlace {
  path: string
  line: number
}

const live = (run: DebugRun) => run.state !== 'ended'

/** The first frame worth showing: the person's own code, else the top. */
export function firstFrame(thread: DebugThread): DebugFrame | null {
  const frames = thread.frames ?? []
  return frames.find((frame) => !frame.skipped && frame.source?.rel) ?? frames.find((frame) => !frame.skipped) ?? frames[0] ?? null
}

/**
 * The frame to show after the state changed: the chosen one while its program is still paused there, else the first
 * paused program's first frame worth showing (the newest run's first), else none.
 */
export function chooseFrame(state: DebugState | null, chosen: FrameChoice | null): FrameChoice | null {
  if (!state) return null
  if (chosen) {
    const thread = state.runs.find((run) => run.id === chosen.run && live(run))?.threads.find((item) => item.id === chosen.thread)
    if (thread?.state === 'paused' && thread.frames?.some((frame) => frame.id === chosen.frame)) return chosen
    // The same program paused again elsewhere: its new place.
    if (thread?.state === 'paused') {
      const frame = firstFrame(thread)
      if (frame) return { run: chosen.run, thread: thread.id, frame: frame.id }
    }
  }
  for (const run of [...state.runs].reverse()) {
    if (!live(run)) continue
    for (const thread of run.threads) {
      if (thread.state !== 'paused') continue
      const frame = firstFrame(thread)
      if (frame) return { run: run.id, thread: thread.id, frame: frame.id }
    }
  }
  return null
}

export function frameOf(state: DebugState | null, choice: FrameChoice | null): { run: DebugRun; thread: DebugThread; frame: DebugFrame; top: boolean } | null {
  if (!state || !choice) return null
  const run = state.runs.find((item) => item.id === choice.run)
  const thread = run?.threads.find((item) => item.id === choice.thread)
  const frames = thread?.frames ?? []
  const index = frames.findIndex((item) => item.id === choice.frame)
  if (!run || !thread || index < 0) return null
  return { run, thread, frame: frames[index]!, top: index === 0 }
}

/** A row of the call stack: a frame, or frames of code the person did not write, folded into one. */
export type StackRow = { kind: 'frame'; frame: DebugFrame } | { kind: 'fold'; frames: DebugFrame[] }

/** The call stack as rows: two or more skipped frames in a row fold into one, unless the panel shows one of them. */
export function stackRows(frames: readonly DebugFrame[], chosen: number | null): StackRow[] {
  const rows: StackRow[] = []
  let run: DebugFrame[] = []
  const flush = () => {
    if (run.length > 1 && !run.some((frame) => frame.id === chosen)) rows.push({ kind: 'fold', frames: run })
    else for (const frame of run) rows.push({ kind: 'frame', frame })
    run = []
  }
  for (const frame of frames) {
    if (frame.skipped) {
      run.push(frame)
      continue
    }
    flush()
    rows.push({ kind: 'frame', frame })
  }
  flush()
  return rows
}

/** Where the chosen frame is, in a file of the folder; null for code outside it or no file at all. */
export function placeOf(state: DebugState | null, choice: FrameChoice | null): (DebugPlace & { top: boolean }) | null {
  const found = frameOf(state, choice)
  const rel = found?.frame.source?.rel
  return found && rel ? { path: rel, line: found.frame.line, top: found.top } : null
}

/** The run the toolbar acts on: the chosen frame's, else the newest that has not ended. */
export function currentRun(state: DebugState | null, choice: FrameChoice | null): DebugRun | null {
  if (!state) return null
  const chosen = choice ? state.runs.find((run) => run.id === choice.run && live(run)) : undefined
  return chosen ?? [...state.runs].reverse().find(live) ?? null
}

/** What the toolbar offers for a run: nothing running, running, or paused. */
export type ToolbarMode = 'idle' | 'starting' | 'running' | 'paused'

export function toolbarMode(run: DebugRun | null): ToolbarMode {
  if (!run || run.state === 'ended') return 'idle'
  if (run.state === 'starting') return 'starting'
  return run.threads.some((thread) => thread.state === 'paused') ? 'paused' : 'running'
}

/** The class the editor's gutter draws a breakpoint with (editor-view's style.css). */
export function breakpointClass(breakpoint: DebugFolderBreakpoint): string {
  if (!breakpoint.enabled) return breakpoint.logMessage ? 'enc-bp-log-off' : 'enc-bp-off'
  if (breakpoint.verified === false) return 'enc-bp-hollow'
  if (breakpoint.logMessage) return 'enc-bp-log'
  return breakpoint.condition || breakpoint.hitCondition ? 'enc-bp-cond' : 'enc-bp'
}

/** What a breakpoint does, in a line for its tooltip and the Breakpoints list. */
export function breakpointWords(breakpoint: DebugFolderBreakpoint): string {
  const parts: string[] = []
  if (breakpoint.logMessage) parts.push(`Prints “${breakpoint.logMessage}”`)
  if (breakpoint.condition) parts.push(`when ${breakpoint.condition}`)
  if (breakpoint.hitCondition) parts.push(`on hit ${breakpoint.hitCondition}`)
  if (!breakpoint.enabled) parts.push('turned off')
  else if (breakpoint.verified === false) parts.push(breakpoint.message ?? 'not in code that runs yet')
  else if (breakpoint.placed) parts.push(`stops on line ${breakpoint.placed}`)
  return parts.join(', ')
}

const newId = (): string => {
  try {
    return `b${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  } catch {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

/** F9 or a click in the gutter: a breakpoint on the line is taken away, else one is added. */
export function toggleAt(list: readonly DebugBreakpoint[], line: number, id: () => string = newId): DebugBreakpoint[] {
  return list.some((item) => item.line === line) ? list.filter((item) => item.line !== line) : sortByLine([...list, { id: id(), line, enabled: true }])
}

/** A breakpoint added with a condition, a hit count or a message; one already on the line takes them instead. */
export function addAt(list: readonly DebugBreakpoint[], line: number, extra: Pick<DebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage'>, id: () => string = newId): DebugBreakpoint[] {
  const clean = Object.fromEntries(Object.entries(extra).filter(([, value]) => typeof value === 'string' && value.trim())) as Pick<DebugBreakpoint, 'condition' | 'hitCondition' | 'logMessage'>
  const existing = list.find((item) => item.line === line)
  if (existing) return list.map((item) => (item === existing ? { id: item.id, line, enabled: true, ...(item.column ? { column: item.column } : {}), ...clean } : item))
  return sortByLine([...list, { id: id(), line, enabled: true, ...clean }])
}

const sortByLine = (list: DebugBreakpoint[]) => list.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0))

/** What the host keeps of a breakpoint: no state of a run. */
export function plain(breakpoint: DebugFolderBreakpoint): DebugBreakpoint {
  return {
    id: breakpoint.id,
    line: breakpoint.line,
    ...(breakpoint.column ? { column: breakpoint.column } : {}),
    ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
    ...(breakpoint.hitCondition ? { hitCondition: breakpoint.hitCondition } : {}),
    ...(breakpoint.logMessage ? { logMessage: breakpoint.logMessage } : {}),
    enabled: breakpoint.enabled,
  }
}

/**
 * The breakpoints after an edit moved lines: each to its new line, two that meet on one line kept as the first.
 * `moved` maps a line before the edit to the line after it. Null when nothing moved.
 */
export function moveLines(list: readonly DebugBreakpoint[], moved: (line: number) => number): DebugBreakpoint[] | null {
  let changed = false
  const seen = new Set<number>()
  const out: DebugBreakpoint[] = []
  for (const item of list) {
    const line = moved(item.line)
    if (line !== item.line) changed = true
    if (seen.has(line)) {
      changed = true
      continue
    }
    seen.add(line)
    out.push(line === item.line ? item : { ...item, line })
  }
  return changed ? out : null
}

/**
 * The expression a hover reads while the program is paused, in a line of text: the name from `start` to `end` and the
 * names before it with dots (`user.address.city`, `a?.b`), nothing that calls. Null when the word is not a name, or
 * what is before a dot is not one (`list[0].name`, `load().name`): its last name alone would be another value.
 */
export function hoverExpression(text: string, start: number, end: number): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(text.slice(start, end))) return null
  let from = start
  for (;;) {
    const dot = text[from - 1] === '.' ? (text[from - 2] === '?' ? 2 : 1) : 0
    if (!dot) break
    const before = /[A-Za-z_$][\w$]*$/.exec(text.slice(0, from - dot))
    if (!before) return null
    from = before.index
  }
  // A digit before the name (`1.5`, `1a.b`) is not where a name starts.
  return /[\w$]/.test(text[from - 1] ?? '') ? null : text.slice(from, end)
}

/** A run's title in the panel: its configuration's name, and how it stands. */
export function runTitle(run: DebugRun): string {
  if (run.state === 'ended') {
    const how = run.message ? run.message : run.exitCode === null || run.exitCode === undefined ? 'Ended' : `Exited with code ${run.exitCode}`
    return `${run.name}: ${how}`
  }
  if (run.state === 'starting') return `${run.name}: starting`
  return run.threads.some((thread) => thread.state === 'paused') ? `${run.name}: paused` : `${run.name}: running`
}

/** Why a program is paused, in a few words. */
export function pauseWords(thread: DebugThread): string {
  switch (thread.reason) {
    case 'breakpoint':
      return 'Paused on a breakpoint'
    case 'step':
      return 'Paused after a step'
    case 'exception':
      return 'Paused on an exception'
    case 'entry':
      return 'Paused at the start'
    case 'debugger':
      return 'Paused on a debugger statement'
    case 'pause':
      return 'Paused'
    default:
      return thread.state === 'paused' ? 'Paused' : 'Running'
  }
}
