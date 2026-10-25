import { create } from '../store'
import type { UpdateOutcome, UpdateStatus } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { useUi } from './ui'

/** The tester builds' updates (ADR 0127), as the main process tells them. */
interface UpdatesStore {
  status: UpdateStatus | null
  /** The build the person was told is ready, so the notice comes once. */
  told: number
  init(): () => void
  check(): Promise<void>
  install(): Promise<void>
  cancel(): Promise<void>
  openPage(build?: number): Promise<void>
}

const notify = (...args: Parameters<ReturnType<typeof useUi.getState>['notify']>) => useUi.getState().notify(...args)

export const useUpdates = create<UpdatesStore>((set, get) => {
  const seen = (status: UpdateStatus) => {
    set({ status })
    if (status.state === 'ready' && !status.waiting && status.next.build !== get().told) {
      set({ told: status.next.build })
      notify('info', `Build ${status.next.build} is ready.`, { label: 'Restart to update', run: () => void get().install() })
    }
  }
  const tell = (outcome: UpdateOutcome | null) => {
    if (!outcome) return
    if (outcome.updated) notify('success', `Updated to build ${outcome.to}.`)
    else notify('error', `The update to build ${outcome.to} did not install. This is still build ${outcome.from}.`, { label: 'Release page', run: () => void get().openPage(outcome.to) })
  }
  const run = async (what: string, action: () => Promise<UpdateStatus | void>) => {
    try {
      const status = await action()
      if (status) seen(status)
    } catch (error) {
      notify('error', `Could not ${what}: ${errorText(error)}`)
    }
  }
  return {
    status: null,
    told: 0,
    init() {
      const off = api.updates.onStatus(seen)
      void api.updates
        .status()
        .then(seen)
        .catch(() => undefined)
      void api.updates
        .outcome()
        .then(tell)
        .catch(() => undefined)
      return off
    },
    check: () => run('look for updates', () => api.updates.check()),
    install: () => run('restart to update', () => api.updates.install()),
    cancel: () => run('stop waiting', () => api.updates.cancel()),
    openPage: (build) => run('open the release page', () => api.updates.openPage(build)),
  }
})
