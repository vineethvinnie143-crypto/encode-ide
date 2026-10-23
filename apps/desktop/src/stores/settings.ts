import { create } from '../store'
import { FREE_REF, demoPatch, labelOfRef, mainPatch, parseRef, withEffort } from '@shared/models'
import type { SearchProviderId } from '@shared/search'
import type { AgentMode, ModelRole, ReasoningEffort, Settings } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { useUi } from './ui'

interface SettingsStore {
  settings: Settings | null
  loading: boolean
  load(): Promise<void>
  /** False when the save failed; the reason has been shown. */
  save(patch: Partial<Settings>): Promise<boolean>
  /** False when the key was refused; the reason has been shown. */
  setProfileKey(id: string, key: string): Promise<boolean>
  /** The same for the key of a search provider; an empty key removes it. */
  setSearchKey(provider: SearchProviderId, key: string): Promise<boolean>
  setMode(mode: AgentMode): Promise<void>
  /**
   * Makes `ref` ("@free" or "<profile id>:<model id>") the only main model. A billed one asks first while only free
   * models are allowed, since choosing it turns that off. False when the person said no.
   */
  chooseMain(ref: string, free: boolean): Promise<boolean>
  /** Hands the main role back to the offline demo. */
  chooseDemo(): Promise<void>
  /** How hard a role's models think; none leaves it to the model. */
  setEffort(role: ModelRole, effort: ReasoningEffort | null): Promise<void>
  activeProfile(): Settings['profiles'][number] | null
}

/** Each save is numbered: only the answer to the latest one is shown, as the main process applies them in order. */
let saves = 0

/** The settings as a patch will leave them, shown before the main process answers so a switch moves at once. */
function patched(settings: Settings, patch: Partial<Settings>): Settings {
  const { appearance, ...rest } = patch
  return { ...settings, ...rest, ...(appearance ? { appearance: { ...settings.appearance, ...appearance } } : {}) }
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
    const turn = ++saves
    const before = get().settings
    if (before) set({ settings: patched(before, patch) })
    try {
      const settings = await api.settings.save(patch)
      if (turn === saves) set({ settings })
      return true
    } catch (error) {
      useUi.getState().notify('error', `Could not save settings: ${(error as Error).message}`)
      // What shows must be what is saved: read it again rather than guess what a failed save left.
      const settings = await api.settings.get().catch(() => before)
      if (turn === saves) set({ settings })
      return false
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

  setSearchKey: async (provider, key) => {
    try {
      const settings = await api.settings.setSearchKey(provider, key)
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

  setEffort: async (role, effort) => {
    const current = get().settings
    if (!current || (current.efforts[role] ?? null) === effort) return
    await get().save({ efforts: withEffort(current.efforts, role, effort) })
  },

  activeProfile: () => {
    const settings = get().settings
    if (!settings) return null
    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? null
  },
}))
