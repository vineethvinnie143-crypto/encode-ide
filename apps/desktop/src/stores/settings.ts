import { create } from '../store'
import type { AgentMode, Settings } from '@shared/types'
import { api } from '../api'
import { useUi } from './ui'

interface SettingsStore {
  settings: Settings | null
  loading: boolean
  load(): Promise<void>
  save(patch: Partial<Settings>): Promise<void>
  /** False when the key was refused; the reason has been shown. */
  setProfileKey(id: string, key: string): Promise<boolean>
  setMode(mode: AgentMode): Promise<void>
  activeProfile(): Settings['profiles'][number] | null
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: null,
  loading: false,

  load: async () => {
    set({ loading: true })
    try {
      const settings = await api.settings.get()
      set({ settings, loading: false })
    } catch (error) {
      set({ loading: false })
      useUi.getState().notify('error', `Could not load settings: ${(error as Error).message}`)
    }
  },

  save: async (patch) => {
    try {
      const settings = await api.settings.save(patch)
      set({ settings })
    } catch (error) {
      useUi.getState().notify('error', `Could not save settings: ${(error as Error).message}`)
    }
  },

  setProfileKey: async (id, key) => {
    try {
      const settings = await api.settings.setProfileKey(id, key)
      set({ settings })
      return true
    } catch (error) {
      const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      useUi.getState().notify('error', `Could not store the key: ${message}`)
      return false
    }
  },

  setMode: async (mode) => {
    const current = get().settings
    if (current?.agentMode === mode) return
    await get().save({ agentMode: mode })
  },

  activeProfile: () => {
    const settings = get().settings
    if (!settings) return null
    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? null
  },
}))
