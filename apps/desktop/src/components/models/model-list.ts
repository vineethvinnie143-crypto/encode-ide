/**
 * What the model picker lists, as plain functions: the choices grouped by the connection they belong to, narrowed by
 * what was typed. The picker draws it, and a test reads it.
 */
import { FREE_REF, freeProfile, modelRef } from '@shared/models'
import type { ModelInfo, ModelProfile, Settings } from '@shared/types'

export type CatalogState = 'idle' | 'loading' | 'ready' | 'error'

/** One connection's model list, as the interface last read it. */
export interface Catalog {
  state: CatalogState
  models: ModelInfo[]
  error?: string
  /** Which address and key the list was read with; a list read with other ones is out of date. */
  signature: string
  /** When it was read. */
  at?: number
}

export interface PickerItem {
  /** What the settings store: "@free", "<profile id>:<model id>", or "demo". */
  ref: string
  kind: 'free' | 'model' | 'demo'
  title: string
  /** Under the title: the model id, or what the entry is. */
  detail?: string
  free: boolean
  /** The provider says this model cannot call tools, and the agent needs them. */
  noTools: boolean
  /** "free", "$0.60 in · $2.00 out / 1M tok", "runs on this computer". */
  price?: string
  contextLength?: number
  selected: boolean
}

export interface PickerGroup {
  id: string
  title: string
  /** The connection the group lists, if it lists one. */
  profileId: string | null
  items: PickerItem[]
  /** Matches left out to keep the list short; typing narrows them. */
  hidden: number
  state: CatalogState | 'static'
  /** Why the group is empty or could not be read. */
  message?: string
}

export interface PickerInput {
  settings: Pick<Settings, 'profiles' | 'freeProfileId'>
  catalogs: Readonly<Record<string, Catalog | undefined>>
  query: string
  /** The references to mark as chosen. */
  selected: readonly string[]
  /** Offer "Free models" as one choice, when a connection can serve them. */
  free?: boolean
  /** Offer the offline demo. */
  demo?: boolean
  /** Most models shown for one connection; more than that is counted in `hidden`. */
  limit?: number
}

/** A connection a model can be asked of: a real provider with an address. */
export function isListed(profile: Pick<ModelProfile, 'kind' | 'baseUrl'>): boolean {
  return profile.kind !== 'demo' && profile.baseUrl.trim() !== ''
}

export function catalogSignature(profile: Pick<ModelProfile, 'kind' | 'baseUrl' | 'hasApiKey'>): string {
  return `${profile.kind}|${profile.baseUrl.trim()}|${profile.hasApiKey ? 'key' : 'nokey'}`
}

const DEFAULT_LIMIT = 40
const SEARCH_LIMIT = 100

function tokensOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function matcher(query: string): (item: PickerItem, group: string) => boolean {
  const tokens = tokensOf(query)
  if (!tokens.length) return () => true
  return (item, group) => {
    const haystack = `${item.title} ${item.detail ?? ''} ${group} ${item.free ? 'free' : ''}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  }
}

function itemOf(profile: ModelProfile, model: ModelInfo, selected: ReadonlySet<string>): PickerItem {
  const ref = modelRef(profile.id, model.id)
  return {
    ref,
    kind: 'model',
    title: model.name && model.name !== model.id ? model.name : model.id,
    ...(model.name && model.name !== model.id ? { detail: model.id } : {}),
    free: Boolean(model.free),
    noTools: model.tools === false,
    ...(model.pricing ? { price: model.pricing } : {}),
    ...(model.contextLength ? { contextLength: model.contextLength } : {}),
    selected: selected.has(ref),
  }
}

export function pickerGroups(input: PickerInput): PickerGroup[] {
  const selected = new Set(input.selected)
  const matches = matcher(input.query)
  const searching = tokensOf(input.query).length > 0
  const limit = input.limit ?? (searching ? SEARCH_LIMIT : DEFAULT_LIMIT)

  const inUse: PickerItem[] = []
  const groups: PickerGroup[] = []

  /** Chosen entries go to the top group; the rest stay under their connection. */
  const place = (item: PickerItem, group: string): PickerItem | null => {
    if (!matches(item, group)) return null
    if (item.selected) {
      inUse.push(item)
      return null
    }
    return item
  }

  if (input.free !== false && freeProfile(input.settings)) {
    const item: PickerItem = {
      ref: FREE_REF,
      kind: 'free',
      title: 'Free models',
      detail: 'eNCode picks one that works and switches when one is busy',
      free: true,
      noTools: false,
      price: 'free',
      selected: selected.has(FREE_REF),
    }
    const kept = place(item, 'Free models')
    if (kept) groups.push({ id: 'free', title: 'Free', profileId: null, items: [kept], hidden: 0, state: 'static' })
  }

  for (const profile of input.settings.profiles) {
    if (!isListed(profile)) continue
    const catalog = input.catalogs[profile.id]
    const listed = catalog?.state === 'ready' ? catalog.models : []
    const own = profile.model.trim()
    // The model typed into the connection is offered even when its provider does not list it.
    const models = own && !listed.some((model) => model.id === own) ? [...listed, { id: own, name: own } satisfies ModelInfo] : listed
    const found: PickerItem[] = []
    for (const model of models) {
      const kept = place(itemOf(profile, model, selected), profile.name)
      if (kept) found.push(kept)
    }
    const shown = found.slice(0, limit)
    const state: CatalogState = catalog?.state ?? 'idle'
    const message =
      state === 'error'
        ? catalog?.error
        : state === 'ready' && !models.length
          ? 'This provider lists no models. Choose one in Settings.'
          : undefined
    // A group with nothing to show is dropped while searching, but kept while it loads or fails so the person sees why.
    if (!shown.length && searching && state === 'ready') continue
    groups.push({ id: profile.id, title: profile.name, profileId: profile.id, items: shown, hidden: found.length - shown.length, state, ...(message ? { message } : {}) })
  }

  if (input.demo) {
    const item: PickerItem = { ref: 'demo', kind: 'demo', title: 'Offline demo', detail: 'A scripted agent for trying the interface, with no model', free: true, noTools: false, selected: selected.has('demo') }
    const kept = place(item, 'Offline demo')
    if (kept) groups.push({ id: 'demo', title: 'Offline', profileId: null, items: [kept], hidden: 0, state: 'static' })
  }

  return inUse.length ? [{ id: 'selected', title: 'In use', profileId: null, items: inUse, hidden: 0, state: 'static' }, ...groups] : groups
}

/** Every entry in the order the keyboard moves through them. */
export function flatten(groups: readonly PickerGroup[]): PickerItem[] {
  return groups.flatMap((group) => group.items)
}

/** 262144 reads as "262k", 1048576 as "1M". */
export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`
  return `${Math.round(tokens / 1000)}k`
}
