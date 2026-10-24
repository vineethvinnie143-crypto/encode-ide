/**
 * Which model does what: the rules the settings, the main process and the interface share. A profile is a
 * connection to a provider with a key; a model is named by a reference, "<profile id>:<model id>", or "@free"
 * for the free models of the OpenRouter account that serves them. Roles (main, explore, ...) are ordered
 * lists of references; the model router in the agent host turns them into calls.
 *
 * Pure functions over Settings, with no runtime dependency, so both tsconfig projects can use them.
 */
import type { ModelProfile, ModelRole, ReasoningEffort, Settings } from './types'

export const MODEL_ROLES: readonly ModelRole[] = ['main', 'explore', 'planner', 'reviewer', 'summarizer', 'utility', 'inline']

/** What a role is for, and which role answers for it when it has no list of its own. */
export const ROLE_INFO: Readonly<Record<ModelRole, { label: string; hint: string; follows?: ModelRole }>> = {
  main: { label: 'Main', hint: 'Writes the code and talks to you.' },
  explore: { label: 'Explore', hint: 'Searches and reads for the main model.', follows: 'main' },
  planner: { label: 'Plan', hint: 'Drafts the plan in Plan mode.', follows: 'main' },
  reviewer: { label: 'Review', hint: 'Checks finished work, and judges low-risk commands under Auto review.', follows: 'main' },
  summarizer: { label: 'Compaction', hint: 'Summarizes old turns to make room.', follows: 'utility' },
  utility: { label: 'Small tasks', hint: 'Names sessions, summarizes pages and drafts commit messages.', follows: 'main' },
  inline: { label: 'Inline suggestions', hint: 'Suggests code as you type in the editor. A fast, cheap model suits it best.', follows: 'utility' },
}

/** The efforts a role can be set to, least first. */
export const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_INFO: Readonly<Record<ReasoningEffort, { label: string; hint: string }>> = {
  low: { label: 'Low', hint: 'Answers fastest and spends the fewest tokens.' },
  medium: { label: 'Medium', hint: 'A balance of speed and care.' },
  high: { label: 'High', hint: 'Thinks longer on hard problems.' },
  xhigh: { label: 'Extra high', hint: 'More than High where the model has it, else High.' },
  max: { label: 'Max', hint: 'As long as the model will think. Slowest, and the most tokens.' },
}

export const isEffort = (value: unknown): value is ReasoningEffort => typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)

/** Efforts as the settings keep them: known roles and levels only. A role left out is left to its model. */
export function cleanEfforts(input: unknown): Partial<Record<ModelRole, ReasoningEffort>> {
  const out: Partial<Record<ModelRole, ReasoningEffort>> = {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  for (const role of MODEL_ROLES) {
    const effort = (input as Record<string, unknown>)[role]
    if (isEffort(effort)) out[role] = effort
  }
  return out
}

/** `efforts` with the role set to `effort`; null leaves the role to its model. */
export function withEffort(efforts: Partial<Record<ModelRole, ReasoningEffort>>, role: ModelRole, effort: ReasoningEffort | null): Partial<Record<ModelRole, ReasoningEffort>> {
  const { [role]: _replaced, ...others } = efforts
  return effort ? { ...others, [role]: effort } : others
}

/** The free models of the connection that serves them; the router spells it the same way. */
/** The sizes Settings > Agent offers for Settings.contextCap; core compacts before a conversation passes it. */
export const CONTEXT_CAPS: readonly number[] = [64_000, 128_000, 200_000, 400_000, 1_000_000]
export const DEFAULT_CONTEXT_CAP = 200_000
export const isContextCap = (value: unknown): value is number => typeof value === 'number' && CONTEXT_CAPS.includes(value)

export const FREE_REF = '@free'

/** Most models one role can list. */
export const MAX_ROLE_MODELS = 8

export type ParsedRef = { kind: 'free' } | { kind: 'model'; profileId: string; model: string }

export function modelRef(profileId: string, model: string): string {
  return `${profileId}:${model}`
}

/**
 * Reads a reference. The profile is found among the known ones, because a model id has colons of its own
 * ("qwen/qwen3-coder:free") and a profile id may have one too.
 */
export function parseRef(ref: string, profiles: readonly { id: string }[]): ParsedRef | null {
  if (ref === FREE_REF) return { kind: 'free' }
  let best: { id: string } | undefined
  for (const profile of profiles) {
    if (ref.startsWith(`${profile.id}:`) && ref.length > profile.id.length + 1 && (!best || profile.id.length > best.id.length)) best = profile
  }
  return best ? { kind: 'model', profileId: best.id, model: ref.slice(best.id.length + 1) } : null
}

/** A server on this machine: it costs nothing and needs no key unless its owner set one. */
export function isLocalUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url.trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]' || host === '::1'
}

/**
 * Why a connection's address cannot be used, in words for the person, or null. The router refuses the same addresses
 * (`normalizeBaseUrl`): a key goes to https anywhere, and over plain http only to a server on this computer.
 */
export function addressProblem(address: string): string | null {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    return 'That is not a web address. Start it with https://.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The address has to start with https://.'
  if (url.protocol === 'http:' && !isLocalUrl(url.href)) return 'Use https:// unless the server runs on this computer, so the key is never sent in the clear.'
  if (url.username || url.password) return 'Leave the user name and password out of the address. The key goes in the key field.'
  if (url.search || url.hash) return 'Leave anything after a ? or # out of the address.'
  return null
}

export function activeProfile(settings: Pick<Settings, 'profiles' | 'activeProfileId'>): ModelProfile | null {
  return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? null
}

/** The connection whose key serves "@free": the one named, else the first OpenRouter profile that has a key. */
export function freeProfile(settings: Pick<Settings, 'profiles' | 'freeProfileId'>): ModelProfile | null {
  const openRouter = settings.profiles.filter((profile) => profile.kind === 'openrouter')
  return openRouter.find((profile) => profile.id === settings.freeProfileId) ?? openRouter.find((profile) => profile.hasApiKey) ?? null
}

/** The models the main role tries: the list the settings name, else the active profile's model. */
export function mainRefs(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId'>): string[] {
  const named = settings.roles.main
  if (named?.length) return named
  const profile = activeProfile(settings)
  return profile && profile.kind !== 'demo' && profile.model.trim() ? [modelRef(profile.id, profile.model.trim())] : []
}

/** The models a role tries: its own list, else the list of the role it follows, down to main's. */
export function roleRefs(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId'>, role: ModelRole): string[] {
  const seen = new Set<ModelRole>()
  let current: ModelRole | undefined = role
  while (current && current !== 'main' && !seen.has(current)) {
    seen.add(current)
    const named = settings.roles[current]
    if (named?.length) return named
    current = ROLE_INFO[current].follows
  }
  return mainRefs(settings)
}

/** What answers the model calls: the scripted demo, nothing yet, or real models through the router. */
export type ModelMode = 'demo' | 'none' | 'router'

export function modelMode(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId'>): ModelMode {
  if (mainRefs(settings).length) return 'router'
  return activeProfile(settings)?.kind === 'demo' ? 'demo' : 'none'
}

/**
 * Whether a model costs nothing, as far as the settings can tell: the free models, a server on this machine,
 * and an OpenRouter model whose id ends in ":free". The router decides for real, from the prices the provider
 * lists; this is what the interface needs to ask before it turns on a model that may be billed.
 */
export function isFreeRef(settings: Pick<Settings, 'profiles'>, ref: string, listedFree: (model: string) => boolean | undefined = () => undefined): boolean {
  const parsed = parseRef(ref, settings.profiles)
  if (!parsed) return false
  if (parsed.kind === 'free') return true
  const profile = settings.profiles.find((candidate) => candidate.id === parsed.profileId)
  if (!profile) return false
  if (profile.kind === 'openrouter') return parsed.model.endsWith(':free') && listedFree(parsed.model) !== false
  return profile.kind !== 'demo' && isLocalUrl(profile.baseUrl)
}

/** A reference in words: "Free models", or the model with the connection it belongs to. */
export function labelOfRef(settings: Pick<Settings, 'profiles'>, ref: string): string {
  const parsed = parseRef(ref, settings.profiles)
  if (!parsed) return ref
  if (parsed.kind === 'free') return 'Free models'
  const profile = settings.profiles.find((candidate) => candidate.id === parsed.profileId)
  return profile ? `${profile.name}: ${parsed.model}` : parsed.model
}

/** The short form for the composer: the model alone, "+2" when others stand by, and the connection when it is not obvious. */
export function mainLabel(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId'>): string {
  switch (modelMode(settings)) {
    case 'demo':
      return 'Demo (offline)'
    case 'none':
      return 'No model'
    case 'router': {
      const refs = mainRefs(settings)
      const parsed = parseRef(refs[0], settings.profiles)
      const first = !parsed ? refs[0] : parsed.kind === 'free' ? 'Free models' : parsed.model
      return refs.length > 1 ? `${first} +${refs.length - 1}` : first
    }
  }
}

/** Role lists as the settings keep them: known roles only, references that name a profile or "@free", no repeats, no empty lists. */
export function cleanRoles(input: unknown, profiles: readonly { id: string }[]): Partial<Record<ModelRole, string[]>> {
  const out: Partial<Record<ModelRole, string[]>> = {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  for (const role of MODEL_ROLES) {
    const list = (input as Record<string, unknown>)[role]
    if (!Array.isArray(list)) continue
    const refs: string[] = []
    for (const item of list) {
      if (typeof item !== 'string' || !parseRef(item.trim(), profiles) || refs.includes(item.trim())) continue
      refs.push(item.trim())
      if (refs.length === MAX_ROLE_MODELS) break
    }
    if (refs.length) out[role] = refs
  }
  return out
}

/** The settings that make `refs` the main role's list; the first one's connection becomes the active profile. */
export function mainPatch(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId' | 'freeProfileId'>, refs: readonly string[]): Pick<Settings, 'roles' | 'activeProfileId'> {
  const { main: _replaced, ...others } = settings.roles
  if (!refs.length) return { roles: others, activeProfileId: settings.activeProfileId }
  const first = parseRef(refs[0], settings.profiles)
  const profileId = first?.kind === 'free' ? freeProfile(settings)?.id : first?.profileId
  return { roles: { ...others, main: [...refs] }, activeProfileId: profileId ?? settings.activeProfileId }
}

/** The settings that hand the main role back to the offline demo. */
export function demoPatch(settings: Pick<Settings, 'roles' | 'profiles' | 'activeProfileId'>): Pick<Settings, 'roles' | 'activeProfileId'> {
  const { main: _dropped, ...others } = settings.roles
  const demo = settings.profiles.find((profile) => profile.kind === 'demo')
  return { roles: others, activeProfileId: demo?.id ?? settings.activeProfileId }
}
