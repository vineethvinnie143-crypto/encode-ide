import { useEffect } from 'react'
import type { ErrorGate, LanguageLibraryInfo, LanguageServerInfo, Settings } from '@shared/types'
import { api } from '../../api'
import { filesLabel, headline, installPercent, sortedServers, stateLabel } from '../../panels/code'
import { useCode } from '../../stores/code'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Code2, Copy, Download, RefreshCw, Trash2 } from '../../ui/icons'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { Toggle } from '../../ui/Toggle'
import { SettingRow, SettingsGroup } from '../settings/Section'

const GATES: SegmentedOption<ErrorGate>[] = [
  { value: 'auto', label: 'Once' },
  { value: 'on', label: 'Up to 3 times' },
  { value: 'off', label: 'Never' },
]

/** "Used by 42 files here · tsconfig.json": why this server matters in the open folder. */
function usedLabel(server: LanguageServerInfo, partial: boolean): string | null {
  const used = server.used
  if (!used || (used.files === 0 && !used.markers.length)) return null
  const files = used.files ? `${used.files}${partial ? '+' : ''} ${used.files === 1 ? 'file' : 'files'} here` : 'a project here'
  return used.markers.length ? `${files} · ${used.markers.slice(0, 2).join(', ')}` : files
}

/** What eNCode installs for a server to read (FiveM's natives for Lua), under the server. */
function LibraryRow({ library, canInstall }: { library: LanguageLibraryInfo; canInstall: boolean }) {
  const percent = installPercent(library)
  const state = library.installing
    ? { label: percent === null ? 'Installing' : `Installing, ${percent}%`, tone: 'busy' }
    : library.installed
      ? { label: 'Installed', tone: 'success' }
      : { label: 'Not installed', tone: 'quiet' }
  return (
    <div className="lsp-library" data-library={library.id}>
      <div className="lsp-server-head">
        <span className="lsp-library-name">{library.label}</span>
        <span className="lsp-server-files">{library.what}</span>
        <span className={cx('lsp-server-state', `is-${state.tone}`)}>{state.label}</span>
      </div>
      {library.installing && (
        <div className="lsp-server-progress">
          <div className={percent === null ? 'install-server-bar is-unknown' : 'install-server-bar'} role="progressbar" aria-label={`Installing ${library.what}`} aria-valuemin={0} aria-valuemax={100} {...(percent === null ? {} : { 'aria-valuenow': percent })}>
            <span style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void api.code.cancelInstall(library.id)}>
            Stop
          </Button>
        </div>
      )}
      {!library.installed && !library.installing && library.installError && <div className="lsp-server-detail is-danger">{library.installError}</div>}
      {!library.installed && !library.installing && canInstall && (
        <div className="lsp-server-actions">
          <Button size="sm" icon={<Download size={13} />} onClick={() => useCode.getState().offerInstall(library.id)}>
            {library.installError ? 'Try again…' : 'Install…'}
          </Button>
        </div>
      )}
      {library.installed && !library.installing && (
        <div className="lsp-server-actions">
          <span className="lsp-server-owned">Installed by eNCode, {library.installed}</span>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void useCode.getState().remove(library.id)}>
            Remove
          </Button>
        </div>
      )}
    </div>
  )
}

function ServerRow({ server, partial, canInstall }: { server: LanguageServerInfo; partial: boolean; canInstall: boolean }) {
  const { label, tone } = stateLabel(server)
  const copy = () => void navigator.clipboard.writeText(server.install).then(() => useUi.getState().notify('success', 'Install command copied.'))
  // Where it was found while it runs; why it stopped, failed or is missing otherwise.
  const detail = server.state === 'running' || server.state === 'starting' ? server.command : server.state === 'missing' ? undefined : server.detail
  const used = usedLabel(server, partial)
  const percent = installPercent(server)
  const missing = server.state === 'missing' && !server.installing
  return (
    <div className="lsp-server" data-server={server.id}>
      <div className="lsp-server-head">
        <span className="lsp-server-name">{server.label}</span>
        <span className="lsp-server-files">{filesLabel(server)}</span>
        {used && <span className="lsp-server-used">{used}</span>}
        <span className={cx('lsp-server-state', `is-${tone}`)}>
          {label}
          {server.state === 'running' && server.documents > 0 ? `, ${server.documents} ${server.documents === 1 ? 'file' : 'files'}` : ''}
        </span>
      </div>
      {detail && <div className="lsp-server-detail">{detail}</div>}
      {server.installing && (
        <div className="lsp-server-progress">
          <div className={percent === null ? 'install-server-bar is-unknown' : 'install-server-bar'} role="progressbar" aria-label={`Installing ${server.label}'s server`} aria-valuemin={0} aria-valuemax={100} {...(percent === null ? {} : { 'aria-valuenow': percent })}>
            <span style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void api.code.cancelInstall(server.id)}>
            Stop
          </Button>
        </div>
      )}
      {missing && server.installError && <div className="lsp-server-detail is-danger">{server.installError}</div>}
      {missing && server.installer && canInstall && (
        <div className="lsp-server-actions">
          <Button size="sm" icon={<Download size={13} />} onClick={() => useCode.getState().offerInstall(server.id)}>
            {server.installError ? 'Try again…' : 'Install…'}
          </Button>
          {server.install && (
            <span className="lsp-server-or" title={server.install}>
              or install it yourself
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={copy}>
                Copy command
              </Button>
            </span>
          )}
        </div>
      )}
      {missing && (!server.installer || !canInstall) && server.install && (
        <div className="lsp-server-install">
          <code>{server.install}</code>
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={copy}>
            Copy
          </Button>
        </div>
      )}
      {server.installed && !server.installing && (
        <div className="lsp-server-actions">
          <span className="lsp-server-owned">Installed by eNCode, {server.installed}</span>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void useCode.getState().remove(server.id)}>
            Remove
          </Button>
        </div>
      )}
      {server.libraries?.map((library) => (
        <LibraryRow key={library.id} library={library} canInstall={canInstall} />
      ))}
    </div>
  )
}

/**
 * Settings > Language servers: whether eNCode starts the servers installed on this computer, what the agent does with
 * the errors they report, and how each one stands in the open folder, with the command that installs a missing one.
 */
export default function LanguageServersSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const report = useCode((state) => state.report)
  const error = useCode((state) => state.error)
  const loading = useCode((state) => state.loading)
  const refresh = useCode((state) => state.refresh)

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const stop = api.code.onChanged(() => void refresh())
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [refresh])

  // The setting changes what the report says; read it again once the host has it.
  useEffect(() => {
    void refresh()
  }, [settings.languageServers, refresh])

  const top = report ? headline(report) : null

  return (
    <>
      <SettingsGroup
        title="Language servers"
        description="Separate programs, such as typescript-language-server, pyright, rust-analyzer, gopls, clangd or lua-language-server. eNCode carries none of them, and installs one only when you click Install."
      >
        <SettingRow
          id="code.enabled"
          htmlFor="language-servers"
          label="Use language servers"
          help="In folders you trust, the editor marks errors as you type, and the agent finds definitions and references exactly, renames across files, and hears what its edits broke."
        >
          <Toggle id="language-servers" checked={settings.languageServers} onChange={(languageServers) => void save({ languageServers })} />
        </SettingRow>
        <SettingRow
          id="code.errorGate"
          label="Send the agent back to fix errors"
          help="When the agent wants to finish while the servers still report errors in files it changed, it is sent back to fix them. It is always told what each edit broke."
        >
          <Segmented label="Send the agent back to fix errors" value={settings.errorGate} options={GATES} onChange={(errorGate) => void save({ errorGate })} />
        </SettingRow>
        <SettingRow
          id="code.formatOnSave"
          htmlFor="format-on-save"
          label="Format on save"
          help="Saving a file formats it first, the way its language server formats code. Not every server formats (pyright does not). A server that takes longer than a second and a half is not waited for, and the file is saved as it is."
        >
          <Toggle id="format-on-save" checked={settings.formatOnSave} onChange={(formatOnSave) => void save({ formatOnSave })} />
        </SettingRow>
        <SettingRow
          id="code.formatOnType"
          htmlFor="format-on-type"
          label="Format as you type"
          help="The server tidies a line once you finish it, after a ; or a } or a new line. Each tidy-up is its own step for Ctrl+Z."
        >
          <Toggle id="format-on-type" checked={settings.formatOnType} onChange={(formatOnType) => void save({ formatOnType })} />
        </SettingRow>
      </SettingsGroup>

      <section className="settings-group" data-setting="code.servers">
        <h2 className="settings-group-title">In this folder</h2>
        {!report ? (
          <div className="info-note">
            {error ? `eNCode could not read the language servers: ${error}` : 'Open a folder to see which language servers it uses.'}
            {error && (
              <div>
                <Button size="sm" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            {top && (
              <div className={cx('lsp-state', `is-${top.tone}`)} aria-live="polite">
                <span className="lsp-state-icon" aria-hidden="true">
                  <Code2 size={18} />
                </span>
                <div className="lsp-state-text">
                  <div className="lsp-state-title">{top.title}</div>
                  <div className="lsp-state-detail">{top.detail}</div>
                </div>
                {top.action === 'trust' && (
                  <Button size="sm" onClick={() => useUi.getState().openSettings('permissions')}>
                    Trust in Permissions
                  </Button>
                )}
                {top.action === 'turn-on' && (
                  <Button size="sm" onClick={() => void save({ languageServers: true })}>
                    Turn on
                  </Button>
                )}
                {!top.action && (
                  <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} busy={loading} onClick={() => void refresh()}>
                    Check again
                  </Button>
                )}
              </div>
            )}
            <div className="settings-card lsp-servers">
              {sortedServers(report).map((server) => (
                <ServerRow key={server.id} server={server} partial={Boolean(report.partial)} canInstall={report.state === 'on'} />
              ))}
            </div>
            <div className="perm-add-help">
              eNCode looks in the project’s own <code>node_modules/.bin</code> first, then on the PATH, then in what it installed itself. A server you just
              installed is found within half a minute; a server runs outside the sandbox of the agent’s commands, with the agent’s environment and no API keys.
              One-click installs come from fixed addresses at pinned versions and are checked before they are unpacked.
            </div>
          </>
        )}
      </section>
    </>
  )
}
