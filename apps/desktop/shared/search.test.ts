import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SEARCH_ENDPOINTS, SEARCH_PROVIDER_IDS as SERVED } from '@encode/tools'
import { KEYED_SEARCH_PROVIDER_IDS, SEARCH_PROVIDERS, SEARCH_PROVIDER_IDS, isKeyedSearchProvider, isSearchProviderId, searchProviderInfo } from './search'

describe('the search providers of the app', () => {
  it('are the ones the tools package serves, each at the host the Settings screen names', () => {
    assert.deepEqual([...SEARCH_PROVIDER_IDS].sort(), [...SERVED].sort())
    for (const provider of SEARCH_PROVIDERS) {
      assert.equal(new URL(SEARCH_ENDPOINTS[provider.id]).hostname, provider.host, provider.id)
      assert.equal(new URL(SEARCH_ENDPOINTS[provider.id]).protocol, 'https:', `${provider.id} is reached over https`)
    }
  })

  it('need a key exactly when the person must bring one, and link where to get it', () => {
    assert.deepEqual([...KEYED_SEARCH_PROVIDER_IDS].sort(), ['brave', 'exa', 'tavily'])
    for (const provider of SEARCH_PROVIDERS) {
      assert.equal(isKeyedSearchProvider(provider.id), provider.needsKey)
      if (provider.needsKey) assert.equal(new URL(provider.keyUrl ?? '').protocol, 'https:', `${provider.id} says where to get a key`)
      else assert.equal(provider.keyUrl, undefined)
    }
  })

  it('are told apart from anything else that is called a provider', () => {
    assert.equal(isSearchProviderId('brave'), true)
    for (const other of ['', 'Brave', 'bing', 'search:brave', undefined, null, 4, {}]) assert.equal(isSearchProviderId(other), false, String(other))
    assert.equal(isKeyedSearchProvider('duckduckgo'), false)
    assert.equal(searchProviderInfo('exa').name, 'Exa')
  })
})
