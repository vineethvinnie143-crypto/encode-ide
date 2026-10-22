import { useEffect, useState } from 'react'
import type { PermissionRuleView, PermissionsReport, RuleScope } from '@shared/types'
import {
  BEHAVIOR_NAMES,
  SCOPE_CHOICES,
  SCOPE_NAMES,
  groupRules,
  removable,
  ruleTiming,
  scopeNote,
  shortPath,
  trustState,
  type RuleBehavior,
} from '../../panels/permissions'
import { usePermissions } from '../../stores/permissions'
import { useUi } from '../../stores/ui'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ShieldCheck, Trash2 } from '../../ui/icons'
import { Chip } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'

const BEHAVIOR_OPTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Never allow' },
] as const

const EXAMPLES = ['Bash(npm test:*)', 'Read(./.env)', 'Edit(/docs/**)', 'WebFetch(domain:example.com)']

/**
 * Settings > Permissions: whether the open folder is trusted, what its own settings are waiting to grant, and the
 * rules that decide what the agent may do without asking. Every change is made at once and the screen shows the
 * folder as it stands afterwards; there is no Save for this tab.
 */
export default function PermissionsPane() {
  const report = usePermissions((state) => state.report)
  const error = usePermissions((state) => state.error)
  const refresh = usePermissions((state) => state.refresh)

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (!report) {
    return (
      <div className="settings-permissions">
        <div className="info-note">
          {error ? `eNCode could not read this folder’s permissions: ${error}` : 'Open a folder to see who may do what in it. Permissions belong to a folder, and the first time you open one it is not trusted.'}
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
    <div className="settings-permissions">
      <FolderCard report={report} />
      {report.problems.length > 0 && <Problems report={report} />}
      {report.waiting.length > 0 && <Waiting report={report} />}
      <Rules report={report} />
      <AddRule report={report} />
      <Hooks report={report} />
      <Extras report={report} />
    </div>
  )
}

function useRun() {
  const act = usePermissions((state) => state.act)
  const notify = useUi((state) => state.notify)
  const [busy, setBusy] = useState(false)
  const run = async (...args: Parameters<typeof act>): Promise<boolean> => {
    setBusy(true)
    try {
      const outcome = await act(...args)
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
      setBusy(false)
    }
  }
  return { run, busy }
}

function FolderCard({ report }: { report: PermissionsReport }) {
  const { run, busy } = useRun()
  const [confirming, setConfirming] = useState(false)
  const state = trustState(report)

  const chip =
    state === 'broken'
      ? { tone: 'danger' as const, label: 'Settings unreadable' }
      : state === 'trusted'
        ? { tone: 'success' as const, label: 'Trusted' }
        : state === 'changed'
          ? { tone: 'warning' as const, label: 'Settings changed' }
          : { tone: 'neutral' as const, label: 'Not trusted' }

  const trust = async () => {
    if (report.trustWarning && !confirming) {
      setConfirming(true)
      return
    }
    if (await run({ type: 'trust', acknowledged: confirming })) setConfirming(false)
  }

  return (
    <section className="settings-card perm-folder" aria-label="This folder">
      <div className="perm-folder-top">
        <div className="perm-folder-id">
          <ShieldCheck size={16} />
          <span className="perm-folder-name" title={report.root}>
            {shortPath(report.root, 64)}
          </span>
        </div>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>

      {state === 'broken' && report.broken ? (
        <div className="perm-folder-text is-danger">{report.broken}</div>
      ) : state === 'trusted' ? (
        <div className="perm-folder-text">You trust this folder. Its own settings apply, and git runs without asking.</div>
      ) : state === 'changed' ? (
        <div className="perm-folder-text">
          You trust this folder, but its settings changed since you approved them. What they grant waits until you read the change and approve it.
        </div>
      ) : state === 'untrusted-waiting' ? (
        <div className="perm-folder-text">
          This folder’s own settings ask for more than the defaults. Nothing it grants applies until you trust the folder; what it takes away applies now.
        </div>
      ) : (
        <div className="perm-folder-text">
          You have not trusted this folder. Your own rules apply, git asks before it runs, and settings files in the folder cannot grant anything.
        </div>
      )}

      {confirming && report.trustWarning && (
        <div className="perm-warning" role="alert">
          <AlertTriangle size={14} />
          <span>{report.trustWarning} Only trust it if you mean to.</span>
        </div>
      )}

      <div className="perm-folder-actions">
        {!report.trusted ? (
          <>
            <Button variant="primary" size="sm" busy={busy} onClick={() => void trust()}>
              {confirming ? 'Trust anyway' : 'Trust this folder'}
            </Button>
            {confirming && (
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            {!report.configApproved && (
              <Button variant="primary" size="sm" busy={busy} onClick={() => void run({ type: 'approve' })}>
                Approve these settings
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run({ type: 'revoke' })}>
              Stop trusting this folder
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

function Problems({ report }: { report: PermissionsReport }) {
  return (
    <section className={cx('perm-problems', report.broken && 'is-danger')} aria-label="Problems in the settings">
      <div className="perm-problems-title">{report.broken ? 'Fix these before anything can run' : 'Settings eNCode could not use'}</div>
      <ul>
        {report.problems.map((problem, index) => (
          <li key={`${index}-${problem}`}>{problem}</li>
        ))}
      </ul>
    </section>
  )
}

function Waiting({ report }: { report: PermissionsReport }) {
  return (
    <section aria-label="Waiting for your review">
      <div className="section-title">Waiting for your review</div>
      {report.waiting.map((item) => (
        <details key={item.file} className="perm-waiting">
          <summary>
            <span className="perm-waiting-file" title={item.file}>
              {shortPath(item.file, 64)}
            </span>
            <span className="perm-waiting-hint">Read what it grants</span>
          </summary>
          <pre>{item.text}</pre>
        </details>
      ))}
    </section>
  )
}

function Rules({ report }: { report: PermissionsReport }) {
  const groups = groupRules(report.rules)
  const { run, busy } = useRun()
  return (
    <section aria-label="Rules">
      <div className="section-title">Rules</div>
      {groups.length === 0 ? (
        <div className="info-note">
          No rules yet. Choose “Always allow” on an approval to add one, or write one below. Rules in your user settings apply in every project.
        </div>
      ) : (
        <div className="perm-groups">
          {groups.map((group) => (
            <div key={group.behavior} className="perm-group">
              <div className="perm-group-head">
                <span className="perm-group-title">{BEHAVIOR_NAMES[group.behavior].title}</span>
                <span className="perm-group-help">{BEHAVIOR_NAMES[group.behavior].help}</span>
              </div>
              {group.rules.map((rule) => (
                <RuleRow key={`${rule.scope}:${rule.behavior}:${rule.text}`} rule={rule} busy={busy} onRemove={(item) => void run({ type: 'remove-rule', scope: item.scope, behavior: item.behavior, text: item.text })} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function RuleRow({ rule, busy, onRemove }: { rule: PermissionRuleView; busy: boolean; onRemove: (rule: PermissionRuleView & { scope: RuleScope }) => void }) {
  return (
    <div className={cx('perm-rule', !rule.active && 'is-waiting')}>
      <code className="perm-rule-text">{rule.text}</code>
      {!rule.active && <Chip tone="warning">Waits for approval</Chip>}
      <Chip>{SCOPE_NAMES[rule.scope]}</Chip>
      {removable(rule) ? (
        <IconButton label="Remove this rule" size="sm" disabled={busy} onClick={() => onRemove(rule)}>
          <Trash2 size={13} />
        </IconButton>
      ) : (
        <span className="perm-rule-pad" />
      )}
    </div>
  )
}

function AddRule({ report }: { report: PermissionsReport }) {
  const { run, busy } = useRun()
  const [behavior, setBehavior] = useState<RuleBehavior>('deny')
  const [scope, setScope] = useState<RuleScope>('local')
  const [text, setText] = useState('')

  const add = async () => {
    if (!text.trim()) return
    if (await run({ type: 'add-rule', scope, behavior, text: text.trim() })) setText('')
  }

  return (
    <section aria-label="Add a rule">
      <div className="section-title">Add a rule</div>
      <div className="settings-card perm-add">
        <Segmented value={behavior} options={BEHAVIOR_OPTIONS} onChange={setBehavior} label="What the rule does" size="sm" />
        <input
          className="text-input perm-add-text"
          value={text}
          placeholder={EXAMPLES[0]}
          spellCheck={false}
          aria-label="The rule"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void add()
            }
          }}
        />
        <div className="perm-add-row">
          <select className="text-input" value={scope} aria-label="Where to save it" onChange={(event) => setScope(event.target.value as RuleScope)}>
            {SCOPE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <Button variant="primary" size="sm" busy={busy} disabled={!text.trim()} onClick={() => void add()}>
            Add rule
          </Button>
        </div>
        <div className="perm-add-help">
          {scopeNote(scope, ruleTiming(report, scope))} Examples: {EXAMPLES.map((example, index) => (
            <span key={example}>
              {index > 0 && ', '}
              <code>{example}</code>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

function Hooks({ report }: { report: PermissionsReport }) {
  return (
    <section aria-label="Hooks">
      <div className="section-title">Hooks</div>
      {report.hooks.length === 0 ? (
        <div className="info-note">
          No hooks. A hook is a command that runs at a point in the agent’s work, such as before a tool call or when it stops. Add them under <code>hooks</code> in a settings file.
        </div>
      ) : (
        <div className="perm-hooks">
          {report.hooks.map((hook, index) => (
            <div key={`${index}-${hook.event}-${hook.command}`} className="perm-hook">
              <div className="perm-hook-top">
                <span className="perm-hook-event">{hook.event}</span>
                {hook.matcher && <Chip mono>{hook.matcher}</Chip>}
                <Chip>{SCOPE_NAMES[hook.scope]}</Chip>
                <span className="perm-hook-time">up to {hook.timeout} s</span>
              </div>
              <pre className="perm-hook-command">{hook.command}</pre>
            </div>
          ))}
        </div>
      )}
      <div className="perm-add-help">Hooks run commands with your rights, in the same environment as the agent’s own commands. A project’s hooks wait until you trust the folder and approve its settings.</div>
    </section>
  )
}

function Extras({ report }: { report: PermissionsReport }) {
  if (!report.additionalDirectories.length && !report.envNames.length && !report.defaultMode) return null
  return (
    <section aria-label="Also in the settings">
      <div className="section-title">Also in the settings</div>
      <div className="settings-card">
        {report.additionalDirectories.length > 0 && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Extra folders</div>
              <div className="settings-row-help">Read and edited as if they were part of the project.</div>
              <div className="perm-list">
                {report.additionalDirectories.map((directory) => (
                  <code key={directory} title={directory}>
                    {shortPath(directory, 72)}
                  </code>
                ))}
              </div>
            </div>
          </div>
        )}
        {report.envNames.length > 0 && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Variables for commands</div>
              <div className="settings-row-help">Set in the settings and handed to every command the agent runs. Names only.</div>
              <div className="perm-list">
                {report.envNames.map((name) => (
                  <code key={name}>{name}</code>
                ))}
              </div>
            </div>
          </div>
        )}
        {report.defaultMode && (
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Mode the settings ask for</div>
              <div className="settings-row-help">
                <code>{report.defaultMode}</code>. Your choice under Agent decides; this is shown so you know the project suggests one.
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
