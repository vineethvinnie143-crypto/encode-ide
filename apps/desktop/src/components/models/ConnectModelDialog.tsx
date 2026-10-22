import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { addressProblem, isFreeRef, modelRef } from '@shared/models'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useModels } from '../../stores/models'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { Dialog } from '../../ui/Dialog'
import { AlertTriangle, Bolt, ChevronRight, Key, Play, Search } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { finishDemo, finishFree, finishOwn, freeConnection, ownConnection, type Connection } from './connect'
import { KeyField } from './KeyField'
import { flatten, pickerGroups } from './model-list'
import { ModelBadges } from './ModelItem'
import { PRESETS, keyWarning, presetOf } from './presets'

type Step = 'choose' | 'free' | 'own' | 'model'

const TITLES: Record<Step, string> = { choose: 'Connect a model', free: 'Use free models', own: 'Use your own key', model: 'Choose a model' }

/** Something that stopped the step, and the way past it if there is one. */
interface Problem {
  text: string
  /** A way to go on regardless, such as "Use it anyway". */
  way?: { label: string; run: () => void | Promise<void> }
}

function Choice({ choice, icon, title, children, onClick }: { choice: string; icon: ReactNode; title: string; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="connect-option" data-choice={choice} onClick={onClick}>
      <span className="connect-option-icon">{icon}</span>
      <span className="connect-option-text">
        <span className="connect-option-title">{title}</span>
        <span className="connect-option-body">{children}</span>
      </span>
      <ChevronRight size={16} className="connect-option-go" />
    </button>
  )
}

/**
 * "Connect a model": the first thing a new install shows, and what "Connect a model…" in the model menu opens.
 * Three ways in: the free models (a free OpenRouter key), a key of one's own (a provider's bill, a model on this
 * computer), or the offline demo. A connection is stored before it is tried, so a key that is refused can be
 * replaced; nothing is chosen as the main model until it works or the person says to go on.
 */
export default function ConnectModelDialog() {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const setProfileKey = useSettings((state) => state.setProfileKey)
  const connectOpen = useUi((state) => state.connectOpen)
  const catalogs = useModels((state) => state.catalogs)

  const firstStart = settings !== null && !settings.setupDone
  // The dialog keeps itself open until it closes itself: finishing a step changes the settings under it.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (firstStart || connectOpen) setShown(true)
  }, [firstStart, connectOpen])

  const [step, setStep] = useState<Step>('choose')
  const [presetId, setPresetId] = useState('openrouter')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [connection, setConnection] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState('')
  const [typed, setTyped] = useState('')
  /** Which attempt is the current one: closing or going back makes a slower one stale, and its answer is dropped. */
  const attempt = useRef(0)

  const reset = () => {
    attempt.current++
    setStep('choose')
    setPresetId('openrouter')
    setBaseUrl('')
    setKey('')
    setBusy(false)
    setProblem(null)
    setConnection(null)
    setQuery('')
    setPicked('')
    setTyped('')
  }

  const hide = () => {
    setShown(false)
    useUi.getState().setConnectOpen(false)
    reset()
  }

  const current = () => useSettings.getState().settings

  const preset = presetOf(presetId)
  const profile = settings?.profiles.find((candidate) => candidate.id === connection) ?? null
  const catalog = connection ? catalogs[connection] : undefined

  const items = useMemo(() => {
    if (!settings || !profile) return []
    return flatten(pickerGroups({ settings: { profiles: [profile], freeProfileId: null }, catalogs, query, selected: [], free: false }))
  }, [settings, profile, catalogs, query])

  const chosen = typed.trim() || picked
  const chosenItem = items.find((item) => item.ref === modelRef(connection ?? '', chosen))

  /** Stores the connection (and its key) so it can be tried; false when that did not work, and the reason has been shown. */
  const store = async (next: Connection, secret: string): Promise<boolean> => {
    await save({ profiles: next.profiles })
    if (!current()?.profiles.some((candidate) => candidate.id === next.profileId)) return false
    if (secret && !(await setProfileKey(next.profileId, secret))) return false
    return true
  }

  const stop = (id: number) => id !== attempt.current

  const connectFree = async () => {
    const id = ++attempt.current
    const base = current()
    if (!base) return
    setBusy(true)
    setProblem(null)
    const next = freeConnection(base, () => crypto.randomUUID())
    if (!(await store(next, key.trim()))) {
      if (!stop(id)) setBusy(false)
      return
    }
    const result = await api.models.test(next.profileId).catch((error: unknown) => ({ ok: false, message: errorText(error) }))
    if (stop(id)) return
    const finish = async () => {
      const fresh = current()
      if (!fresh) return
      await save(finishFree(fresh, next.profileId))
      useUi.getState().notify('success', 'Free models are ready. Ask for anything in the box below.')
      hide()
    }
    if (result.ok) await finish()
    else setProblem({ text: result.message, way: { label: 'Use it anyway', run: finish } })
    if (!stop(id)) setBusy(false)
  }

  const connectOwn = async () => {
    const id = ++attempt.current
    const base = current()
    if (!base) return
    setBusy(true)
    setProblem(null)
    const next = ownConnection(base, preset, baseUrl, () => crypto.randomUUID())
    if (!(await store(next, key.trim()))) {
      if (!stop(id)) setBusy(false)
      return
    }
    const result = await api.models.test(next.profileId).catch((error: unknown) => ({ ok: false, message: errorText(error) }))
    if (stop(id)) return
    const toModels = () => {
      setConnection(next.profileId)
      setQuery('')
      setTyped('')
      setPicked('')
      setStep('model')
    }
    const stored = current()?.profiles.find((candidate) => candidate.id === next.profileId)
    if (stored) await useModels.getState().load(stored, { force: true })
    if (stop(id)) return
    if (!result.ok) {
      // Not every server lists its models: the person can still name one.
      setProblem({ text: result.message, way: { label: 'Choose a model anyway', run: toModels } })
    } else {
      const listed = useModels.getState().catalogs[next.profileId]?.models ?? []
      if (preset.model && listed.some((model) => model.id === preset.model)) setPicked(preset.model)
      toModels()
    }
    setBusy(false)
  }

  const start = async () => {
    const id = ++attempt.current
    const fresh = current()
    if (!fresh || !connection || !chosen) return
    setBusy(true)
    setProblem(null)
    const ref = modelRef(connection, chosen)
    const listed = catalog?.models ?? []
    const free = isFreeRef(fresh, ref, (model) => listed.find((candidate) => candidate.id === model)?.free)
    // The choice is stored first, so the check asks the router with the settings it will really run under (a billed model is refused while only free ones are allowed).
    await save(finishOwn(fresh, connection, chosen, free))
    if (stop(id)) return
    const result = await api.models.test(connection).catch((error: unknown) => ({ ok: false, message: errorText(error) }))
    if (stop(id)) return
    if (result.ok) {
      useUi.getState().notify('success', `${profile?.name ?? 'The connection'} is ready with ${chosen}.`)
      hide()
      return
    }
    setProblem({ text: result.message, way: { label: 'Keep this model', run: hide } })
    setBusy(false)
  }

  const useDemo = async () => {
    const fresh = current()
    if (!fresh) return
    attempt.current++
    await save(finishDemo(fresh))
    useUi.getState().notify('info', 'Using the offline demo. Choose a model from the model button any time.')
    hide()
  }

  /** Moves to a step. A key typed for one provider is not carried into another's field. */
  const go = (next: Step) => {
    attempt.current++
    setBusy(false)
    setProblem(null)
    if (next === 'choose' || next === 'free' || next === 'own') setKey('')
    setStep(next)
  }

  const back = () => go(step === 'model' ? 'own' : 'choose')

  /** Escape or the close button: a step goes back, the first screen closes. A first start that is closed carries on with the demo. */
  const close = () => {
    if (step !== 'choose') {
      back()
      return
    }
    if (firstStart) void useDemo()
    else hide()
  }

  const needsKey = step === 'free' || (step === 'own' && !preset.local)
  const addressIssue = preset.id === 'custom' && baseUrl.trim() ? addressProblem(baseUrl) : null
  const customReady = preset.id !== 'custom' || (baseUrl.trim() !== '' && addressIssue === null)
  const warning = step === 'free' ? keyWarning(presetOf('openrouter'), key) : keyWarning(preset, key)
  const canConnect = !busy && (!needsKey || key.trim().length > 0) && (step !== 'own' || customReady)
  const billed = step === 'model' && chosen !== '' && !isFreeRef(settings ?? { profiles: [] }, modelRef(connection ?? '', chosen), (model) => catalog?.models.find((candidate) => candidate.id === model)?.free)

  let footer: ReactNode
  if (step === 'choose') {
    footer = firstStart ? (
      <Button className="connect-skip" onClick={() => void useDemo()}>
        Skip for now
      </Button>
    ) : (
      <Button onClick={hide}>Cancel</Button>
    )
  } else if (step === 'free') {
    footer = (
      <>
        <Button onClick={back} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" busy={busy} disabled={!canConnect} onClick={() => void connectFree()}>
          Connect
        </Button>
      </>
    )
  } else if (step === 'own') {
    footer = (
      <>
        <Button onClick={back} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" busy={busy} disabled={!canConnect} onClick={() => void connectOwn()}>
          Continue
        </Button>
      </>
    )
  } else {
    footer = (
      <>
        <Button onClick={back} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" busy={busy} disabled={busy || !chosen} onClick={() => void start()}>
          Use this model
        </Button>
      </>
    )
  }

  const description =
    step === 'choose'
      ? 'Pick how eNCode reaches a model. You can change it any time from the model button or in Settings.'
      : step === 'free'
        ? 'OpenRouter serves free models to anyone with an account. Create a key there (no payment needed) and paste it here.'
        : step === 'own'
          ? 'Your provider bills you directly. eNCode never adds a charge.'
          : `Models from ${profile?.name ?? 'the provider'}. The agent needs one that can call tools.`

  return (
    <Dialog open={shown && settings !== null} onClose={close} title={TITLES[step]} description={description} width={540} className="connect-dialog" backdropCloses={!firstStart} footer={footer}>
      {step === 'choose' && (
        <div className="connect-options">
          <Choice choice="free" icon={<Bolt size={18} />} title="Free models" onClick={() => go('free')}>
            Free models from OpenRouter, with a free key. eNCode picks one that works and moves on when one is busy.
          </Choice>
          <Choice choice="own" icon={<Key size={18} />} title="My own API key" onClick={() => go('own')}>
            OpenRouter, Anthropic, OpenAI, DeepSeek or any compatible provider, or a model running on this computer.
          </Choice>
          <Choice choice="demo" icon={<Play size={18} />} title="Offline demo" onClick={() => void useDemo()}>
            A scripted agent for trying the interface. Nothing leaves your computer and no key is needed.
          </Choice>
        </div>
      )}

      {step === 'free' && (
        <div className="connect-form">
          <KeyField
            value={key}
            onChange={setKey}
            onSubmit={() => canConnect && void connectFree()}
            placeholder="sk-or-v1-…"
            provider="OpenRouter"
            storage={settings?.keyStorage}
            warning={warning}
            autoFocus
            disabled={busy}
          />
          <p className="connect-link">
            No key yet?{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              Create one at openrouter.ai/keys
            </a>
            .
          </p>
          <p className="connect-note">
            Free models can be slower and busier than paid ones, and their providers may keep and learn from what you send them. For private code, use a key of your own.
          </p>
        </div>
      )}

      {step === 'own' && (
        <div className="connect-form">
          <div className="connect-field">
            <label className="key-field-label" htmlFor="connect-provider">
              Provider
            </label>
            <Select
              id="connect-provider"
              value={presetId}
              options={PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))}
              onChange={(next) => {
                setPresetId(next)
                setProblem(null)
              }}
              disabled={busy}
            />
          </div>
          {preset.id === 'custom' && (
            <div className="connect-field">
              <label className="key-field-label" htmlFor="connect-url">
                Base URL
              </label>
              <input id="connect-url" className="text-input" value={baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} disabled={busy} aria-invalid={addressIssue !== null} onChange={(event) => setBaseUrl(event.target.value)} />
              {addressIssue && <p className="connect-note is-warn">{addressIssue}</p>}
            </div>
          )}
          <KeyField
            key={preset.id}
            value={key}
            onChange={setKey}
            onSubmit={() => canConnect && void connectOwn()}
            placeholder={preset.keyHint}
            provider={preset.id === 'custom' ? 'that server' : preset.label}
            storage={settings?.keyStorage}
            warning={warning}
            optional={preset.local}
            autoFocus
            disabled={busy}
          />
          {preset.keyUrl && (
            <p className="connect-link">
              <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                Get a {preset.label} key
              </a>
            </p>
          )}
          {preset.local && <p className="connect-note">The server has to be running. A key is only needed if you set one.</p>}
        </div>
      )}

      {step === 'model' && (
        <div className="connect-form">
          <div className="connect-search">
            <Search size={14} />
            <input
              className="connect-search-input"
              type="search"
              placeholder="Search models"
              aria-label="Search models"
              value={query}
              data-autofocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="connect-models" role="listbox" aria-label="Models">
            {catalog?.state === 'loading' && !items.length && (
              <div className="connect-models-note">
                <Spinner size={14} /> Reading the model list…
              </div>
            )}
            {catalog?.state === 'error' && <div className="connect-models-note is-warn">{catalog.error}</div>}
            {items.map((item) => {
              const picked_ = item.ref === modelRef(connection ?? '', chosen)
              return (
                <button
                  key={item.ref}
                  type="button"
                  role="option"
                  aria-selected={picked_}
                  className={cx('connect-model', picked_ && 'is-picked', item.noTools && 'is-dim')}
                  onClick={() => {
                    setPicked(item.ref.slice((connection ?? '').length + 1))
                    setTyped('')
                  }}
                >
                  <span className="connect-model-text">
                    <span className="connect-model-title">{item.title}</span>
                    {item.detail && <span className="connect-model-id">{item.detail}</span>}
                  </span>
                  <ModelBadges item={item} />
                </button>
              )
            })}
            {catalog?.state === 'ready' && !items.length && <div className="connect-models-note">{query ? `No model matches “${query}”.` : 'This provider does not list its models. Type a model id below.'}</div>}
          </div>
          <div className="connect-field">
            <label className="key-field-label" htmlFor="connect-model-id">
              Or type a model id
            </label>
            <input
              id="connect-model-id"
              className="text-input"
              value={typed}
              placeholder={preset.model || 'model-id'}
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && chosen && !busy) {
                  event.preventDefault()
                  void start()
                }
              }}
            />
          </div>
          {chosenItem?.noTools && <p className="connect-note is-warn">The provider says this model cannot call tools, so it cannot drive the agent.</p>}
          {billed && <p className="connect-note">{profile?.name ?? 'The provider'} bills this model to your key. “Only use free models” is turned off so it can run; turn it back on in Settings if you want it enforced.</p>}
        </div>
      )}

      {problem && (
        <div className="connect-problem" role="alert">
          <AlertTriangle size={15} />
          <div>
            <div>{problem.text}</div>
            {problem.way && (
              <button type="button" className="connect-way" onClick={() => void problem.way?.run()}>
                {problem.way.label}
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}
