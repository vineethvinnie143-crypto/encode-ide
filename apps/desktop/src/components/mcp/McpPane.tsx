import { useEffect, useState } from 'react'
import type { McpAction, McpReport, McpServerView } from '@shared/types'
import { api } from '../../api'
import { STATE_CHIPS, SCOPE_LABELS, approvalWarning, cardActions, environmentLine, offerLine, summaryLine, type McpCardAction } from '../../panels/mcp'
import { shortPath } from '../../panels/permissions'
import { useMcp } from '../../stores/mcp'
import { useUi, type SettingsSection } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, RefreshCw } from '../../ui/icons'
import { Chip } from '../../ui/Pill'

const EXAMPLE = JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } }, null, 2)

/**
 * Settings > MCP: the servers that give the agent tools from outside programs. Yours start with eNCode; a project's
 * wait until the folder is trusted and you have read, and approved, exactly what each one starts. Every change is made
 * at once and the screen shows the servers as they stand afterwards; there is no Save for this tab.
 */
export default function McpPane({ onOpenTab }: { onOpenTab(section: SettingsSection): void }) {
  const report = useMcp((state) => state.report)
  const error = useMcp((state) => state.error)
  const refresh = useMcp((state) => state.refresh)

  // This screen is about how the servers run, so looking at it starts them, as a chat in the folder would.
  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const stop = api.mcp.onChanged(() => void refresh())
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [refresh])

  if (!report) {
    return (
      <div className="settings-mcp">
        <div className="info-note">
          {error ? `eNCode could not read this folder’s MCP servers: ${error}` : 'Open a folder to see its MCP servers. Servers you set up for yourself work in every folder; a project’s own wait for your approval.'}
        </div>
        {error && (
          <div>
            <Button size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settings-mcp">
      <Overview report={report} />
      {report.broken && (
        <section className="perm-problems is-danger" aria-label="Why no server runs">
          <div className="perm-problems-title">No server runs until this is fixed</div>
          <ul>
            <li>{report.broken}</li>
          </ul>
        </section>
      )}
      {report.problems.length > 0 && (
        <section className="perm-problems" aria-label="Problems in the MCP files">
          <div className="perm-problems-title">Entries eNCode could not use</div>
          <ul>
            {report.problems.map((problem, index) => (
              <li key={`${index}-${problem}`}>{problem}</li>
            ))}
          </ul>
        </section>
      )}
      {report.servers.length === 0 ? <Empty report={report} /> : report.servers.map((server) => <ServerCard key={`${server.scope}:${server.name}`} server={server} report={report} onOpenTab={onOpenTab} />)}
      <Files report={report} />
    </div>
  )
}

function Overview({ report }: { report: McpReport }) {
  const refresh = useMcp((state) => state.refresh)
  const loading = useMcp((state) => state.loading)
  return (
    <div className="mcp-overview">
      <div className="mcp-overview-text">
        <div className="mcp-overview-title">MCP servers</div>
        <div className="mcp-overview-sub">
          {summaryLine(report)}
          {report.starting ? ' · starting…' : ''}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} busy={loading} onClick={() => void refresh()}>
        Refresh
      </Button>
    </div>
  )
}

function useRun() {
  const act = useMcp((state) => state.act)
  const notify = useUi((state) => state.notify)
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (kind: string, action: McpAction): Promise<boolean> => {
    setBusy(kind)
    try {
      const outcome = await act(action)
      if (!outcome) {
        notify('error', 'eNCode could not do that. Try again.')
        return false
      }
      if (!outcome.ok) {
        notify('error', outcome.reason)
        return false
      }
      if (outcome.note) notify('info', outcome.note)
      return true
    } finally {
      setBusy(null)
    }
  }
  return { run, busy }
}

function ServerCard({ server, report, onOpenTab }: { server: McpServerView; report: McpReport; onOpenTab(section: SettingsSection): void }) {
  const { run, busy } = useRun()
  const chip = STATE_CHIPS[server.state]
  const actions = cardActions(server, report)
  const offer = offerLine(server)
  const environment = environmentLine(server)
  const approval = server.state === 'needs-approval' && server.scope === 'project' && !report.broken
  const approve = actions.find((action) => action.kind === 'approve')

  const press = (action: McpCardAction) => {
    switch (action.kind) {
      case 'approve':
        return run(action.kind, { type: 'approve', name: server.name, digest: server.digest })
      case 'forget':
        return run(action.kind, { type: 'forget', name: server.name })
      case 'restart':
        return run(action.kind, { type: 'restart', name: server.name })
      case 'turn-off':
        return run(action.kind, { type: 'turn-off', name: server.name })
      case 'turn-on':
        return run(action.kind, { type: 'turn-on', name: server.name })
    }
  }

  return (
    <section className={cx('mcp-card', `is-${server.state}`)} aria-label={`MCP server ${server.name}`}>
      <header className="mcp-card-top">
        <span className={cx('mcp-dot', `is-${server.state}`)} aria-hidden="true" />
        <span className="mcp-name">{server.name}</span>
        <Chip>{SCOPE_LABELS[server.scope]}</Chip>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </header>

      <code className="mcp-summary" title={`${server.summary}\n${server.file}`}>
        {server.summary}
      </code>
      {server.detail && <p className={cx('mcp-detail', server.state === 'failed' && 'is-danger')}>{server.detail}</p>}
      {offer && <p className="mcp-offer">{offer}</p>}
      {environment && <p className="mcp-environment">{environment}</p>}
      {server.problems.length > 0 && (
        <ul className="mcp-problems">
          {server.problems.map((problem, index) => (
            <li key={`${index}-${problem}`}>{problem}</li>
          ))}
        </ul>
      )}

      {approval && (
        <div className="mcp-approval" role="group" aria-label="Approval">
          <AlertTriangle size={14} />
          <div className="mcp-approval-text">
            <span>{approvalWarning(server)}</span>
            {approve?.kind === 'approve' && approve.blocked && (
              <span className="mcp-approval-blocked">
                {approve.blocked}{' '}
                <button className="link-btn" onClick={() => onOpenTab('permissions')}>
                  Open Permissions
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <div className="mcp-actions">
          {actions.map((action) => (
            <Button
              key={action.kind}
              size="sm"
              variant={action.kind === 'approve' ? 'primary' : 'ghost'}
              busy={busy === action.kind}
              disabled={busy !== null || (action.kind === 'approve' && Boolean(action.blocked))}
              onClick={() => void press(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {server.tools.length > 0 && (
        <details className="mcp-details">
          <summary>Tools ({server.tools.length})</summary>
          <ul className="mcp-tools">
            {server.tools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                {tool.description && <span>{tool.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {server.log.length > 0 && (
        <details className="mcp-details">
          <summary>What it printed ({server.log.length} {server.log.length === 1 ? 'line' : 'lines'})</summary>
          <pre className="mcp-log">{server.log.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}

function Empty({ report }: { report: McpReport }) {
  const notify = useUi((state) => state.notify)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EXAMPLE)
      notify('success', 'Copied. Paste it into one of the files below and change it to the server you want.')
    } catch {
      notify('error', 'eNCode could not copy that. Select the text and copy it yourself.')
    }
  }
  return (
    <section className="mcp-empty" aria-label="No servers">
      <div className="mcp-empty-title">No MCP servers yet</div>
      <p>
        An MCP server gives the agent tools from another program: a database, a browser, an issue tracker. Describe one in{' '}
        <code title={report.files.user}>{shortPath(report.files.user, 48)}</code> for every project, or in <code>.mcp.json</code> in a project (the file Claude Code reads too).
      </p>
      <pre className="mcp-example">{EXAMPLE}</pre>
      <div>
        <Button size="sm" onClick={() => void copy()}>
          Copy this example
        </Button>
      </div>
    </section>
  )
}

function Files({ report }: { report: McpReport }) {
  const rows: Array<[string, string]> = [
    [report.files.user, 'Your servers, in every project.'],
    [report.files.project, 'This project’s servers, shared with everyone who uses it. Claude Code reads this file too.'],
    [report.files.encode, 'This project’s servers for eNCode only. A server here replaces one of the same name in the file above.'],
  ]
  return (
    <section aria-label="Where servers are set up">
      <div className="section-title">Where servers are set up</div>
      <div className="settings-card mcp-files">
        {rows.map(([file, help]) => (
          <div key={file} className="settings-row">
            <div className="settings-row-text">
              <code className="mcp-file" title={file}>
                {shortPath(file, 72)}
              </code>
              <div className="settings-row-help">{help}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="perm-add-help">Add or remove a server by editing one of these files; eNCode reads them again as soon as you save. A project’s server never starts until you approve exactly what it starts, and a changed entry has to be approved again.</div>
    </section>
  )
}
