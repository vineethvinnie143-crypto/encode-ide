import { useCallback, useEffect, useState } from 'react'
import { normalizeFont } from '@shared/appearance'

interface LocalFont {
  family: string
}

/** Chromium's Local Font Access API; not in every TypeScript DOM library. */
type QueryLocalFonts = () => Promise<LocalFont[]>

let cached: Promise<string[]> | null = null

/** The font families installed on this PC, sorted and without repeats. Empty when the API says no. */
export function loadInstalledFonts(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  if (!query) return Promise.resolve([])
  return query
    .call(window)
    .then((fonts) => {
      const families = new Set<string>()
      for (const font of fonts) {
        // Names the setting would refuse are not offered.
        if (typeof font.family === 'string' && normalizeFont(font.family, '') === font.family) families.add(font.family)
      }
      return [...families].sort((a, b) => a.localeCompare(b))
    })
}

/**
 * The installed fonts for a font picker. The list is asked for once and kept; if the browser refuses
 * (it wants a click to answer), `retry` asks again, and it is called from a click.
 */
export function useInstalledFonts(): { fonts: string[]; loading: boolean; failed: boolean; retry: () => void } {
  const [fonts, setFonts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    cached ??= Promise.resolve().then(loadInstalledFonts)
    cached
      .then((list) => {
        setFonts(list)
        setFailed(false)
      })
      .catch(() => {
        // Do not keep a refusal: the next try may come with a click.
        cached = null
        setFailed(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { fonts, loading, failed, retry: load }
}
