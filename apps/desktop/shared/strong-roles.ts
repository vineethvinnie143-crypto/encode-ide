/**
 * A strong model for the hard steps (ADR 0100). A smaller model writes most code well enough and costs a fraction; the
 * steps it gets wrong are the plan and the review of its own work. While Main is a smaller model and Plan and Review
 * follow it, Settings > Roles suggests one strong model of the same connection for those two roles alone, so no new key
 * and no other provider is involved, and never a free model. With it set, the Reviewer reads the smaller model's work
 * and, when that model runs into trouble twice in a request, the agent asks whether the strong one may finish it.
 *
 * Pure, over the settings and the connection's model list, so both tsconfig projects and the tests can use it.
 */
import { isStrongModel } from '@encode/providers/strong'
import { MODEL_ROLES, isLocalUrl, mainRefs, modelRef, parseRef } from './models'
import type { ModelInfo, ModelRole, Settings } from './types'

/** The roles the suggestion is for, both of which follow Main when they have no list. */
export const STRONG_ROLES: readonly ModelRole[] = ['planner', 'reviewer']

export interface StrongRoleSuggestion {
  /** The model to use: "<profile id>:<model id>". */
  ref: string
  model: ModelInfo
  /** Main's model, as the connection lists it. */
  main: ModelInfo
  /** The roles that would use it: those of STRONG_ROLES that follow Main now. */
  roles: ModelRole[]
}

type Draft = Pick<Settings, 'profiles' | 'roles' | 'activeProfileId' | 'freeOnly'>

const bare = (id: string) => (id.split('/').pop() ?? id).split(':')[0].toLowerCase()

/** A version written in a model id ("4-5", "4.5", "2.5") as a number, for picking the newest. */
const version = (text: string | undefined) => (text ? Number.parseFloat(text.replace('-', '.')) || 0 : 0)

/**
 * The strong models to suggest, best first, as patterns over bare names: the ones their makers offer for everyday hard
 * work. The largest sizes (Opus, GPT-5 Pro) cost several times as much for a plan or a review, so they come last or not
 * at all.
 */
const PREFERRED: readonly RegExp[] = [
  /^claude-sonnet-(\d+(?:[.-]\d)?)(?:$|-\d{8})/,
  /^claude-(\d+(?:[.-]\d)?)-sonnet/,
  /^gpt-5(?:\.(\d+))?(?:-codex)?(?:$|-\d{4}-\d{2}-\d{2})/,
  /^gemini-(\d+(?:\.\d+)?)-pro(?:$|-preview|-\d{2})/,
  /^grok-4(?:\.(\d+))?(?:$|-\d{4})/,
  /^claude-opus-(\d+(?:[.-]\d)?)/,
]

/** The newest model of `models` that a pattern matches, trying the patterns in order. */
function newest(models: readonly ModelInfo[], patterns: readonly RegExp[]): ModelInfo | undefined {
  for (const pattern of patterns) {
    let best: { model: ModelInfo; version: number } | undefined
    for (const model of models) {
      const match = pattern.exec(bare(model.id))
      if (!match) continue
      const found = version(match[1])
      if (!best || found > best.version) best = { model, version: found }
    }
    if (best) return best.model
  }
  return undefined
}

/**
 * The suggestion for these settings, or null: when billed models may run, Main is a smaller model on a connection whose
 * list holds a strong one that calls tools and is not free, and at least one of Plan and Review still follows Main.
 */
export function strongRoleSuggestion(draft: Draft, catalog: (profileId: string) => readonly ModelInfo[] | undefined): StrongRoleSuggestion | null {
  // Only free models run: a billed suggestion would be refused.
  if (draft.freeOnly) return null
  const main = parseRef(mainRefs(draft)[0] ?? '', draft.profiles)
  if (!main || main.kind !== 'model' || isStrongModel(main.model)) return null
  const profile = draft.profiles.find((candidate) => candidate.id === main.profileId)
  if (!profile || profile.kind === 'demo' || isLocalUrl(profile.baseUrl)) return null
  const roles = STRONG_ROLES.filter((role) => !draft.roles[role]?.length)
  if (!roles.length) return null
  const models = catalog(profile.id) ?? []
  const usable = models.filter((model) => model.id !== main.model && !model.free && model.tools !== false && isStrongModel(model.id))
  const model = newest(usable, PREFERRED)
  if (!model) return null
  const mainInfo = models.find((candidate) => candidate.id === main.model) ?? { id: main.model, name: main.model }
  return { ref: modelRef(profile.id, model.id), model, main: mainInfo, roles }
}

/** The settings that give the suggested model to its roles, leaving every other role as it is. */
export function applyStrongRoles(draft: Pick<Settings, 'roles'>, suggestion: Pick<StrongRoleSuggestion, 'ref' | 'roles'>): Pick<Settings, 'roles'> {
  const roles = { ...draft.roles }
  for (const role of suggestion.roles) if (MODEL_ROLES.includes(role)) roles[role] = [suggestion.ref]
  return { roles }
}
