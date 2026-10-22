import { useEffect, useRef, useState } from 'react'
import { FREE_REF, MAX_ROLE_MODELS, MODEL_ROLES, ROLE_INFO, freeProfile, isFreeRef, labelOfRef, mainPatch, mainRefs } from '@shared/models'
import type { ModelRole, ModelStatus, Settings } from '@shared/types'
import { useModels } from '../../stores/models'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ArrowDown, ArrowUp, Plus, RefreshCw, X } from '../../ui/icons'
import type { Rect } from '../../ui/place'
import { Chip } from '../../ui/Pill'
import { Select } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { Toggle } from '../../ui/Toggle'
import { ModelPicker } from './ModelPicker'

type Draft = Pick<Settings, 'profiles' | 'roles' | 'activeProfileId' | 'freeOnly' | 'freeProfileId'>

/** The refs a role lists in the draft; Main falls back to the active connection's model, as the router does. */
function refsOf(draft: Draft, role: ModelRole): string[] {
  return role === 'main' ? mainRefs(draft) : [...(draft.roles[role] ?? [])]
}

/** The settings that make `refs` the role's list. */
export function rolePatch(draft: Draft, role: ModelRole, refs: readonly string[]): Partial<Settings> {
  if (role === 'main') return mainPatch(draft, refs)
  const { [role]: _replaced, ...others } = draft.roles
  return { roles: refs.length ? { ...others, [role]: [...refs] } : others }
}

function AddModel({ draft, role, onPick }: { draft: Draft; role: ModelRole; onPick: (ref: string) => void }) {
  const [anchor, setAnchor] = useState<Rect | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const refs = refsOf(draft, role)
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        icon={<Plus size={13} />}
        disabled={refs.length >= MAX_ROLE_MODELS}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-role-add={role}
        onClick={() => {
          const box = trigger.current?.getBoundingClientRect()
          if (box) setAnchor({ left: box.left, top: box.top, width: box.width, height: box.height })
        }}
      >
        Add model
      </Button>
      {anchor && (
        <ModelPicker
          anchor={anchor}
          selected={refs}
          side="bottom"
          align="end"
          ignore={trigger}
          label={`Add a model for ${ROLE_INFO[role].label}`}
          onClose={(refocus) => {
            setAnchor(null)
            if (refocus) trigger.current?.focus()
          }}
          onPick={(item) => onPick(item.kind === 'free' ? FREE_REF : item.ref)}
        />
      )}
    </>
  )
}

function RoleRow({ draft, role, onChange }: { draft: Draft; role: ModelRole; onChange: (patch: Partial<Settings>) => void }) {
  const info = ROLE_INFO[role]
  const refs = refsOf(draft, role)
  const set = (next: string[]) => onChange(rolePatch(draft, role, next))
  const move = (index: number, by: -1 | 1) => {
    const next = [...refs]
    ;[next[index], next[index + by]] = [next[index + by], next[index]]
    set(next)
  }
  // Main always needs a model: removing the last one would fall back to whatever the active connection holds.
  const canRemove = role !== 'main' || refs.length > 1

  return (
    <div className="role-row" data-role={role}>
      <div className="role-head">
        <div>
          <div className="role-name">{info.label}</div>
          <div className="role-hint">{info.hint}</div>
        </div>
        <AddModel draft={draft} role={role} onPick={(ref) => !refs.includes(ref) && set([...refs, ref])} />
      </div>
      {refs.length === 0 ? (
        <div className="role-follows">{info.follows ? `Uses ${ROLE_INFO[info.follows].label.toLowerCase()}.` : 'No model chosen.'}</div>
      ) : (
        <ol className="role-models">
          {refs.map((ref, index) => {
            const free = isFreeRef(draft, ref)
            const skipped = draft.freeOnly && !free
            return (
              <li key={ref} className={cx('role-model', skipped && 'is-skipped')}>
                <span className="role-order" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="role-model-name" title={labelOfRef(draft, ref)}>
                  {labelOfRef(draft, ref)}
                </span>
                {free && <Chip tone="success">Free</Chip>}
                {skipped && (
                  <Chip tone="warning" title="Billed models are skipped while only free models are allowed.">
                    <AlertTriangle size={11} /> Skipped
                  </Chip>
                )}
                <span className="role-model-actions">
                  <IconButton label="Try it earlier" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton label="Try it later" size="sm" disabled={index === refs.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton label="Remove" size="sm" disabled={!canRemove} onClick={() => set(refs.filter((_, at) => at !== index))}>
                    <X size={13} />
                  </IconButton>
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {refs.length > 1 && <div className="role-order-note">Tried in this order; the next one runs when one fails.</div>}
    </div>
  )
}

function untilText(until: number): string {
  const date = new Date(until)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

type Row = ModelStatus['providers'][number]

function summary(row: Row): { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string } {
  if (row.blocked) return { tone: 'bad', text: `${row.blocked.message} Paused until ${untilText(row.blocked.until)}.` }
  if (row.catalogError) return { tone: 'warn', text: row.catalogError }
  if (row.models === undefined) return { tone: 'idle', text: 'Not checked yet.' }
  const parts = [`${row.models} ${row.models === 1 ? 'model' : 'models'}`]
  if (row.free) parts.push(`${row.free} free`)
  if (row.freeLeft !== undefined) parts.push(`${row.freeLeft} free ${row.freeLeft === 1 ? 'request' : 'requests'} left today`)
  return { tone: 'ok', text: parts.join(' · ') }
}

/** What the model router knows about each connection: whether its key works, how many models, what is paused and until when. */
export function ModelStatusBlock() {
  const status = useModels((state) => state.status)
  const state = useModels((state_) => state_.statusState)
  const error = useModels((state_) => state_.statusError)

  useEffect(() => {
    void useModels.getState().loadStatus()
  }, [])

  const loading = state === 'loading'
  return (
    <section className="roles-section" data-section="status">
      <header className="roles-section-head">
        <h3>Connections</h3>
        <Button size="sm" busy={loading} icon={<RefreshCw size={13} />} onClick={() => void useModels.getState().recheck()}>
          Check again
        </Button>
      </header>
      <p className="roles-note">What the router sees with the settings you have saved. “Check again” lifts a pause after you changed a key or added credit.</p>
      {error && <div className="status-row is-bad">{error}</div>}
      {status?.providers.length === 0 && <div className="status-empty">No connection yet. Connect a model first.</div>}
      {status?.providers.map((row) => {
        const { tone, text } = summary(row)
        return (
          <div key={row.profileId} className={cx('status-row', `is-${tone}`)}>
            <span className="status-dot" aria-hidden="true" />
            <span className="status-name">{row.name}</span>
            <span className="status-text">{text}</span>
          </div>
        )
      })}
      {!status && loading && (
        <div className="status-empty">
          <Spinner size={14} /> Asking the router…
        </div>
      )}
      {status?.problems.map((problem) => (
        <div key={problem} className="status-row is-warn">
          <AlertTriangle size={13} />
          <span className="status-text">{problem}</span>
        </div>
      ))}
    </section>
  )
}

/** Settings → Roles: only free models or not, which model does which job, and how the connections are doing. */
export default function RolesSettings({ draft, onChange, onConnect }: { draft: Settings; onChange: (patch: Partial<Settings>) => void; onConnect: () => void }) {
  const openRouter = draft.profiles.filter((profile) => profile.kind === 'openrouter')
  const serving = freeProfile(draft)
  return (
    <div className="settings-roles">
      <section className="roles-section" data-section="free">
        <header className="roles-section-head">
          <h3>Free models</h3>
        </header>
        <div className="roles-row">
          <div className="roles-row-text">
            <label className="roles-row-title" htmlFor="free-only">
              Only use free models
            </label>
            <div className="roles-row-hint">When on, eNCode refuses any model that is billed, so a paid key is never charged by accident. A model running on this computer counts as free.</div>
          </div>
          <Toggle id="free-only" checked={draft.freeOnly} onChange={(freeOnly) => onChange({ freeOnly })} label="Only use free models" />
        </div>
        {openRouter.length > 1 && (
          <div className="roles-row">
            <div className="roles-row-text">
              <label className="roles-row-title" htmlFor="free-connection">
                Free models run on
              </label>
              <div className="roles-row-hint">The OpenRouter key that serves “Free models”. Its limits apply to all of them.</div>
            </div>
            <Select
              id="free-connection"
              value={serving?.id ?? openRouter[0].id}
              options={openRouter.map((profile) => ({ value: profile.id, label: profile.name }))}
              onChange={(freeProfileId) => onChange({ freeProfileId })}
            />
          </div>
        )}
        {!openRouter.length ? (
          <div className="roles-row">
            <div className="roles-row-text">
              <div className="roles-row-title">No free models yet</div>
              <div className="roles-row-hint">They run on a free OpenRouter key.</div>
            </div>
            <Button size="sm" onClick={onConnect}>
              Connect free models
            </Button>
          </div>
        ) : (
          <p className="roles-note">Free models can be slower and busier than paid ones, and their providers may keep and learn from what you send them.</p>
        )}
      </section>

      <section className="roles-section" data-section="roles">
        <header className="roles-section-head">
          <h3>Which model does what</h3>
        </header>
        <p className="roles-note">Each job takes a list. The first model that works answers; a role with no list uses the one named under its name.</p>
        {MODEL_ROLES.map((role) => (
          <RoleRow key={role} draft={draft} role={role} onChange={onChange} />
        ))}
      </section>

      <ModelStatusBlock />
    </div>
  )
}
