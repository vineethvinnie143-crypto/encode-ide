import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, CornerDownRight, Loader2, Paperclip, Pencil, Plus, Shield, Square, Target, Trash2, X } from '../../ui/icons'
import { api } from '../../api'
import { agentActions } from '../../commands/agent'
import { commandRegistry } from '../../commands/app'
import { POLICY_DESCRIPTIONS, POLICY_LABELS, POLICY_OPTIONS } from '../../policies'
import { useChat } from '../../stores/chat'
import { useEditor } from '../../stores/editor'
import { useSessions } from '../../stores/sessions'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Menu, type MenuEntry } from '../../ui/Menu'
import { Pill } from '../../ui/Pill'
import EffortButton from '../models/EffortButton'
import ModelButton from '../models/ModelButton'
import { ComposerPicker } from './ComposerPicker'
import { fileMention, fileOptions, findSlash, indexFiles, parseSlash, replaceTrigger, skillOptions, slashOptions, triggerAt, type FileIndex, type PickerOption, type SkillLike } from './picker'
import { sendAction, sendKeys } from './send-key'
import { runSlash } from './slash'
import { conversationStats } from './stats'
import { errorText } from '../../ipc-error'

const MAX_LINES = 12
const LINE = 22
/** The file list for `@` is read again when the picker opens this long after the last read. */
const FILES_FRESH_MS = 10_000

/** A ring that fills with how much of the context window the conversation uses. */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={cx('context-ring', percent >= 80 && 'is-high')} aria-hidden="true">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="context-ring-track" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="context-ring-fill"
        strokeDasharray={`${(Math.min(100, percent) / 100) * circumference} ${circumference}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

interface ListedFiles {
  root: string
  index: FileIndex
  truncated: boolean
  at: number
}

/** The open folder's files for `@`: read when the picker first opens, and again when it opens on a list gone stale or another folder. */
function useFileList(wanted: boolean): { files: ListedFiles | null; loading: boolean } {
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const [files, setFiles] = useState<ListedFiles | null>(null)
  const [loading, setLoading] = useState(false)
  const reading = useRef<string | null>(null)
  useEffect(() => {
    if (!wanted || !root || reading.current === root) return
    if (files?.root === root && Date.now() - files.at < FILES_FRESH_MS) return
    reading.current = root
    setLoading(true)
    api.workspace
      .listAllFiles()
      .then(
        (result) => {
          if (useWorkspace.getState().workspace?.root === root) setFiles({ root, index: indexFiles(result.files), truncated: result.truncated, at: Date.now() })
        },
        () => undefined,
      )
      .finally(() => {
        reading.current = null
        setLoading(false)
      })
  }, [wanted, root])
  return { files: files?.root === root ? files : null, loading }
}

/** The skills `/` and `$` offer: read for each folder, and again each time one of those pickers opens. */
function useSkillList(wanted: boolean): SkillLike[] {
  const [skills, setSkills] = useState<SkillLike[]>([])
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const readFor = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!wanted && readFor.current === root) return
    readFor.current = root
    let live = true
    api.skills.list().then(
      (list) => live && setSkills(list.map(({ name, description }) => ({ name, description }))),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [wanted, root])
  return skills
}

export default function Composer() {
  const draft = useChat((state) => state.draft)
  const setDraft = useChat((state) => state.setDraft)
  const send = useChat((state) => state.send)
  const stop = useChat((state) => state.stop)
  const running = useChat((state) => state.running)
  const ask = useChat((state) => state.ask)
  const answer = useChat((state) => state.answer)
  const entries = useChat((state) => state.entries)
  const enqueue = useChat((state) => state.enqueue)
  const steer = useChat((state) => state.steer)
  const sendQueued = useChat((state) => state.sendQueued)
  const removeQueued = useChat((state) => state.removeQueued)
  const moveQueued = useChat((state) => state.moveQueued)
  const editQueued = useChat((state) => state.editQueued)
  const tokensPerSecond = useChat((state) => state.tokensPerSecond)
  const usageTotals = useChat((state) => state.usageTotals)
  const activeId = useSessions((state) => state.activeId)
  const queue = useChat((state) => state.queues[activeId])
  const steering = useChat((state) => state.steering[activeId])
  const activePath = useEditor((state) => state.activePath)
  const tabs = useEditor((state) => state.tabs)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const workspace = useWorkspace((state) => state.workspace)
  const notify = useUi((state) => state.notify)
  const stopArmed = useUi((state) => state.stopArmed)
  const policyRequest = useUi((state) => (state.menuRequest?.menu === 'policy' ? state.menuRequest.id : undefined))

  const [attachments, setAttachments] = useState<{ path: string; content: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listId = useId()

  // Where the caret is, for the word it is in: `/`, `@` or `$` there opens a picker.
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  /** The picker Esc closed, by its kind and where its word starts; it stays closed until the caret leaves that word. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  /** Where the caret goes once a pick has changed the draft. */
  const placeCaret = useRef<number | null>(null)
  /** An unknown `/word` that Enter was pressed on once: a second Enter sends it as it is. */
  const unknownSlash = useRef<string | null>(null)

  const trigger = useMemo(() => triggerAt(draft, caret), [draft, caret])
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null
  // A question from the agent is answered in words, so slash commands wait until it is answered.
  const kind = trigger && triggerKey !== dismissed && !(trigger.kind === 'slash' && ask) ? trigger.kind : null
  const query = kind && trigger ? trigger.query : ''

  const { files, loading: filesLoading } = useFileList(kind === 'file')
  const skills = useSkillList(kind === 'slash' || kind === 'skill')
  const openPaths = useMemo(() => [...new Set([...(activePath ? [activePath] : []), ...tabs.map((tab) => tab.path)])], [activePath, tabs])

  const options = useMemo((): PickerOption[] => {
    if (kind === 'slash') return slashOptions(query, skills)
    if (kind === 'skill') return skillOptions(query, skills)
    if (kind === 'file' && files) return fileOptions(query, files.index, openPaths)
    return []
  }, [kind, query, skills, files, openPaths])

  /** The line under the list: what is loading, or why nothing is listed. */
  const pickerNote = (): string | undefined => {
    if (!kind) return undefined
    if (kind === 'file') {
      if (!workspace) return 'Open a folder to mention its files.'
      if (!files) return filesLoading ? 'Listing the folder’s files…' : undefined
      if (options.length) return undefined
      return files.truncated ? `No file matches “${query}” in the first ${files.index.paths.length.toLocaleString()} files.` : `No file matches “${query}”.`
    }
    if (options.length) return undefined
    if (kind === 'skill') return skills.length ? `No skill matches “${query}”.` : 'No skills yet. /skills shows where to add them.'
    return `No command matches “/${query}”.`
  }
  const note = pickerNote()
  const pickerOpen = kind !== null && (options.length > 0 || note !== undefined)
  const active = Math.min(pick, Math.max(0, options.length - 1))

  useEffect(() => setPick(0), [kind, query])
  useEffect(() => {
    if (dismissed && triggerKey !== dismissed) setDismissed(null)
  }, [triggerKey, dismissed])

  // The box grows from one line to twelve, then scrolls.
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(MAX_LINES * LINE, Math.max(LINE, element.scrollHeight))}px`
  }, [draft])

  // A pick wrote into the draft: the caret goes after what it wrote.
  useLayoutEffect(() => {
    const at = placeCaret.current
    const element = textareaRef.current
    if (at === null || !element) return
    placeCaret.current = null
    element.focus()
    element.setSelectionRange(at, at)
  }, [draft])

  const policy = settings?.policy ?? 'workspace-write'
  const mode = settings?.agentMode ?? 'code'
  const followUp = settings?.followUp ?? 'queue'
  const keys = sendKeys(settings?.sendKey ?? 'enter')
  const stats = useMemo(() => conversationStats(entries, usageTotals), [entries, usageTotals])

  /** Replaces the draft and puts the caret at `at`. */
  const write = (text: string, at: number) => {
    placeCaret.current = at
    setCaret(at)
    if (text === draft) {
      const element = textareaRef.current
      element?.focus()
      element?.setSelectionRange(at, at)
      placeCaret.current = null
    } else setDraft(text)
  }

  /** True while the key press or click that made a pick is handled: React then reports the field's old selection. */
  const picking = useRef(false)

  const followCaret = () => {
    // A pick has written the draft and places the caret itself; the selection the field still has is the old one.
    if (picking.current || placeCaret.current !== null) return
    const element = textareaRef.current
    if (element && element.selectionStart === element.selectionEnd) setCaret(element.selectionStart)
  }

  /**
   * A row picked: a file or a skill is written into the message. A command runs (Enter or a click), taking what
   * follows it as its words when it takes any; Tab only completes its name, to type words after it.
   */
  const choose = (option: PickerOption | undefined, complete = false) => {
    if (!option || !trigger) return
    picking.current = true
    queueMicrotask(() => (picking.current = false))
    if (option.kind !== 'command') {
      const next = replaceTrigger(draft, trigger, option.kind === 'file' ? fileMention(option.name) : `$${option.name}`)
      write(next.text, next.caret)
      return
    }
    const command = findSlash(option.name)
    if (!command) return
    if (complete) {
      const next = replaceTrigger(draft, trigger, `/${command.name}`)
      write(next.text, next.caret)
      return
    }
    const rest = draft.slice(trigger.end).trim()
    // The box keeps its focus as it is, so a dialog the command opens keeps its own.
    setDraft(command.args ? '' : rest)
    setCaret(0)
    void runSlash(command, command.args ? rest : '')
  }

  const attachActiveFile = async () => {
    if (!activePath) {
      notify('info', 'Open a file to attach it as context.')
      return
    }
    if (attachments.some((file) => file.path === activePath)) return
    try {
      const file = await api.workspace.read(activePath)
      if (file.binary) {
        notify('info', 'Binary files cannot be attached as text context.')
        return
      }
      setAttachments((previous) => [...previous, { path: activePath, content: file.content }])
    } catch (error) {
      notify('error', errorText(error))
    }
  }

  /** Types `@` or `$` at the caret, as its own word, so that its picker opens. */
  const typeSign = (sign: '@' | '$') => {
    const element = textareaRef.current
    const at = element ? element.selectionStart : draft.length
    const before = draft.slice(0, at)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    write(`${before}${lead}${sign}${draft.slice(at)}`, at + lead.length + 1)
  }

  /** Sends the draft. While the agent works, the send key does what the follow-up setting says and `other` the other one. */
  const submit = (other = false) => {
    const text = draft.trim()
    if (!text) return
    if (ask) {
      void answer(text)
      setDraft('')
      return
    }
    let message = text
    const slash = parseSlash(text)
    if (slash) {
      const command = findSlash(slash.name)
      if (command) {
        unknownSlash.current = null
        setDraft('')
        void runSlash(command, slash.args)
        return
      }
      // `/name` of a skill calls it, as `$name` does.
      const skill = skills.find((item) => item.name.toLowerCase() === slash.name)
      if (skill) message = `$${skill.name}${slash.args ? ` ${slash.args}` : ''}`
      else if (unknownSlash.current !== text) {
        unknownSlash.current = text
        notify('info', `/${slash.name} is not a command. Press ${keys.send} again to send it as a message.`)
        return
      }
    }
    unknownSlash.current = null
    if (!workspace) {
      notify('info', 'Open a folder first so the agent has a project to work on.')
      return
    }
    // While the agent works, a message either waits in the queue for it to be done, or goes to it now, read after its step.
    if (running) {
      if ((followUp === 'steer') !== other) steer(message)
      else enqueue(message)
      return
    }
    send(message, attachments)
    setAttachments([])
  }

  const addEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-add', label: 'Add' },
    { id: 'file', label: 'The open file', description: activePath ?? 'Open a file in the editor first', disabled: !activePath, onSelect: () => void attachActiveFile() },
    { id: 'mention', label: 'A file from the project…', description: 'It comes with the message', shortcut: '@', disabled: !workspace, onSelect: () => typeSign('@') },
    { id: 'skill', label: 'A skill…', description: 'Its instructions come with the message', shortcut: '$', onSelect: () => typeSign('$') },
    { id: 'goal', label: 'A goal for a long task…', icon: <Target size={14} />, onSelect: () => void agentActions.setGoal() },
    { kind: 'separator', id: 'sep-add' },
    { id: 'plan', label: 'Plan mode', description: 'Plan first, then ask before building.', checked: mode === 'plan', shortcut: 'Shift+Tab', onSelect: () => agentActions.togglePlan() },
    { kind: 'separator', id: 'sep-session' },
    { id: 'compact', label: 'Compact the conversation', onSelect: () => void agentActions.compact() },
    { id: 'export', label: 'Export session…', onSelect: () => void commandRegistry.run('session.export') },
    { id: 'commands', label: 'Command palette…', shortcut: commandRegistry.shortcut('app.palette'), onSelect: () => useUi.getState().setPaletteOpen(true) },
  ]

  const policyEntries = (): MenuEntry[] => [
    { kind: 'group', id: 'g-policy', label: 'What eNCode may do without asking' },
    ...POLICY_OPTIONS.map((option) => ({
      id: option,
      label: POLICY_LABELS[option],
      description: POLICY_DESCRIPTIONS[option],
      checked: policy === option,
      onSelect: () => void save({ policy: option }),
    })),
  ]

  const placeholder = !workspace
    ? 'Open a workspace to start…'
    : ask
      ? "Answer the agent's question…"
      : running
        ? followUp === 'steer'
          ? `Steer the agent now. ${keys.other} queues it for later`
          : `Queue a follow-up. ${keys.other} steers the agent now`
        : 'Message or run a task. / commands, @ files, $ skills'

  const lastPrompt = [...entries].reverse().find((entry) => entry.kind === 'user' || entry.kind === 'steer')?.text
  const tone = policy === 'full-access' ? 'warning' : policy === 'auto-review' ? 'accent' : 'neutral'

  return (
    <div className="composer-dock">
      {((queue && queue.length > 0) || (steering && steering.length > 0)) && (
        <div className="queue-strip" aria-label="Messages waiting">
          {steering && steering.length > 0 && (
            <>
              <div className="queue-head">
                Steering · {steering.length}
                <span className="queue-note">read by the agent after the step it is on</span>
              </div>
              {steering.map((item) => (
                <div className="queue-row is-steering" key={item.id}>
                  <Loader2 size={13} className="spin queue-spinner" />
                  <span className="queue-text" title={item.text}>
                    {item.text}
                  </span>
                </div>
              ))}
            </>
          )}
          {queue && queue.length > 0 && (
            <div className="queue-head">
              Queued · {queue.length}
              <span className="queue-note">sent one by one when eNCode is done</span>
            </div>
          )}
          {queue?.map((item, index) => (
            <div className="queue-row" key={item.id}>
              <span className="queue-text" title={item.text}>
                {item.text}
              </span>
              <span className="queue-actions">
                <IconButton label={running ? 'Steer now: the agent reads it after its step' : 'Send now'} size="sm" onClick={() => sendQueued(item.id)}>
                  {running ? <CornerDownRight size={14} /> : <ArrowUp size={14} />}
                </IconButton>
                <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => moveQueued(item.id, -1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label="Move down" size="sm" disabled={index === queue.length - 1} onClick={() => moveQueued(item.id, 1)}>
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton label="Edit queued message" size="sm" onClick={() => editQueued(item.id)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton label="Remove queued message" size="sm" onClick={() => removeQueued(item.id)}>
                  <Trash2 size={14} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((file) => (
            <span className="attachment-chip" key={file.path} title={file.path}>
              <Paperclip size={11} />
              {file.path.split('/').pop()}
              <button
                className="chip-remove"
                onClick={() => setAttachments((previous) => previous.filter((item) => item.path !== file.path))}
                title="Remove attachment"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={cx('composer-card', running && 'is-running')}>
        {pickerOpen && kind && <ComposerPicker kind={kind} options={options} index={active} listId={listId} {...(note ? { note } : {})} onPick={choose} onHover={setPick} />}
        {stopArmed && running && !pickerOpen && (
          <div className="composer-hint" role="status">
            Press Esc again to stop
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          placeholder={placeholder}
          rows={1}
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen && options.length ? listId : undefined}
          aria-activedescendant={pickerOpen && options.length ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.target.value)
            setCaret(event.target.selectionStart)
          }}
          onSelect={followCaret}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (pickerOpen) {
              const move = (step: number) => {
                event.preventDefault()
                if (options.length) setPick((active + step + options.length) % options.length)
              }
              if (event.key === 'ArrowDown') return move(1)
              if (event.key === 'ArrowUp') return move(-1)
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(triggerKey)
                return
              }
              if (options.length && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                event.preventDefault()
                choose(options[active], event.key === 'Tab')
                return
              }
            }
            const action = sendAction(event, settings?.sendKey ?? 'enter')
            if (action) {
              event.preventDefault()
              submit(action === 'other')
            } else if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault()
              agentActions.togglePlan()
            } else if (event.key === 'ArrowUp' && !draft && lastPrompt) {
              event.preventDefault()
              setDraft(lastPrompt)
            }
          }}
        />

        <div className="composer-toolbar">
          <Menu
            label="Add"
            side="top"
            width={320}
            entries={addEntries}
            trigger={(props) => (
              <IconButton label="Add" size="md" className="composer-plus" {...props}>
                <Plus size={16} />
              </IconButton>
            )}
          />

          <Menu
            label="Permissions"
            side="top"
            width={360}
            entries={policyEntries}
            openRequest={policyRequest}
            trigger={(props) => (
              <Pill className="policy-chip" tone={tone} icon={<Shield size={14} />} caret={<ChevronDown size={12} />} title="What eNCode may do without asking" {...props}>
                {POLICY_LABELS[policy]}
              </Pill>
            )}
          />

          <span className="composer-spacer" />

          <ModelButton />
          <EffortButton />

          {running && !ask ? (
            <>
              {draft.trim() && (
                <button
                  type="button"
                  className="composer-send is-follow-up"
                  onClick={() => submit()}
                  title={followUp === 'steer' ? `Steer now (${keys.send}) · Queue (${keys.other})` : `Queue (${keys.send}) · Steer now (${keys.other})`}
                  aria-label={followUp === 'steer' ? 'Steer now' : 'Queue'}
                >
                  {followUp === 'steer' ? <CornerDownRight size={16} /> : <ArrowUp size={16} />}
                </button>
              )}
              <button type="button" className="composer-send is-stop" onClick={() => void stop()} title="Stop (Esc twice)" aria-label="Stop">
                <Square size={13} fill="currentColor" />
              </button>
            </>
          ) : (
            <button type="button" className="composer-send" onClick={() => submit()} disabled={!draft.trim() || (!workspace && !parseSlash(draft))} title={`Send (${keys.send})`} aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="composer-stats">
        <ContextRing percent={stats.context} />
        <span>{stats.turns === 1 ? '1 turn' : `${stats.turns} turns`}</span>
        <span>{stats.steps === 1 ? '1 step' : `${stats.steps} steps`}</span>
        <span className="stats-sep">·</span>
        {tokensPerSecond > 0 && (
          <>
            <span>{tokensPerSecond} tok/s</span>
            <span className="stats-sep">·</span>
          </>
        )}
        <span>{stats.totalTokens.toLocaleString()} tok</span>
        {stats.cacheHit > 0 && (
          <>
            <span className="stats-sep">·</span>
            <span>{stats.cacheHit}% cache hit</span>
          </>
        )}
        <span className="stats-sep">·</span>
        <span>{stats.context}% ctx</span>
      </div>
    </div>
  )
}
