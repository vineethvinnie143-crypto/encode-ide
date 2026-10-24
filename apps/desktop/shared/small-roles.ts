/**
 * A cheaper model for the small jobs (ADR 0094). Explore searches and reads, Small tasks names sessions and drafts
 * commit messages, Compaction and Inline suggestions follow it: none of them needs the model that writes the code.
 * While they follow a billed Main, Settings > Roles suggests the smaller model of Main's own family on the same
 * connection, so no new key and no other provider is involved, and never a free model: free providers may keep what
 * they are sent, and code goes there only when the person chooses it.
 *
 * Pure, over the settings and the connection's model list, so both tsconfig projects and the tests can use it.
 */
import { MODEL_ROLES, isLocalUrl, mainRefs, modelRef, parseRef } from './models'
import type { ModelInfo, ModelRole, Settings } from './types'

/** The roles the suggestion is for, both of which follow Main when they have no list; Compaction and Inline suggestions follow Small tasks. */
export const SMALL_ROLES: readonly ModelRole[] = ['explore', 'utility']

export interface SmallRoleSuggestion {
  /** The model to use: "<profile id>:<model id>". */
  ref: string
  model: ModelInfo
  /** Main's model, as the connection lists it. */
  main: ModelInfo
  /** The roles that would use it: those of SMALL_ROLES that follow Main now. */
  roles: ModelRole[]
  /** How much less it costs per token read, 0 to 1, when both prices are known. */
  saving?: number
}

type Draft = Pick<Settings, 'profiles' | 'roles' | 'activeProfileId' | 'freeOnly'>

const bare = (id: string) => (id.split('/').pop() ?? id).split(':')[0].toLowerCase()

/** A version written in a model id ("4-5", "4.5", "2.5") as a number, for picking the newest. */
const version = (text: string | undefined) => (text ? Number.parseFloat(text.replace('-', '.')) || 0 : 0)

/**
 * The smaller siblings of a model, best first, as patterns over bare model names. Each family's small model is the one
 * its maker offers for fast, cheap work with tools.
 */
function siblingsOf(model: string): RegExp[] {
  const name = bare(model)
  if (/^claude-(?:opus|sonnet|fable)|^claude-\d.*-(?:opus|sonnet)/.test(name)) return [/^claude-haiku-(\d+(?:[.-]\d)?)/, /^claude-(\d+(?:[.-]\d)?)-haiku/]
  if (/^(?:gpt-5|gpt-4\.1|o3|o4)(?![\w.-]*(?:mini|nano))/.test(name)) return [/^gpt-5(?:\.(\d+))?-mini(?:$|-\d{4})/, /^gpt-4\.1-mini/]
  if (/^gemini-[\d.]+-pro/.test(name)) return [/^gemini-(\d+(?:\.\d+)?)-flash(?!-lite)(?:$|-preview|-\d{3})/]
  if (/^grok-4(?![\w.-]*(?:fast|mini))/.test(name)) return [/^grok-4(?:\.(\d+))?-fast/, /^grok-code-fast/]
  if (/^qwen3-coder(?!-flash|-30b)/.test(name) || /^qwen3-coder-plus/.test(name)) return [/^qwen3-coder-flash/, /^qwen3-coder-30b/]
  if (/^glm-4\.[56](?!-air)/.test(name)) return [/^glm-4\.(\d)-air/]
  if (/^(?:mistral-large|mistral-medium)/.test(name)) return [/^mistral-small/]
  return []
}

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
 * The suggestion for these settings, or null: when billed models may run, Main is billed and on a connection whose
 * list holds a smaller model of its family that calls tools, is not free, and costs less where prices are listed, and
 * at least one small role still follows Main.
 */
export function smallRoleSuggestion(draft: Draft, catalog: (profileId: string) => readonly ModelInfo[] | undefined): SmallRoleSuggestion | null {
  // Only free models run: a billed suggestion would be refused like Main itself.
  if (draft.freeOnly) return null
  const main = parseRef(mainRefs(draft)[0] ?? '', draft.profiles)
  if (!main || main.kind !== 'model') return null
  const profile = draft.profiles.find((candidate) => candidate.id === main.profileId)
  if (!profile || profile.kind === 'demo' || isLocalUrl(profile.baseUrl)) return null
  const roles = SMALL_ROLES.filter((role) => !draft.roles[role]?.length)
  if (!roles.length) return null
  const models = catalog(profile.id) ?? []
  const listed = models.find((model) => model.id === main.model)
  if (listed?.free) return null
  const usable = models.filter((model) => model.id !== main.model && !model.free && model.tools !== false)
  const model = newest(usable, siblingsOf(main.model))
  if (!model) return null
  const mainInfo = listed ?? { id: main.model, name: main.model }
  let saving: number | undefined
  if (mainInfo.price && model.price) {
    if (model.price.input >= mainInfo.price.input) return null
    saving = mainInfo.price.input > 0 ? 1 - model.price.input / mainInfo.price.input : undefined
  }
  return { ref: modelRef(profile.id, model.id), model, main: mainInfo, roles, ...(saving !== undefined ? { saving } : {}) }
}

/** The settings that give the suggested model to its roles, leaving every other role as it is. */
export function applySmallRoles(draft: Pick<Settings, 'roles'>, suggestion: Pick<SmallRoleSuggestion, 'ref' | 'roles'>): Pick<Settings, 'roles'> {
  const roles = { ...draft.roles }
  for (const role of suggestion.roles) if (MODEL_ROLES.includes(role)) roles[role] = [suggestion.ref]
  return { roles }
}
