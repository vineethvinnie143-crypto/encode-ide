/**
 * What "Connect a model" stores, as plain functions over the settings so a test can read each choice's result.
 * A choice is stored in two steps: the connection first (so its key can be set and tried), then, once it works
 * or the person goes on anyway, which model answers.
 */
import { FREE_REF, demoPatch, freeProfile, isLocalUrl, mainPatch, modelRef } from '@shared/models'
import type { ModelProfile, Settings } from '@shared/types'
import { OPENROUTER_URL, sameAddress, type Preset } from './presets'

type Slice = Pick<Settings, 'profiles' | 'roles' | 'activeProfileId' | 'freeProfileId' | 'freeOnly' | 'setupDone'>

export interface Connection {
  /** Every profile, with the one to use among them. */
  profiles: ModelProfile[]
  profileId: string
}

/** "OpenAI", then "OpenAI 2": names are how people tell connections apart, so they stay unique. */
export function uniqueName(profiles: readonly Pick<ModelProfile, 'name'>[], name: string): string {
  const taken = new Set(profiles.map((profile) => profile.name.trim().toLowerCase()))
  if (!taken.has(name.trim().toLowerCase())) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}

/** The connection the free models run on: the one already serving them, else any OpenRouter one, else a new one. */
export function freeConnection(settings: Pick<Settings, 'profiles' | 'freeProfileId'>, newId: () => string): Connection {
  const existing = freeProfile(settings) ?? settings.profiles.find((profile) => profile.kind === 'openrouter')
  if (existing) return { profiles: settings.profiles.map((profile) => (profile.id === existing.id ? { ...profile, baseUrl: OPENROUTER_URL } : profile)), profileId: existing.id }
  const profile: ModelProfile = { id: newId(), name: 'OpenRouter', kind: 'openrouter', baseUrl: OPENROUTER_URL, model: '', hasApiKey: false }
  return { profiles: [...settings.profiles, profile], profileId: profile.id }
}

/**
 * A connection to a provider with a key of its own. A remote one at the same address that has no key yet is taken
 * over; one that has a key stays as it is, because a second key is usually another account (a paid one beside a
 * free one). A server on this computer is one thing however often it is chosen.
 */
export function ownConnection(settings: Pick<Settings, 'profiles'>, preset: Preset, baseUrl: string, newId: () => string): Connection {
  const address = preset.kind === 'openrouter' ? OPENROUTER_URL : baseUrl.trim()
  const same = settings.profiles.filter((profile) => profile.kind !== 'demo' && sameAddress(profile.baseUrl, address))
  const reuse = isLocalUrl(address) ? same[0] : same.find((profile) => !profile.hasApiKey)
  if (reuse) return { profiles: settings.profiles, profileId: reuse.id }
  const profile: ModelProfile = { id: newId(), name: uniqueName(settings.profiles, preset.name), kind: preset.kind, baseUrl: address, model: '', hasApiKey: false }
  return { profiles: [...settings.profiles, profile], profileId: profile.id }
}

/**
 * The free models are chosen. Only a first start turns "free models only" on by itself, so connecting again later
 * never changes what the person set.
 */
export function finishFree(settings: Slice, profileId: string): Partial<Settings> {
  const patch = mainPatch({ ...settings, freeProfileId: profileId }, [FREE_REF])
  return { ...patch, freeProfileId: profileId, ...(settings.setupDone ? {} : { freeOnly: true }), setupDone: true }
}

/**
 * A model of the person's own is chosen and becomes the main model. One that is billed turns "free models only"
 * off, because they asked for it; the caller says whether it is free (see isFreeRef).
 */
export function finishOwn(settings: Slice, profileId: string, model: string, free: boolean): Partial<Settings> {
  const profiles = settings.profiles.map((profile) => (profile.id === profileId ? { ...profile, model } : profile))
  const patch = mainPatch({ ...settings, profiles }, [modelRef(profileId, model)])
  return { profiles, ...patch, ...(free ? {} : { freeOnly: false }), setupDone: true }
}

/** The offline demo answers; nothing leaves the computer. */
export function finishDemo(settings: Slice): Partial<Settings> {
  return { ...demoPatch(settings), setupDone: true }
}
