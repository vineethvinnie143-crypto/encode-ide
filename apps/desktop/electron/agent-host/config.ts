import type { ModelProfile, Settings } from '../../shared/types'
import type { HostConfig } from './api'

/** What the agent host is told of the settings: the limits, and the model in use. */
export function hostConfigOf(settings: Settings, contextWindow: (profile: ModelProfile) => number | undefined = () => undefined): HostConfig {
  const profile = settings.profiles.find((candidate) => candidate.id === settings.activeProfileId)
  const window = profile ? contextWindow(profile) : undefined
  return {
    policy: settings.policy,
    maxSteps: settings.maxSteps,
    maxGoalRounds: settings.maxGoalRounds,
    profile: profile
      ? {
          id: profile.id,
          kind: profile.kind,
          baseUrl: profile.baseUrl,
          model: profile.model,
          ...(window ? { contextWindow: window } : {}),
        }
      : null,
  }
}
