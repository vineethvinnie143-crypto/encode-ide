/**
 * Shortcut text as shown on keys: "Ctrl+Shift+P" is three keys. A plus key
 * is written "Plus" or as a trailing "+", as in "Ctrl++".
 */
export function shortcutKeys(shortcut: string): string[] {
  const text = shortcut.trim()
  if (!text) return []
  if (text === '+') return ['+']
  const trailingPlus = text.endsWith('++')
  const body = trailingPlus ? text.slice(0, -2) : text
  const keys = body
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => (key.toLowerCase() === 'plus' ? '+' : key))
  if (trailingPlus) keys.push('+')
  return keys
}

/** "Ctrl+Shift+P" read out as "Ctrl Shift P", for labels and tooltips. */
export function shortcutLabel(shortcut: string): string {
  return shortcutKeys(shortcut).join(' ')
}

/** How long a tooltip waits. Right after another one closed it opens at once, so scanning a toolbar stays quick. */
export function tooltipDelay(now: number, lastClosedAt: number, delay = 400, warmFor = 300): number {
  return now - lastClosedAt < warmFor ? 0 : delay
}
