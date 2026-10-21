import type { EncodeApi } from '@shared/types'

declare global {
  interface Window {
    eNCode: EncodeApi
  }
}

export {}
