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
  /** USD per million tokens. */
  price: { input: number; output: number }
  /** Free to call, and on OpenRouter guaranteed so: a `:free` id with zero prices. */
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
    },
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
    typeof value.free === 'boolean'
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
    const entry = this.catalogs.get(provider)?.models.get(model)
    const config = this.providers[provider] ?? { type: 'openai-compatible', baseUrl: '', free: false }
    const fallback = defaultModel(config, model)
    const base: ModelInfo = {
      ...(entry ?? fallback),
      // A provider that charges nothing makes every model free, listed or not.
      free: (entry?.free ?? false) || Boolean(config.free),
      key,
      provider,
      scores: { ...this.scores.get(key) },
      known: Boolean(entry) || Boolean(this.overrides[key]),
    }
    return applyOverride(applyLearned(base, this.learned.get(key)), this.overrides[key])
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
