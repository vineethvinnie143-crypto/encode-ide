import { useEffect, useState, type KeyboardEvent } from 'react'
import type { InstructionsInfo, ProjectInstructions } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useEditor } from '../../stores/editor'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button } from '../../ui/Button'
import { AlertTriangle, FileText, FolderOpen, Plus } from '../../ui/icons'
import { Spinner } from '../../ui/Spinner'
import { SettingsGroup } from './Section'

/** An edit not yet saved, kept while the person looks at another section; dropped once the file it started from changed. */
let kept: { base: string; text: string } | null = null

/** A text box holds its lines with \n alone; a file kept with Windows line ends gets them back when saved. */
const lines = (text: string): string => text.replace(/\r\n/g, '\n')

const PLACEHOLDER = 'For example: I build FiveM resources with ox_lib and oxmysql. Prefer TypeScript, keep replies short, and never commit for me.'

/** Settings > Personalization: the person's own instructions, read in every project, and where the open folder keeps its own. */
export function PersonalizationSection() {
  return (
    <>
      <OwnInstructions />
      <ProjectFile />
    </>
  )
}

function OwnInstructions() {
  const [info, setInfo] = useState<InstructionsInfo | null>(null)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** The file as it is now, when it changed elsewhere since it was read. */
  const [changed, setChanged] = useState<InstructionsInfo | null>(null)

  const load = (next: InstructionsInfo) => {
    setInfo(next)
    setChanged(null)
    setText(kept && kept.base === next.text ? kept.text : lines(next.text))
    if (kept && kept.base !== next.text) kept = null
  }

  useEffect(() => {
    let live = true
    api.instructions.read().then(
      (next) => live && load(next),
      (error) => live && setFailed(errorText(error)),
    )
    return () => {
      live = false
    }
  }, [])

  const dirty = info !== null && text !== lines(info.text)
  useEffect(() => {
    if (info) kept = dirty ? { base: info.text, text } : null
  }, [info, text, dirty])

  const save = async (base = info?.text) => {
    if (base === undefined) return
    setSaving(true)
    try {
      const outcome = await api.instructions.write(text, base)
      if (outcome.ok) {
        kept = null
        setInfo(outcome.info)
        setChanged(null)
        setText(lines(outcome.info.text))
        useUi.getState().notify('success', 'Saved. The agent reads them from your next request.')
      } else setChanged(outcome.changed)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 's' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (dirty && !saving) void save()
    }
  }

  const over = info !== null && text.length > info.sentChars
  return (
    <SettingsGroup
      title="Your instructions"
      description="The agent reads these in every project, before the project's own instructions, and the command line reads the same file. They go to the model with each new conversation, so a few clear lines work better than pages."
    >
      <div className="settings-row settings-row-block personal-block" data-setting="personalization.instructions">
        {failed ? (
          <div className="personal-problem" role="alert">
            <AlertTriangle size={14} aria-hidden="true" /> {failed}
          </div>
        ) : !info ? (
          <div className="settings-loading" role="status">
            <Spinner size={14} /> Reading your instructions…
          </div>
        ) : (
          <>
            <textarea
              className="personal-text"
              aria-label="Your instructions"
              rows={12}
              spellCheck
              value={text}
              placeholder={PLACEHOLDER}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {changed && (
              <div className="personal-changed" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>The file was changed outside eNCode since you opened it.</span>
                <span className="settings-actions">
                  <Button size="sm" variant="ghost" onClick={() => load(changed)}>
                    Load the file
                  </Button>
                  <Button size="sm" onClick={() => void save(changed.text)}>
                    Keep mine
                  </Button>
                </span>
              </div>
            )}
            <div className="personal-foot">
              <span className="personal-meta">
                <code title={info.path}>{info.path}</code>
                <span className={over ? 'personal-over' : undefined}>
                  {text.length.toLocaleString()} characters
                  {over && ` · past ${info.sentChars.toLocaleString()} the middle is left out`}
                </span>
              </span>
              <span className="settings-actions">
                <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setText(lines(info.text))}>
                  Revert
                </Button>
                <Button size="sm" variant="primary" disabled={!dirty} busy={saving} onClick={() => void save()}>
                  Save
                </Button>
              </span>
            </div>
          </>
        )}
      </div>
    </SettingsGroup>
  )
}

function ProjectFile() {
  const root = useWorkspace((state) => state.workspace?.root ?? null)
  const [project, setProject] = useState<ProjectInstructions | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setProject(undefined)
    api.instructions.project().then(
      (next) => live && setProject(next),
      () => live && setProject(null),
    )
    return () => {
      live = false
    }
  }, [root])

  const open = async (file: string) => {
    useUi.getState().setSettingsOpen(false)
    await useEditor.getState().openFile(file)
  }

  const create = async () => {
    try {
      await open(await api.instructions.createProject())
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  }

  const folder = project?.root.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return (
    <SettingsGroup
      title="This project’s instructions"
      description="Each project can keep its own in ENCODE.md at its root. eNCode also reads an AGENTS.md or CLAUDE.md a project already has, and ENCODE.local.md beside it for notes you keep out of the repository."
    >
      <div className="settings-row" data-setting="personalization.project">
        {project === undefined ? (
          <div className="settings-loading" role="status">
            <Spinner size={14} /> Looking in the folder…
          </div>
        ) : project === null ? (
          <div className="settings-row-text">
            <div className="settings-row-label">No folder is open</div>
            <div className="settings-row-help">Open a folder to see or start its instructions.</div>
          </div>
        ) : project.file ? (
          <>
            <div className="settings-row-text">
              <div className="settings-row-label">
                <FileText size={14} aria-hidden="true" /> {project.file}
              </div>
              <div className="settings-row-help">In {folder}. The agent reads it whenever it works there.</div>
            </div>
            <div className="settings-row-control">
              <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void open(project.file!)}>
                Open in the editor
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-row-text">
              <div className="settings-row-label">{folder} has no instructions file</div>
              <div className="settings-row-help">Start one with how to build and test it, and the conventions it follows.</div>
            </div>
            <div className="settings-row-control">
              <Button size="sm" icon={<Plus size={13} />} onClick={() => void create()}>
                Create ENCODE.md
              </Button>
            </div>
          </>
        )}
      </div>
    </SettingsGroup>
  )
}
