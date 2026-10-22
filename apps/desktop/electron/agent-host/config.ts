import { modelMode } from '../../shared/models'
import type { Settings } from '../../shared/types'
import type { HostConfig } from './api'
import { isCallable, providerIds, routerSettingsOf } from './router-settings'

/**
 * What the agent host is told of the settings: the limits, which model answers, and the router's settings. A key
 * is never among them; the host learns only which providers have one and a number that changes with the key, and
 * asks for the key itself when it makes a request.
 */
export function hostConfigOf(settings: Settings, keyRevision: (profileId: string) => number = () => 0): HostConfig {
  const ids = providerIds(settings.profiles)
  const providers: HostConfig['providers'] = {}
  for (const profile of settings.profiles) {
    if (!isCallable(profile)) continue
    providers[ids.get(profile.id)!] = { profile: profile.id, name: profile.name, keyRevision: profile.hasApiKey ? keyRevision(profile.id) : null }
  }
  return {
    policy: settings.policy,
    maxSteps: settings.maxSteps,
    maxGoalRounds: settings.maxGoalRounds,
    model: modelMode(settings),
    router: routerSettingsOf(settings),
    providers,
  }
}
