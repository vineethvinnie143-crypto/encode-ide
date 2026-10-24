import { useEffect, useRef, useState } from 'react'
import { EFFORTS, EFFORT_INFO, FREE_REF, MAX_ROLE_MODELS, MODEL_ROLES, ROLE_INFO, freeProfile, isFreeRef, labelOfRef, mainPatch, mainRefs, parseRef, roleRefs, withEffort } from '@shared/models'
import { applySmallRoles, smallRoleSuggestion } from '@shared/small-roles'
import { applyStrongRoles, strongRoleSuggestion } from '@shared/strong-roles'
import type { ModelRole, ModelStatus, ReasoningEffort, Settings } from '@shared/types'
import { useModels } from '../../stores/models'
import { Button, IconButton } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, ArrowDown, ArrowUp, Plus, RefreshCw, X } from '../../ui/icons'
import type { Rect } from '../../ui/place'
import { Chip } from '../../ui/Pill'
import { Select, type SelectOption } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { Toggle } from '../../ui/Toggle'
import { ModelPicker } from './ModelPicker'

type Draft = Pick<Settings, 'profiles' | 'roles' | 'activeProfileId' | 'freeOnly' | 'freeProfileId' | 'efforts'>

type EffortChoice = ReasoningEffort | 'default'

const EFFORT_CHOICES: readonly SelectOption<EffortChoice>[] = [
  { value: 'default', label: 'Default effort' },
  ...EFFORTS.map((effort) => ({ value: effort, label: `${EFFORT_INFO[effort].label} effort` })),
]

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
        <div className="role-tools">
          <Select<EffortChoice>
            className="role-effort"
            label={`How hard ${info.label} thinks`}
            value={draft.efforts[role] ?? 'default'}
            options={EFFORT_CHOICES}
            onChange={(choice) => onChange({ efforts: withEffort(draft.efforts, role, choice === 'default' ? null : choice) })}
          />
          <AddModel draft={draft} role={role} onPick={(ref) => !refs.includes(ref) && set([...refs, ref])} />
        </div>
      </div>
      {refs.length === 0 ? (
        <div className="role-follows">
          {info.follows ? `Uses ${ROLE_INFO[info.follows].label.toLowerCase()}.` : 'No model chosen.'}
          {info.follows && roleRefs(draft, role).includes(FREE_REF) && ' That includes the free models, whose providers may keep what they are sent.'}
        </div>
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

/** Where the main model is not needed: a smaller model of its own family for Explore and Small tasks (ADR 0094). */
function SmallRolesHint({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const catalogs = useModels((state) => state.catalogs)
  const main = parseRef(mainRefs(draft)[0] ?? '', draft.profiles)
  const profile = main?.kind === 'model' ? draft.profiles.find((candidate) => candidate.id === main.profileId) : undefined
  useEffect(() => {
    if (profile) void useModels.getState().load(profile)
  }, [profile])
  const suggestion = smallRoleSuggestion(draft, (id) => catalogs[id]?.models)
  if (!suggestion) return null
  const roles = suggestion.roles.map((role) => ROLE_INFO[role].label).join(' and ')
  const saving = suggestion.saving !== undefined && suggestion.saving >= 0.1 ? ` for about ${Math.round(suggestion.saving * 100)}% less per token` : ''
  return (
    <div className="roles-row roles-suggest" data-setting="roles.small">
      <div className="roles-row-text">
        <div className="roles-row-title">
          {roles} could use {suggestion.model.name}
        </div>
        <div className="roles-row-hint">
          These jobs now go to {suggestion.main.name}. Searching, reading and naming need no more than its smaller sibling on the same connection, which does them as well{saving}.
          Compaction and Inline suggestions follow Small tasks.
        </div>
      </div>
      <Button size="sm" onClick={() => onChange(applySmallRoles(draft, suggestion))}>
        Use {suggestion.model.name}
      </Button>
    </div>
  )
}

/** Where Main is a smaller model: one strong model of the same connection for planning and review (ADR 0100). */
function StrongRolesHint({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const catalogs = useModels((state) => state.catalogs)
  const suggestion = strongRoleSuggestion(draft, (id) => catalogs[id]?.models)
  if (!suggestion) return null
  const roles = suggestion.roles.map((role) => ROLE_INFO[role].label).join(' and ')
  const price = suggestion.model.price ? ` It costs $${suggestion.model.price.input.toFixed(2)} per million tokens read, for these steps only.` : ''
  return (
    <div className="roles-row roles-suggest" data-setting="roles.strong">
      <div className="roles-row-text">
        <div className="roles-row-title">
          {roles} could use {suggestion.model.name}
        </div>
        <div className="roles-row-hint">
          {suggestion.main.name} keeps writing the code; the plan and the review of its work are where a strong model helps most, and when {suggestion.main.name} runs into trouble twice in a
          request, eNCode asks whether {suggestion.model.name} may finish it.{price}
        </div>
      </div>
      <Button size="sm" onClick={() => onChange(applyStrongRoles(draft, suggestion))}>
        Use {suggestion.model.name}
      </Button>
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

/** Settings > Roles: only free models or not, which model does which job, and how the connections are doing. Each change is kept at once. */
export default function RolesSettings({ draft, onChange, onConnect }: { draft: Settings; onChange: (patch: Partial<Settings>) => void; onConnect: () => void }) {
  const openRouter = draft.profiles.filter((profile) => profile.kind === 'openrouter')
  const serving = freeProfile(draft)
  return (
    <div className="settings-roles">
      <section className="roles-section" data-section="free" data-setting="roles.free">
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

      <section className="roles-section" data-section="roles" data-setting="roles.list">
        <header className="roles-section-head">
          <h3>Which model does what</h3>
        </header>
        <p className="roles-note">
          Each job takes a list. The first model that works answers; a role with no list uses the one named under its name. Effort is how hard a role’s models think, where a model has
          that dial; each role has its own, and Default leaves it to the model.
        </p>
        <SmallRolesHint draft={draft} onChange={onChange} />
        <StrongRolesHint draft={draft} onChange={onChange} />
        {MODEL_ROLES.map((role) => (
          <RoleRow key={role} draft={draft} role={role} onChange={onChange} />
        ))}
      </section>

      <section className="roles-section" data-section="guide" data-setting="roles.guide">
        <header className="roles-section-head">
          <h3>Instructions</h3>
        </header>
        <div className="roles-row">
          <div className="roles-row-text">
            <label className="roles-row-title" htmlFor="short-guide">
              Short instructions for strong models
            </label>
            <div className="roles-row-hint">
              Claude Opus and Sonnet 4 and later, GPT-5, o3, Gemini Pro 2.5 and later and Grok 4 work as well from a shorter guide, which saves about 2,500 tokens on every step. Other
              models always get the full guide; turn this off to give it to every model.
            </div>
          </div>
          <Toggle id="short-guide" checked={draft.guide !== 'full'} onChange={(short) => onChange({ guide: short ? 'auto' : 'full' })} label="Short instructions for strong models" />
        </div>
        <div className="roles-row" data-setting="roles.smaller">
          <div className="roles-row-text">
            <label className="roles-row-title" htmlFor="help-smaller">
              Help smaller models
            </label>
            <div className="roles-row-hint">
              Every other model gets a few lines after the instructions, and its first change in a request waits until it has said which files it will change and how it will check
              them. That is one more step at most, once a request.
            </div>
          </div>
          <Toggle id="help-smaller" checked={draft.helpSmaller !== 'off'} onChange={(on) => onChange({ helpSmaller: on ? 'auto' : 'off' })} label="Help smaller models" />
        </div>
        <div className="roles-row" data-setting="roles.stronger">
          <div className="roles-row-text">
            <label className="roles-row-title" htmlFor="offer-stronger">
              Offer a stronger model when one fails twice
            </label>
            <div className="roles-row-hint">
              When a smaller model runs into trouble twice in a request (the checks or the Reviewer send its work back, or a call fails the same way twice) and the Plan or Review role
              has a strong model, eNCode asks whether that model may do the rest of the request. It costs more, so it never happens without your yes.
            </div>
          </div>
          <Toggle id="offer-stronger" checked={draft.offerStronger !== 'off'} onChange={(on) => onChange({ offerStronger: on ? 'ask' : 'off' })} label="Offer a stronger model when one fails twice" />
        </div>
      </section>

      <ModelStatusBlock />
    </div>
  )
}
