// Money as people read it. Amounts are kept in cents (minor units) everywhere and formatted only at the edge.

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹' }

/** Formats an amount in cents for a person: thousands separated, two decimals, the currency's symbol in front. */
export function formatCents(cents, currency = 'USD') {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const minor = String(abs % 100).padStart(2, '0')
  const symbol = SYMBOLS[currency] ?? `${currency} `
  return `${sign}${symbol}${whole}.${minor}`
}

/** A range of amounts, as a price filter shows it: "$5.00 to $20.00", or one amount when both ends are the same. */
export function formatRange(low, high, currency = 'USD') {
  return low === high ? formatCents(low, currency) : `${formatCents(low, currency)} to ${formatCents(high, currency)}`
}

/** Parses what a person typed ("1,234.5", "$12", "-3.10") into cents; undefined when it is not an amount. */
export function parseCents(text) {
  const match = /^\s*(-)?\s*[$€£₹]?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(String(text))
  if (!match) return undefined
  const whole = Number(match[2].replace(/,/g, ''))
  const minor = Number((match[3] ?? '0').padEnd(2, '0'))
  return (match[1] ? -1 : 1) * (whole * 100 + minor)
}
