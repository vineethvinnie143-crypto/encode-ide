import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { bannerKey, mcpBannerOf } from '../../panels/mcp'
import { bannerOf } from '../../panels/permissions'
import { useChat } from '../../stores/chat'
import { useMcp } from '../../stores/mcp'
import { usePermissions } from '../../stores/permissions'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ShieldAlert, X } from '../../ui/icons'

const DISMISSED_KEY = 'encode.mcpBannerDismissed'
const MAX_DISMISSED = 50

/** What the person said "not now" to: the folder and exactly which MCP servers waited. Kept in this window's storage only. */
function readDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(keys: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-MAX_DISMISSED)))
  } catch {
    /* storage may be unavailable; the banner then comes back next time */
  }
}

/**
 * A line above the composer when the open folder needs the person: its settings cannot be read (nothing runs), it
 * asks for more than a folder that is not trusted may be given, or it asks to run MCP servers. It reads the folder
 * when the folder or the window changes and when the agent finishes a turn (it may have written to the settings,
 * which an approval let through); the Permissions and MCP screens are where it is dealt with. Looking for servers
 * never starts one.
 */
export default function TrustBanner() {
  const root = useWorkspace((state) => state.workspace?.root)
  const report = usePermissions((state) => state.report)
  const refreshPermissions = usePermissions((state) => state.refresh)
  const mcp = useMcp((state) => state.report)
  const refreshMcp = useMcp((state) => state.refresh)
  const openSettings = useUi((state) => state.openSettings)
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)

  const refresh = useCallback(() => {
    void refreshPermissions()
    // The MCP screen looks with the servers started; this only looks.
    if (!useUi.getState().settingsOpen) void refreshMcp({ start: false })
  }, [refreshPermissions, refreshMcp])

  useEffect(() => {
    if (root) refresh()
    else {
      usePermissions.setState({ report: null, error: null })
      useMcp.setState({ report: null, error: null })
    }
  }, [root, refresh])

  const running = useChat((state) => state.running)
  const wasRunning = useRef(running)
  useEffect(() => {
    const ended = wasRunning.current && !running
    wasRunning.current = running
    if (ended && useWorkspace.getState().workspace) refresh()
  }, [running, refresh])

  useEffect(() => {
    const onFocus = () => {
      if (useWorkspace.getState().workspace) refresh()
    }
    window.addEventListener('focus', onFocus)
    const stop = api.mcp.onChanged(() => {
      if (useWorkspace.getState().workspace && !useUi.getState().settingsOpen) void refreshMcp({ start: false })
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [refresh, refreshMcp])

  const banner = root ? bannerOf(report) : null
  if (banner) {
    const danger = banner.tone === 'danger'
    return (
      <div className={cx('trust-banner', danger && 'is-danger')} role={danger ? 'alert' : 'status'}>
        {danger ? <ShieldAlert size={15} /> : <AlertTriangle size={15} />}
        <span className="trust-banner-text">{banner.text}</span>
        <Button size="sm" variant={danger ? 'default' : 'ghost'} onClick={() => openSettings('permissions')}>
          {banner.action}
        </Button>
      </div>
    )
  }

  const servers = root && mcp ? mcpBannerOf(mcp) : null
  const key = root && mcp && servers ? bannerKey(mcp) : null
  if (!servers || !key || dismissed.includes(key)) return null
  return (
    <div className="trust-banner" role="status">
      <AlertTriangle size={15} />
      <span className="trust-banner-text">{servers.text}</span>
      <Button size="sm" variant="ghost" onClick={() => openSettings('mcp')}>
        {servers.action}
      </Button>
      <IconButton
        label="Not now"
        size="sm"
        onClick={() => {
          const next = [...dismissed, key]
          setDismissed(next)
          writeDismissed(next)
        }}
      >
        <X size={13} />
      </IconButton>
    </div>
  )
}
