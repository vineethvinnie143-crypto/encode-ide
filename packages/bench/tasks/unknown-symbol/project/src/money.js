/** Cents as money in the given currency, such as $12.50. */
export function formatCurrency(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
