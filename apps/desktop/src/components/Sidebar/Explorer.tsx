import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from '../../ui/icons'
import type { FileEntry } from '@shared/types'
import { useEditor } from '../../stores/editor'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function TreeRow({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expanded = useWorkspace((state) => Boolean(state.expanded[entry.path]))
  const loading = useWorkspace((state) => Boolean(state.loadingDirs[entry.path]))
  const children = useWorkspace((state) => state.children[entry.path])
  const selected = useWorkspace((state) => state.selected === entry.path)
  const toggleDir = useWorkspace((state) => state.toggleDir)
  const select = useWorkspace((state) => state.select)
  const rename = useWorkspace((state) => state.rename)
  const remove = useWorkspace((state) => state.remove)
  const openFile = useEditor((state) => state.openFile)
  const askText = useUi((state) => state.askText)

  const indent = 8 + depth * 13

  return (
    <div className="tree-node">
      <div
        className={`tree-row ${selected ? 'is-selected' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => {
          select(entry.path)
          if (entry.isDir) {
            void toggleDir(entry.path)
          } else {
            void openFile(entry.path)
            useUi.getState().setWorkspaceTab('editor')
          }
        }}
        title={entry.path}
      >
        <span className="tree-chevron">
          {entry.isDir ? (
            expanded ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )
          ) : null}
        </span>
        <span className={`tree-icon ${entry.isDir ? 'is-dir' : 'is-file'}`}>
          {entry.isDir ? expanded ? <FolderOpen size={14} /> : <Folder size={14} /> : <File size={14} />}
        </span>
        <span className="tree-label">{entry.name}</span>
        <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="tree-action"
            title="Rename"
            onClick={async () => {
              const next = await askText(`Rename "${entry.name}"`, 'New name', entry.name)
              if (next && next !== entry.name) await rename(entry.path, next)
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            className="tree-action danger"
            title="Move to trash"
            onClick={async () => {
              if (!window.confirm(`Move "${entry.name}" to the trash?`)) return
              await remove(entry.path)
              useEditor.getState().closeTabsUnder(entry.path)
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {entry.isDir && expanded && (
        <div className="tree-children">
          {loading && <div className="tree-note" style={{ paddingLeft: indent + 21 }}>Loading…</div>}
          {!loading &&
            (children ?? []).map((child) => <TreeRow key={child.path} entry={child} depth={depth + 1} />)}
          {!loading && children && children.length === 0 && (
            <div className="tree-note" style={{ paddingLeft: indent + 21 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Explorer() {
  const workspace = useWorkspace((state) => state.workspace)
  const children = useWorkspace((state) => state.children)
  const selected = useWorkspace((state) => state.selected)
  const openDialog = useWorkspace((state) => state.openDialog)
  const loadDir = useWorkspace((state) => state.loadDir)
  const refreshAll = useWorkspace((state) => state.refreshAll)
  const createFile = useWorkspace((state) => state.createFile)
  const createDir = useWorkspace((state) => state.createDir)
  const askText = useUi((state) => state.askText)
  const [busy, setBusy] = useState(false)

  if (!workspace) {
    return (
      <div className="panel-empty">
        <FolderOpen size={22} />
        <div>No folder open</div>
        <button className="btn primary sm" onClick={openDialog}>
          Open folder
        </button>
      </div>
    )
  }

  const selectedIsDir = selected !== null && children[selected] !== undefined
  const targetDir = selected ? (selectedIsDir ? selected : dirname(selected)) : ''

  const reload = async () => {
    setBusy(true)
    await refreshAll()
    setBusy(false)
  }

  const onNewFile = async () => {
    const name = await askText('New file', 'filename.ts')
    if (name) {
      await createFile(targetDir, name)
      await loadDir(targetDir)
    }
  }

  const onNewFolder = async () => {
    const name = await askText('New folder', 'folder-name')
    if (name) {
      await createDir(targetDir, name)
      await loadDir(targetDir)
    }
  }

  const rootChildren = children[''] ?? []

  return (
    <div className="explorer">
      <div className="panel-header">
        <span className="panel-title" title={workspace.root}>
          {workspace.name}
        </span>
        <div className="panel-actions">
          <button className="icon-btn" onClick={onNewFile} title="New file">
            <FilePlus2 size={14} />
          </button>
          <button className="icon-btn" onClick={onNewFolder} title="New folder">
            <FolderPlus size={14} />
          </button>
          <button className="icon-btn" onClick={reload} title="Refresh" disabled={busy}>
            <RefreshCw size={13} className={busy ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="tree">
        {rootChildren.map((entry) => (
          <TreeRow key={entry.path} entry={entry} depth={0} />
        ))}
        {rootChildren.length === 0 && <div className="tree-note">This folder is empty.</div>}
      </div>
    </div>
  )
}
