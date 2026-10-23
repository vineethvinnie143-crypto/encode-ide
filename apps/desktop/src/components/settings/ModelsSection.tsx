import { useId, useMemo, useState } from 'react'
import { addressProblem } from '@shared/models'
import type { ModelInfo, ModelProfile, ProfileKind, Settings } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useModels } from '../../stores/models'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Details } from '../../ui/Details'
import { Check, ChevronDown, Plus, RefreshCw, Trash2 } from '../../ui/icons'
import { Select, type SelectOption } from '../../ui/Select'
import { KeyField } from '../models/KeyField'
import { PRESETS, isAnthropicUrl } from '../models/presets'
import { addProfile, chooseProfile, editProfile, kindPatch, removeProfile } from './profiles'
import { CommitInput, SettingsGroup } from './Section'

const KINDS: SelectOption<ProfileKind>[] = [
  { value: 'custom', label: 'Custom / OpenAI-compatible' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'demo', label: 'Offline demo' },
]

/** The address requests go to, as the router builds it from the base URL. */
function endpointOf(baseUrl: string): string {
  const anthropic = isAnthropicUrl(baseUrl)
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, anthropic ? '' : '/v1')}${anthropic ? '/v1/messages' : '/chat/completions'}`
}

/** Settings > Models: every connection, opened one at a time to change it. Each change is saved as it is made. */
export function ModelsSection({ settings }: { settings: Settings }) {
  const [openId, setOpenId] = useState<string | null>(() => settings.activeProfileId)
  const save = useSettings((state) => state.save)

  const add = async (presetId: string) => {
    const preset = PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) return
    const { patch, profile } = addProfile(settings, preset, crypto.randomUUID())
    if (await save(patch)) setOpenId(profile.id)
  }

  return (
    <>
      <SettingsGroup
        title="Connections"
        description="Each connection is a provider and the key for it. Model calls go straight from this app to the provider; no eNCode server is involved."
        className="models-connections"
      >
        {settings.profiles.map((profile) => (
          <Connection
            key={profile.id}
            settings={settings}
            profile={profile}
            open={openId === profile.id}
            onToggle={() => setOpenId((current) => (current === profile.id ? null : profile.id))}
            onRemoved={() => setOpenId(null)}
          />
        ))}
        <div className="conn-add" data-setting="models.add">
          <span className="conn-add-label">Add a provider</span>
          <div className="conn-add-presets">
            {PRESETS.map((preset) => (
              <button key={preset.id} type="button" className="preset-btn" onClick={() => void add(preset.id)}>
                <Plus size={12} aria-hidden="true" />
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </SettingsGroup>
      <div className="settings-aside">
        <span>A guided way to connect a model and pick the free ones:</span>
        <Button size="sm" onClick={() => useUi.getState().setConnectOpen(true)}>
          Connect a model…
        </Button>
      </div>
    </>
  )
}

function Connection({ settings, profile, open, onToggle, onRemoved }: { settings: Settings; profile: ModelProfile; open: boolean; onToggle: () => void; onRemoved: () => void }) {
  const active = profile.id === settings.activeProfileId
  const keyState = profile.kind === 'demo' ? 'Needs no key' : profile.hasApiKey ? 'Key stored' : 'No key'
  const panel = useId()
  return (
    <div className={cx('conn', open && 'is-open')} data-setting={open ? 'models.profiles' : undefined} data-connection={profile.id}>
      <button type="button" className="conn-head" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <span className="conn-text">
          <span className="conn-name">{profile.name}</span>
          <span className="conn-model">{profile.kind === 'demo' ? 'offline demo' : profile.model || 'no model chosen'}</span>
        </span>
        {active && <span className="active-badge">Answers now</span>}
        <span className={cx('conn-key', profile.kind !== 'demo' && !profile.hasApiKey && 'is-missing')}>{keyState}</span>
        <ChevronDown size={14} className={cx('conn-chevron', open && 'is-open')} aria-hidden="true" />
      </button>
      {open && (
        <div id={panel} className="conn-body">
          <ConnectionForm settings={settings} profile={profile} onRemoved={onRemoved} />
        </div>
      )}
    </div>
  )
}

function ConnectionForm({ settings, profile, onRemoved }: { settings: Settings; profile: ModelProfile; onRemoved: () => void }) {
  const save = useSettings((state) => state.save)
  const setProfileKey = useSettings((state) => state.setProfileKey)
  const notify = useUi((state) => state.notify)
  const ids = { name: useId(), kind: useId(), url: useId(), model: useId(), list: useId() }
  const [key, setKey] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [freeOnly, setFreeOnly] = useState(true)
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; detail?: string } | null>(null)
  const storage = settings.keyStorage
  const active = profile.id === settings.activeProfileId

  const shown = useMemo(() => (freeOnly && profile.kind === 'openrouter' ? models.filter((model) => model.free) : models), [models, freeOnly, profile.kind])

  const change = async (patch: Partial<Omit<ModelProfile, 'id' | 'hasApiKey'>>) => {
    const hadKey = profile.hasApiKey
    setResult(null)
    if (!(await save(editProfile(useSettings.getState().settings ?? settings, profile.id, patch)))) return
    const now = useSettings.getState().settings?.profiles.find((candidate) => candidate.id === profile.id)
    // A key stays with the server it was entered for: the main process drops it when the address points elsewhere.
    if (hadKey && now && !now.hasApiKey) notify('info', `Removed the API key for ${now.name} because its base URL now points to another server. Enter the key for that server.`)
  }

  const storeKey = async () => {
    if (!key.trim()) return
    if (await setProfileKey(profile.id, key.trim())) {
      setKey('')
      notify('success', `Stored the key for ${profile.name}.`)
    }
  }

  const removeKey = async () => {
    if (await setProfileKey(profile.id, '')) notify('success', `Removed the key for ${profile.name}.`)
  }

  const fetchModels = async () => {
    setLoading(true)
    setResult(null)
    try {
      const list = profile.kind === 'openrouter' ? await api.models.openRouter(false) : await api.models.provider(profile.id)
      setModels(list)
      setResult({ ok: true, message: `Found ${list.length} model${list.length === 1 ? '' : 's'}.` })
    } catch (error) {
      setResult({ ok: false, message: errorText(error) })
    } finally {
      setLoading(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.models.test(profile.id))
    } catch (error) {
      setResult({ ok: false, message: errorText(error) })
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    const current = useSettings.getState().settings ?? settings
    const patch = removeProfile(current, profile.id)
    if (!patch) return
    const ok = await useUi.getState().askConfirm({
      title: `Delete ${profile.name}?`,
      body: profile.hasApiKey ? 'Its key is removed from this computer, and the roles that used its models stop using them.' : 'The roles that used its models stop using them.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    useModels.getState().forget(profile.id)
    if (await save(patch)) onRemoved()
  }

  const problem = profile.kind === 'custom' && profile.baseUrl.trim() ? addressProblem(profile.baseUrl) : null

  return (
    <div className="conn-form">
      <div className="conn-fields">
        <div className="form-row">
          <label htmlFor={ids.name}>Name</label>
          <CommitInput id={ids.name} value={profile.name} onCommit={(name) => name.trim() && void change({ name: name.trim() })} />
        </div>
        <div className="form-row">
          <label htmlFor={ids.kind}>Provider type</label>
          <Select id={ids.kind} label="Provider type" value={profile.kind} options={KINDS} disabled={profile.kind === 'demo'} onChange={(kind) => void change(kindPatch(profile, kind))} />
        </div>
      </div>

      {profile.kind === 'demo' ? (
        <div className="info-note">
          The offline demo runs a scripted plan without network access. Its tools still work on your real folder, which makes it useful for trying the approval flow.
        </div>
      ) : (
        <>
          <div className="form-row">
            <label htmlFor={ids.url}>Base URL</label>
            <CommitInput id={ids.url} value={profile.baseUrl} placeholder="https://api.deepseek.com" disabled={profile.kind === 'openrouter'} spellCheck={false} onCommit={(baseUrl) => void change({ baseUrl: baseUrl.trim() })} />
            {problem && <div className="form-help is-warn">{problem}</div>}
            {profile.baseUrl.trim() && (
              <div className="form-help">
                Requests go to <code>{endpointOf(profile.baseUrl)}</code>
              </div>
            )}
          </div>

          <div className="form-row">
            <label htmlFor={ids.model}>Model</label>
            <div className="model-row">
              <CommitInput id={ids.model} list={ids.list} value={profile.model} placeholder="e.g. deepseek-chat" spellCheck={false} onCommit={(model) => void change({ model: model.trim() })} />
              <Button size="sm" variant="ghost" busy={loading} icon={<RefreshCw size={13} />} onClick={() => void fetchModels()}>
                Fetch
              </Button>
            </div>
            <datalist id={ids.list}>
              {shown.slice(0, 500).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.free ? `${model.name} (free)` : model.name}
                </option>
              ))}
            </datalist>
            {profile.kind === 'openrouter' && models.length > 0 && (
              <label className="checkbox-row sub">
                <input type="checkbox" checked={freeOnly} onChange={(event) => setFreeOnly(event.target.checked)} />
                Suggest free models only <span className="muted">({models.filter((model) => model.free).length} free)</span>
              </label>
            )}
          </div>

          <div className="form-row conn-key-row">
            <KeyField
              value={key}
              onChange={setKey}
              onSubmit={() => void storeKey()}
              placeholder={profile.hasApiKey ? (storage.mode === 'session' ? 'Held for this session. Type to replace.' : 'Stored. Type to replace.') : profile.kind === 'openrouter' ? 'sk-or-v1-…' : 'sk-…'}
              provider={profile.name}
              storage={storage}
            />
            <div className="conn-key-actions">
              <Button size="sm" variant="primary" disabled={!key.trim()} onClick={() => void storeKey()}>
                Save key
              </Button>
              {profile.hasApiKey && (
                <Button size="sm" variant="ghost" onClick={() => void removeKey()}>
                  Remove key
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {result && (
        <div className={cx('details-row', result.ok ? 'ok-text' : 'error-text')} role="status">
          <span>{result.message}</span>
          {result.detail && <Details text={result.detail} />}
        </div>
      )}

      <div className="form-actions">
        {profile.kind !== 'demo' && (
          <Button size="sm" variant="ghost" busy={testing} onClick={() => void test()}>
            Test connection
          </Button>
        )}
        {active ? null : (
          <Button size="sm" icon={<Check size={13} />} onClick={() => void save(chooseProfile(useSettings.getState().settings ?? settings, profile.id))}>
            Use this one
          </Button>
        )}
        <span className="grow" />
        {settings.profiles.length > 1 && (
          <Button size="sm" variant="ghost" className="is-danger" icon={<Trash2 size={13} />} onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
