import { SEARCH_PROVIDERS, searchProviderInfo, type SearchCheckResult, type SearchProviderId } from '@shared/search'
import type { KeyStorage } from '@shared/types'
import { Loader2 } from '../../ui/icons'
import { KeyField } from '../models/KeyField'

export interface SearchSettingsProps {
  /** The provider chosen in the draft. */
  provider: SearchProviderId
  /** The providers that have a key stored. */
  storedKeys: readonly SearchProviderId[]
  keyStorage?: KeyStorage
  /** What was typed into the key field for the chosen provider; nothing is stored until Save. */
  keyInput: string
  onProvider(provider: SearchProviderId): void
  onKeyInput(value: string): void
  /** Takes the stored key of the chosen provider away at once. */
  onRemoveKey(): void
  onTest(): void
  testing: boolean
  result: SearchCheckResult | null
}

/** Settings > Agent > Web search: who answers the agent's searches, their key if they need one, and a test. */
export function SearchSettings({ provider, storedKeys, keyStorage, keyInput, onProvider, onKeyInput, onRemoveKey, onTest, testing, result }: SearchSettingsProps) {
  const info = searchProviderInfo(provider)
  const stored = storedKeys.includes(provider)
  return (
    <>
      <div className="section-title">Web search</div>
      <div className="policy-list" role="radiogroup" aria-label="Search provider">
        {SEARCH_PROVIDERS.map((option) => {
          const has = storedKeys.includes(option.id)
          return (
            <label key={option.id} className={`policy-option${provider === option.id ? ' is-selected' : ''}`}>
              <input type="radio" name="search-provider" value={option.id} checked={provider === option.id} onChange={() => onProvider(option.id)} />
              <span className="policy-option-text">
                <span className="policy-option-label">
                  {option.name}
                  {option.needsKey && (
                    <>
                      {' '}
                      <span className={`search-option-state${has ? ' is-ready' : ''}`}>{has ? 'Key stored' : 'Needs a key'}</span>
                    </>
                  )}
                </span>
                <span className="policy-option-description">{option.summary}</span>
              </span>
            </label>
          )
        })}
      </div>

      {info.needsKey && (
        <div className="search-key">
          <KeyField
            // A key typed for one provider is not carried over to another.
            key={provider}
            value={keyInput}
            onChange={onKeyInput}
            label={`${info.name} API key`}
            placeholder={stored ? (keyStorage?.mode === 'session' ? 'Held for this session. Type to replace.' : 'Stored. Type to replace.') : 'Paste the key'}
            provider={info.name}
            storage={keyStorage}
          />
          <p className="search-link">
            {info.keyUrl && (
              <a href={info.keyUrl} target="_blank" rel="noreferrer">
                Get a {info.name} key
              </a>
            )}
          </p>
        </div>
      )}

      <div className="search-test">
        <button className="btn ghost sm" onClick={onTest} disabled={testing}>
          {testing && <Loader2 size={13} className="spin" />}
          Test search
        </button>
        {stored && (
          <button className="btn ghost sm" onClick={onRemoveKey} disabled={testing}>
            Remove the stored key
          </button>
        )}
      </div>
      {result && (
        <div className={result.ok ? 'ok-text' : 'error-text'} role="status">
          {result.message}
          {result.ok && result.ms !== undefined && <span className="search-test-time"> {(result.ms / 1000).toFixed(1)} s</span>}
        </div>
      )}

      <div className="info-note">
        The words the agent searches for go to {info.name} ({info.host}) and nowhere else. It asks before its first search in a session, and what comes back is
        treated as information, never as instructions.
      </div>
    </>
  )
}
