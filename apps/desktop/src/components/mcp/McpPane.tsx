import { useEffect, useMemo, useState } from 'react'
import type { McpAction, McpReport, McpServerView } from '@shared/types'
import { api } from '../../api'
import { STATE_CHIPS, SCOPE_LABELS, approvalWarning, cardActions, environmentLine, newServerOf, offerLine, summaryLine, writtenValues, type McpCardAction, type McpServerForm } from '../../panels/mcp'
import { shortPath } from '../../panels/permissions'
import { useMcp } from '../../stores/mcp'
import { useUi, type SettingsSection } from '../../stores/ui'
import { copyText } from '../../copy'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { AlertTriangle, Plus, RefreshCw } from '../../ui/icons'
import { Chip } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'

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
  const [adding, setAdding] = useState(false)
  return (
    <div className="mcp-overview">
      <div className="mcp-overview-text">
        <div className="mcp-overview-title">MCP servers</div>
        <div className="mcp-overview-sub">
          {summaryLine(report)}
          {report.starting ? ' · starting…' : ''}
        </div>
      </div>
      <div className="mcp-overview-actions">
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} busy={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          Add a server
        </Button>
      </div>
      {adding && <AddServer report={report} onClose={() => setAdding(false)} />}
    </div>
  )
}

const KINDS = [
  { value: 'stdio', label: 'Program' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
] as const
const SCOPES = [
  { value: 'user', label: 'All my projects' },
  { value: 'project', label: 'This project' },
] as const
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/

/** Settings > MCP > Add a server: written into the file of its scope, which the screen reads again at once. */
function AddServer({ report, onClose }: { report: McpReport; onClose: () => void }) {
  const { run, busy } = useRun()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [form, setForm] = useState<McpServerForm>({ kind: 'stdio', commandLine: '', env: '', url: '', headers: '' })
  const [problem, setProblem] = useState<string | null>(null)
  const edit = (patch: Partial<McpServerForm>) => setForm((current) => ({ ...current, ...patch }))
  const server = useMemo(() => newServerOf(form), [form])
  const shared = scope === 'project' && typeof server !== 'string' ? writtenValues(server) : []
  const nameProblem = name && !SERVER_NAME.test(name) ? 'Use letters, digits, - and _, starting with a letter or digit.' : name.includes('__') ? 'A name cannot hold two underscores in a row.' : null

  const add = async () => {
    if (!name || nameProblem) return setProblem(nameProblem ?? 'Name the server.')
    if (typeof server === 'string') return setProblem(server)
    setProblem(null)
    if (await run('add', { type: 'add', name, scope, setup: server })) onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add an MCP server"
      description={scope === 'user' ? `Written into ${shortPath(report.files.user, 56)}; it starts in every project.` : 'Written into this project’s .mcp.json, which Claude Code reads too and everyone who has the project shares.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'add'} disabled={!name || Boolean(nameProblem)} onClick={() => void add()}>
            Add the server
          </Button>
        </>
      }
    >
      <form
        className="form-stack mcp-add"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <label className="form-field">
          <span className="form-label">Name</span>
          <input className="text-input" data-autofocus value={name} placeholder="github" spellCheck={false} maxLength={48} onChange={(event) => setName(event.target.value.trim())} />
          <span className={cx('form-help', nameProblem && 'is-problem')}>{nameProblem ?? 'Its tools reach the agent as mcp__name__tool.'}</span>
        </label>
        <div className="form-field">
          <span className="form-label">Where</span>
          <Segmented label="Where" value={scope} options={[...SCOPES]} onChange={setScope} />
        </div>
        <div className="form-field">
          <span className="form-label">How eNCode reaches it</span>
          <Segmented label="How eNCode reaches it" value={form.kind} options={[...KINDS]} onChange={(kind) => edit({ kind })} />
        </div>
        {form.kind === 'stdio' ? (
          <>
            <label className="form-field">
              <span className="form-label">Command</span>
              <input className="text-input mcp-add-code" value={form.commandLine} placeholder="npx -y @modelcontextprotocol/server-filesystem ." spellCheck={false} onChange={(event) => edit({ commandLine: event.target.value })} />
              {typeof server !== 'string' && server.type === 'stdio' ? (
                <span className="mcp-add-words" aria-label="What it runs, word by word">
                  {[server.command, ...server.args].map((word, index) => (
                    <code key={`${index}-${word}`}>{word || '""'}</code>
                  ))}
                </span>
              ) : (
                <span className="form-help">Quote a word with spaces in it. eNCode runs it in the open folder.</span>
              )}
            </label>
            <label className="form-field">
              <span className="form-label">Environment variables</span>
              <textarea className="text-input mcp-add-pairs" rows={3} value={form.env} placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}'} spellCheck={false} onChange={(event) => edit({ env: event.target.value })} />
              <span className="form-help">One NAME=value a line. {'${NAME}'} reads a variable of your own when the server starts.</span>
            </label>
          </>
        ) : (
          <>
            <label className="form-field">
              <span className="form-label">Address</span>
              <input className="text-input mcp-add-code" value={form.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} onChange={(event) => edit({ url: event.target.value })} />
            </label>
            <label className="form-field">
              <span className="form-label">Headers</span>
              <textarea className="text-input mcp-add-pairs" rows={3} value={form.headers} placeholder={'Authorization: Bearer ${API_TOKEN}'} spellCheck={false} onChange={(event) => edit({ headers: event.target.value })} />
              <span className="form-help">One Name: value a line. {'${NAME}'} reads a variable of your own when the server connects.</span>
            </label>
          </>
        )}
        {shared.length > 0 && (
          <p className="mcp-add-warning" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              {shared.join(', ')} {shared.length === 1 ? 'is' : 'are'} written into .mcp.json as typed, for everyone who has the project. For a token, write {'${NAME}'} and set NAME on your own computer.
            </span>
          </p>
        )}
        {problem && (
          <p className="form-problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
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

  const remove = async () => {
    const confirmed = await useUi.getState().askConfirm({
      title: `Remove ${server.name}?`,
      body: server.scope === 'project' ? `It comes out of ${shortPath(server.file, 56)}, which everyone who has the project shares, and its approval goes with it.` : `It comes out of ${shortPath(server.file, 56)} and stops in every project.`,
      confirmLabel: 'Remove the server',
      danger: true,
    })
    if (confirmed) await run('remove', { type: 'remove', name: server.name })
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
          <Button size="sm" variant="ghost" className="mcp-remove" busy={busy === 'remove'} disabled={busy !== null} onClick={() => void remove()}>
            Remove…
          </Button>
        </div>

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
    if (await copyText(EXAMPLE)) notify('success', 'Copied. Paste it into one of the files below and change it to the server you want.')
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
      <div className="perm-add-help">You can also edit these files yourself; eNCode reads them again as soon as you save. A project’s server never starts until you approve exactly what it starts, and a changed entry has to be approved again.</div>
    </section>
  )
}
