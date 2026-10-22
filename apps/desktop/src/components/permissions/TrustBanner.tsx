import { useEffect, useRef } from 'react'
import { bannerOf } from '../../panels/permissions'
import { useChat } from '../../stores/chat'
import { usePermissions } from '../../stores/permissions'
import { useUi } from '../../stores/ui'
import { useWorkspace } from '../../stores/workspace'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ShieldAlert } from '../../ui/icons'

/**
 * A line above the composer when the open folder needs the person: its settings cannot be read (nothing runs), or it
 * asks for more than a folder that is not trusted may be given. It reads the folder when the folder or the window
 * changes and when the agent finishes a turn (it may have written to the settings, which an approval let through); the
 * Permissions screen is where it is dealt with.
 */
export default function TrustBanner() {
  const root = useWorkspace((state) => state.workspace?.root)
  const report = usePermissions((state) => state.report)
  const refresh = usePermissions((state) => state.refresh)
  const openSettings = useUi((state) => state.openSettings)

  useEffect(() => {
    if (root) void refresh()
    else usePermissions.setState({ report: null, error: null })
  }, [root, refresh])

  const running = useChat((state) => state.running)
  const wasRunning = useRef(running)
  useEffect(() => {
    const ended = wasRunning.current && !running
    wasRunning.current = running
    if (ended && useWorkspace.getState().workspace) void refresh()
  }, [running, refresh])

  useEffect(() => {
    const onFocus = () => {
      if (useWorkspace.getState().workspace) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const banner = root ? bannerOf(report) : null
  if (!banner) return null
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
