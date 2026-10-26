import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { DebugBreakpoint, DebugFolderBreakpoint, DebugFrame, DebugRun, DebugThread, DebugVariable } from '@shared/types'
import { commandRegistry } from '../../commands/app'
import { breakpointClass, breakpointWords, currentRun, frameOf, pauseWords, runTitle, stackRows, toolbarMode } from '../../panels/debug'
import { useDebug, type ConsoleItem } from '../../stores/debug'
import { useEditor } from '../../stores/editor'
import { usePanels } from '../../stores/panels'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Bug, ChevronDown, ChevronRight, Pause, Play, Plus, RotateCw, ShieldAlert, Square, StepInto, StepOut, StepOver, Trash2, X } from '../../ui/icons'
import { Select } from '../../ui/Select'

/** A part of the panel's left column, with a header that opens and closes it. */
function Section({ title, count, actions, open, onToggle, children }: { title: string; count?: number; actions?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={cx('dp-section', open && 'is-open')}>
      <div className="dp-section-head">
        <button type="button" className="dp-section-title" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <span>{title}</span>
          {count !== undefined && count > 0 && <span className="dp-count">{count}</span>}
        </button>
        {actions && <div className="dp-section-actions">{actions}</div>}
      </div>
      {open && <div className="dp-section-body">{children}</div>}
    </section>
  )
}

/** A value, and its children once opened: an object's properties, an array's items. */
function VariableRow({ item, depth, path }: { item: DebugVariable; depth: number; path: string }) {
  const children = useDebug((state) => (item.ref ? state.children[item.ref] : undefined))
  const [open, setOpen] = useState(false)
  const openable = item.ref !== undefined && item.ref > 0
  const toggle = () => {
    if (!openable) return
    if (!open) void useDebug.getState().open(item.ref!)
    setOpen(!open)
  }
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={openable ? open : undefined}
        className={cx('dp-var', item.kind && `is-${item.kind}`)}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={item.type ? `${item.name}: ${item.type}` : item.name}
        onClick={toggle}
      >
        <span className="dp-chevron">{openable ? open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" /> : null}</span>
        <span className="dp-var-name">{item.name}</span>
        <span className="dp-var-value">{item.lazy && !open ? '(…)' : item.value}</span>
      </button>
      {open && children === 'loading' && (
        <div className="dp-note" style={{ paddingLeft: 22 + depth * 14 }}>
          Reading…
        </div>
      )}
      {open && Array.isArray(children) && children.map((child, index) => <VariableRow key={`${path}/${child.name}/${index}`} item={child} depth={depth + 1} path={`${path}/${child.name}`} />)}
    </>
  )
}

function Variables() {
  const scopes = useDebug((state) => state.scopes)
  const children = useDebug((state) => state.children)
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set())
  if (!scopes.length) return <div className="dp-note">Pause the program to see its values: at a breakpoint, a step, or with Pause.</div>
  return (
    <div role="tree" aria-label="Variables">
      {scopes.map((scope) => {
        const list = children[scope.ref]
        const open = Array.isArray(list) || list === 'loading' ? !closed.has(scope.ref) : false
        return (
          <div key={scope.ref}>
            <button
              type="button"
              role="treeitem"
              aria-expanded={open}
              className="dp-scope"
              onClick={() => {
                if (!list) void useDebug.getState().open(scope.ref)
                setClosed((current) => {
                  const next = new Set(current)
                  if (open) next.add(scope.ref)
                  else next.delete(scope.ref)
                  return next
                })
              }}
            >
              {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <span>{scope.name}</span>
            </button>
            {open && list === 'loading' && <div className="dp-note">Reading…</div>}
            {open &&
              Array.isArray(list) &&
              (list.length ? list.map((item, index) => <VariableRow key={`${scope.ref}/${item.name}/${index}`} item={item} depth={1} path={`${scope.ref}/${item.name}`} />) : <div className="dp-note">Nothing here.</div>)}
          </div>
        )
      })}
    </div>
  )
}

function Watches() {
  const watches = useDebug((state) => state.watches)
  const values = useDebug((state) => state.watchValues)
  const paused = useDebug((state) => state.frame !== null)
  const [adding, setAdding] = useState('')
  return (
    <div>
      {watches.map((expression, index) => {
        const value = values[expression]
        return (
          <div key={expression} className="dp-watch">
            <span className="dp-var-name">{expression}</span>
            <span className={cx('dp-var-value', value && !value.ok && 'is-failed')}>{!paused ? '' : !value ? '…' : value.ok ? value.value : value.message}</span>
            <IconButton label={`Stop watching ${expression}`} size="sm" onClick={() => useDebug.getState().removeWatch(index)}>
              <X size={12} />
            </IconButton>
          </div>
        )
      })}
      <input
        className="dp-watch-input"
        value={adding}
        placeholder="Add an expression to watch"
        aria-label="Add an expression to watch"
        spellCheck={false}
        onChange={(event) => setAdding(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && adding.trim()) {
            useDebug.getState().addWatch(adding)
            setAdding('')
          }
        }}
      />
    </div>
  )
}

/** A frame of the call stack; choosing it shows its values and its line. */
function FrameRow({ run, thread, item, chosen }: { run: string; thread: number; item: DebugFrame; chosen: boolean }) {
  const where = item.source?.rel ?? item.source?.name ?? ''
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={chosen}
      className={cx('dp-frame', chosen && 'is-chosen', item.skipped && 'is-skipped')}
      disabled={item.noScopes && !item.source?.rel}
      onClick={() => useDebug.getState().selectFrame({ run, thread, frame: item.id })}
    >
      {item.async && <span className="dp-async">{item.async}</span>}
      <span className="dp-frame-name">{item.name || '(anonymous)'}</span>
      <span className="dp-frame-at">
        {where}
        {where && `:${item.line}`}
      </span>
    </button>
  )
}

function CallStack({ runs }: { runs: DebugRun[] }) {
  const frame = useDebug((state) => state.frame)
  /** Folds of frames opened, by run, program and first frame. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  if (!runs.length) return <div className="dp-note">Nothing runs. Start with F5, or the button above.</div>
  return (
    <div role="tree" aria-label="Call stack">
      {runs.map((run) => (
        <div key={run.id} className="dp-run">
          <div className={cx('dp-run-title', run.state === 'ended' && 'is-ended')}>
            <span>{runTitle(run)}</span>
            {run.state === 'ended' && (
              <IconButton label="Put away this run" size="sm" onClick={() => void useDebug.getState().dismiss(run.id)}>
                <X size={12} />
              </IconButton>
            )}
          </div>
          {run.threads.map((thread) => {
            const chosen = frame?.run === run.id && frame.thread === thread.id ? frame.frame : null
            return (
              <div key={thread.id}>
                {run.threads.length > 1 && <div className="dp-thread">{`${thread.name}: ${pauseWords(thread)}`}</div>}
                {thread.state === 'paused' && thread.exception && <div className="dp-exception">{thread.exception.split('\n')[0]}</div>}
                {stackRows(thread.frames ?? [], chosen).map((row) => {
                  if (row.kind === 'frame') return <FrameRow key={row.frame.id} run={run.id} thread={thread.id} item={row.frame} chosen={row.frame.id === chosen} />
                  const key = `${run.id}/${thread.id}/${row.frames[0]!.id}`
                  if (opened.has(key)) return row.frames.map((item) => <FrameRow key={item.id} run={run.id} thread={thread.id} item={item} chosen={false} />)
                  return (
                    <button key={key} type="button" className="dp-fold" onClick={() => setOpened((current) => new Set(current).add(key))}>
                      {`${row.frames.length} frames of code you did not write`}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function Breakpoints({ list }: { list: [string, DebugFolderBreakpoint[]][] }) {
  const exceptions = useDebug((state) => state.state?.exceptions ?? { uncaught: true, all: false })
  const go = (path: string, breakpoint: DebugBreakpoint) => {
    usePanels.getState().open('editor')
    void useEditor.getState().openFile(path, breakpoint.line)
  }
  return (
    <div>
      <label className="dp-check">
        <input type="checkbox" checked={exceptions.uncaught} onChange={(event) => useDebug.getState().setExceptions({ ...exceptions, uncaught: event.target.checked })} />
        <span>Stop on uncaught exceptions</span>
      </label>
      <label className="dp-check">
        <input type="checkbox" checked={exceptions.all} onChange={(event) => useDebug.getState().setExceptions({ ...exceptions, all: event.target.checked })} />
        <span>Stop on every exception, caught ones too</span>
      </label>
      {!list.length && <div className="dp-note">Click left of a line number, or press F9, to stop there.</div>}
      {list.map(([path, items]) =>
        items.map((item) => {
          const words = breakpointWords(item)
          const name = path.slice(path.lastIndexOf('/') + 1)
          return (
            <div key={item.id} className="dp-breakpoint">
              <input
                type="checkbox"
                checked={item.enabled}
                aria-label={`${item.enabled ? 'Turn off' : 'Turn on'} the breakpoint at ${name}:${item.line}`}
                onChange={(event) =>
                  useDebug.getState().editBreakpoint(path, item.id, {
                    enabled: event.target.checked,
                  })
                }
              />
              <span className={cx('dp-bp-mark', breakpointClass(item))} aria-hidden="true" />
              <button type="button" className="dp-bp-place" title={path} onClick={() => go(path, item)}>
                <span>{name}</span>
                <span className="dp-frame-at">{item.line}</span>
                {words && <span className="dp-bp-words">{words}</span>}
              </button>
              <IconButton label={`Remove the breakpoint at ${name}:${item.line}`} size="sm" onClick={() => useDebug.getState().editBreakpoint(path, item.id, null)}>
                <X size={12} />
              </IconButton>
            </div>
          )
        }),
      )}
    </div>
  )
}

function ConsoleLine({ item }: { item: ConsoleItem }) {
  const [open, setOpen] = useState(false)
  const children = useDebug((state) => (item.ref ? state.children[item.ref] : undefined))
  const openFile = () => {
    if (!item.source) return
    usePanels.getState().open('editor')
    void useEditor.getState().openFile(item.source.path, item.source.line)
  }
  if (item.ref) {
    return (
      <div className={cx('dp-line', `is-${item.kind}`)}>
        <button
          type="button"
          className="dp-line-open"
          aria-expanded={open}
          onClick={() => {
            if (!open) void useDebug.getState().open(item.ref!)
            setOpen(!open)
          }}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <span>{item.text}</span>
        </button>
        {open && Array.isArray(children) && (
          <div role="tree">
            {children.map((child, index) => (
              <VariableRow key={`${item.id}/${child.name}/${index}`} item={child} depth={1} path={`${item.id}/${child.name}`} />
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className={cx('dp-line', `is-${item.kind}`)}>
      {item.kind === 'input' && <span className="dp-prompt">›</span>}
      <span className="dp-text">{item.text}</span>
      {item.source && (
        <button type="button" className="dp-line-source" onClick={openFile}>
          {item.source.path.split(/[\\/]/).pop()}:{item.source.line}
        </button>
      )}
    </div>
  )
}

function Console() {
  const items = useDebug((state) => state.console)
  const [text, setText] = useState('')
  const history = useRef<string[]>([])
  const back = useRef(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    const list = listRef.current
    if (list && stuck.current) list.scrollTop = list.scrollHeight
  }, [items])
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && text.trim()) {
      history.current = [text, ...history.current.filter((item) => item !== text)].slice(0, 100)
      back.current = -1
      void useDebug.getState().evaluate(text)
      setText('')
    } else if (event.key === 'ArrowUp' && history.current.length) {
      event.preventDefault()
      back.current = Math.min(history.current.length - 1, back.current + 1)
      setText(history.current[back.current]!)
    } else if (event.key === 'ArrowDown' && back.current >= 0) {
      event.preventDefault()
      back.current -= 1
      setText(back.current >= 0 ? history.current[back.current]! : '')
    }
  }
  return (
    <div className="dp-console">
      <div className="dp-console-head">
        <span>Console</span>
        <IconButton label="Clear the console" size="sm" onClick={() => useDebug.getState().clearConsole()}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      <div
        ref={listRef}
        className="dp-output"
        role="log"
        aria-label="What the program printed"
        onScroll={(event) => {
          const list = event.currentTarget
          stuck.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
        }}
      >
        {items.length ? items.map((item) => <ConsoleLine key={item.id} item={item} />) : <div className="dp-note">What the program prints shows here. Below, type an expression to read it in the paused frame.</div>}
      </div>
      <label className="dp-input">
        <span className="dp-prompt" aria-hidden="true">
          ›
        </span>
        <input value={text} placeholder="Evaluate an expression" aria-label="Evaluate an expression" spellCheck={false} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} />
      </label>
    </div>
  )
}

const shortcut = (id: string) => commandRegistry.shortcut(id)

/** The toolbar's words for a run: its name and why it is paused, or how it stands. */
function runDetail(run: DebugRun, thread: DebugThread | null): string {
  return thread?.state === 'paused' ? `${run.name} · ${pauseWords(thread)}` : runTitle(run)
}

function Toolbar() {
  const state = useDebug((store) => store.state)
  const frame = useDebug((store) => store.frame)
  const configs = useDebug((store) => store.configs)
  const chosen = useDebug((store) => store.chosen)
  const run = currentRun(state, frame)
  const mode = toolbarMode(run)
  const debug = useDebug.getState()
  const options = useMemo(
    () =>
      (configs?.configs ?? []).map((item) => ({
        value: item.id,
        label: item.problem ? `${item.name} (cannot run)` : item.name,
      })),
    [configs],
  )
  const config = configs?.configs.find((item) => item.id === chosen)
  return (
    <div className="dp-toolbar">
      {mode === 'idle' ? (
        <>
          <IconButton label="Start debugging" shortcut={shortcut('debug.continue')} size="md" disabled={!options.length} onClick={() => void debug.start()}>
            <Play size={14} className="dp-start" />
          </IconButton>
          {options.length > 0 && chosen && <Select value={chosen} options={options} label="What to debug" className="dp-config" onChange={(id) => debug.choose(id)} />}
          {config && (
            <span className="dp-detail" title={config.problem ?? config.detail}>
              {config.problem ?? config.detail}
            </span>
          )}
        </>
      ) : (
        <>
          {mode === 'paused' ? (
            <IconButton label="Continue" shortcut={shortcut('debug.continue')} size="md" onClick={() => void debug.act({ kind: 'continue' })}>
              <Play size={14} className="dp-start" />
            </IconButton>
          ) : (
            <IconButton label="Pause" shortcut={shortcut('debug.pause')} size="md" disabled={mode === 'starting'} onClick={() => void debug.act({ kind: 'pause' })}>
              <Pause size={14} />
            </IconButton>
          )}
          <IconButton label="Step over" shortcut={shortcut('debug.stepOver')} size="md" disabled={mode !== 'paused'} onClick={() => void debug.act({ kind: 'step', step: 'over' })}>
            <StepOver size={14} />
          </IconButton>
          <IconButton label="Step into" shortcut={shortcut('debug.stepInto')} size="md" disabled={mode !== 'paused'} onClick={() => void debug.act({ kind: 'step', step: 'into' })}>
            <StepInto size={14} />
          </IconButton>
          <IconButton label="Step out" shortcut={shortcut('debug.stepOut')} size="md" disabled={mode !== 'paused'} onClick={() => void debug.act({ kind: 'step', step: 'out' })}>
            <StepOut size={14} />
          </IconButton>
          <IconButton label="Restart" shortcut={shortcut('debug.restart')} size="md" onClick={() => void debug.act({ kind: 'restart' })}>
            <RotateCw size={14} />
          </IconButton>
          <IconButton label="Stop" shortcut={shortcut('debug.stop')} size="md" onClick={() => void debug.act({ kind: 'stop' })}>
            <Square size={13} className="dp-stop" />
          </IconButton>
          <span className="dp-detail">{run ? runDetail(run, frameOf(state, frame)?.thread ?? null) : ''}</span>
        </>
      )}
    </div>
  )
}

type SectionKey = 'variables' | 'watch' | 'stack' | 'breakpoints'

/** The bottom panel's Debug tab (ADR 0143): the toolbar, the paused frame's values, the stack and breakpoints, and the console. */
export default function DebugPane() {
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const state = useDebug((store) => store.state)
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    variables: true,
    watch: true,
    stack: true,
    breakpoints: true,
  })
  const toggle = (key: SectionKey) => setOpen((current) => ({ ...current, [key]: !current[key] }))
  useEffect(() => {
    if (root) void useDebug.getState().loadConfigs()
  }, [root])
  const breakpoints = useMemo(() => Object.entries(state?.breakpoints ?? {}).sort(([a], [b]) => a.localeCompare(b)), [state?.breakpoints])
  const count = breakpoints.reduce((sum, [, items]) => sum + items.length, 0)

  if (!root) {
    return (
      <div className="panel-empty">
        <Bug size={18} />
        <span>Open a folder to debug its code.</span>
      </div>
    )
  }
  if (!state) {
    return (
      <div className="panel-empty">
        <Bug size={18} />
        <span>The debugger is not ready yet. It starts with the agent; try again in a moment.</span>
      </div>
    )
  }
  return (
    <div className="debug-pane">
      {!state.trusted && (
        <div className="dp-trust" role="status">
          <ShieldAlert size={14} />
          <span>Debugging runs this folder's code, so it runs only in folders you trust. Breakpoints are kept meanwhile.</span>
          <Button size="sm" variant="ghost" onClick={() => useUi.getState().openSettings('permissions')}>
            Trust this folder
          </Button>
        </div>
      )}
      <div className="dp-body">
        <div className="dp-side">
          <Toolbar />
          <div className="dp-sections">
            <div className="dp-col">
              <Section title="Variables" open={open.variables} onToggle={() => toggle('variables')}>
                <Variables />
              </Section>
              <Section
                title="Watch"
                count={useDebug.getState().watches.length}
                open={open.watch}
                onToggle={() => toggle('watch')}
                actions={
                  <IconButton
                    label="Add an expression to watch"
                    size="sm"
                    onClick={() => {
                      void useUi
                        .getState()
                        .askText('Watch an expression', 'user.name, items.length…')
                        .then((value) => value && useDebug.getState().addWatch(value))
                    }}
                  >
                    <Plus size={12} />
                  </IconButton>
                }
              >
                <Watches />
              </Section>
            </div>
            <div className="dp-col">
              <Section title="Call stack" open={open.stack} onToggle={() => toggle('stack')}>
                <CallStack runs={state.runs} />
              </Section>
              <Section
                title="Breakpoints"
                count={count}
                open={open.breakpoints}
                onToggle={() => toggle('breakpoints')}
                actions={
                  count > 0 ? (
                    <IconButton label="Remove every breakpoint" size="sm" onClick={() => useDebug.getState().removeAllBreakpoints()}>
                      <Trash2 size={12} />
                    </IconButton>
                  ) : undefined
                }
              >
                <Breakpoints list={breakpoints} />
              </Section>
            </div>
          </div>
        </div>
        <Console />
      </div>
    </div>
  )
}
