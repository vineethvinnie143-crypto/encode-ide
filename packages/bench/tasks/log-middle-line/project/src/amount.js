// Amounts as the bank's export writes them, in dollars with a dot before the cents ("1250.00", "-3.10").

/** Reads an amount into whole cents; undefined when the text is not an amount. */
export function parseAmount(text) {
  const value = Number(String(text).trim())
  if (String(text).trim() === '' || !Number.isFinite(value)) return undefined
  return Math.round(value * 100)
}

/** Writes cents back the way the export does. */
export function writeAmount(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
