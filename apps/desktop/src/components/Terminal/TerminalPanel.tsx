import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Plus, X } from '../../ui/icons'
import { api } from '../../api'
import { TerminalBuffer } from '../../terminal/buffer'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'

interface SessionMeta {
  id: string
  label: string
  cwd: string
  prompt: string
  running: boolean
}

interface HistoryState {
  list: string[]
  index: number
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

export default function TerminalPanel() {
  const workspace = useWorkspace((state) => state.workspace)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)

  const buffersRef = useRef(new Map<string, TerminalBuffer>())
  const historyRef = useRef(new Map<string, HistoryState>())
  const sessionsRef = useRef<SessionMeta[]>([])
  const activeIdRef = useRef<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)
  const stickRef = useRef(true)
  const bootedRef = useRef(false)

  sessionsRef.current = sessions
  activeIdRef.current = activeId

  const render = useCallback(() => {
    const id = activeIdRef.current
    const element = outputRef.current
    if (!element) return
    if (!id) {
      element.innerHTML = ''
      return
    }
    const buffer = buffersRef.current.get(id)
    element.innerHTML = buffer ? buffer.toHtml() : ''
    if (stickRef.current) element.scrollTop = element.scrollHeight
  }, [])

  const scheduleRender = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      render()
    })
  }, [render])

  const updateSession = useCallback((id: string, patch: Partial<SessionMeta>) => {
    setSessions((previous) => previous.map((session) => (session.id === id ? { ...session, ...patch } : session)))
  }, [])

  const createSession = useCallback(async () => {
    try {
      const info = await api.shell.create({ cwd: useWorkspace.getState().workspace?.root })
      buffersRef.current.set(info.id, new TerminalBuffer())
      historyRef.current.set(info.id, { list: [], index: -1 })
      setSessions((previous) => [
        ...previous,
        {
          id: info.id,
          label: `shell ${previous.length + 1}`,
          cwd: info.cwd,
          prompt: info.prompt,
          running: false,
        },
      ])
      setActiveId(info.id)
      setPrompt(info.prompt)
      setRunning(false)
      setInput('')
    } catch (error) {
      useUi.getState().notify('error', `Could not start the eNCode Shell: ${(error as Error).message}`)
    }
  }, [])

  // One shell per panel on first mount.
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void createSession()
  }, [createSession])

  // Keep existing shells pointed at the active workspace.
  const lastRootRef = useRef<string | null>(null)
  useEffect(() => {
    const root = workspace?.root
    if (!root || lastRootRef.current === root) return
    lastRootRef.current = root
    for (const session of sessionsRef.current) {
      void api.shell.run(session.id, `cd "${root.replace(/"/g, '')}"`)
    }
  }, [workspace?.root])

  // Subscribe to shell events once.
  useEffect(() => {
    const offData = api.shell.onData((id, text) => {
      const buffer = buffersRef.current.get(id)
      if (!buffer) return
      buffer.write(text)
      if (id === activeIdRef.current) scheduleRender()
    })

    const offPrompt = api.shell.onPrompt((info) => {
      setSessions((previous) =>
        previous.map((session) =>
          session.id === info.id ? { ...session, cwd: info.cwd, prompt: info.prompt, running: false } : session,
        ),
      )
      if (info.id === activeIdRef.current) {
        setPrompt(info.prompt)
        setRunning(false)
        window.requestAnimationFrame(() => inputRef.current?.focus())
      }
      scheduleRender()
    })

    const offExit = api.shell.onExit((id) => {
      buffersRef.current.delete(id)
      historyRef.current.delete(id)
      const remaining = sessionsRef.current.filter((session) => session.id !== id)
      setSessions(remaining)
      if (activeIdRef.current === id) {
        const next = remaining[remaining.length - 1]
        setActiveId(next?.id ?? null)
        setPrompt(next?.prompt ?? '')
        setRunning(Boolean(next?.running))
      }
    })

    return () => {
      offData()
      offPrompt()
      offExit()
    }
  }, [scheduleRender])

  // Reflect the active session and repaint its screen.
  useEffect(() => {
    const meta = sessions.find((session) => session.id === activeId)
    setPrompt(meta?.prompt ?? '')
    setRunning(Boolean(meta?.running))
    render()
    if (activeId) window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [activeId, sessions, render])

  const submit = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const buffer = buffersRef.current.get(id)
    if (!buffer) return
    const meta = sessionsRef.current.find((session) => session.id === id)
    const displayPrompt = meta?.prompt ?? prompt
    buffer.write(`${displayPrompt}${input}\n`)
    const history = historyRef.current.get(id)
    if (history) {
      if (input.trim()) history.list.push(input.trim())
      history.index = -1
    }
    void api.shell.run(id, input)
    setInput('')
    setRunning(true)
    updateSession(id, { running: true })
    stickRef.current = true
    scheduleRender()
  }, [input, prompt, scheduleRender, updateSession])

  const cancel = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const buffer = buffersRef.current.get(id)
    buffer?.write('^C\n')
    void api.shell.cancel(id)
    setRunning(false)
    updateSession(id, { running: false })
    scheduleRender()
  }, [scheduleRender, updateSession])

  const clear = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    buffersRef.current.get(id)?.clear()
    scheduleRender()
  }, [scheduleRender])

  const navigateHistory = useCallback(
    (direction: -1 | 1) => {
      const id = activeIdRef.current
      if (!id) return
      const history = historyRef.current.get(id)
      if (!history || !history.list.length) return
      history.index =
        direction === -1
          ? Math.min(history.index + 1, history.list.length - 1)
          : Math.max(history.index - 1, -1)
      setInput(history.index === -1 ? '' : history.list[history.list.length - 1 - history.index])
    },
    [],
  )

  const complete = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    try {
      const candidates = await api.shell.complete(id, input)
      if (!candidates.length) return
      if (candidates.length === 1) {
        setInput((previous) => previous.replace(/[^\s]*$/, candidates[0]))
        return
      }
      const buffer = buffersRef.current.get(id)
      if (buffer) {
        buffer.write(candidates.join('  ') + '\n')
        scheduleRender()
      }
    } catch {
      /* completion is best effort */
    }
  }, [input, scheduleRender])

  const closeSession = useCallback(
    (id: string) => {
      buffersRef.current.delete(id)
      historyRef.current.delete(id)
      const remaining = sessionsRef.current.filter((session) => session.id !== id)
      setSessions(remaining)
      if (activeIdRef.current === id) {
        setActiveId(remaining[remaining.length - 1]?.id ?? null)
      }
      void api.shell.close(id)
    },
    [],
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      void complete()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      navigateHistory(-1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      navigateHistory(1)
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      clear()
    }
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        <span className="terminal-label">SHELL</span>
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab ${session.id === activeId ? 'is-active' : ''}`}
            onClick={() => setActiveId(session.id)}
          >
            <span>{session.label}</span>
            <button
              className="terminal-tab-close"
              title="Close shell"
              onClick={(event) => {
                event.stopPropagation()
                closeSession(session.id)
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn terminal-new" onClick={() => void createSession()} title="New shell">
          <Plus size={14} />
        </button>
      </div>

      <div className="terminal-screen">
        <div
          className="terminal-lines"
          ref={outputRef}
          onScroll={() => {
            const element = outputRef.current
            if (!element) return
            stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
          }}
        />
        <div className="term-input-row">
          <span className="term-prompt">{stripAnsi(prompt)}</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            placeholder={running ? 'running…' : ''}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {running && (
            <button className="term-stop" onClick={cancel} title="Cancel (Ctrl+C)">
              stop
            </button>
          )}
        </div>
      </div>

      <div className="terminal-hint">
        {workspace ? `eNCode Shell · ${workspace.name}` : 'eNCode Shell'} — built-ins + programs, no cmd/PowerShell
      </div>
    </div>
  )
}
