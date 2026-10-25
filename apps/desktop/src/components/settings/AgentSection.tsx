import { useEffect, useState } from 'react'
import { CONTEXT_CAPS } from '@shared/models'
import { isKeyedSearchProvider, searchProviderInfo, type KeyedSearchProviderId, type SearchCheckResult, type SearchProviderId } from '@shared/search'
import type { AskAgain, CheckGate, LearnConventions, LightSteps, ReviewWork, Settings } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { ALWAYS_ASKS_NOTE, POLICY_DESCRIPTIONS, POLICY_LABELS, POLICY_OPTIONS } from '../../policies'
import { useSettings } from '../../stores/settings'
import { useUi } from '../../stores/ui'
import { cx } from '../../ui/cx'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
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

const ASK_AGAIN: SegmentedOption<AskAgain>[] = [
  { value: 'on', label: 'Ask the model again' },
  { value: 'off', label: 'Run as allowed' },
]

const LEARN: SegmentedOption<LearnConventions>[] = [
  { value: 'on', label: 'Offer to keep' },
  { value: 'off', label: 'Never' },
]

const LIGHT: SegmentedOption<LightSteps>[] = [
  { value: 'on', label: 'Think less there' },
  { value: 'off', label: 'Same effort' },
]

/** Settings > Agent: what it may do without asking, web search, checks before it finishes and its limits. */
export function AgentSection({ settings }: { settings: Settings }) {
  const save = useSettings((state) => state.save)
  const setSearchKey = useSettings((state) => state.setSearchKey)
  const [searchKey, setSearchKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SearchCheckResult | null>(null)
  // A provider that needs a key and has none is chosen here first, and used once its key is stored: choosing it on
  // the way to pasting a key does not stop the agent's searches meanwhile.
  const [draft, setDraft] = useState<KeyedSearchProviderId | null>(null)
  const shown: SearchProviderId = draft ?? settings.searchProvider
  const keyFor = useUi((state) => state.searchKeyFor)

  const chooseProvider = (searchProvider: SearchProviderId) => {
    setSearchKeyInput('')
    setResult(null)
    if (isKeyedSearchProvider(searchProvider) && !settings.searchKeys.includes(searchProvider)) {
      setDraft(searchProvider)
      return
    }
    setDraft(null)
    if (searchProvider !== settings.searchProvider) void save({ searchProvider })
  }

  // The offer of a free key in the chat opens this screen with that provider chosen.
  useEffect(() => {
    if (!keyFor) return
    useUi.setState({ searchKeyFor: null })
    chooseProvider(keyFor)
  }, [keyFor])

  /** The key typed for the provider chosen, stored now, and that provider used from then on; false when it was refused. */
  const storeKey = async (): Promise<boolean> => {
    const provider = shown
    if (!searchKey.trim() || !isKeyedSearchProvider(provider)) return true
    if (!(await setSearchKey(provider, searchKey.trim()))) return false
    setSearchKeyInput('')
    if (draft === provider) {
      setDraft(null)
      await save({ searchProvider: provider })
    }
    return true
  }

  const removeKey = async () => {
    const provider = shown
    if (!(await setSearchKey(provider, ''))) return
    setSearchKeyInput('')
    setResult(null)
    useUi.getState().notify('success', `Removed the ${searchProviderInfo(provider).name} key.`)
  }

  /** The agent's own way of searching, with what was typed stored first. */
  const test = async () => {
    setResult(null)
    if (draft && !searchKey.trim()) {
      setResult({ ok: false, message: `There is no API key for ${searchProviderInfo(draft).name}. Paste one above, then press Test search.` })
      return
    }
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
        <SettingRow
          id="agent.askAgain"
          label="Before a command that is hard to undo"
          help="When a command that deletes recursively, discards uncommitted work, pushes, publishes, deploys or drops data would run without you seeing it (Full access, or a rule allows it), the agent's model is asked about it once more, with only your requests to go on. If it does not confirm, you decide. Each check is one short call to that model."
        >
          <Segmented label="Before a command that is hard to undo" value={settings.askAgain} options={ASK_AGAIN} onChange={(askAgain) => void save({ askAgain })} />
        </SettingRow>
      </SettingsGroup>

      <section className="settings-group settings-web-search" data-setting="agent.search">
        <SearchSettings
          provider={shown}
          inUse={settings.searchProvider}
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
          help="When a request changed code, eNCode runs the project's typecheck and tests (from package.json, Cargo.toml, go.mod or pytest's settings, or the checks list in .encode/settings.json) and sends the agent back for what its changes broke; failures that were there before are left alone. Each run needs what the agent's own command would. It also reads the lines the agent added for common security bugs (keys in code, SQL or commands built from values, FiveM events that trust what the client sends) and checks the reply: a claim that the tests pass with no passing run, a file that is not there, or a name a file does not hold sends the agent back once. When bigger work starts in a project with tests, the agent is told to write the tests first."
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
        <SettingRow
          id="agent.learnConventions"
          label="Keep what a request taught"
          help="After a request where you set a rule (“always use pnpm”) or a command failed and another worked, the model of the Small jobs role writes up to three lines for the project's instructions file: ENCODE.md, or the AGENTS.md or CLAUDE.md the project already has. They show below the answer, and nothing is written until you click Add. Each offer is one short call to that model, with your messages and the failed commands."
        >
          <Segmented label="Keep what a request taught" value={settings.learnConventions} options={LEARN} onChange={(learnConventions) => void save({ learnConventions })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Limits">
        <SettingRow id="agent.limits" htmlFor="max-steps" label="Max agent steps" help="How many steps one request may take before the agent stops and asks you to go on. 1 to 1000; 200 unless you set it.">
          <CommitInput
            id="max-steps"
            className="narrow"
            type="number"
            min={1}
            max={1000}
            value={String(settings.maxSteps)}
            onCommit={(text) => {
              const steps = Math.round(Number(text))
              if (text.trim() && Number.isFinite(steps)) void save({ maxSteps: Math.max(1, Math.min(1000, steps)) })
            }}
          />
        </SettingRow>
        <SettingRow
          id="agent.lightSteps"
          label="Think less on steps that read results"
          help="After steps that only read, searched or ran commands, and each worked, the next step thinks at low effort: it is mostly reading what they found. The first step of a request, the one after a failure or an edit, and the answer keep the effort set for the role; a step that would answer is asked again at that effort. Only for OpenAI, DeepSeek and Kimi models that reason, where a changed effort keeps the prompt cache. Off until the benchmark shows it keeps the pass rate."
        >
          <Segmented label="Think less on steps that read results" value={settings.lightSteps} options={LIGHT} onChange={(lightSteps) => void save({ lightSteps })} />
        </SettingRow>
        <SettingRow
          id="agent.contextCap"
          label="Summarize the conversation past"
          help="Before a conversation grows past this, eNCode shortens old tool results and then summarizes the oldest part, whatever the model's own window. Every step sends the whole conversation, so a larger size costs more each step, and most models read a long one less well. A model with a smaller window is summarized sooner."
        >
          <Segmented
            label="Summarize the conversation past"
            size="sm"
            value={String(settings.contextCap)}
            options={CONTEXT_CAPS.map((cap) => ({ value: String(cap), label: cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${cap / 1000}k` }))}
            onChange={(cap) => void save({ contextCap: Number(cap) })}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
