import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@encode/editor-view'
import type { EditorAction, EditorChangeFile } from '@shared/types'
import { count } from '../../editor/assist/changes'
import { actionSections } from '../../editor/assist/actions'
import { useRefactor, type ActionsView, type EditorRefactor, type RenameView } from '../../editor/assist/refactor'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { ArrowRight, FilePlus2, FileText, Lightbulb, Trash2, Wrench } from '../../ui/icons'
import { MenuPanel, type MenuEntry } from '../../ui/Menu'
import { place } from '../../ui/place'

/** The input's padding and border: the box moves left by them, so the name in it lines up with the one in the text. */
const INPUT_INSET = 7

function RenameInput({ box, refactor }: { box: RenameView; refactor: EditorRefactor }) {
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(box.initial)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const node = panel.current
    if (!node) return
    const anchor = { left: box.anchor.left - INPUT_INSET, top: box.anchor.top, width: 1, height: box.anchor.bottom - box.anchor.top }
    setSpot(place(anchor, { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { side: 'bottom', align: 'start', gap: 2 }))
  }, [box.anchor.left, box.anchor.top, box.anchor.bottom, box.error])

  // The name is selected, so typing replaces it. Only once the box is placed: until then it is hidden, and a hidden
  // field cannot take the focus.
  const placed = spot !== null
  useLayoutEffect(() => {
    const field = input.current
    if (!field || !placed) return
    field.focus({ preventScroll: true })
    field.select()
  }, [placed])

  // A refused name gives the keyboard back to the box, for another try.
  useLayoutEffect(() => {
    if (box.error) input.current?.focus({ preventScroll: true })
  }, [box.error])

  return createPortal(
    <div
      ref={panel}
      className={cx('rename-box', box.busy && 'is-busy', box.error && 'has-error')}
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
      role="dialog"
      aria-label={`Rename ${box.initial}`}
    >
      <input
        ref={input}
        className="rename-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        readOnly={box.busy}
        aria-label="New name"
        aria-invalid={box.error ? true : undefined}
        aria-describedby="rename-hint"
        style={{ width: `${Math.min(Math.max(value.length, box.initial.length, 12) + 4, 60)}ch` }}
        onChange={(event) => {
          setValue(event.target.value)
          refactor.renameEdited()
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void refactor.finishRename(value, event.shiftKey)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            refactor.closeRename(true)
          }
        }}
        onBlur={() => {
          // Another window taking the focus is not leaving the box; a click elsewhere in eNCode is.
          if (!box.busy && document.hasFocus()) refactor.closeRename()
        }}
      />
      <div id="rename-hint" className={cx('rename-hint', box.error && 'is-error')} aria-live="polite">
        {box.error ?? (box.busy ? 'Renaming…' : 'Enter to rename, Shift+Enter to preview')}
      </div>
    </div>,
    document.body,
  )
}

/** F2: the box over the symbol, for its new name. */
export function RenameBox({ refactor }: { refactor: EditorRefactor }) {
  const box = useRefactor((state) => state.rename)
  if (!box) return null
  return <RenameInput key={`${box.path}:${box.from}:${box.initial}`} box={box} refactor={refactor} />
}

const actionIcon = (action: EditorAction): ReactNode => {
  if (action.kind?.startsWith('refactor')) return <Wrench size={14} />
  if (action.kind?.startsWith('source')) return <FileText size={14} />
  return <Lightbulb size={14} className={cx('code-action-bulb', action.preferred && 'is-preferred')} />
}

/** The menu's rows: its sections when there is more than one, each action with why it cannot be taken when it cannot. */
function actionEntries(menu: ActionsView, refactor: EditorRefactor): MenuEntry[] {
  const sections = actionSections(menu.actions)
  const entries: MenuEntry[] = []
  for (const section of sections) {
    if (sections.length > 1) entries.push({ kind: 'group', id: `group-${section.label}`, label: section.label })
    for (const action of section.actions) {
      entries.push({
        id: `action-${action.id}`,
        label: action.title,
        icon: actionIcon(action),
        ...(action.disabled ? { disabled: true, description: action.disabled } : {}),
        ...(action.preferred && !action.disabled ? { trailing: 'Preferred' } : {}),
        onSelect: () => void refactor.takeAction(menu, action.id),
        // A command's changes are known only once it runs: there is nothing to show first.
        ...(action.command ? {} : { onAlternate: () => void refactor.takeAction(menu, action.id, true) }),
      })
    }
  }
  return entries
}

/** Ctrl+. and the lightbulb: what the servers offer here, under the place it is for. */
export function ActionMenu({ refactor }: { refactor: EditorRefactor }) {
  const menu = useRefactor((state) => state.actions)
  if (!menu) return null
  const previewable = menu.actions.some((action) => !action.command && !action.disabled)
  return (
    <MenuPanel
      entries={actionEntries(menu, refactor)}
      anchor={{ left: menu.anchor.left, top: menu.anchor.top, width: 1, height: menu.anchor.bottom - menu.anchor.top }}
      label={menu.title}
      start="first"
      className="code-actions-menu"
      footer={previewable ? 'Enter to apply, Shift+Enter to preview first' : undefined}
      onClose={(refocus) => refactor.closeActions(refocus)}
    />
  )
}

/** Beside a line with a problem a server can fix; it opens the menu, as Ctrl+. does. */
export function LightbulbButton({ refactor, view }: { refactor: EditorRefactor; view: EditorView }) {
  const bulb = useRefactor((state) => state.bulb)
  if (!bulb) return null
  // In the editor's own layer, so it goes when the editor is hidden and never covers the rest of the window.
  const root = view.root.getBoundingClientRect()
  return createPortal(
    <button
      type="button"
      className="code-bulb"
      style={{ left: bulb.left - root.left, top: bulb.top - root.top, width: bulb.size, height: bulb.size }}
      title="Show fixes (Ctrl+.)"
      aria-label="Show fixes"
      // The editor keeps the focus, and with it the cursor the fixes are for.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => refactor.openBulb()}
    >
      <Lightbulb size={14} />
    </button>,
    view.widgets,
  )
}

const KIND_LABEL: Record<EditorChangeFile['kind'], string> = { edit: 'Edit', create: 'New file', move: 'Move', delete: 'Delete' }

function FileIcon({ kind }: { kind: EditorChangeFile['kind'] }) {
  if (kind === 'create') return <FilePlus2 size={14} />
  if (kind === 'delete') return <Trash2 size={14} />
  return <FileText size={14} />
}

function PreviewFile({ file }: { file: EditorChangeFile }) {
  return (
    <section className={cx('cp-file', `is-${file.kind}`)}>
      <header className="cp-file-head">
        <FileIcon kind={file.kind} />
        <span className="cp-path" title={file.path}>
          {file.path}
        </span>
        {file.kind === 'move' && file.to && (
          <>
            <ArrowRight size={12} className="cp-arrow" />
            <span className="cp-path" title={file.to}>
              {file.to}
            </span>
          </>
        )}
        <span className="cp-spacer" />
        {file.inEditor && (
          <span className="cp-tag" title="It has unsaved changes, so the change goes into the editor and is saved when you save the file.">
            Unsaved, changed in the editor
          </span>
        )}
        <span className="cp-kind">{file.kind === 'edit' ? count(file.places, 'change') : KIND_LABEL[file.kind]}</span>
      </header>
      {file.lines?.length ? (
        <div className="cp-lines">
          {file.lines.map((line, index) => {
            const before = line.before.trimStart()
            const after = line.after.trimStart()
            return (
              <div key={`${line.line}-${index}`} className="cp-line">
                <span className="cp-num">{line.line + 1}</span>
                <div className="cp-texts">
                  {before !== after && <code className="cp-before">{before || ' '}</code>}
                  <code className={before !== after ? 'cp-after' : 'cp-same'}>{after || ' '}</code>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

/** Shift+Enter in the rename box or the menu: every file the change touches, each line before and after it. */
export function ChangePreview({ refactor }: { refactor: EditorRefactor }) {
  const preview = useRefactor((state) => state.preview)
  if (!preview) return null
  const places = preview.files.reduce((sum, file) => sum + file.places, 0)
  const edited = preview.files.filter((file) => file.kind === 'edit').length
  const summary = [places ? `${count(places, 'change')} in ${count(edited, 'file')}` : null, ...(['create', 'move', 'delete'] as const).map((kind) => {
    const n = preview.files.filter((file) => file.kind === kind).length
    return n ? `${n} ${kind === 'create' ? (n === 1 ? 'new file' : 'new files') : kind === 'move' ? (n === 1 ? 'file moved' : 'files moved') : n === 1 ? 'file deleted' : 'files deleted'}` : null
  })]
    .filter(Boolean)
    .join(', ')
  return (
    <Dialog
      open
      title={preview.title}
      description={summary || 'Nothing to change.'}
      width={760}
      className="change-preview-dialog"
      onClose={() => refactor.cancelPreview()}
      footer={
        <>
          <Button variant="ghost" onClick={() => refactor.cancelPreview()} disabled={preview.busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={preview.busy} data-autofocus onClick={() => void refactor.applyPreview()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="change-preview">
        {preview.files.map((file) => (
          <PreviewFile key={`${file.kind}:${file.path}`} file={file} />
        ))}
        {preview.files.some((file) => file.cut) && <div className="cp-more">Some lines are left out here, to keep the preview short. Apply makes every change.</div>}
      </div>
    </Dialog>
  )
}
