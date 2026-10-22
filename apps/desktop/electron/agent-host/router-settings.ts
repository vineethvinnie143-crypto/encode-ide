/**
 * The model router's settings, made from the app's. The app keeps profiles (a connection and its key) and roles
 * (lists of "<profile id>:<model id>"); the router wants providers and roles over them. Pure, so a test can read
 * what the router will be told for any settings, and no key passes through it: keys are asked for when a request
 * is made.
 */
import { providerTypeFor } from '@encode/providers'
import { FREE_REF, MODEL_ROLES, freeProfile, isLocalUrl, mainRefs, parseRef } from '../../shared/models'
import type { ModelProfile, Settings } from '../../shared/types'

/** What parseRouterConfig reads; it treats all of it as untrusted and reports what it cannot use. */
export interface RouterSettings {
  providers: Record<string, { type: string; baseUrl: string; needsKey: boolean; free: boolean }>
  roles: Record<string, string[]>
  freeOnly: boolean
  freePool: { providers: string[] }
  /** Failover limits (see the router's RouterLimits); the app leaves them at their defaults, a test shortens them. */
  limits?: Record<string, number>
}

/** The router names a provider with letters, digits, "-" and "_" (64 at most); a profile id may hold anything. */
function sanitize(profileId: string): string {
  return `p-${profileId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)
}

/** Each profile's name for the router, one to one. */
export function providerIds(profiles: readonly Pick<ModelProfile, 'id'>[]): Map<string, string> {
  const ids = new Map<string, string>()
  const taken = new Set<string>()
  for (const profile of profiles) {
    let id = sanitize(profile.id)
    for (let n = 2; taken.has(id); n++) id = `${sanitize(profile.id).slice(0, 60)}-${n}`
    taken.add(id)
    ids.set(profile.id, id)
  }
  return ids
}

/** A profile the router can call: a real provider with an address. The demo is the host's own. */
export function isCallable(profile: ModelProfile): boolean {
  return profile.kind !== 'demo' && profile.baseUrl.trim() !== ''
}

export function routerSettingsOf(settings: Settings): RouterSettings {
  const ids = providerIds(settings.profiles)
  const providers: RouterSettings['providers'] = {}
  for (const profile of settings.profiles) {
    if (!isCallable(profile)) continue
    const local = isLocalUrl(profile.baseUrl)
    providers[ids.get(profile.id)!] = {
      type: providerTypeFor(profile.baseUrl.trim(), profile.kind === 'openrouter' ? 'openrouter' : undefined),
      baseUrl: profile.baseUrl.trim(),
      // A server on this machine usually wants no key; one that has been given a key gets it.
      needsKey: !local || Boolean(profile.hasApiKey),
      // Everything on this machine is free to call.
      free: local,
    }
  }

  const free = freeProfile(settings)
  const freeId = free && providers[ids.get(free.id)!] ? ids.get(free.id)! : undefined

  const roles: Record<string, string[]> = {}
  const named: Record<string, readonly string[]> = { ...settings.roles, main: mainRefs(settings) }
  for (const role of MODEL_ROLES) {
    const refs: string[] = []
    for (const ref of named[role] ?? []) {
      const parsed = parseRef(ref, settings.profiles)
      if (!parsed) continue
      if (parsed.kind === 'free') {
        if (freeId && !refs.includes(FREE_REF)) refs.push(FREE_REF)
        continue
      }
      const provider = ids.get(parsed.profileId)
      if (provider && providers[provider]) refs.push(`${provider}:${parsed.model}`)
    }
    if (refs.length) roles[role] = refs
  }

  return {
    providers,
    roles,
    freeOnly: settings.freeOnly,
    // Without a connection for them there are no free models: "@free" has nowhere to look, and never falls to another key.
    freePool: { providers: freeId ? [freeId] : [] },
  }
}
