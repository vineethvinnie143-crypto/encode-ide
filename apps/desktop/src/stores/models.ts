import type { ModelProfile, ModelStatus } from '@shared/types'
import { api } from '../api'
import { catalogSignature, isListed, type Catalog } from '../components/models/model-list'
import { errorText } from '../ipc-error'
import { create } from '../store'

/** A list read this recently is used as it is; the provider's list changes slowly. */
const FRESH_MS = 5 * 60 * 1000
/** A list that failed is not asked for again at once when the picker is opened and closed. */
const RETRY_MS = 10 * 1000

type StatusState = 'idle' | 'loading' | 'ready' | 'error'

interface ModelsStore {
  /** Each connection's models, by profile id. */
  catalogs: Record<string, Catalog>
  /** What the router knows about the connections: lists, blocks, free requests left. */
  status: ModelStatus | null
  statusState: StatusState
  statusError: string | null
  /** Reads a connection's models, unless they were read just now with the same address and key. */
  load(profile: ModelProfile, options?: { force?: boolean }): Promise<void>
  loadAll(profiles: readonly ModelProfile[], options?: { force?: boolean }): Promise<void>
  /** Forgets a connection's list, for one that was deleted. */
  forget(profileId: string): void
  loadStatus(): Promise<void>
  /** Lifts what a refused key or a payment problem set, asks again, and reads the status. */
  recheck(): Promise<void>
}

/** Which read is the current one for a connection; an older read that finishes late is dropped. */
const reads = new Map<string, number>()
let readCounter = 0
let statusCounter = 0

export const useModels = create<ModelsStore>((set, get) => ({
  catalogs: {},
  status: null,
  statusState: 'idle',
  statusError: null,

  load: async (profile, options = {}) => {
    if (!isListed(profile)) return
    const signature = catalogSignature(profile)
    const current = get().catalogs[profile.id]
    if (!options.force && current && current.signature === signature) {
      const age = Date.now() - (current.at ?? 0)
      if (current.state === 'loading') return
      if (current.state === 'ready' && age < FRESH_MS) return
      if (current.state === 'error' && age < RETRY_MS) return
    }
    const token = ++readCounter
    reads.set(profile.id, token)
    // The list that was shown stays while the new one is read, unless it came from another address or key.
    const keep = current && current.signature === signature ? current.models : []
    set((state) => ({ catalogs: { ...state.catalogs, [profile.id]: { state: 'loading', models: keep, signature, at: Date.now() } } }))
    try {
      const models = profile.kind === 'openrouter' ? await api.models.openRouter(false) : await api.models.provider(profile.id)
      if (reads.get(profile.id) !== token) return
      set((state) => ({ catalogs: { ...state.catalogs, [profile.id]: { state: 'ready', models, signature, at: Date.now() } } }))
    } catch (error) {
      if (reads.get(profile.id) !== token) return
      set((state) => ({ catalogs: { ...state.catalogs, [profile.id]: { state: 'error', models: keep, error: errorText(error), signature, at: Date.now() } } }))
    }
  },

  loadAll: async (profiles, options) => {
    await Promise.all(profiles.map((profile) => get().load(profile, options)))
  },

  forget: (profileId) => {
    reads.delete(profileId)
    set((state) => {
      const { [profileId]: _gone, ...rest } = state.catalogs
      return { catalogs: rest }
    })
  },

  loadStatus: async () => {
    const token = ++statusCounter
    set({ statusState: 'loading', statusError: null })
    try {
      const status = await api.models.status()
      if (token !== statusCounter) return
      set({ status, statusState: 'ready' })
    } catch (error) {
      if (token !== statusCounter) return
      set({ statusState: 'error', statusError: errorText(error) })
    }
  },

  recheck: async () => {
    const token = ++statusCounter
    set({ statusState: 'loading', statusError: null })
    try {
      await api.models.recheck()
      if (token !== statusCounter) return
      set({ status: await api.models.status(), statusState: 'ready' })
    } catch (error) {
      if (token !== statusCounter) return
      set({ statusState: 'error', statusError: errorText(error) })
    }
  },
}))
