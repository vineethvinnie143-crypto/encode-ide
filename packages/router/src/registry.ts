import { familyOf, modelInfo, type ModelCapabilities, type ModelFamily } from '@encode/providers'
import { type EditFormat, isLoopbackUrl, type ModelOverride, type ProviderConfig } from './config'
import { modelKey } from './refs'

/**
 * What eNCode knows about each model: its window and output limit, what it
 * can do, what it costs, and how well it scored per role.
 *
 * Several sources merge, the later ones winning: defaults from the model
 * table in @encode/providers (the offline floor DirectClient also uses), the
 * provider's catalog (OpenRouter's
 * /api/v1/models), what failures taught at run time (a window named in an
 * overflow error, tools refused), and the user's overrides in settings.
 */

export interface ModelInfo {
  /** `<provider>:<model id>` */
  key: string
  provider: string
  model: string
  name: string
  /** Who trained it. Thinking blocks only replay to the same family. */
  family: ModelFamily
  contextWindow: number
  maxOutputTokens: number
  capabilities: ModelCapabilities
  /** Whether the model edits best by exact string replacement or by patches. */
  editFormat: EditFormat
  /** USD per million tokens, with the prompt cache's prices where the catalog lists them (ADR 0130). */
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** Free to call. On OpenRouter that is a `:free` id whose every price is zero (see freeVerdict); on a free provider, every model. */
  free: boolean
  /** When the provider published it, epoch ms. */
  created?: number
  /** When the provider retires it, epoch ms. */
  expiresAt?: number
  /** The roles a virtual model serves (eNCode's gateway lists them). */
  roles?: string[]
  /** eNCode's eval score per role, 0 to 1. */
  scores: Record<string, number>
  /** False when nothing but defaults describe the model. */
  known: boolean
}

/** A catalog entry before the registry merges it: everything but what the registry adds. */
export type CatalogEntry = Omit<ModelInfo, 'key' | 'provider' | 'scores' | 'known'>

/** What failures taught about a model. */
export interface LearnedFacts {
  contextWindow?: number
  tools?: false
  images?: false
  documents?: false
  /** The provider billed a request to this model although it was listed as free. */
  free?: false
  /**
   * The listed model that answered for this one, which no catalog lists: an OpenRouter preset (`@preset/<slug>`)
   * names its model only in its replies. The model is described as that one, the latest answer winning (ADR 0117).
   */
  servedBy?: string
}

/** An OpenRouter preset: its settings, the model among them, live on openrouter.ai, and no catalog lists it. */
export function isPreset(model: string): boolean {
  return model.startsWith('@preset/')
}

export interface RegistrySnapshot {
  version: 1
  catalogs: Record<string, { fetchedAt: number; models: CatalogEntry[] }>
  learned: Record<string, LearnedFacts>
}

/** The family a model belongs to, from its id; the provider type decides when the id says nothing. */
export function inferFamily(model: string, providerType = ''): ModelFamily {
  const family = familyOf(model)
  return family === 'other' && providerType === 'anthropic' ? 'anthropic' : family
}

/** Models that think before every answer, whatever the catalog says, so their first token comes late. */
const ALWAYS_REASONS = /(^|[/-])(r1|qwq|o[1-9](-mini|-pro)?|magistral[\w.-]*)([-:]|$)|thinking|reasoner/i

export function inferReasoning(model: string, supportsReasoning: boolean): boolean {
  return supportsReasoning || ALWAYS_REASONS.test(model)
}

/** OpenAI's newer coding models are trained on patches; everything else edits best with string replacement. */
export function inferEditFormat(family: ModelFamily, model: string): EditFormat {
  return family === 'openai' && /gpt-5|codex/i.test(model) ? 'patch' : 'replace'
}

/** A local server's window is whatever it was started with; assume a modest one until an overflow says otherwise. */
const LOCAL_CONTEXT_WINDOW = 32_000

/** A model no catalog describes: what the shared model table knows, else conservative limits and assumed tool support. */
export function defaultModel(provider: Pick<ProviderConfig, 'type' | 'baseUrl'>, model: string): CatalogEntry {
  const known = modelInfo(model)
  const family = known.family === 'other' && provider.type === 'anthropic' ? 'anthropic' : known.family
  return {
    model,
    name: model,
    family,
    contextWindow: !known.known && isLoopbackUrl(provider.baseUrl) ? LOCAL_CONTEXT_WINDOW : known.contextWindow,
    maxOutputTokens: Math.min(known.maxOutputTokens, known.contextWindow),
    capabilities: { ...known.capabilities, reasoning: inferReasoning(model, known.capabilities.reasoning) },
    editFormat: inferEditFormat(family, model),
    price: { input: 0, output: 0 },
    free: false,
  }
}

/**
 * A preset before any reply has said which model it uses: it is sent pictures, which the provider refuses when that
 * model cannot read them, so the next call sends notes in their place (ADR 0117). Without this a preset of a model
 * that sees could never be shown a picture until it had answered once.
 */
function presetDefaults(provider: Pick<ProviderConfig, 'type'>, model: string, entry: CatalogEntry): CatalogEntry {
  if (provider.type !== 'openrouter' || !isPreset(model)) return entry
  return { ...entry, capabilities: { ...entry.capabilities, images: true } }
}

/** The listed model's description under the preset's id. Its retirement date stays its own: the preset can be moved on. */
function describedBy(served: CatalogEntry, model: string): CatalogEntry {
  const { expiresAt: _retired, ...rest } = served
  return { ...rest, model }
}

function applyOverride(info: ModelInfo, override: ModelOverride | undefined): ModelInfo {
  if (!override) return info
  return {
    ...info,
    name: override.name ?? info.name,
    family: override.family ?? info.family,
    contextWindow: override.contextWindow ?? info.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? info.maxOutputTokens,
    capabilities: {
      tools: override.tools ?? info.capabilities.tools,
      parallelTools: override.parallelTools ?? info.capabilities.parallelTools,
      images: override.images ?? info.capabilities.images,
      reasoning: override.reasoning ?? info.capabilities.reasoning,
      promptCache: override.promptCache ?? info.capabilities.promptCache,
      documents: override.documents ?? info.capabilities.documents,
    },
    editFormat: override.editFormat ?? info.editFormat,
  }
}

function applyLearned(info: ModelInfo, learned: LearnedFacts | undefined): ModelInfo {
  if (!learned) return info
  return {
    ...info,
    contextWindow: learned.contextWindow ? Math.min(info.contextWindow, learned.contextWindow) : info.contextWindow,
    capabilities: {
      ...info.capabilities,
      tools: learned.tools === false ? false : info.capabilities.tools,
      parallelTools: learned.tools === false ? false : info.capabilities.parallelTools,
      images: learned.images === false ? false : info.capabilities.images,
      documents: learned.documents === false ? false : info.capabilities.documents,
    },
    free: learned.free === false ? false : info.free,
  }
}

function validEntry(entry: unknown): entry is CatalogEntry {
  const value = entry as CatalogEntry
  return (
    Boolean(value) &&
    typeof value.model === 'string' &&
    typeof value.name === 'string' &&
    Number.isFinite(value.contextWindow) &&
    Number.isFinite(value.maxOutputTokens) &&
    Boolean(value.capabilities) &&
    typeof value.capabilities.tools === 'boolean' &&
    Boolean(value.price) &&
    Number.isFinite(value.price.input) &&
    Number.isFinite(value.price.output) &&
    typeof value.free === 'boolean' &&
    // A snapshot comes from disk: it cannot vouch for a model that has a price.
    (!value.free || (value.price.input === 0 && value.price.output === 0))
  )
}

export class ModelRegistry {
  private catalogs = new Map<string, { fetchedAt: number; models: Map<string, CatalogEntry> }>()
  private learned = new Map<string, LearnedFacts>()
  private overrides: Record<string, ModelOverride> = {}
  private scores = new Map<string, Record<string, number>>()
  private providers: Record<string, Pick<ProviderConfig, 'type' | 'baseUrl' | 'free'>> = {}

  /** The configured providers: they decide the defaults of models no catalog lists. */
  setProviders(providers: Record<string, Pick<ProviderConfig, 'type' | 'baseUrl' | 'free'>>): void {
    this.providers = providers
  }

  /** Replaces everything a provider's catalog said, for example after a sync. */
  setCatalog(provider: string, models: readonly CatalogEntry[], fetchedAt: number): void {
    this.catalogs.set(provider, { fetchedAt, models: new Map(models.map((model) => [model.model, model])) })
  }

  /** When the provider's catalog was last fetched, epoch ms. */
  catalogFetchedAt(provider: string): number | undefined {
    return this.catalogs.get(provider)?.fetchedAt
  }

  setOverrides(overrides: Record<string, ModelOverride>): void {
    this.overrides = overrides
  }

  /** Eval scores by model key, then role, each 0 to 1. Replaces earlier scores. */
  setScores(scores: Record<string, Record<string, number>>): void {
    this.scores = new Map(
      Object.entries(scores).map(([key, byRole]) => [
        key,
        Object.fromEntries(
          Object.entries(byRole)
            .filter(([, score]) => typeof score === 'number' && Number.isFinite(score))
            .map(([role, score]) => [role, Math.min(1, Math.max(0, score))]),
        ),
      ]),
    )
  }

  /** Records what a failure revealed. A learned window only ever shrinks. */
  learn(key: string, facts: LearnedFacts): void {
    const current = { ...this.learned.get(key) }
    if (facts.contextWindow && Number.isFinite(facts.contextWindow) && facts.contextWindow > 0) {
      current.contextWindow = current.contextWindow ? Math.min(current.contextWindow, facts.contextWindow) : facts.contextWindow
    }
    if (facts.tools === false) current.tools = false
    if (facts.images === false) current.images = false
    if (facts.documents === false) current.documents = false
    if (facts.free === false) current.free = false
    if (typeof facts.servedBy === 'string' && facts.servedBy && facts.servedBy.length <= 200) {
      // Another model answers for the preset now: what failures taught was about the one before.
      if (current.servedBy && current.servedBy !== facts.servedBy) {
        delete current.contextWindow
        delete current.tools
        delete current.images
        delete current.documents
      }
      current.servedBy = facts.servedBy
    }
    this.learned.set(key, current)
  }

  /** Forgets what failures taught about a model, for instance after the user edits its settings. */
  unlearn(key: string): void {
    this.learned.delete(key)
  }

  /** True when the provider's catalog lists the model. */
  listed(provider: string, model: string): boolean {
    return Boolean(this.catalogs.get(provider)?.models.has(model))
  }

  /** Everything known about a model; models nobody listed get defaults. */
  get(provider: string, model: string): ModelInfo {
    const key = modelKey(provider, model)
    const catalog = this.catalogs.get(provider)?.models
    const entry = catalog?.get(model)
    const learned = this.learned.get(key)
    // A model no catalog lists that a listed one answered for (a preset) is described as that one, under its own id.
    const served = !entry && learned?.servedBy ? catalog?.get(learned.servedBy) : undefined
    const config = this.providers[provider] ?? { type: 'openai-compatible', baseUrl: '', free: false }
    const fallback = served ? describedBy(served, model) : presetDefaults(config, model, defaultModel(config, model))
    const base: ModelInfo = {
      ...(entry ?? fallback),
      // A provider that charges nothing makes every model free, listed or not. A preset is never free by what answered
      // for it: the preset may send the next request to another model.
      free: (entry?.free ?? false) || Boolean(config.free),
      key,
      provider,
      scores: { ...this.scores.get(key) },
      known: Boolean(entry) || Boolean(served) || Boolean(this.overrides[key]),
    }
    return applyOverride(applyLearned(base, learned), this.overrides[key])
  }

  /** Every model a provider's catalog lists, merged with what was learned and overridden. */
  list(provider: string): ModelInfo[] {
    const catalog = this.catalogs.get(provider)
    return catalog ? [...catalog.models.keys()].map((model) => this.get(provider, model)) : []
  }

  snapshot(): RegistrySnapshot {
    return {
      version: 1,
      catalogs: Object.fromEntries([...this.catalogs].map(([provider, catalog]) => [provider, { fetchedAt: catalog.fetchedAt, models: [...catalog.models.values()] }])),
      learned: Object.fromEntries(this.learned),
    }
  }

  /** Restores a snapshot; anything malformed in it is skipped, since it comes from disk. */
  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || (snapshot as RegistrySnapshot).version !== 1) return
    const { catalogs, learned } = snapshot as RegistrySnapshot
    if (catalogs && typeof catalogs === 'object') {
      for (const [provider, catalog] of Object.entries(catalogs)) {
        if (!catalog || !Array.isArray(catalog.models) || !Number.isFinite(catalog.fetchedAt)) continue
        this.setCatalog(provider, catalog.models.filter(validEntry), catalog.fetchedAt)
      }
    }
    if (learned && typeof learned === 'object') {
      for (const [key, facts] of Object.entries(learned)) if (facts && typeof facts === 'object') this.learn(key, facts)
    }
  }
}
