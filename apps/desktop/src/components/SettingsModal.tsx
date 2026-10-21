import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  X,
} from '../ui/icons'
import type { ModelInfo, ModelProfile, ProfileKind, Settings } from '@shared/types'
import { api } from '../api'
import { ALWAYS_ASKS_NOTE, POLICY_DESCRIPTIONS, POLICY_LABELS, POLICY_OPTIONS } from '../policies'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { SettingsTab } from '../stores/ui'

interface Preset {
  label: string
  name: string
  kind: ProfileKind
  baseUrl: string
  model: string
}

const PRESETS: Preset[] = [
  { label: 'DeepSeek', name: 'DeepSeek', kind: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: 'OpenRouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'Ollama', name: 'Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { label: 'LM Studio', name: 'LM Studio', kind: 'custom', baseUrl: 'http://localhost:1234/v1', model: '' },
  { label: 'OpenAI', name: 'OpenAI', kind: 'custom', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Custom', name: 'Custom', kind: 'custom', baseUrl: '', model: '' },
]

export default function SettingsModal() {
  const settings = useSettings((state) => state.settings)
  const keyStorage = settings?.keyStorage
  const save = useSettings((state) => state.save)
  const setProfileKey = useSettings((state) => state.setProfileKey)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const notify = useUi((state) => state.notify)

  const [tab, setTab] = useState<SettingsTab>(() => useUi.getState().settingsTab)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [freeOnly, setFreeOnly] = useState(true)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!settings || draft) return
    setDraft(structuredClone(settings))
    setSelectedId(settings.activeProfileId ?? settings.profiles[0]?.id ?? null)
  }, [settings, draft])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  const selected = useMemo(
    () => draft?.profiles.find((profile) => profile.id === selectedId) ?? draft?.profiles[0] ?? null,
    [draft, selectedId],
  )
  // Whether a key is stored comes from the main process: it can drop one when the base URL changes.
  const storedKey = settings?.profiles.find((profile) => profile.id === selected?.id)?.hasApiKey ?? false

  const visibleModels = useMemo(() => {
    if (!models.length) return []
    if (freeOnly && selected?.kind === 'openrouter') return models.filter((model) => model.free)
    return models
  }, [models, freeOnly, selected?.kind])

  if (!draft) {
    return <div className="modal-backdrop" />
  }

  const updateProfile = (id: string, patch: Partial<ModelProfile>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)),
          }
        : current,
    )
  }

  const addProfile = (preset: Preset) => {
    if (!draft) return
    let name = preset.name
    let counter = 2
    while (draft.profiles.some((profile) => profile.name === name)) {
      name = `${preset.name} ${counter++}`
    }
    const profile: ModelProfile = {
      id: crypto.randomUUID(),
      name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      model: preset.model,
      hasApiKey: false,
    }
    setDraft({
      ...draft,
      profiles: [...draft.profiles, profile],
      activeProfileId: draft.activeProfileId ?? profile.id,
    })
    setSelectedId(profile.id)
    setKeyInput('')
    setModels([])
    setModelError(null)
    setTestResult(null)
  }

  const deleteProfile = (id: string) => {
    if (!draft) return
    const profiles = draft.profiles.filter((profile) => profile.id !== id)
    if (!profiles.length) return
    const activeProfileId = draft.activeProfileId === id ? profiles[0].id : draft.activeProfileId
    setDraft({ ...draft, profiles, activeProfileId })
    if (selectedId === id) setSelectedId(profiles[0].id)
    setKeyInput('')
    setModels([])
    setTestResult(null)
  }

  const persist = async (): Promise<boolean> => {
    if (!draft) return false
    if (!draft.profiles.length) {
      notify('error', 'Keep at least one model profile.')
      return false
    }
    const hadKey = new Set(settings?.profiles.filter((profile) => profile.hasApiKey).map((profile) => profile.id))
    await save({ ...draft, profiles: draft.profiles })
    const newKeyFor = selected && keyInput.trim() ? selected.id : null
    const dropped = (useSettings.getState().settings?.profiles ?? []).filter(
      (profile) => hadKey.has(profile.id) && !profile.hasApiKey && profile.id !== newKeyFor,
    )
    if (dropped.length) {
      notify(
        'info',
        `Removed the API key for ${dropped.map((profile) => profile.name).join(', ')} because its base URL now points to another server. Enter the key for that server.`,
      )
    }
    if (selected && newKeyFor) {
      if (!(await setProfileKey(selected.id, keyInput.trim()))) return false
      setKeyInput('')
    }
    return true
  }

  const fetchModels = async () => {
    if (!selected) return
    setModelLoading(true)
    setModelError(null)
    setTestResult(null)
    try {
      const saved = await persist()
      if (!saved) return
      const list =
        selected.kind === 'openrouter'
          ? await api.models.openRouter(false)
          : await api.models.provider(selected.id)
      setModels(list)
      if (list.length) {
        notify('success', `Found ${list.length} model${list.length === 1 ? '' : 's'}`)
      }
    } catch (error) {
      setModelError((error as Error).message)
    } finally {
      setModelLoading(false)
    }
  }

  const testConnection = async () => {
    if (!selected) return
    setTestResult(null)
    try {
      const saved = await persist()
      if (!saved) return
      const result = await api.models.test(selected.id)
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, message: (error as Error).message })
    }
  }

  const onSave = async () => {
    const saved = await persist()
    if (!saved) return
    notify('success', 'Settings saved')
    setSettingsOpen(false)
  }

  const close = () => setSettingsOpen(false)

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div className="settings-title">Settings</div>
          <div className="settings-tabs">
            <button className={tab === 'models' ? 'is-on' : ''} onClick={() => setTab('models')}>
              Models
            </button>
            <button className={tab === 'agent' ? 'is-on' : ''} onClick={() => setTab('agent')}>
              Agent
            </button>
          </div>
          <button className="icon-btn" onClick={close} title="Close">
            <X size={16} />
          </button>
        </header>

        <div className="settings-body">
          {tab === 'models' ? (
            <div className="settings-models">
              <aside className="profile-list">
                <div className="profile-list-label">Profiles</div>
                {draft.profiles.map((profile) => (
                  <div
                    key={profile.id}
                    className={`profile-item ${profile.id === selected?.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSelectedId(profile.id)
                      setKeyInput('')
                      setModels([])
                      setModelError(null)
                      setTestResult(null)
                    }}
                  >
                    <span className="profile-item-main">
                      <span className="profile-item-name">{profile.name}</span>
                      <span className="profile-item-model">
                        {profile.kind === 'demo' ? 'offline demo' : profile.model || 'no model selected'}
                      </span>
                    </span>
                    {profile.id === draft.activeProfileId && (
                      <Star size={13} className="profile-active" fill="currentColor" />
                    )}
                    {draft.profiles.length > 1 && (
                      <button
                        className="icon-btn tiny"
                        title="Delete profile"
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteProfile(profile.id)
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}

                <div className="profile-add">
                  <div className="profile-add-label">Add provider</div>
                  <div className="profile-add-grid">
                    {PRESETS.map((preset) => (
                      <button key={preset.label} className="preset-btn" onClick={() => addProfile(preset)}>
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </aside>

              <section className="profile-form">
                {selected && (
                  <>
                    <div className="form-row">
                      <label>Name</label>
                      <input
                        className="text-input"
                        value={selected.name}
                        onChange={(event) => updateProfile(selected.id, { name: event.target.value })}
                      />
                    </div>

                    <div className="form-row">
                      <label>Provider type</label>
                      <select
                        className="text-input"
                        value={selected.kind}
                        disabled={selected.kind === 'demo'}
                        onChange={(event) => {
                          const kind = event.target.value as ProfileKind
                          updateProfile(selected.id, {
                            kind,
                            baseUrl:
                              kind === 'openrouter'
                                ? 'https://openrouter.ai/api/v1'
                                : kind === 'custom' && selected.baseUrl === 'https://openrouter.ai/api/v1'
                                  ? ''
                                  : selected.baseUrl,
                          })
                          setModels([])
                          setTestResult(null)
                        }}
                      >
                        <option value="custom">Custom / OpenAI-compatible</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="demo">Offline demo</option>
                      </select>
                    </div>

                    {selected.kind !== 'demo' && (
                      <>
                        <div className="form-row">
                          <label>Base URL</label>
                          <input
                            className="text-input"
                            value={selected.baseUrl}
                            disabled={selected.kind === 'openrouter'}
                            placeholder="https://api.deepseek.com"
                            onChange={(event) => updateProfile(selected.id, { baseUrl: event.target.value })}
                          />
                          <div className="form-help">Chat endpoint is <code>{selected.baseUrl.replace(/\/+$/, '')}/chat/completions</code></div>
                        </div>

                        <div className="form-row">
                          <label>Model</label>
                          <div className="model-row">
                            <input
                              className="text-input"
                              list={`model-options-${selected.id}`}
                              value={selected.model}
                              placeholder="e.g. deepseek-chat"
                              onChange={(event) => updateProfile(selected.id, { model: event.target.value })}
                            />
                            <button className="btn ghost sm" onClick={() => void fetchModels()} disabled={modelLoading}>
                              {modelLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                              Fetch
                            </button>
                          </div>
                          <datalist id={`model-options-${selected.id}`}>
                            {visibleModels.slice(0, 500).map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.free ? `${model.name} (free)` : model.name}
                              </option>
                            ))}
                          </datalist>
                          {selected.kind === 'openrouter' && (
                            <label className="checkbox-row sub">
                              <input
                                type="checkbox"
                                checked={freeOnly}
                                onChange={(event) => setFreeOnly(event.target.checked)}
                              />
                              Show free models only
                              {models.length > 0 && (
                                <span className="muted">
                                  ({models.filter((model) => model.free).length} free)
                                </span>
                              )}
                            </label>
                          )}
                        </div>

                        <div className="form-row">
                          <label>API key</label>
                          <div className="key-row">
                            <input
                              className="text-input"
                              type={showKey ? 'text' : 'password'}
                              value={keyInput}
                              placeholder={
                                storedKey
                                  ? keyStorage?.mode === 'session'
                                    ? 'Held for this session — type to replace'
                                    : 'Stored — type to replace'
                                  : selected.kind === 'openrouter'
                                    ? 'sk-or-v1-…'
                                    : 'sk-…'
                              }
                              onChange={(event) => setKeyInput(event.target.value)}
                            />
                            <button
                              className="icon-btn"
                              title={showKey ? 'Hide' : 'Show'}
                              onClick={() => setShowKey((value) => !value)}
                            >
                              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>
                          {keyStorage?.mode === 'session' ? (
                            <div className="form-help is-warn">
                              Kept in memory until eNCode closes and never written to disk. {keyStorage.reason}
                            </div>
                          ) : (
                            <div className="form-help">
                              Encrypted by your system keychain and sent only to this provider.
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {selected.kind === 'demo' && (
                      <div className="info-note">
                        The offline demo agent runs a scripted plan without network access. Its tools still operate on your
                        real workspace, which makes it useful for trying the approval flow.
                      </div>
                    )}

                    {modelError && <div className="error-text">{modelError}</div>}
                    {testResult && (
                      <div className={testResult.ok ? 'ok-text' : 'error-text'}>{testResult.message}</div>
                    )}

                    <div className="form-actions">
                      <button className="btn ghost sm" onClick={() => void testConnection()}>
                        Test connection
                      </button>
                      {selected.id === draft.activeProfileId ? (
                        <span className="active-badge">
                          <Star size={12} fill="currentColor" /> Active profile
                        </span>
                      ) : (
                        <button
                          className="btn sm"
                          onClick={() => setDraft({ ...draft, activeProfileId: selected.id })}
                        >
                          <Check size={13} /> Use this profile
                        </button>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
          ) : (
            <div className="settings-agent">
              <div className="section-title">Approvals</div>
              <div className="policy-list" role="radiogroup" aria-label="Approval policy">
                {POLICY_OPTIONS.map((option) => (
                  <label key={option} className={`policy-option${draft.policy === option ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="approval-policy"
                      value={option}
                      checked={draft.policy === option}
                      onChange={() => setDraft({ ...draft, policy: option })}
                    />
                    <span className="policy-option-text">
                      <span className="policy-option-label">{POLICY_LABELS[option]}</span>
                      <span className="policy-option-description">{POLICY_DESCRIPTIONS[option]}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="info-note">
                {ALWAYS_ASKS_NOTE} Ask and Plan modes never edit files or run commands. When eNCode asks, it shows you
                exactly what will change or run.
              </div>

              <div className="section-title">Limits</div>
              <div className="form-row inline">
                <label>Max agent steps</label>
                <input
                  className="text-input narrow"
                  type="number"
                  min={1}
                  max={100}
                  value={draft.maxSteps}
                  onChange={(event) =>
                    setDraft({ ...draft, maxSteps: Math.max(1, Math.min(100, Number(event.target.value) || 30)) })
                  }
                />
              </div>
            </div>
          )}
        </div>

        <footer className="settings-footer">
          <span className="settings-hint">
            Model calls go straight from this app to your provider. No eNCode server is involved.
          </span>
          <div className="settings-footer-actions">
            <button className="btn ghost" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void onSave()}>
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
