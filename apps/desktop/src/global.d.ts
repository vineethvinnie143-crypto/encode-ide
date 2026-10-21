import type { ForgeApi } from '@shared/types'

declare global {
  interface Window {
    eNCode: ForgeApi
  }
}

export {}
