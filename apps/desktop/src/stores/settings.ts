import { create } from '../store'
import { FREE_REF, demoPatch, labelOfRef, mainPatch, parseRef } from '@shared/models'
import type { AgentMode, Settings } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { useUi } from './ui'

interface SettingsStore {
  settings: Settings | null
  loading: boolean
  load(): Promise<void>
  save(patch: Partial<Settings>): Promise<void>
  /** False when the key was refused; the reason has been shown. */
  setProfileKey(id: string, key: string): Promise<boolean>
  setMode(mode: AgentMode): Promise<void>
  /**
   * Makes `ref` ("@free" or "<profile id>:<model id>") the only main model. A billed one asks first while only free
   * models are allowed, since choosing it turns that off. False when the person said no.
   */
  chooseMain(ref: string, free: boolean): Promise<boolean>
  /** Hands the main role back to the offline demo. */
  chooseDemo(): Promise<void>
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
      useUi.getState().notify('error', `Could not store the key: ${errorText(error)}`)
      return false
    }
  },

  setMode: async (mode) => {
    const current = get().settings
    if (current?.agentMode === mode) return
    await get().save({ agentMode: mode })
  },

  chooseMain: async (ref, free) => {
    const settings = get().settings
    if (!settings) return false
    if (!free && ref !== FREE_REF && settings.freeOnly) {
      const parsed = parseRef(ref, settings.profiles)
      const provider = parsed?.kind === 'model' ? settings.profiles.find((profile) => profile.id === parsed.profileId)?.name : undefined
      const allowed = await useUi.getState().askConfirm({
        title: 'Use a billed model?',
        body: `${labelOfRef(settings, ref)} is billed${provider ? ` by ${provider}` : ''} to your key. eNCode is set to use only free models, so choosing it turns that off. You can turn it back on in Settings, under Roles.`,
        confirmLabel: 'Allow billed models',
      })
      if (!allowed) return false
      await get().save({ ...mainPatch(settings, [ref]), freeOnly: false })
      return true
    }
    await get().save(mainPatch(settings, [ref]))
    return true
  },

  chooseDemo: async () => {
    const settings = get().settings
    if (settings) await get().save(demoPatch(settings))
  },

  activeProfile: () => {
    const settings = get().settings
    if (!settings) return null
    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? null
  },
}))
