import { useState } from 'react'
import { isKeyedSearchProvider, searchProviderInfo, type SearchCheckResult, type SearchProviderId } from '@shared/search'
import type { CheckGate, ReviewWork, Settings } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { ALWAYS_ASKS_NOTE, POLICY_DESCRIPTIONS, POLICY_LABELS, POLICY_OPTIONS } from '../../policies'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { Toggle } from '../../ui/Toggle'
import { SearchSettings } from '../search/SearchSettings'
import { CommitInput, SettingRow, SettingsGroup } from './Section'

const CHECK_GATES: SegmentedOption<CheckGate>[] = [
  { value: 'auto', label: 'Up to twice' },
  { value: 'on', label: 'Up to 4 times' },
  { value: 'off', label: 'Never' },
]

const REVIEW_WORK: SegmentedOption<ReviewWork>[] = [
  { value: 'auto', label: 'Smaller models' },
  { value: 'on', label: 'Always' },
  { value: 'off', label: 'Never' },
]

/** Settings > Agent: what it may do without asking, the computer, web search, checks before it finishes and its limits. */
export function AgentSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const setSearchKey = useSettings((state) => state.setSearchKey)
  const [searchKey, setSearchKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SearchCheckResult | null>(null)

  const chooseProvider = (searchProvider: SearchProviderId) => {
    setSearchKeyInput('')
    setResult(null)
    void save({ searchProvider })
  }

  /** The key typed for the provider chosen, stored now; false when it was refused. */
  const storeKey = async (): Promise<boolean> => {
    const provider = settings.searchProvider
    if (!searchKey.trim() || !isKeyedSearchProvider(provider)) return true
    if (!(await setSearchKey(provider, searchKey.trim()))) return false
    setSearchKeyInput('')
    return true
  }

  const removeKey = async () => {
    const provider = settings.searchProvider
    if (!(await setSearchKey(provider, ''))) return
    setSearchKeyInput('')
    setResult(null)
    useUi.getState().notify('success', `Removed the ${searchProviderInfo(provider).name} key.`)
  }

  /** The agent's own way of searching, with what was typed stored first. */
  const test = async () => {
    setResult(null)
    setTesting(true)
    try {
      if (!(await storeKey())) return
      setResult(await api.search.test())
    } catch (error) {
      setResult({ ok: false, message: errorText(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <SettingsGroup title="Approvals" description={`${ALWAYS_ASKS_NOTE} Ask and Plan modes never edit files or run commands.`}>
        <div className="settings-row settings-row-block" data-setting="agent.policy">
          <div className="policy-list" role="radiogroup" aria-label="Approval policy">
            {POLICY_OPTIONS.map((option) => (
              <label key={option} className={cx('policy-option', settings.policy === option && 'is-selected')}>
                <input type="radio" name="approval-policy" value={option} checked={settings.policy === option} onChange={() => void save({ policy: option })} />
                <span className="policy-option-text">
                  <span className="policy-option-label">{POLICY_LABELS[option]}</span>
                  <span className="policy-option-description">{POLICY_DESCRIPTIONS[option]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </SettingsGroup>

      {settings.computerSupported && (
        <SettingsGroup title="Computer">
          <SettingRow
            id="agent.computer"
            htmlFor="computer-use"
            label="Let the agent use this computer"
            help="It can look at an application and use the mouse and keyboard in it, one application at a time, and only after you allow that application. A banner shows while it works. Stop it with the banner's Stop button, with Ctrl+Alt+Esc, or by using the mouse or keyboard yourself. eNCode's own windows and password fields are never shown to it."
          >
            <Toggle id="computer-use" checked={settings.computer} onChange={(computer) => void save({ computer })} />
          </SettingRow>
        </SettingsGroup>
      )}

      <section className="settings-group settings-web-search" data-setting="agent.search">
        <SearchSettings
          provider={settings.searchProvider}
          storedKeys={settings.searchKeys}
          keyStorage={settings.keyStorage}
          keyInput={searchKey}
          onProvider={chooseProvider}
          onKeyInput={setSearchKeyInput}
          onSaveKey={() => void storeKey()}
          onRemoveKey={() => void removeKey()}
          onTest={() => void test()}
          testing={testing}
          result={result}
        />
      </section>

      <SettingsGroup title="Checks">
        <SettingRow
          id="agent.checks"
          label="Check the agent's work before it finishes"
          help="When a request changed code, eNCode runs the project's typecheck and tests (from package.json, Cargo.toml, go.mod or pytest's settings, or the checks list in .encode/settings.json) and sends the agent back for what its changes broke; failures that were there before are left alone. Each run needs what the agent's own command would. It also reads the lines the agent added for common security bugs (keys in code, SQL or commands built from values, FiveM events that trust what the client sends) and checks the reply: a claim that the tests pass with no passing run, a file that is not there, or a name a file does not hold sends the agent back once."
        >
          <Segmented label="Check the agent's work before it finishes" value={settings.checkGate} options={CHECK_GATES} onChange={(checkGate) => void save({ checkGate })} />
        </SettingRow>
        <SettingRow
          id="agent.review"
          label="Have the Reviewer read the agent's work"
          help="The model of the Review role reads each finished change against your request, and each plan, before you do. What holds up the work, and cases no test covers when the project has tests, go back to the agent once. Smaller models: for models that need the full guide, or whenever the Review role has a model of its own. It sends the change to that model, and its answer adds to what the request costs."
        >
          <Segmented label="Have the Reviewer read the agent's work" value={settings.reviewWork} options={REVIEW_WORK} onChange={(reviewWork) => void save({ reviewWork })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Limits">
        <SettingRow id="agent.limits" htmlFor="max-steps" label="Max agent steps" help="How many steps one request may take before the agent stops and asks you to go on. 1 to 100.">
          <CommitInput
            id="max-steps"
            className="narrow"
            type="number"
            min={1}
            max={100}
            value={String(settings.maxSteps)}
            onCommit={(text) => {
              const steps = Math.round(Number(text))
              if (text.trim() && Number.isFinite(steps)) void save({ maxSteps: Math.max(1, Math.min(100, steps)) })
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
