import { useUi } from './stores/ui'

/**
 * Puts plain text on the clipboard for a Copy button. True when it is there; otherwise the person is told, so a Copy
 * that did nothing never passes in silence.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // The browser engine's own words are not plain; they go to the log, which Save diagnostics includes.
    console.warn('Copy failed:', error)
    useUi.getState().notify('error', 'eNCode could not copy that. Select the text and copy it yourself.')
    return false
  }
}
