/**
 * Settings > Models: the settings after a change to the connections, each one saved as it is made. Pure, for tests.
 */
import { cleanRoles, demoPatch, mainPatch, mainRefs, modelRef } from '@shared/models'
import type { ModelProfile, ProfileKind, Settings } from '@shared/types'
import { uniqueName } from '../models/connect'
import { OPENROUTER_URL, type Preset } from '../models/presets'

type Connections = Pick<Settings, 'profiles' | 'activeProfileId' | 'roles' | 'freeProfileId'>

/**
 * The patch that changes one connection. The model typed into the connection that answers goes on answering: a main
 * role that held only its old model follows the new one.
 */
export function editProfile(settings: Connections, id: string, patch: Partial<Omit<ModelProfile, 'id' | 'hasApiKey'>>): Partial<Settings> {
  const before = settings.profiles.find((profile) => profile.id === id)
  if (!before) return {}
  const profiles = settings.profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile))
  const model = patch.model?.trim()
  const main = mainRefs(settings)
  if (model && model !== before.model.trim() && id === settings.activeProfileId && main.length === 1 && main[0] === modelRef(id, before.model.trim())) {
    return { profiles, ...mainPatch({ ...settings, profiles }, [modelRef(id, model)]) }
  }
  return { profiles }
}

/** What a connection's address becomes when its kind changes: OpenRouter has one, and a custom one starts empty. */
export function kindPatch(profile: Pick<ModelProfile, 'baseUrl'>, kind: ProfileKind): Pick<ModelProfile, 'kind' | 'baseUrl'> {
  if (kind === 'openrouter') return { kind, baseUrl: OPENROUTER_URL }
  if (kind === 'custom' && profile.baseUrl === OPENROUTER_URL) return { kind, baseUrl: '' }
  return { kind, baseUrl: profile.baseUrl }
}

/** A new connection to a preset's provider, named so it differs from the others; the first real one becomes the active one. */
export function addProfile(settings: Connections, preset: Preset, id: string): { patch: Partial<Settings>; profile: ModelProfile } {
  const profile: ModelProfile = { id, name: uniqueName(settings.profiles, preset.name), kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model, hasApiKey: false }
  return { profile, patch: { profiles: [...settings.profiles, profile], activeProfileId: settings.activeProfileId ?? id } }
}

/** The patch that removes a connection (its key goes with it), or null for the last one, which has to stay. */
export function removeProfile(settings: Connections, id: string): Partial<Settings> | null {
  const profiles = settings.profiles.filter((profile) => profile.id !== id)
  if (!profiles.length || profiles.length === settings.profiles.length) return null
  return {
    profiles,
    activeProfileId: settings.activeProfileId === id ? profiles[0].id : settings.activeProfileId,
    roles: cleanRoles(settings.roles, profiles),
    freeProfileId: settings.freeProfileId === id ? null : settings.freeProfileId,
  }
}

/**
 * The patch that makes a connection the one that answers: its model as the main role's, the offline demo in place of
 * every main model, or (with no model chosen yet) only the active connection.
 */
export function chooseProfile(settings: Connections, id: string): Partial<Settings> {
  const profile = settings.profiles.find((candidate) => candidate.id === id)
  if (!profile) return {}
  if (profile.kind === 'demo') return demoPatch(settings)
  const model = profile.model.trim()
  return model ? mainPatch(settings, [modelRef(id, model)]) : { activeProfileId: id }
}
